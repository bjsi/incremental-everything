/**
 * Pure shield math: no SDK imports, so the unit tests can load it under
 * ts-node. Re-exported from utils.ts for existing callers.
 */

/**
 * Calculates a "volume-aware" percentile rank for a priority shield.
 * Unlike standard percentile which depends on the exact position of a specific item,
 * this calculation treats all items with the same priority as a block.
 *
 * The rank is calculated as:
 * Rank = (Count of Higher Priority Items) + (Count of Non-Due Items with Same Priority)
 *
 * This ensures that as you complete items with the *same* priority, the shield naturally moves up.
 *
 * @param allItems The full list of items in the universe (KB or Doc scope).
 * @param topMissedPriority The priority value of the "top missed" item (the shield's current level).
 * @param isDuePredicate A function to determine if an item is currently "due" (unreviewed).
 * @returns A number from 1-100 representing the completion progress.
 */
export function calculateVolumeBasedPercentile<T extends { priority: number }>(
  allItems: T[],
  topMissedPriority: number,
  isDuePredicate: (item: T) => boolean
): number {
  if (!allItems || allItems.length === 0) {
    return 100; // Empty universe is considered complete/100%
  }

  // Pre-filter: Ignore rems that explicitly have 0 cards (e.g. Disabled Cards)
  // so they don't artificially inflate the completion metric.
  const validItems = allItems.filter((item: any) => item.cardCount === undefined || item.cardCount > 0);

  if (validItems.length === 0) {
    return 100;
  }

  // 1. Count items with strictly higher priority (lower priority value number)
  const higherPriorityCount = validItems.filter((x) => x.priority < topMissedPriority).length;

  // 2. Count items with the SAME priority that are ALREADY PROCESSED (not due)
  const samePriorityProcessedCount = validItems.filter(
    (x) => x.priority === topMissedPriority && !isDuePredicate(x)
  ).length;

  const currentRank = higherPriorityCount + samePriorityProcessedCount;
  const percentile = (currentRank / validItems.length) * 100;

  // Round to 1 decimal place
  return Math.round(percentile * 10) / 10;
}

/**
 * Calculates a weighted priority completion metric across all items.
 *
 * The metric represents "what fraction of the total priority weight has been processed",
 * using exponential decay W(p) = e^(-k * p/100) with k ≈ 2.3026 so that
 * a 0-percentile item weighs ~10× a 100-percentile item.
 *
 * Shield = (processedWeight / totalWeight) × 100
 *
 * This ALWAYS increases as items are processed, with bigger jumps for
 * high-priority items. 100 = fully processed, 0 = nothing processed.
 *
 * @param allItems Full universe of items (KB or doc scope).
 * @param isDuePredicate Returns true if the item is due and unreviewed.
 * @returns Weighted completion percentage (0–100), or 100 if no items / no due items.
 */
export function calculateWeightedShield<T extends { priority: number; remId: string }>(
  allItems: T[],
  isDuePredicate: (item: T) => boolean
): number {
  if (!allItems || allItems.length === 0) return 100;

  // Pre-filter: Ignore rems that explicitly have 0 cards
  const validItems = allItems.filter((item: any) => item.cardCount === undefined || item.cardCount > 0);
  if (validItems.length === 0) return 100;

  // 1. Sort by priority to compute each item's percentile rank.
  //    Percentile is per ITEM, by its position in the sorted list. It used to be
  //    stored in a Map keyed by remId, which meant every card of a multi-card
  //    Rem was overwritten by the last one's rank — so they all shared a
  //    percentile, a weight, and a bucket. That is what made this table's
  //    buckets disagree with the Card Priority × Memory Analytics deciles.
  const sorted = [...validItems].sort((a, b) => a.priority - b.priority);
  const n = sorted.length;

  // 2. Compute total weight and due (unprocessed) weight
  // k = ln(10) ≈ 2.3026 → a 0% item weighs 10× more than a 100% item
  const k = 2.3026;
  let totalWeight = 0;
  let dueWeight = 0;

  for (let idx = 0; idx < n; idx++) {
    const item = sorted[idx];
    const p = ((idx + 1) / n) * 100;
    const weight = Math.exp(-k * p / 100);
    totalWeight += weight;

    if (isDuePredicate(item)) {
      dueWeight += weight;
    }
  }

  if (totalWeight === 0) return 100;

  // Shield = fraction of total weight that's been processed
  const processedFraction = (totalWeight - dueWeight) / totalWeight;
  const result = processedFraction * 100;
  return Math.round(result * 10) / 10; // 1 decimal
}
