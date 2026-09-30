import { RNPlugin, PluginRem, RemId } from '@remnote/plugin-sdk';
import { allIncrementalRemKey, allCardPriorityInfoKey } from '../consts';
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
  isBackwardCard,
  isCardDue,
  isImageOcclusionText,
  isRecentlyCreatedUnseen,
  pickConceptAncestor,
  REM_TYPE_DESCRIPTOR,
  withoutOwnSightings,
} from './cooling';
import { getCoolingParams, HeldByCoolingAncestor, mergeCoolingCache, readCoolingOverrides } from './cooling_store';
import { getCardPriorityValue } from '../card_priority';
import type { CardPriorityInfo } from '../card_priority/types';
import { readChildren } from './children';
import { isAnswerLine } from './multiline';
import { CardSource, loadCardSource } from './card_source';

/**
 * Turns RemNote data into the plain facts the cooling engine judges.
 *
 * COST MODEL. Every card question for every candidate — due-ness, last
 * viewing, interval — is a map lookup into one card source (card_source.ts):
 * the card cache in Full Mode, which costs no read at all, or a single
 * `card.getAll()` when there is no cache, shared with the rest of the refresh. Tree reads are the
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
 *
 * MULTI-LINE CARDS. A candidate whose children include answer lines (card
 * items, multiline.ts) takes events from those children only, as
 * `answer-line`, plus an `answer-line-due` hold for each one still due — the
 * inverted order: answer lines first, the multi-line card after them. And the
 * other way round, for a multi-line card reviewed first anyway: an answer line
 * takes `multi-line-card` events from its parent. Card-item membership costs
 * one probe per child that has cards (or carded children), and per candidate
 * whose parent has cards, memoised.
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
  /**
   * Card facts to judge with. Omitted, the scanner loads its own: the card cache
   * in Full Mode, one card.getAll() otherwise (see card_source.ts). A refresh
   * passes the source it already loaded so the drain, cooling and selection
   * share a single read.
   */
  cardSource?: CardSource;
  /**
   * Judge as cooling any Rem that was cooling at some moment since this instant
   * (see evaluateCooling). Only the shield's scan sets it, to the start of the
   * local day; its verdicts may then have an `until` in the past.
   */
  since?: number;
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
/** How far up a chain of nested descriptors the concept is looked for. */
const MAX_CONCEPT_WALK = 8;

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

  private childCache = new Map<RemId, Promise<PluginRem[]>>();

  /**
   * A Rem's children, through getChildrenRem — never the lazy `children` field,
   * which is empty for documents not opened this session (see children.ts) and
   * would silently hide every sibling and descendant spoiler in them. Memoised:
   * siblings share a parent, and a descriptor tree shares whole rows.
   */
  childrenOf(rem: PluginRem): Promise<PluginRem[]> {
    let pending = this.childCache.get(rem._id);
    if (!pending) {
      pending = readChildren(this.plugin, rem).then((kids) => {
        for (const k of kids) if (!this.cache.has(k._id)) this.cache.set(k._id, k);
        return kids;
      });
      this.childCache.set(rem._id, pending);
    }
    return pending;
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
  /** The clock verdicts are judged at. Moves forward on {@link refresh}. */
  now: number;
  /** Set on load: the explicit option, else the IE settings, else the defaults. */
  params: CoolingParams;
  /** Every Rem this scanner has judged, cooling or not. */
  readonly checkedIds = new Set<RemId>();
  /** Verdicts by Rem, for the Rems found cooling. */
  readonly verdicts = new Map<RemId, CoolingVerdict>();
  readonly candidates: CoolingCandidate[] = [];
  /** The candidate behind each verdict, so one card's view of it needs no read. */
  private readonly candidateByRem = new Map<RemId, CoolingCandidate>();
  withDueCards = 0;
  clustersSkipped = 0;

  private readonly reader: RemReader;
  private readonly clusterCache = new Map<RemId, boolean>();
  /** Card-item membership, memoised: siblings share a parent, candidates share children. */
  private readonly answerLineCache = new Map<RemId, Promise<boolean>>();
  private loaded: Promise<void> | null = null;
  private cardsByRem = new Map<RemId, CardLike[]>();
  private incByRem = new Map<RemId, IncrementalRem>();
  private clozeExtractIds = new Set<RemId>();
  private overrides: CoolingOverrides = { released: {}, extended: {}, never: [] };
  /**
   * Priority per Rem for the verdicts. The caller's map when given; otherwise the
   * card cache's, so a scan that was not handed one (the Priority Queue refresh)
   * no longer publishes `P?`. Anything still missing is read per verdict in
   * {@link publish} — bounded by how many Rems are cooling, never by the KB.
   */
  private priorityByRemId = new Map<RemId, number>();

  constructor(private readonly plugin: RNPlugin, private readonly options: CoolingScanOptions = {}) {
    this.now = options.now ?? Date.now();
    this.params = options.params ?? DEFAULT_COOLING_PARAMS;
    this.reader = new RemReader(plugin);
  }

  /** The whole-KB reads, paid once per scanner, on first use. */
  private load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const [source, overrides, allIncRems, clozeExtractTag, params] = await Promise.all([
          this.options.cardSource ? Promise.resolve(this.options.cardSource) : loadCardSource(this.plugin),
          readCoolingOverrides(this.plugin),
          this.plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey).then((v) => v || []),
          this.plugin.rem.findByName(['cloze-extract'], null).catch(() => null),
          this.options.params ? Promise.resolve(this.options.params) : getCoolingParams(this.plugin),
        ]);
        this.params = params;
        this.cardsByRem = source.cardsByRem;
        if (this.options.priorityByRemId) {
          this.priorityByRemId = this.options.priorityByRemId;
        } else {
          const infos =
            (await this.plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey).catch(() => null)) || [];
          this.priorityByRemId = new Map(infos.map((i) => [i.remId, i.priority]));
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

  private isAnswerLine(rem: PluginRem): Promise<boolean> {
    let pending = this.answerLineCache.get(rem._id);
    if (!pending) {
      pending = isAnswerLine(rem);
      this.answerLineCache.set(rem._id, pending);
    }
    return pending;
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
    if (isImageOcclusionText(rem.text, rem.backText)) return null;
    const label = flattenText(rem.text) || undefined;

    const candidate: CoolingCandidate = {
      remId,
      label,
      priority: this.priorityByRemId.get(remId),
      dueCards: dueCards.map((c) => ({ cardId: c._id, intervalDays: cardIntervalDays(c) })),
      seen: [],
    };

    // 0. A due card of this Rem that was just created and never shown. Its own
    //    fixed window (the new-card setting), counted from the card's creation —
    //    the card's, never the Rem's, which can be younger than its cards.
    const newCardDays = this.params.newCardDays ?? 0;
    if (newCardDays > 0) {
      for (const card of dueCards) {
        if (!isRecentlyCreatedUnseen(card, this.now, newCardDays)) continue;
        candidate.seen.push({
          relation: 'just-created',
          sourceRemId: remId,
          sourceLabel: label,
          cardId: card._id,
          seenAt: card.createdAt as number,
          // The card is due by definition; the rule is about the card itself.
          stillDue: false,
          windowDays: newCardDays,
        });
      }
    }

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

    // 1b. The concept, for a descriptor's backward card. That card shows the
    //     descriptor and asks for the concept it belongs to — the nearest
    //     ancestor that is not itself a descriptor, which is a grandparent or
    //     higher when descriptors are nested. Any card of that concept being
    //     shown (forward, backward, or a cloze inside it) puts the answer on
    //     screen. RemNote's own bury pairs a descriptor's backward card with its
    //     parent for an hour; this follows the chain and lasts the window.
    const parentForConcept = (rem.parent as RemId | undefined) ?? null;
    if (
      parentForConcept &&
      (rem as any).type === REM_TYPE_DESCRIPTOR &&
      dueCards.some((c) => isBackwardCard(c))
    ) {
      const chain: { _id: RemId; type?: number | null }[] = [];
      let cursor: RemId | null = parentForConcept;
      for (let depth = 0; cursor && depth < MAX_CONCEPT_WALK; depth++) {
        const ancestor: PluginRem | null = await this.reader.one(cursor);
        if (!ancestor) break;
        chain.push({ _id: ancestor._id, type: (ancestor as any).type ?? null });
        if ((ancestor as any).type !== REM_TYPE_DESCRIPTOR) break;
        cursor = (ancestor.parent as RemId | undefined) ?? null;
      }
      const conceptId = pickConceptAncestor(chain);
      if (conceptId) {
        const concept = await this.reader.one(conceptId);
        candidate.seen.push(
          ...this.seenEventsFor(conceptId, 'concept-reviewed', flattenText(concept?.text) || undefined)
        );
      }
    }

    // 1c. Its multi-line card, when this Rem is one of its answer lines: that
    //     card's back shows the line in full. Probed only when the parent has
    //     cards at all, so most Rems cost nothing here.
    const lineParentId = (rem.parent as RemId | undefined) ?? null;
    if (lineParentId && (this.cardsByRem.get(lineParentId)?.length ?? 0) > 0 && (await this.isAnswerLine(rem))) {
      const multiLine = await this.reader.one(lineParentId);
      if (multiLine && !(await this.isCluster(multiLine))) {
        candidate.seen.push(
          ...this.seenEventsFor(lineParentId, 'multi-line-card', flattenText(multiLine.text) || undefined)
        );
      }
    }

    // 2. Cloze siblings and the parent extract — only when this Rem IS an Alt+Z
    //    cloze, since only then is its content the parent's sentence.
    const parentId = (rem.parent as RemId | undefined) ?? null;
    if (parentId && this.clozeExtractIds.has(remId)) {
      const parent = await this.reader.one(parentId);
      if (parent && !(await this.isCluster(parent))) {
        const parentLabel = flattenText(parent.text) || undefined;
        const siblings = (await this.reader.childrenOf(parent)).filter(
          (s) => s._id !== remId && this.clozeExtractIds.has(s._id)
        );
        for (const sib of siblings) {
          candidate.seen.push(
            ...this.seenEventsFor(sib._id, 'cloze-sibling', flattenText(sib.text) || undefined)
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
      const children = await this.reader.childrenOf(rem);
      // Every child's own children, read concurrently — one call per child,
      // memoised across candidates that share them.
      const grandchildLists = await Promise.all(children.map((c) => this.reader.childrenOf(c)));

      // A multi-line card: some children are its answer lines (multiline.ts).
      // Only children that could produce an event are asked — those with cards,
      // or with children that have cards — so a Rem with none costs no probe.
      const hasCards = (id: RemId) => (this.cardsByRem.get(id)?.length ?? 0) > 0;
      const answerLines = new Set<RemId>();
      await Promise.all(
        children.map(async (child, i) => {
          if (!hasCards(child._id) && !grandchildLists[i].some((gc) => hasCards(gc._id))) return;
          if (await this.isAnswerLine(child)) answerLines.add(child._id);
        })
      );
      const multiLine = answerLines.size > 0;

      const grandchildrenSeen = new Set<RemId>();
      children.forEach((child, i) => {
        // The other children of a multi-line card show only its question as
        // context, never its answer: they neither cool it nor hold it.
        if (multiLine && !answerLines.has(child._id)) return;
        const childLabel = flattenText(child.text) || undefined;
        const relation = this.clozeExtractIds.has(child._id)
          ? 'own-cloze-child'
          : multiLine
            ? 'answer-line'
            : 'descendant';
        candidate.seen.push(...this.seenEventsFor(child._id, relation, childLabel));

        // An answer line still due goes first: the multi-line card is held
        // until it has been reviewed, and then cools from that review.
        if (multiLine) {
          const due = (this.cardsByRem.get(child._id) ?? []).filter((c) => isCardDue(c, this.now));
          if (due.length) {
            const first = due.reduce((a, b) =>
              (b.nextRepetitionTime ?? Infinity) < (a.nextRepetitionTime ?? Infinity) ? b : a
            );
            candidate.seen.push({
              relation: 'answer-line-due',
              sourceRemId: child._id,
              sourceLabel: childLabel,
              cardId: first._id,
              seenAt: first.nextRepetitionTime ?? this.now,
              stillDue: true,
              whileDue: true,
            });
          }
        }

        for (const gc of grandchildLists[i]) {
          if (grandchildrenSeen.has(gc._id)) continue;
          grandchildrenSeen.add(gc._id);
          candidate.seen.push(
            ...this.seenEventsFor(gc._id, 'descendant', flattenText(gc.text) || undefined)
          );
        }
      });
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
        const verdict = evaluateCooling(candidate, this.now, this.params, this.overrides, this.options.since);
        if (verdict) {
          this.verdicts.set(id, verdict);
          this.candidateByRem.set(id, candidate);
          found.push(verdict);
        }
      });
    }
    return found;
  }

  /**
   * Judges the given Rems again at the current time, from what the scanner has
   * already read — for a scanner kept open through a queue session
   * (queue_cooling_skip.ts), whose card facts change as cards are rated. The
   * tree reads are memoised, so Rems judged before cost no read at all.
   */
  async refresh(remIds: Iterable<RemId>): Promise<void> {
    await this.load();
    this.now = Date.now();
    const ids = [...remIds];
    for (const id of ids) {
      this.checkedIds.delete(id);
      this.verdicts.delete(id);
      this.candidateByRem.delete(id);
    }
    await this.scan(ids);
  }

  /** Replaces one Rem's card facts — after one of its cards was rated in the queue. */
  async updateCards(remId: RemId, cards: CardLike[]): Promise<void> {
    await this.load();
    this.cardsByRem.set(remId, cards);
  }

  /** One Rem's card facts as the scanner judges them. Empty before the facts are loaded. */
  cardsOf(remId: RemId): CardLike[] {
    return this.cardsByRem.get(remId) ?? [];
  }

  /** A Rem through the scanner's memo: no read once the Rem has been judged. */
  remOf(remId: RemId): Promise<PluginRem | null> {
    return this.reader.one(remId);
  }

  /** One Rem, lazily — used for ancestors the spoiler swap wants to pull in. */
  async verdictFor(remId: RemId): Promise<CoolingVerdict | null> {
    if (!this.checkedIds.has(remId)) await this.scan([remId]);
    return this.verdicts.get(remId) ?? null;
  }

  /**
   * The Rem's verdict as one of its cards sees it, from memory: a card never
   * spoils itself (see {@link withoutOwnSightings}). Null when that card's own
   * sightings were all that held the Rem.
   */
  verdictForCard(remId: RemId, cardId: string, now: number = Date.now()): CoolingVerdict | null {
    const verdict = this.verdicts.get(remId) ?? null;
    const candidate = this.candidateByRem.get(remId);
    if (!verdict || !candidate) return verdict;
    const own = withoutOwnSightings(candidate, cardId);
    if (own === candidate) return verdict;
    return evaluateCooling(own, now, this.params, this.overrides, this.options.since);
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
  /** The card facts this scanner judges with — shared so a caller need not load them twice. */
  async cardFacts(): Promise<Map<RemId, CardLike[]>> {
    await this.load();
    return this.cardsByRem;
  }

  /** Reads the priority of cooling Rems no map knew — Light Mode, or a Rem missing from the cache. */
  private async fillMissingPriorities(): Promise<void> {
    const missing = [...this.verdicts.values()].filter((v) => typeof v.priority !== 'number');
    if (missing.length === 0) return;
    const rems = await this.reader.many(missing.map((v) => v.remId));
    await Promise.all(
      missing.map(async (v) => {
        const rem = rems.get(v.remId);
        if (!rem) return;
        try {
          v.priority = await getCardPriorityValue(this.plugin, rem);
        } catch {
          /* stays unknown */
        }
      })
    );
  }

  async publish(extra?: { held?: HeldByCoolingAncestor[]; heldCheckedIds?: ReadonlySet<RemId> }): Promise<void> {
    await this.fillMissingPriorities();
    await mergeCoolingCache(this.plugin, {
      computedAt: this.now,
      since: this.options.since,
      scopeRemId: this.options.scopeRemId ?? null,
      checkedIds: this.checkedIds,
      verdicts: this.sortedVerdicts(),
      held: extra?.held,
      heldCheckedIds: extra?.heldCheckedIds,
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
