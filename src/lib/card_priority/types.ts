import { RemId } from '@remnote/plugin-sdk';
import { IncrementalRem } from '../incremental_rem';

export const CARD_PRIORITY_CODE = 'cardPriority';
export const PRIORITY_SLOT = 'priority';
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
  return out;
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
