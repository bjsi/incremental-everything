// lib/card_enablement/scan.ts
//
// Batch card-enablement audit: take one anchor Rem, gather every Rem in its
// orbit (tagged with it, referencing it, descended from it), and ask each one
// why it does or does not produce flashcards.
//
// WHY THIS EXISTS ALONGSIDE SuppressedCardsView
//
// The analytics view answers the same question from the other end: it starts at
// `plugin.card.getAll()` and classifies the card records it finds. That makes it
// structurally blind to the case this module was written for. A Rem whose
// practice direction was switched to 'none' before any card was ever made owns
// ZERO card records — so it produces zero analytics rows, and no card-driven
// tool can ever surface it, however it is filtered. An Anki import that lands
// hundreds of Rems in that state is invisible.
//
// So this walk is REM-DRIVEN: the population is the scope, not the card table,
// and a Rem with no cards at all is a first-class result rather than an absence.
//
// The verdicts follow CARD_STATE_REFERENCE.md, which is the measured account of
// how these states differ. In particular: `rem.getCards()` is a "currently
// surfaced" filter and its emptiness proves nothing on its own, which is why
// every row here carries BOTH the surfaced count and the record count.
//
// COST
//
// The single-Rem probe in card_analytics_export.ts calls `plugin.card.getAll()`
// once per Rem and walks the full ancestor chain with four IPC calls per hop.
// Run over a few hundred Rems that is tens of thousands of bridge round-trips —
// the same saturation the priority badges hit. Three things keep this usable:
// the card table is fetched ONCE and indexed by remId; ancestor chains are
// memoised per parent id, so the hundreds of rows of an imported deck resolve
// one shared chain instead of one chain each; and the per-Rem reads run at a
// bounded concurrency rather than all at once.

import { BuiltInPowerupCodes, RNPlugin } from '@remnote/plugin-sdk';
import { safeRemTextToString } from '../pdfUtils';
import { collectClozeIds } from '../card_analytics_export';

/** Which populations the audit draws from. Freely combinable. */
export interface AuditScope {
  /** Rems carrying the anchor as a tag. */
  tagged: boolean;
  /** Rems whose text references the anchor. */
  referencing: boolean;
  /** The anchor itself and everything under it. */
  descendants: boolean;
  /**
   * Pull in the descendants of every match as well.
   *
   * This is what reaches an imported deck: the tag or the reference usually
   * sits on the container, while the Rems that own the cards are its children.
   * Off by default because it multiplies the population.
   */
  expandDescendants: boolean;
}

export const DEFAULT_AUDIT_SCOPE: AuditScope = {
  tagged: true,
  referencing: true,
  descendants: false,
  expandDescendants: false,
};

/** Hard ceiling on the population. Past this the scan reports `capped`. */
export const AUDIT_SCOPE_CAP = 5000;

/** How many Rems are probed concurrently. Bounded to keep the bridge responsive. */
const PROBE_CONCURRENCY = 8;

export type EnablementVerdict =
  /** Surfaces at least one card. Nothing to do. */
  | 'ok'
  /** Has card material, practice is on, but no direction is enabled. */
  | 'direction-none'
  /** "Enable Cards" is off on the Rem itself. */
  | 'practice-off'
  /** The Rem is a table or sits in one — RemNote ships those with cards off. */
  | 'in-table'
  /** An ancestor carries "Disable Descendant Cards". */
  | 'disabled-by-ancestor'
  /** Inside a paused deck. Cards exist and keep their due dates; the queue skips them. */
  | 'in-paused-deck'
  /** Card material or records exist, nothing surfaces, and no Rem-level flag explains it. */
  | 'not-surfaced'
  /** No back side, no clozes, no card records — there is nothing here to enable. */
  | 'no-card-material';

export const VERDICT_LABELS: Record<EnablementVerdict, string> = {
  ok: 'Producing cards',
  'direction-none': 'Direction set to none',
  'practice-off': 'Cards switched off on the Rem',
  'in-table': 'In a table (cards off by default)',
  'disabled-by-ancestor': 'Disabled by an ancestor',
  'in-paused-deck': 'Inside a paused deck',
  'not-surfaced': 'Not surfaced — no Rem-level cause',
  'no-card-material': 'No card material',
};

