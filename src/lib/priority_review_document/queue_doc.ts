import { RNPlugin, PluginRem, RemId } from '@remnote/plugin-sdk';
import {
  PRIORITY_QUEUE_DEFAULT_BURST,
  PRIORITY_QUEUE_KB_SCOPE,
  PRIORITY_QUEUE_SHIELD_SLICE,
  incrementalQueueActiveKey,
  priorityQueueBurstSlotCode,
  priorityQueueLastRefreshSlotCode,
  priorityQueuePowerupCode,
  priorityQueueScopeSlotCode,
  priorityQueueShieldSliceSlotCode,
  PRIORITY_QUEUE_SHIELD_SLICE_MAX,
  PRIORITY_QUEUE_BURST_MIN,
  PRIORITY_QUEUE_BURST_MAX,
  allCardPriorityInfoKey,
} from '../consts';
import { CardPriorityInfo } from '../card_priority/types';
import { getCardsPerRem } from '../sorting';
import {
  attachToReviewQueueTag,
  buildGraphData,
  buildReviewDocTitle,
  findOrCreateMetadataRem,
  findOrCreateGraphRem,
  findOrCreateTag,
  GraphItem,
  PRD_TAG_NAME,
  writeEntries,
  writeGraph,
} from './index';
import { selectPriorityItems, SelectionResult } from './select';
import { cleanPriorityReviewDocuments, PrdDocReport, scanPriorityReviewDocuments } from './clean';
import { CoolingScanner } from './cooling_gather';
import { CoolingVerdict } from './cooling';

/**
 * The persistent Priority Queue document — one per scope.
 *
 * A snapshot review document is built once and decays: every item you review
 * leaves a dead entry behind, and every day's snapshot adds a document to the
 * tag, until practising the tag serves yesterday's leftovers before today's
 * priorities. The Priority Queue document is the same document kept alive
 * instead: REFILL tops it up to a fill target from the current ranking, DRAIN
 * removes what you have reviewed (and what is cooling), REFRESH is both. Small
 * bursts are the point — RemNote serves a document's cards in random order
 * (its base card provider is literally named `random`), so the only control a
 * plugin has over what comes first is how few items the document holds.
 *
 * Nothing here runs while a queue is open. RemNote gathers a document's cards
 * when Practice is pressed, so editing between sessions is safe and editing
 * during one is not.
 */

export interface PriorityQueueDocInfo {
  doc: PluginRem;
  scopeRemId: RemId | null;
  burst: number;
  /** 0–1. See PRIORITY_QUEUE_SHIELD_SLICE. */
  shieldSlice: number;
  lastRefresh: number | null;
}

export const clampBurst = (n: number) =>
  Math.max(PRIORITY_QUEUE_BURST_MIN, Math.min(PRIORITY_QUEUE_BURST_MAX, Math.round(n)));
export const clampShieldSlice = (f: number) =>
  Math.max(0, Math.min(PRIORITY_QUEUE_SHIELD_SLICE_MAX, Math.round(f * 100) / 100));

/** True when RemNote is on a flashcards route or the plugin's queue widget is mounted. */
export async function isQueueOpen(plugin: RNPlugin): Promise<boolean> {
  try {
    const url = await plugin.window.getURL();
    if (typeof url === 'string' && url.includes('/flashcards')) return true;
  } catch {
    /* fall through */
  }
  try {
    return !!(await plugin.storage.getSession<boolean>(incrementalQueueActiveKey));
  } catch {
    return false;
  }
}

export async function isPriorityQueueDoc(rem: PluginRem): Promise<boolean> {
  try {
    return await rem.hasPowerup(priorityQueuePowerupCode);
  } catch {
    return false;
  }
}

