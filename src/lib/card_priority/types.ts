import { RemId } from '@remnote/plugin-sdk';
import { IncrementalRem } from '../incremental_rem';

export const CARD_PRIORITY_CODE = 'cardPriority';
/**
 * The ORIGINAL, VISIBLE priority slot. Still read (and, before the hidden-slot
 * migration, still written) but no longer the slot new values belong in — a
 * visible slot materialises a property CHILD rem on every tagged rem, and a
 * tagged rem that is itself a table cell then renders that child instead of its
 * own value. See lib/card_priority/slot_access.ts.
 */
export const PRIORITY_SLOT = 'priority';
/**
 * Where the priority value lives from v1.0.48 on: a HIDDEN slot, whose values
 * RemNote stores without creating a property child (confirmed in
 * lib/powerup_slot_compat.ts — a rem with hidden slots set can have zero
 * property children). Registered fresh, so unlike PRIORITY_SLOT it is hidden in
 * existing knowledge bases too: RemNote applies slot options when the slot
 * definition rem is created, and this code had no rem before.
 */
export const PRIORITY_VALUE_SLOT = 'priorityValue';
export const SOURCE_SLOT = 'prioritySource';
export const LAST_UPDATED_SLOT = 'lastUpdated';

export type PrioritySource = 'manual' | 'inherited' | 'default' | 'incremental';

export interface CardPriorityInfo {
  remId: string;
  priority: number;
  source: PrioritySource;
  lastUpdated: number;
  cardCount: number;
  dueCards: number;
  /** Count of cards with nextRepetitionTime <= start of today (user's local timezone).
   * Used exclusively by the priority shield to filter intraday scheduling noise. */
  dueCardsOverdue?: number;
  kbPercentile?: number;
  /**
   * Per-card nextRepetitionTime, length === cardCount, order arbitrary but stable.
   * `null` for disabled/never-scheduled cards (their `nextRepetitionTime` was null).
   * Used to expand the rem's CardPriorityInfo into per-card items for the Weighted
   * Shield of Cards so that buckets are formed by cards (not by rems-with-cards),
   * matching the Card Priority × Memory Analytics tab.
   */
  cardsNextRep?: (number | null)[];
}

/** Per-card item shape consumed by `calculateWeightedShield` and
 *  `computeWeightedShieldBreakdown` after expanding `CardPriorityInfo[]`. */
export interface PerCardShieldItem {
  /** The owning rem's inherited priority — every card from the same rem shares this value. */
  priority: number;
  /** Owning rem id (multiple items can share a remId — one per card on that rem). */
  remId: string;
  /** Card's own nextRepetitionTime; null/undefined for disabled or never-scheduled cards. */
  nextRepetitionTime?: number | null;
}

/**
 * Expand `CardPriorityInfo[]` (one entry per rem-with-cards) into per-card items
 * suitable for the Weighted Shield. Each card inherits its rem's priority; the
 * card's own `nextRepetitionTime` drives the due predicate. Rems with explicit
 * zero cards are skipped. If `cardsNextRep` is missing on a CardPriorityInfo
 * (cache from an older session), we degrade gracefully by emitting `cardCount`
 * synthetic items with the first `dueCards` of them stamped as due — preserves
 * the shield value approximately until the cache is rebuilt.
 */
/**
 * For a list of CardPriorityInfo (one entry per rem-with-cards), expand to a
 * per-card universe and compute each rem's effective percentile as the MEAN
 * percentile of its cards within that universe. Returns a `remId → percentile`
 * map (percentile in [0, 100], rounded to 1 decimal).
 *
 * Why mean: cards of the same rem share a single priority value and therefore
 * occupy adjacent indices in the sorted per-card list; their per-card
 * percentiles span a small contiguous range. The mean is the natural single
 * representative — it places the rem at the midpoint of its own card cluster
 * and respects the fact that a rem with N cards has more presence in the card
 * population than a rem with one card at the same priority.
 *
 * This unifies the percentile universe used by the Weighted Shield, the
 * standard Priority Shield, the `kbPercentile` shown next to a rem's priority,
 * and the Priority Review Document — all consume the same card-based ranking.
 */