export const VERDICT_SHORT: Record<EnablementVerdict, string> = {
  ok: 'OK',
  'direction-none': 'dir=none',
  'practice-off': 'practice off',
  'in-table': 'table',
  'disabled-by-ancestor': 'ancestor off',
  'in-paused-deck': 'paused deck',
  'not-surfaced': 'not surfaced',
  'no-card-material': 'no material',
};

/**
 * What a bulk write on this Rem can actually achieve.
 *
 * `direction` and `practice` are the two switches this panel owns. A verdict
 * that is not fixed by either is marked so the UI can say so instead of
 * offering a button that would change a flag without changing the outcome —
 * setting a direction on a Rem whose ancestor disables cards writes the slot
 * and produces nothing.
 */
export const ACTIONABLE_VERDICTS: ReadonlySet<EnablementVerdict> = new Set<EnablementVerdict>([
  'direction-none',
  'practice-off',
  'in-table',
]);

/** The two verdicts the default filter opens on — the ones worth hunting. */
export const DEFAULT_VERDICT_FILTER: ReadonlySet<EnablementVerdict> = new Set<EnablementVerdict>([
  'direction-none',
  'practice-off',
]);

export type PracticeDirection = 'forward' | 'backward' | 'none' | 'both';

export interface EnablementRow {
  remId: string;
  /** Front text, references resolved. */
  text: string;
  /** Back text, empty when the Rem has none. */
  backText: string;
  /** Ancestor path, top-down, for locating the Rem in the outline. */
  breadcrumb: string;
  verdict: EnablementVerdict;
  enablePractice: boolean;
  practiceDirection: PracticeDirection | null;
  /** Cards `rem.getCards()` surfaces right now. */
  surfaced: number;
  /** Card records the card table holds for this Rem, surfaced or not. */
  records: number;
  /** Cloze ids the text currently defines. */
  clozeCount: number;
  hasBackText: boolean;
  isTableOwn: boolean;
  inTable: boolean;
  disableCardsOwn: boolean;
  /** Nearest ancestor carrying "Disable Descendant Cards", if any. */
  disablingAncestorId: string | null;
  disablingAncestorText: string | null;
  pausedAncestorId: string | null;
  /** Where this Rem entered the population. Purely informational. */
  origins: ScopeOrigin[];
}

export type ScopeOrigin = 'tagged' | 'referencing' | 'descendant' | 'expanded' | 'anchor';

export interface AuditResult {
  anchorId: string;
  anchorText: string;
  scope: AuditScope;
  rows: EnablementRow[];
  counts: Record<EnablementVerdict, number>;
  /** Population size before the cap was applied. */
  scanned: number;
  capped: boolean;
  /** Rems that threw while being probed and are absent from `rows`. */
  failed: number;
  tookMs: number;
}

// --- Ancestor chain, memoised ---------------------------------------------
//
// One node per ancestor Rem, and one resolved verdict per chain STARTING at a
// given Rem. Both are keyed by rem id and shared across the whole scan, which
// is where the saving is: every row of an imported deck hangs off the same
// handful of parents, so the chain above them is walked exactly once.

interface ChainVerdict {
  disablingAncestorId: string | null;
  disablingAncestorText: string | null;
  pausedAncestorId: string | null;
  inTable: boolean;
  /** Ancestor names, nearest first. */
  names: string[];
}

const EMPTY_CHAIN: ChainVerdict = {
  disablingAncestorId: null,
  disablingAncestorText: null,
  pausedAncestorId: null,
  inTable: false,
  names: [],
};

export class AncestorChainCache {
  private chains = new Map<string, ChainVerdict>();

  constructor(private plugin: RNPlugin) {}

  /** Resolved state of the chain above `rem` (the Rem itself is not included). */
  async forParentOf(rem: any): Promise<ChainVerdict> {
    const parentId: string | undefined = rem.parent;
    if (!parentId) return EMPTY_CHAIN;
    return this.forRem(parentId);
  }