async function readSlot(rem: PluginRem, slot: string): Promise<string | null> {
  try {
    const raw = await rem.getPowerupProperty(priorityQueuePowerupCode, slot);
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

async function readInfo(doc: PluginRem): Promise<PriorityQueueDocInfo> {
  const scope = await readSlot(doc, priorityQueueScopeSlotCode);
  const burst = Number(await readSlot(doc, priorityQueueBurstSlotCode));
  const last = Number(await readSlot(doc, priorityQueueLastRefreshSlotCode));
  const sliceRaw = await readSlot(doc, priorityQueueShieldSliceSlotCode);
  const slice = sliceRaw === null ? NaN : Number(sliceRaw);
  return {
    doc,
    scopeRemId: scope && scope !== PRIORITY_QUEUE_KB_SCOPE ? scope : null,
    burst: Number.isFinite(burst) && burst > 0 ? burst : PRIORITY_QUEUE_DEFAULT_BURST,
    shieldSlice: Number.isFinite(slice) ? clampShieldSlice(slice) : PRIORITY_QUEUE_SHIELD_SLICE,
    lastRefresh: Number.isFinite(last) && last > 0 ? last : null,
  };
}

/** Every Priority Queue document in the KB. */
export async function listPriorityQueueDocs(plugin: RNPlugin): Promise<PriorityQueueDocInfo[]> {
  const tag = await plugin.rem.findByName([PRD_TAG_NAME], null);
  if (!tag) return [];
  const docs = (await tag.taggedRem()) || [];
  const out: PriorityQueueDocInfo[] = [];
  for (const doc of docs) {
    if (await isPriorityQueueDoc(doc)) out.push(await readInfo(doc));
  }
  return out;
}

export async function findPriorityQueueDoc(
  plugin: RNPlugin,
  scopeRemId: RemId | null
): Promise<PriorityQueueDocInfo | null> {
  const all = await listPriorityQueueDocs(plugin);
  return all.find((d) => d.scopeRemId === scopeRemId) ?? null;
}

export async function setPriorityQueueBurst(plugin: RNPlugin, doc: PluginRem, burst: number): Promise<void> {
  await doc.setPowerupProperty(priorityQueuePowerupCode, priorityQueueBurstSlotCode, [String(clampBurst(burst))]);
}

export async function setPriorityQueueShieldSlice(plugin: RNPlugin, doc: PluginRem, fraction: number): Promise<void> {
  await doc.setPowerupProperty(priorityQueuePowerupCode, priorityQueueShieldSliceSlotCode, [
    String(clampShieldSlice(fraction)),
  ]);
}

export async function findOrCreatePriorityQueueDoc(
  plugin: RNPlugin,
  scopeRemId: RemId | null,
  burst: number = PRIORITY_QUEUE_DEFAULT_BURST
): Promise<PriorityQueueDocInfo> {
  const existing = await findPriorityQueueDoc(plugin, scopeRemId);
  if (existing) return existing;

  const doc = await plugin.rem.createRem();
  if (!doc) throw new Error('Could not create the Priority Queue document.');
  await doc.setText(await buildReviewDocTitle(plugin, 'Priority Queue', scopeRemId));
  await doc.setIsDocument(true);
  await doc.addPowerup(priorityQueuePowerupCode);
  await doc.setPowerupProperty(priorityQueuePowerupCode, priorityQueueScopeSlotCode, [
    scopeRemId ?? PRIORITY_QUEUE_KB_SCOPE,
  ]);
  await setPriorityQueueBurst(plugin, doc, burst);
  await setPriorityQueueShieldSlice(plugin, doc, PRIORITY_QUEUE_SHIELD_SLICE);
  // Status block first, graph second, entries after — created now so the
  // first refill appends below them rather than above the graph.
  await findOrCreateMetadataRem(plugin, doc);
  await findOrCreateGraphRem(plugin, doc);
  await attachToReviewQueueTag(plugin, doc);
  // The tag lookups the entries need, created up front so the first refill
  // does not create them mid-loop.
  await findOrCreateTag(plugin, 'INC');
  await findOrCreateTag(plugin, 'FC');
  return { doc, scopeRemId, burst: clampBurst(burst), shieldSlice: PRIORITY_QUEUE_SHIELD_SLICE, lastRefresh: null };
}

// --- refresh --------------------------------------------------------------

export type RefreshMode = 'refresh' | 'drain' | 'refill';

export interface RefreshOptions {
  scopeRemId: RemId | null;
  mode?: RefreshMode;
  /** Overrides (and stores) the document's fill target. */
  burst?: number;
  /** Overrides (and stores) the document's shield slice, 0–1. */
  shieldSlice?: number;
  /** Skip the open-queue guard — for the QueueExit hook, which runs as the queue closes. */
  skipQueueGuard?: boolean;
  onProgress?: (message: string) => void;
}

export interface RefreshResult {
  blocked?: 'queue-open';
  /** Null only when blocked before the document existed. */
  doc: PluginRem | null;
  scopeRemId: RemId | null;
  burst: number;
  /** Entries in the document after the refresh. */
  holding: { total: number; flashcards: number; incRems: number };
  drained: { reviewed: number; cooling: number; missing: number; kept: number };
  added: { total: number; flashcards: number; incRems: number; shieldSlice: number };
  cooling: CoolingVerdict[];
  selection: SelectionResult | null;
  elapsedMs: number;
}

/** The target Rem ids the document's entries point at, by entry kind. */
async function readDocTargets(plugin: RNPlugin, doc: PluginRem): Promise<Map<RemId, RemId>> {
  const childIds = doc.children || [];
  const children = childIds.length ? (await plugin.rem.findMany(childIds)) || [] : [];
  const targets = new Map<RemId, RemId>(); // entryId -> targetId
  for (const child of children) {
    if (!Array.isArray(child.text)) continue;
    const ref = child.text.find((el) => el && typeof el === 'object' && (el as any).i === 'q' && (el as any)._id);
    if (ref) targets.set(child._id, (ref as any)._id as RemId);
  }
  return targets;
}

function formatStamp(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Drain, then refill up to the fill target, then rewrite the status block and
 * the graph. Returns `blocked: 'queue-open'` (and does nothing) while a queue
 * is open, unless the caller vouches for the moment.
 */
export async function refreshPriorityQueue(plugin: RNPlugin, options: RefreshOptions): Promise<RefreshResult> {
  const startedAt = Date.now();
  const mode = options.mode ?? 'refresh';
  const progress = options.onProgress ?? (() => {});

  if (!options.skipQueueGuard && (await isQueueOpen(plugin))) {
    console.warn('[Priority Queue] Refresh refused: a queue is open.');
    const existing = await findPriorityQueueDoc(plugin, options.scopeRemId);
    return {
      blocked: 'queue-open',
      doc: existing?.doc ?? null,
      scopeRemId: options.scopeRemId,
      burst: options.burst ?? existing?.burst ?? PRIORITY_QUEUE_DEFAULT_BURST,
      holding: { total: 0, flashcards: 0, incRems: 0 },
      drained: { reviewed: 0, cooling: 0, missing: 0, kept: 0 },
      added: { total: 0, flashcards: 0, incRems: 0, shieldSlice: 0 },
      cooling: [],
      selection: null,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const info = await findOrCreatePriorityQueueDoc(plugin, options.scopeRemId, options.burst);
  let doc = info.doc;
  const burst = clampBurst(options.burst ?? info.burst);
  if (burst !== info.burst) await setPriorityQueueBurst(plugin, doc, burst);
  const shieldSlice = clampShieldSlice(options.shieldSlice ?? info.shieldSlice);
  if (shieldSlice !== info.shieldSlice) await setPriorityQueueShieldSlice(plugin, doc, shieldSlice);

  const scanner = new CoolingScanner(plugin, { scopeRemId: info.scopeRemId });

  // 1. Drain. The document's own targets are judged for cooling first, so an
  //    entry whose sibling was reviewed in the last session leaves with the
  //    reviewed ones.
  progress('Reading the document…');
  const entryTargets = await readDocTargets(plugin, doc);
  const targetIds = [...new Set(entryTargets.values())];
  await scanner.scan(targetIds);

  progress('Draining reviewed and cooling entries…');
  const scan = await scanPriorityReviewDocuments(plugin, undefined, {
    docIds: [doc._id],
    coolingRemIds: scanner.coolingIds(),
  });
  const report: PrdDocReport | undefined = scan.docs[0];
  const drained = { reviewed: 0, cooling: 0, missing: 0, kept: 0 };
  if (report && mode !== 'refill') {
    for (const e of report.removableEntries) {
      if (e.status === 'cooling') drained.cooling++;
      else if (e.status === 'missing') drained.missing++;
      else drained.reviewed++;
    }
    drained.kept = report.keptEntries.length;
    if (report.removableEntries.length) {
      await cleanPriorityReviewDocuments(plugin, [report], { deleteEmptiedDocs: false });
    }
  }

  // What the document still holds after the drain — never re-selected.
  const remaining = report
    ? mode === 'refill'
      ? [...report.dueEntries, ...report.removableEntries, ...report.keptEntries, ...report.unknownEntries]
      : [...report.dueEntries, ...report.keptEntries, ...report.unknownEntries]
    : [];
  const remainingTargets = new Set<RemId>(remaining.map((e) => e.targetRemId).filter((id): id is RemId => !!id));
  const remainingFc = remaining.filter((e) => e.kind === 'fc').length;
  const remainingInc = remaining.length - remainingFc;

  // 2. Refill up to the target.
  const toAdd = mode === 'drain' ? 0 : Math.max(0, burst - remaining.length);
  progress(toAdd ? `Selecting ${toAdd} items…` : 'Computing the priority universe…');
  const cardRatio = await getCardsPerRem(plugin);
  const selection = await selectPriorityItems(plugin, {
    scopeRemId: info.scopeRemId,
    itemCount: toAdd,
    cardRatio,
    filterPaused: true,
    pausedPriorityThreshold: 20,
    excludeRemIds: remainingTargets,
    shieldSliceFraction: shieldSlice,
    coolingScanner: scanner,
  });
  await scanner.publish();

  const addedFc = selection.items.filter((i) => i.type === 'flashcard').length;
  const addedInc = selection.items.length - addedFc;
  // Entries are appended at the bottom; the status block and the graph must
  // already be in place (and in that order) so they stay on top.
  await ensureHeaderOrder(plugin, doc);
  if (selection.items.length) {
    progress(`Writing ${selection.items.length} entries…`);
    await writeEntries(plugin, doc, selection.items);
  }

  // 3. Status block and graph, describing the document as it now is. The Rem
  //    object is re-read first: its `children` list was captured before the
  //    entries (and, on a new document, the status block) were written.
  doc = (await plugin.rem.findOne(doc._id)) ?? doc;
  const now = Date.now();
  const holding = {
    total: remaining.length + selection.items.length,
    flashcards: remainingFc + addedFc,
    incRems: remainingInc + addedInc,
  };
  const graphItems: GraphItem[] = [
    ...remaining.map((e): GraphItem => {
      const id = e.targetRemId;
      const priority = id ? selection.priorityByRemId.get(id) : undefined;
      const percentile = id
        ? e.kind === 'inc'
          ? selection.incRemPercentiles[id]
          : selection.cardPercentiles[id]
        : undefined;
      return {
        type: e.kind === 'inc' ? 'incremental' : 'flashcard',
        priority: typeof priority === 'number' ? priority : 100,
        percentile: typeof percentile === 'number' ? percentile : 100,
      };
    }),
    ...selection.items.map((i) => ({ type: i.type, priority: i.priority, percentile: i.percentile })),
  ];

  const s = selection.stats;
  const heldBack = selection.skippedAncestorItems.length;
  const cooling = scanner.sortedVerdicts();
  const statusText =
    `Scope: ${s.scopeName}\n` +
    `Priority Queue · fill target ${burst} · shield slice ${Math.round(shieldSlice * 100)}%\n` +
    `Holding: ${holding.total} items (${holding.flashcards} flashcard Rems, ${holding.incRems} IncRems)\n` +
    `Last refresh: ${formatStamp(now)} — drained ${drained.reviewed} reviewed` +
    (drained.cooling ? `, ${drained.cooling} cooling` : '') +
    (drained.missing ? `, ${drained.missing} missing` : '') +
    ` · added ${selection.items.length}` +
    (selection.shieldSliceCount ? ` (${selection.shieldSliceCount} from the shield slice)` : '') +
    `\n` +
    `Cooling now: ${cooling.length} Rems` +
    (heldBack ? ` · Held back (due ancestor): ${heldBack}` : '') +
    (selection.skippedPausedItems.length ? ` · Skipped (paused): ${selection.skippedPausedItems.length}` : '') +
    `\n` +
    `Due in scope: ${s.dueCardRems} flashcard Rems (${s.dueCards} cards), ${s.dueIncRems} IncRems\n` +
    `Randomness: IncRem ${selection.randomnessPct.incRem}%, Cards ${selection.randomnessPct.card}%`;

  const metadataRem = await findOrCreateMetadataRem(plugin, doc);
  if (metadataRem) await metadataRem.setText([statusText]);
  await writeGraph(plugin, doc, buildGraphData(graphItems, selection.randomnessPct));
  await doc.setPowerupProperty(priorityQueuePowerupCode, priorityQueueLastRefreshSlotCode, [String(now)]);

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[Priority Queue] ${mode} (${s.scopeName}): holding ${holding.total}, drained ${drained.reviewed + drained.cooling + drained.missing} ` +
      `(${drained.cooling} cooling), added ${selection.items.length} (${selection.shieldSliceCount} shield slice), ` +
      `${cooling.length} cooling in scope, in ${elapsedMs}ms`
  );

  return {
    doc,
    scopeRemId: info.scopeRemId,
    burst,
    holding,
    drained,
    added: { total: selection.items.length, flashcards: addedFc, incRems: addedInc, shieldSlice: selection.shieldSliceCount },
    cooling,
    selection,
    elapsedMs,
  };
}

/**
 * Status block at position 0, graph at position 1, whatever else the document
 * holds after them. Creates either when missing; moves them when an earlier
 * write left them below the entries.
 */
async function ensureHeaderOrder(plugin: RNPlugin, doc: PluginRem): Promise<void> {
  const metadata = await findOrCreateMetadataRem(plugin, doc);
  const graph = await findOrCreateGraphRem(plugin, doc);
  const fresh = (await plugin.rem.findOne(doc._id)) ?? doc;
  const children = (fresh.children as RemId[] | undefined) ?? [];
  try {
    if (metadata && children[0] !== metadata._id) await metadata.setParent(doc, 0);
    if (graph && children[1] !== graph._id) await graph.setParent(doc, 1);
  } catch (e) {
    console.warn('[Priority Queue] Could not reorder the header children:', e);
  }
}

/** Opens Practice for the document: RemNote's own Practice button is this route. */
export async function practicePriorityQueue(plugin: RNPlugin, doc: PluginRem): Promise<void> {
  await plugin.window.setURL(`/flashcards/${doc._id}`);
}

/**
 * The card shield as it stands and as it would stand once every entry of the
 * document is reviewed: the lowest priority among overdue, unpaused Rems that
 * are neither cooling nor in the document. Read from the priority cache only.
 */
export async function computeShieldOutlook(
  plugin: RNPlugin,
  docTargetIds: ReadonlySet<RemId>,
  coolingIds: ReadonlySet<RemId>,
  scopeIds: ReadonlySet<RemId> | null
): Promise<{ now: number | null; afterDocument: number | null; overdueRems: number }> {
  const infos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
  let now: number | null = null;
  let after: number | null = null;
  let overdue = 0;
  for (const info of infos) {
    if ((info.dueCardsOverdue ?? 0) <= 0 || info.paused) continue;
    if (scopeIds && !scopeIds.has(info.remId)) continue;
    overdue++;
    if (coolingIds.has(info.remId)) continue;
    if (now === null || info.priority < now) now = info.priority;
    if (docTargetIds.has(info.remId)) continue;
    if (after === null || info.priority < after) after = info.priority;
  }
  return { now, afterDocument: after, overdueRems: overdue };
}

/** The entries' target Rem ids by kind, without a scan. */
export async function readDocTargetIds(plugin: RNPlugin, doc: PluginRem): Promise<RemId[]> {
  const fresh = (await plugin.rem.findOne(doc._id)) ?? doc;
  return [...new Set((await readDocTargets(plugin, fresh)).values())];
}
