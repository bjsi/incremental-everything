/**
 * The unified priority scale for EDITOR colours: IncRems and cards ranked
 * together, the universe of the Priority Shield (see unified_shield.ts) —
 * one element per IncRem and one per scheduled card, dismissed Rems out
 * (they are not in the IncRem cache), inheritance-only Rems out (no cards).
 *
 * The editor badge (priority_editor) and the priority bands (tables, PDF
 * highlights) colour every priority on this one scale, so the same number has
 * the same colour whether it sits on an IncRem or a flashcard. The queue keeps
 * its own scales: the flashcard bar and the queue toolbar rank a card against
 * cards, an IncRem against IncRems.
 *
 * A percentile here is a function of the priority value alone (midpoint of the
 * ties), so it needs no per-Rem lookup: a histogram is enough, and building one
 * is a single pass with no sort. Pure: runs under the ts-node tests.
 */

/** The card fields the ranking needs (a subset of CardPriorityInfo). */
export type UnifiedCardInfo = {
  priority: number;
  cardCount?: number;
  cardsNextRep?: (number | null)[] | null;
};

export interface UnifiedRanking {
  /** IncRems + scheduled cards. */
  total: number;
  /** Distinct priorities, ascending. */
  keys: number[];
  /** prefix[i] = elements with priority < keys[i]. */
  prefix: number[];
  counts: number[];
}

/**
 * Scheduled cards of one Rem, the way expandCardInfosToCards counts them:
 * unscheduled (null) cards are not practised and take no part in the ranking;
 * a cache without per-card dates falls back to cardCount.
 */
export function scheduledCardCount(info: UnifiedCardInfo): number {
  if (!info || !info.cardCount) return 0;
  const reps = info.cardsNextRep;
  if (reps && reps.length > 0) {
    let n = 0;
    for (const r of reps) if (r !== null && r !== undefined) n++;
    return n;
  }
  return info.cardCount;
}

export function buildUnifiedRanking(
  incRems: ReadonlyArray<{ priority?: number }>,
  cardInfos: ReadonlyArray<UnifiedCardInfo>
): UnifiedRanking {
  const byPriority = new Map<number, number>();
  const add = (p: number, n: number) => byPriority.set(p, (byPriority.get(p) ?? 0) + n);
  for (const r of incRems) {
    if (typeof r?.priority === 'number' && !isNaN(r.priority)) add(r.priority, 1);
  }
  for (const c of cardInfos) {
    if (typeof c?.priority !== 'number' || isNaN(c.priority)) continue;
    const n = scheduledCardCount(c);
    if (n > 0) add(c.priority, n);
  }
  const keys = [...byPriority.keys()].sort((a, b) => a - b);
  const counts = keys.map((k) => byPriority.get(k)!);
  const prefix: number[] = new Array(keys.length);
  let run = 0;
  for (let i = 0; i < keys.length; i++) {
    prefix[i] = run;
    run += counts[i];
  }
  return { total: run, keys, prefix, counts };
}

/**
 * Percentile (0–100, one decimal) of a priority on the unified scale: the
 * midpoint of the ranks its ties occupy, like estimateCardRemPercentile. A
 * priority nobody holds (just edited, cache not caught up) lands between its
 * neighbours. Null for an empty universe.
 */
export function unifiedPercentileAt(ranking: UnifiedRanking, priority: number): number | null {
  if (ranking.total === 0) return null;
  const { keys, prefix, counts } = ranking;
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < priority) lo = mid + 1;
    else hi = mid;
  }
  const below = lo < keys.length ? prefix[lo] : ranking.total;
  const equal = lo < keys.length && keys[lo] === priority ? counts[lo] : 0;
  const rank = below + (equal + 1) / 2;
  return Math.round(Math.min(100, (rank / ranking.total) * 100) * 10) / 10;
}

/**
 * The ranking for a pair of cache arrays, built once per cache version: a cache
 * write is a new array, so identity is a safe key and it never goes stale.
 */
const rankingCache = new WeakMap<object, WeakMap<object, UnifiedRanking>>();
export function unifiedRankingFor(
  incRems: ReadonlyArray<{ priority?: number }>,
  cardInfos: ReadonlyArray<UnifiedCardInfo>
): UnifiedRanking {
  let inner = rankingCache.get(incRems);
  if (!inner) {
    inner = new WeakMap();
    rankingCache.set(incRems, inner);
  }
  let ranking = inner.get(cardInfos);
  if (!ranking) {
    ranking = buildUnifiedRanking(incRems, cardInfos);
    inner.set(cardInfos, ranking);
  }
  return ranking;
}
