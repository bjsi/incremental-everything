import { RNPlugin, PluginRem, RemId } from '@remnote/plugin-sdk';
import { allIncrementalRemKey } from '../consts';
import { IncrementalRem } from '../incremental_rem';
import { repCountsForStats } from '../incremental_rem/types';
import { hasCardClusterPowerup } from './cluster';
import {
  CardLike,
  CoolingCandidate,
  CoolingOverrides,
  CoolingParams,
  CoolingVerdict,
  DEFAULT_COOLING_PARAMS,
  SpoilerSeenEvent,
  cardIntervalDays,
  cardLastSeenAt,
  evaluateCooling,
  isCardDue,
} from './cooling';
import { getCoolingParams, mergeCoolingCache, readCoolingOverrides } from './cooling_store';

/**
 * Turns RemNote data into the plain facts the cooling engine judges.
 *
 * COST MODEL. One `card.getAll()` answers every card question for every
 * candidate — due-ness, last viewing, interval — as map lookups; the clean
 * command already pays this read and it is the cheap part. Tree reads are the
 * only per-candidate cost and they are bounded by the candidate list, never by
 * the KB: a candidate's parent, its siblings, its children and grandchildren,
 * fetched with `findMany` in a few batches and memoised across candidates that
 * share them (siblings share a parent; a descriptor tree shares whole rows).
 * Candidates are processed in small concurrent windows so wall time is a few
 * round-trips deep regardless of how many there are. Measured: 200 candidates
 * in 1.5s on a 45k-rem KB.
 *
 * The scanner is an OBJECT so one refresh can pay the whole-KB read once and
 * then ask about Rems incrementally — the document's entries first, then the
 * refill candidates, then any ancestor the spoiler swap wants to pull in.
 *
 * MEMBERSHIP. Alt+Z clozes are identified by the `cloze-extract` tag's own
 * member list, read once. That list is known to under-report for BUILT-IN
 * powerups (lib/empty_ecd_scan.ts), but `cloze-extract` is a plain Rem tag the
 * plugin creates itself, and the debug "Probe Spoiler State" cross-check found
 * the two sources agreeing on it. The clean command reads INC/FC the same way.
 *
 * CLUSTERS. Children of a Card Cluster are designed to be shown together, and
 * RemNote's own bury rule treats the selected cluster as one unit; so a cluster
 * parent contributes no sibling events, and a cluster parent's own children
 * contribute no descendant events.
 */

export interface CoolingScanOptions {
  now?: number;
  params?: CoolingParams;
  /** Recorded on the cache so the UI can say which scope it describes. */
  scopeRemId?: RemId | null;
  /** Priority per candidate, when the caller has it; copied onto the verdicts. */
  priorityByRemId?: Map<RemId, number>;
  /** Keep the raw candidates (every seen event) — for probes. */
  includeCandidates?: boolean;
}

export interface CoolingScanResult {
  verdicts: CoolingVerdict[];
  /** Candidates examined. */
  checked: number;
  /** Candidates that actually owed a card (the rest cannot cool). */
  withDueCards: number;
  /** Parents / candidates skipped as Card Clusters. */
  clustersSkipped: number;
  candidates?: CoolingCandidate[];
  elapsedMs: number;
}

const WINDOW = 8;

/** Local, allocation-only text for labels — same trade as clean.ts. */
function flattenText(text: unknown): string {
  if (!Array.isArray(text)) return '';
  return text
    .map((el) => {
      if (typeof el === 'string') return el;
      if (el && typeof el === 'object' && 'text' in el && typeof (el as any).text === 'string') {
        return (el as any).text;
      }
      return '';
    })
    .join('')
    .trim();
}

/** Memoising Rem reader: one findMany per batch of misses. */
class RemReader {
  private cache = new Map<RemId, PluginRem | null>();
  constructor(private plugin: RNPlugin) {}