export function calculateCardRemPercentilesFromCards(
  infos: CardPriorityInfo[],
): Record<string, number> {
  if (!infos || infos.length === 0) return {};
  const items = expandCardInfosToCards(infos);
  if (items.length === 0) return {};

  // Stable sort by priority. Items at the same priority keep their input
  // order, which is the iteration order of `expandCardInfosToCards` — that
  // groups a rem's cards together. Mean-rank is invariant to intra-tie order,
  // so this is safe.
  const sorted = [...items].sort((a, b) => a.priority - b.priority);
  const N = sorted.length;

  // Accumulate (sum of 1-based ranks, count) per rem.
  const acc = new Map<string, { sum: number; count: number }>();
  for (let i = 0; i < N; i++) {
    const remId = sorted[i].remId;
    const rank = i + 1;
    const cur = acc.get(remId);
    if (cur) {
      cur.sum += rank;
      cur.count += 1;
    } else {
      acc.set(remId, { sum: rank, count: 1 });
    }
  }

  const out: Record<string, number> = {};
  for (const [remId, { sum, count }] of acc) {
    const meanRank = sum / count;
    out[remId] = Math.round((meanRank / N) * 1000) / 10; // 1 decimal
  }

  // Inheritance-only rems (cardCount === 0) own no cards, so they never appear
  // in the per-card universe above and receive no mean-rank. They still carry a
  // priority and need a representative percentile for their badge color (and any
  // other kbPercentile consumer). Place each at the rank a hypothetical card at
  // its priority would occupy — the midpoint of the equal-priority band in the
  // sorted per-card list — so the value stays inside the SAME per-card universe
  // as every rem that does own cards. Without this they fell through to a `?? 0`
  // default at the cache layer and rendered as top-priority (red), disagreeing
  // with the Priority popup's relative percentile. We intentionally do NOT emit
  // fake cards for them (that would corrupt shields / counts) — this is a pure
  // read-out of where their priority slots into the existing card population.
  const sortedPriorities = sorted.map((s) => s.priority);
  for (const info of infos) {
    if (!info || info.cardCount !== 0) continue;
    if (out[info.remId] !== undefined) continue; // defensive: already ranked
    const lo = lowerBoundIdx(sortedPriorities, info.priority); // # cards with priority < p
    const hi = upperBoundIdx(sortedPriorities, info.priority); // # cards with priority <= p
    const representativeRank = (lo + hi + 1) / 2; // 1-based midpoint of the insertion band
    out[info.remId] = Math.round((representativeRank / N) * 1000) / 10;
  }

  return out;
}

// Count of elements strictly less than `target` in an ascending-sorted array.
function lowerBoundIdx(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Count of elements less than or equal to `target` in an ascending-sorted array.
function upperBoundIdx(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function expandCardInfosToCards(infos: CardPriorityInfo[]): PerCardShieldItem[] {
  const out: PerCardShieldItem[] = [];
  for (const info of infos) {
    if (!info || info.cardCount === 0) continue;
    if (info.cardsNextRep && info.cardsNextRep.length > 0) {
      for (const nextRep of info.cardsNextRep) {
        out.push({ priority: info.priority, remId: info.remId, nextRepetitionTime: nextRep });
      }
    } else {
      // Fallback for stale caches: synthesize one item per card. We can't tell
      // which card is which, so we mark the first `dueCards` as due (in the past)
      // and the rest as not due (far future). The shield value will be close to
      // the new per-card semantics within a single cache refresh.
      const dueCount = Math.min(info.dueCards ?? 0, info.cardCount);
      for (let i = 0; i < info.cardCount; i++) {
        out.push({
          priority: info.priority,
          remId: info.remId,
          nextRepetitionTime: i < dueCount ? 0 : null,
        });
      }
    }
  }
  return out;
}

export interface QueueSessionCache {
  /**
   * A map of RemID -> document-level percentile.
   * Pre-calculated for every card in the current document scope.
   * Allows for an instant lookup of the "X% of Doc" value.
   */
  docPercentiles: Record<RemId, number>;

  /**
   * A pre-filtered list of all due cards that are part of the current document/folder.
   * Used for the fast Document Shield calculation.
   */
  dueCardsInScope: CardPriorityInfo[];

  /**
   * A pre-filtered list of all due cards from the entire Knowledge Base.
   * Used for the fast KB Shield calculation.
   */
  dueCardsInKB: CardPriorityInfo[];

  /**
   * A pre-filtered list of cards due before the start of today (user timezone).
   * Used exclusively by the card priority shield to filter intraday scheduling noise.
   */
  overdueCardsInKB?: CardPriorityInfo[];

  /**
   * Same as overdueCardsInKB but scoped to the current document/folder.
   */
  overdueCardsInScope?: CardPriorityInfo[];

  /**
   * A pre-filtered list of all due Incremental Rems in the document scope.
   * Used for the fast Incremental Rem Document Shield.
   */
  dueIncRemsInScope: IncrementalRem[];

  /**
   * A pre-filtered list of all due Incremental Rems in the entire KB.
   * Used for the fast Incremental Rem KB Shield.
   */
  dueIncRemsInKB: IncrementalRem[];

  /**
   * A map of RemID -> document-level percentile for Incremental Rems.
   * Pre-calculated for every IncRem in the current document scope.
   */
  incRemDocPercentiles: Record<RemId, number>;

  /**
   * Pre-computed weighted shield value for cards at KB scope.
   * null when not enabled or not yet computed.
   */
  weightedShieldCardKB?: number | null;

  /**
   * Pre-computed weighted shield value for cards at document scope.
   * null when not enabled or not yet computed.
   */
  weightedShieldCardDoc?: number | null;

  /**
   * Pre-computed weighted shield value for IncRems at KB scope.
   * null when not enabled or not yet computed.
   */
  weightedShieldIncRemKB?: number | null;

  /**
   * Pre-computed weighted shield value for IncRems at document scope.
   * null when not enabled or not yet computed.
   */
  weightedShieldIncRemDoc?: number | null;
}