  /**
   * The chain starting AT `remId` (inclusive), memoised at every level.
   *
   * Walks up collecting ids until it meets a level that is already known — or
   * the root — then folds back down, storing each level on the way. So the
   * second Rem under the same parent costs one map lookup.
   */
  private async forRem(remId: string): Promise<ChainVerdict> {
    const pending: string[] = [];
    let cursor: string | undefined = remId;
    let base: ChainVerdict = EMPTY_CHAIN;
    let hops = 0;

    while (cursor && hops < 64) {
      const cached = this.chains.get(cursor);
      if (cached) {
        base = cached;
        break;
      }
      pending.push(cursor);
      const rem: any = await this.plugin.rem.findOne(cursor);
      if (!rem) break;
      // Stash the node's own flags on the way up; the fold below needs them in
      // reverse order, so they are read here and combined there.
      this.nodes.set(cursor, await this.readNode(rem));
      cursor = rem.parent;
      hops++;
    }

    // Fold from the topmost unknown level down to `remId`.
    for (let i = pending.length - 1; i >= 0; i--) {
      const id = pending[i];
      const node = this.nodes.get(id);
      if (!node) {
        this.chains.set(id, base);
        continue;
      }
      const verdict: ChainVerdict = {
        disablingAncestorId: node.disableCards ? id : base.disablingAncestorId,
        disablingAncestorText: node.disableCards ? node.text : base.disablingAncestorText,
        pausedAncestorId: node.deckStatus === 'Paused' ? id : base.pausedAncestorId,
        inTable: node.isTable || base.inTable,
        names: node.text ? [node.text, ...base.names] : base.names,
      };
      this.chains.set(id, verdict);
      base = verdict;
    }

    return base;
  }

  private nodes = new Map<string, { text: string; disableCards: boolean; deckStatus: string | null; isTable: boolean }>();

  private async readNode(rem: any) {
    const [disableCards, isDeck, isTable, text] = await Promise.all([
      rem.hasPowerup(BuiltInPowerupCodes.DisableCards).catch(() => false),
      rem.hasPowerup(BuiltInPowerupCodes.Deck).catch(() => false),
      rem.isTable().catch(() => false),
      remTextFast(this.plugin, rem.text),
    ]);
    let deckStatus: string | null = null;
    if (isDeck) {
      deckStatus =
        ((await rem.getPowerupProperty(BuiltInPowerupCodes.Deck, 'Status').catch(() => null)) as
          | string
          | null) ?? null;
    }
    return {
      text: text === 'Untitled' ? '' : text,
      disableCards: !!disableCards,
      deckStatus,
      isTable: !!isTable,
    };
  }
}

/** Top-down breadcrumb from a nearest-first name list, elided in the middle. */
function formatBreadcrumb(names: string[], maxLabel = 24): string {
  const topDown = names
    .map((n) => (n.length > maxLabel ? `${n.slice(0, maxLabel)}…` : n))
    .reverse();
  if (topDown.length === 0) return '';
  if (topDown.length <= 4) return topDown.join(' / ');
  return `${topDown[0]} / … / ${topDown.slice(-3).join(' / ')}`;
}

/**
 * Rich text to string, taking the free path when it can.
 *
 * `safeRemTextToString` costs a `normalize` + `toString` round-trip per call,
 * which over a few thousand Rems (front and back) is thousands of bridge calls
 * for text that is, in the overwhelming majority of cases, a plain string
 * already sitting in the array. Only the values that actually carry structure
 * pay for the SDK.
 */
export async function remTextFast(plugin: RNPlugin, richText: any): Promise<string> {
  if (richText == null) return 'Untitled';
  if (!Array.isArray(richText)) return 'Untitled';
  if (richText.length === 0) return 'Untitled';
  if (richText.every((el: unknown) => typeof el === 'string')) {
    const joined = (richText as string[]).join('').trim();
    return joined.length > 0 ? joined : 'Untitled';
  }
  return safeRemTextToString(plugin, richText);
}

// --- Scope resolution ------------------------------------------------------