  async many(ids: RemId[]): Promise<Map<RemId, PluginRem>> {
    const unique = [...new Set(ids.filter(Boolean))];
    const misses = unique.filter((id) => !this.cache.has(id));
    if (misses.length) {
      try {
        const found = (await this.plugin.rem.findMany(misses)) || [];
        for (const r of found) this.cache.set(r._id, r);
      } catch (e) {
        console.warn('[Cooling] findMany failed:', e);
      }
      for (const id of misses) if (!this.cache.has(id)) this.cache.set(id, null);
    }
    const out = new Map<RemId, PluginRem>();
    for (const id of unique) {
      const r = this.cache.get(id);
      if (r) out.set(id, r);
    }
    return out;
  }

  async one(id: RemId): Promise<PluginRem | null> {
    return (await this.many([id])).get(id) ?? null;
  }
}

/** Last date the IncRem was actually read, from the plugin's own history. */
function incRemLastReadAt(inc: IncrementalRem | undefined): number | null {
  if (!inc?.history?.length) return null;
  let last: number | null = null;
  for (const rep of inc.history) {
    if (!repCountsForStats(rep.eventType)) continue;
    if (typeof rep.date !== 'number') continue;
    if (last === null || rep.date > last) last = rep.date;
  }
  return last;
}

export class CoolingScanner {
  readonly now: number;
  /** Set on load: the explicit option, else the IE settings, else the defaults. */
  params: CoolingParams;
  /** Every Rem this scanner has judged, cooling or not. */
  readonly checkedIds = new Set<RemId>();
  /** Verdicts by Rem, for the Rems found cooling. */
  readonly verdicts = new Map<RemId, CoolingVerdict>();
  readonly candidates: CoolingCandidate[] = [];
  withDueCards = 0;
  clustersSkipped = 0;

  private readonly reader: RemReader;
  private readonly clusterCache = new Map<RemId, boolean>();
  private loaded: Promise<void> | null = null;
  private cardsByRem = new Map<RemId, CardLike[]>();
  private incByRem = new Map<RemId, IncrementalRem>();
  private clozeExtractIds = new Set<RemId>();
  private overrides: CoolingOverrides = { released: {}, extended: {}, never: [] };

  constructor(private readonly plugin: RNPlugin, private readonly options: CoolingScanOptions = {}) {
    this.now = options.now ?? Date.now();
    this.params = options.params ?? DEFAULT_COOLING_PARAMS;
    this.reader = new RemReader(plugin);
  }

  /** The whole-KB reads, paid once per scanner, on first use. */
  private load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const [allCards, overrides, allIncRems, clozeExtractTag, params] = await Promise.all([
          this.plugin.card.getAll().catch((e) => {
            console.error('[Cooling] card.getAll failed:', e);
            return [] as CardLike[];
          }),
          readCoolingOverrides(this.plugin),
          this.plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey).then((v) => v || []),
          this.plugin.rem.findByName(['cloze-extract'], null).catch(() => null),
          this.options.params ? Promise.resolve(this.options.params) : getCoolingParams(this.plugin),
        ]);
        this.params = params;
        for (const card of allCards as any[]) {
          const owner = card.remId as RemId | undefined;
          if (!owner) continue;
          const list = this.cardsByRem.get(owner);
          if (list) list.push(card);
          else this.cardsByRem.set(owner, [card]);
        }
        this.incByRem = new Map(allIncRems.map((r) => [r.remId, r]));
        this.overrides = overrides;
        if (clozeExtractTag) {
          try {
            this.clozeExtractIds = new Set(
              ((await clozeExtractTag.taggedRem()) || []).map((r) => r._id)
            );
          } catch (e) {
            console.warn('[Cooling] cloze-extract member list unavailable:', e);
          }
        }
      })();
    }
    return this.loaded;
  }

  private async isCluster(rem: PluginRem): Promise<boolean> {
    const cached = this.clusterCache.get(rem._id);
    if (cached !== undefined) return cached;
    const result = await hasCardClusterPowerup(this.plugin, rem);
    this.clusterCache.set(rem._id, result);
    if (result) this.clustersSkipped++;
    return result;
  }

  /** Every viewing of a Rem's cards, flagged with whether the card is still due. */
  private seenEventsFor(
    ownerId: RemId,
    relation: SpoilerSeenEvent['relation'],
    label: string | undefined
  ): SpoilerSeenEvent[] {
    const events: SpoilerSeenEvent[] = [];
    for (const card of this.cardsByRem.get(ownerId) ?? []) {
      const seenAt = cardLastSeenAt(card);
      if (seenAt === null) continue;
      events.push({
        relation,
        sourceRemId: ownerId,
        sourceLabel: label,
        cardId: card._id,
        seenAt,
        stillDue: isCardDue(card, this.now),
      });
    }
    return events;
  }

  private async buildCandidate(remId: RemId): Promise<CoolingCandidate | null> {
    const own = this.cardsByRem.get(remId) ?? [];
    const dueCards = own.filter((c) => isCardDue(c, this.now));
    if (dueCards.length === 0) return null;

    const rem = await this.reader.one(remId);
    if (!rem) return null;
    const label = flattenText(rem.text) || undefined;

    const candidate: CoolingCandidate = {
      remId,
      label,
      priority: this.options.priorityByRemId?.get(remId),
      dueCards: dueCards.map((c) => ({ cardId: c._id, intervalDays: cardIntervalDays(c) })),
      seen: [],
    };

    // 1. Other cards of the same Rem.
    for (const card of own) {
      if (isCardDue(card, this.now)) continue;
      const seenAt = cardLastSeenAt(card);
      if (seenAt === null) continue;
      candidate.seen.push({
        relation: 'same-rem',
        sourceRemId: remId,
        sourceLabel: label,
        cardId: card._id,
        seenAt,
        stillDue: false,
      });
    }

    // 2. Cloze siblings and the parent extract — only when this Rem IS an Alt+Z
    //    cloze, since only then is its content the parent's sentence.
    const parentId = (rem.parent as RemId | undefined) ?? null;
    if (parentId && this.clozeExtractIds.has(remId)) {
      const parent = await this.reader.one(parentId);
      if (parent && !(await this.isCluster(parent))) {
        const parentLabel = flattenText(parent.text) || undefined;
        const siblingIds = ((parent.children as RemId[] | undefined) ?? []).filter(
          (id) => id !== remId && this.clozeExtractIds.has(id)
        );
        const siblings = await this.reader.many(siblingIds);
        for (const [sibId, sib] of siblings) {
          candidate.seen.push(
            ...this.seenEventsFor(sibId, 'cloze-sibling', flattenText(sib.text) || undefined)
          );
        }
        candidate.seen.push(...this.seenEventsFor(parentId, 'parent-extract', parentLabel));
        const readAt = incRemLastReadAt(this.incByRem.get(parentId));
        if (readAt !== null) {
          candidate.seen.push({
            relation: 'parent-extract',
            sourceRemId: parentId,
            sourceLabel: parentLabel,
            seenAt: readAt,
            // An IncRem read is not a card and never "stays due" in the sense
            // that matters here: the queue's own spoiler gate holds the parent
            // extract back while these clozes are due, so treat the read as done.
            stillDue: false,
          });
        }
      }
    }

    // 3 & 4. Own Alt+Z clozes, and descendant cards two levels down.
    if (!(await this.isCluster(rem))) {
      const childIds = (rem.children as RemId[] | undefined) ?? [];
      const children = await this.reader.many(childIds);
      const grandchildIds: RemId[] = [];
      for (const [childId, child] of children) {
        const childLabel = flattenText(child.text) || undefined;
        const relation = this.clozeExtractIds.has(childId) ? 'own-cloze-child' : 'descendant';
        candidate.seen.push(...this.seenEventsFor(childId, relation, childLabel));
        grandchildIds.push(...((child.children as RemId[] | undefined) ?? []));
      }
      const grandchildren = await this.reader.many(grandchildIds);
      for (const [gcId, gc] of grandchildren) {
        candidate.seen.push(
          ...this.seenEventsFor(gcId, 'descendant', flattenText(gc.text) || undefined)
        );
      }
    }

    return candidate;
  }

  /**
   * Judges the given Rems (skipping any already judged by this scanner) and
   * returns the verdicts for the ones found cooling among them.
   */
  async scan(remIds: RemId[]): Promise<CoolingVerdict[]> {
    await this.load();
    const ids = [...new Set(remIds)].filter((id) => id && !this.checkedIds.has(id));
    const found: CoolingVerdict[] = [];
    for (let i = 0; i < ids.length; i += WINDOW) {
      const window = ids.slice(i, i + WINDOW);
      const built = await Promise.all(
        window.map((id) =>
          this.buildCandidate(id).catch((e) => {
            console.warn(`[Cooling] candidate ${id} failed, treated as not cooling:`, e);
            return null;
          })
        )
      );
      window.forEach((id, idx) => {
        this.checkedIds.add(id);
        const candidate = built[idx];
        if (!candidate) return;
        this.withDueCards++;
        if (this.options.includeCandidates) this.candidates.push(candidate);
        const verdict = evaluateCooling(candidate, this.now, this.params, this.overrides);
        if (verdict) {
          this.verdicts.set(id, verdict);
          found.push(verdict);
        }
      });
    }
    return found;
  }

  /** One Rem, lazily — used for ancestors the spoiler swap wants to pull in. */
  async verdictFor(remId: RemId): Promise<CoolingVerdict | null> {
    if (!this.checkedIds.has(remId)) await this.scan([remId]);
    return this.verdicts.get(remId) ?? null;
  }

  isCooling(remId: RemId): boolean {
    return this.verdicts.has(remId);
  }

  coolingIds(): Set<RemId> {
    return new Set(this.verdicts.keys());
  }

  sortedVerdicts(): CoolingVerdict[] {
    return [...this.verdicts.values()].sort(
      (a, b) => (a.priority ?? 101) - (b.priority ?? 101) || a.until - b.until
    );
  }

  /**
   * Merges what this scanner learned into the session cache the shields read:
   * Rems it judged replace their old entries (cooling or not), Rems it never
   * looked at keep theirs until they expire.
   */
  async publish(): Promise<void> {
    await mergeCoolingCache(this.plugin, {
      computedAt: this.now,
      scopeRemId: this.options.scopeRemId ?? null,
      checkedIds: this.checkedIds,
      verdicts: this.sortedVerdicts(),
    });
  }
}

/**
 * One-shot convenience: scan the given Rems and, unless `dryRun`, publish.
 */
export async function scanCooling(
  plugin: RNPlugin,
  candidateRemIds: RemId[],
  options: CoolingScanOptions & { dryRun?: boolean } = {}
): Promise<CoolingScanResult> {
  const startedAt = Date.now();
  const scanner = new CoolingScanner(plugin, options);
  await scanner.scan(candidateRemIds);
  if (!options.dryRun) await scanner.publish();
  const verdicts = scanner.sortedVerdicts();
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[Cooling] ${verdicts.length} cooling of ${scanner.withDueCards} with due cards ` +
      `(${scanner.checkedIds.size} checked, ${scanner.clustersSkipped} clusters skipped) in ${elapsedMs}ms` +
      (options.dryRun ? ' [dry run]' : '')
  );
  return {
    verdicts,
    checked: scanner.checkedIds.size,
    withDueCards: scanner.withDueCards,
    clustersSkipped: scanner.clustersSkipped,
    candidates: options.includeCandidates ? scanner.candidates : undefined,
    elapsedMs,
  };
}