/** Deduplicated population for a scope, each id tagged with where it came from. */
export async function resolveAuditPopulation(
  plugin: RNPlugin,
  anchorId: string,
  scope: AuditScope,
): Promise<{ rems: any[]; origins: Map<string, ScopeOrigin[]>; capped: boolean; total: number }> {
  const anchor = await plugin.rem.findOne(anchorId);
  const origins = new Map<string, ScopeOrigin[]>();
  const byId = new Map<string, any>();

  const add = (rem: any, origin: ScopeOrigin) => {
    if (!rem?._id) return;
    if (!byId.has(rem._id)) byId.set(rem._id, rem);
    const list = origins.get(rem._id);
    if (list) {
      if (!list.includes(origin)) list.push(origin);
    } else {
      origins.set(rem._id, [origin]);
    }
  };

  if (!anchor) return { rems: [], origins, capped: false, total: 0 };

  if (scope.tagged) {
    const tagged = (await anchor.taggedRem().catch(() => [])) || [];
    for (const r of tagged) add(r, 'tagged');
  }
  if (scope.referencing) {
    const refs = (await anchor.remsReferencingThis().catch(() => [])) || [];
    for (const r of refs) add(r, 'referencing');
  }
  if (scope.descendants) {
    add(anchor, 'anchor');
    const kids = (await anchor.getDescendants().catch(() => [])) || [];
    for (const r of kids) add(r, 'descendant');
  }

  if (scope.expandDescendants) {
    // Snapshot first: expanding while iterating the live map would walk the
    // descendants we are in the middle of adding, re-walking whole subtrees.
    const seeds = Array.from(byId.values());
    for (const seed of seeds) {
      if (byId.size > AUDIT_SCOPE_CAP) break;
      const kids = (await seed.getDescendants().catch(() => [])) || [];
      for (const r of kids) add(r, 'expanded');
    }
  }

  const all = Array.from(byId.values());
  return {
    rems: all.slice(0, AUDIT_SCOPE_CAP),
    origins,
    capped: all.length > AUDIT_SCOPE_CAP,
    total: all.length,
  };
}

// --- The scan --------------------------------------------------------------

export interface ScanProgress {
  phase: 'scope' | 'cards' | 'probe' | 'done';
  done: number;
  total: number;
}

export async function auditCardEnablement(
  plugin: RNPlugin,
  anchorId: string,
  scope: AuditScope,
  onProgress?: (p: ScanProgress) => void,
  isCancelled?: () => boolean,
): Promise<AuditResult> {
  const startedAt = Date.now();
  onProgress?.({ phase: 'scope', done: 0, total: 0 });

  const anchor = await plugin.rem.findOne(anchorId);
  const anchorText = anchor ? await remTextFast(plugin, anchor.text) : '(missing)';

  const { rems, origins, capped, total } = await resolveAuditPopulation(plugin, anchorId, scope);

  // The card table, ONCE. Indexed by owning rem id, which is the field every
  // per-Rem verdict in this codebase groups by (verified by the ownership probe
  // in card_analytics_export.ts).
  onProgress?.({ phase: 'cards', done: 0, total: rems.length });
  const allCards = (await plugin.card.getAll().catch(() => [])) || [];
  const cardsByRem = new Map<string, any[]>();
  for (const card of allCards as any[]) {
    const owner = card?.remId;
    if (!owner) continue;
    const list = cardsByRem.get(owner);
    if (list) list.push(card);
    else cardsByRem.set(owner, [card]);
  }

  const chains = new AncestorChainCache(plugin);
  const rows: EnablementRow[] = [];
  let failed = 0;
  let done = 0;

  onProgress?.({ phase: 'probe', done: 0, total: rems.length });

  for (let i = 0; i < rems.length; i += PROBE_CONCURRENCY) {
    if (isCancelled?.()) break;
    const batch = rems.slice(i, i + PROBE_CONCURRENCY);
    const probed = await Promise.all(
      batch.map(async (rem) => {
        try {
          return await probeOne(plugin, rem, cardsByRem, chains, origins.get(rem._id) ?? []);
        } catch (e) {
          console.error('[CardEnablement] probe failed for', rem?._id, e);
          return null;
        }
      }),
    );
    for (const row of probed) {
      if (row) rows.push(row);
      else failed++;
    }
    done += batch.length;
    onProgress?.({ phase: 'probe', done, total: rems.length });
  }

  const counts = emptyCounts();
  for (const row of rows) counts[row.verdict]++;

  onProgress?.({ phase: 'done', done, total: rems.length });

  return {
    anchorId,
    anchorText,
    scope,
    rows,
    counts,
    scanned: total,
    capped,
    failed,
    tookMs: Date.now() - startedAt,
  };
}

export function emptyCounts(): Record<EnablementVerdict, number> {
  return {
    ok: 0,
    'direction-none': 0,
    'practice-off': 0,
    'in-table': 0,
    'disabled-by-ancestor': 0,
    'in-paused-deck': 0,
    'not-surfaced': 0,
    'no-card-material': 0,
  };
}

/** Probe one Rem. Every read here is per-Rem; the shared work is already done. */
async function probeOne(
  plugin: RNPlugin,
  rem: any,
  cardsByRem: Map<string, any[]>,
  chains: AncestorChainCache,
  origins: ScopeOrigin[],
): Promise<EnablementRow> {
  const [text, surfacedCards, enablePractice, practiceDirection, disableCardsOwn, isTableOwn, chain] =
    await Promise.all([
      remTextFast(plugin, rem.text),
      rem.getCards().catch(() => [] as any[]),
      rem.getEnablePractice().catch(() => null),
      rem.getPracticeDirection().catch(() => null),
      rem.hasPowerup(BuiltInPowerupCodes.DisableCards).catch(() => false),
      rem.isTable().catch(() => false),
      chains.forParentOf(rem),
    ]);

  const hasBackText = Array.isArray(rem.backText) && rem.backText.length > 0;
  const backText = hasBackText ? await remTextFast(plugin, rem.backText) : '';
  const clozeIds = collectClozeIds(rem.text);
  const records = cardsByRem.get(rem._id)?.length ?? 0;

  const row: EnablementRow = {
    remId: rem._id,
    text,
    backText: backText === 'Untitled' ? '' : backText,
    breadcrumb: formatBreadcrumb(chain.names),
    verdict: 'ok',
    enablePractice: enablePractice !== false,
    practiceDirection: (practiceDirection as PracticeDirection) ?? null,
    surfaced: surfacedCards.length,
    records,
    clozeCount: clozeIds.size,
    hasBackText,
    isTableOwn: !!isTableOwn,
    inTable: chain.inTable,
    disableCardsOwn: !!disableCardsOwn,
    disablingAncestorId: chain.disablingAncestorId,
    disablingAncestorText: chain.disablingAncestorText,
    pausedAncestorId: chain.pausedAncestorId,
    origins,
  };
  row.verdict = classifyRow(row);
  return row;
}

/**
 * One verdict per Rem, most actionable cause first.
 *
 * The order encodes what a fix would actually accomplish. An ancestor that
 * disables cards outranks the Rem's own direction because setting a direction
 * under it writes the slot and still produces nothing — reporting `direction-none`
 * there would send the user to a button that cannot work. `no-card-material`
 * comes first of all: a Rem with no back side, no clozes and no card records is
 * not broken, it is simply not a flashcard, and it is the overwhelming majority
 * of any subtree.
 */
export function classifyRow(row: EnablementRow): EnablementVerdict {
  const hasMaterial = row.hasBackText || row.clozeCount > 0 || row.records > 0;
  if (!hasMaterial) return 'no-card-material';

  if (row.disablingAncestorId) return 'disabled-by-ancestor';

  // Tables report enablePractice === false natively, so they are separated
  // BEFORE the deliberate switch-off — otherwise every row of every table in
  // scope reads as something a user turned off by hand.
  if (row.isTableOwn || row.inTable) {
    if (row.surfaced > 0) return 'ok';
    return 'in-table';
  }

  // The Rem's OWN DisableCards powerup is not an ancestor problem — it is the
  // other face of the Enable-Cards switch (CARD_STATE_REFERENCE.md lists them
  // as one state), so it is fixable from here and classified as such.
  if (!row.enablePractice || row.disableCardsOwn) return 'practice-off';
  if (row.practiceDirection === 'none') return 'direction-none';

  if (row.surfaced > 0) {
    return row.pausedAncestorId ? 'in-paused-deck' : 'ok';
  }

  if (row.pausedAncestorId) return 'in-paused-deck';
  return 'not-surfaced';
}
