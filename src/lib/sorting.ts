import { RNPlugin } from '@remnote/plugin-sdk';

// 10% by default. Now that randomness is priority-weighted (see
// applyPriorityWeightedLottery), a modest default is safe: it dedicates a small
// slice of every session to surfacing lower-priority "golden nuggets" while the
// queue stays strongly biased toward high-priority items.
export const DEFAULT_RANDOMNESS = 0.1;
// Default is now the number of cards, e.g., 6 cards per incremental rem.
export const DEFAULT_CARDS_PER_REM = 6; 

export const setSortingRandomness = async (plugin: RNPlugin, randomness: number) => {
  randomness = Math.min(1, Math.max(0, randomness));
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  await plugin.storage.setSynced(`randomness_${kbId}`, randomness);
};

export const getSortingRandomness = async (plugin: RNPlugin) => {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  let val = (await plugin.storage.getSynced(`randomness_${kbId}`)) as number;
  if (val == null) {
    val = (await plugin.storage.getSynced('randomness')) as number;
  }
  return val == null ? DEFAULT_RANDOMNESS : val;
};

export type CardsPerRem = 'no-rem' | 'no-cards' | number;

export const getCardsPerRem = async (plugin: RNPlugin): Promise<CardsPerRem> => {
	const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
	let val = await plugin.storage.getSynced(`cardsPerRem_${kbId}`);
	if (val == null) {
		val = await plugin.storage.getSynced('cardsPerRem');
	}
	if (val === 'no-rem' || val === 'no-cards' || typeof val === 'number') {
		return val;
	}
	return DEFAULT_CARDS_PER_REM;
}

export const setCardsPerRem = async (plugin: RNPlugin, value: CardsPerRem) => {
	const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
	await plugin.storage.setSynced(`cardsPerRem_${kbId}`, value);
}

// Add new functions for flashcard randomness
export const DEFAULT_CARD_RANDOMNESS = 0.1;

export const setCardRandomness = async (plugin: RNPlugin, randomness: number) => {
  randomness = Math.min(1, Math.max(0, randomness));
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  await plugin.storage.setSynced(`cardRandomness_${kbId}`, randomness);
};

export const getCardRandomness = async (plugin: RNPlugin) => {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  let val = (await plugin.storage.getSynced(`cardRandomness_${kbId}`)) as number;
  if (val == null) {
    val = (await plugin.storage.getSynced('cardRandomness')) as number;
  }
  return val == null ? DEFAULT_CARD_RANDOMNESS : val;
};

export interface SortingPreset {
  name: string;
  randomness: number;
  cardRandomness: number;
  cardsPerRem: CardsPerRem;
}

export const getSortingPresets = async (plugin: RNPlugin): Promise<SortingPreset[]> => {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  const val = await plugin.storage.getSynced<SortingPreset[]>(`sortingPresets_${kbId}`);
  return val ?? [];
};

export const setSortingPresets = async (plugin: RNPlugin, presets: SortingPreset[]): Promise<void> => {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  await plugin.storage.setSynced(`sortingPresets_${kbId}`, presets);
};

// Decay constant for the priority-weighted selection lottery.
// k = ln(10) ≈ 2.3026 makes a 0-percentile (top-priority) item weigh ~10× a
// 100-percentile (bottom-priority) item — the SAME curve the Weighted Shield
// reports (W = e^(-k * p/100)). Larger k = steeper favouring of high priority
// (low-priority items appear more rarely); smaller k = flatter / more uniform.
export const DEFAULT_WEIGHT_K = 2.3026;

export const setWeightSelectionK = async (plugin: RNPlugin, k: number) => {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  await plugin.storage.setSynced(`weightSelectionK_${kbId}`, k);
};

export const getWeightSelectionK = async (plugin: RNPlugin): Promise<number> => {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  let val = (await plugin.storage.getSynced(`weightSelectionK_${kbId}`)) as number;
  if (val == null) {
    val = (await plugin.storage.getSynced('weightSelectionK')) as number;
  }
  return typeof val === 'number' && val > 0 ? val : DEFAULT_WEIGHT_K;
};

/**
 * Picks `count` distinct indices from [0, n) uniformly, via a partial
 * Fisher–Yates shuffle (unbiased, O(n) setup + O(count) selection).
 */
function pickDistinctIndices(n: number, count: number): number[] {
  if (count >= n) {
    return Array.from({ length: n }, (_, i) => i);
  }
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, count);
}

/**
 * Injects randomness into an array that is ALREADY sorted ascending by priority
 * (so index = rank) via a *priority-weighted lottery*, in place. Returns `sorted`.
 *
 * Old behaviour (uniform swaps): `randomness * N` swaps picked BOTH endpoints
 * uniformly, so a displaced slot was refilled from a uniformly-random rank. That
 * made the random tail FLAT — an item one rank past a cutoff and an item in the
 * last quartile were equally likely to be pulled into a (later truncated) window.
 *
 * New behaviour: the same number of slots (`randomness * N`) are randomised, but
 * the items competing for the earlier of those slots are drawn with probability
 * proportional to their Weighted-Shield weight `W = e^(-k * p/100)`, where `p` is
 * the item's rank-percentile. So among displaced items, higher-priority ones win
 * the early slots ~`10×` more often than bottom-priority ones (with the default k),
 * while every item still keeps a real, non-zero chance of appearing. Items not
 * selected into the lottery keep their strict priority position, so the
 * high-priority deterministic core is preserved (and `randomness = 0` ⇒ untouched).
 *
 * Factored out of applySortingCriteria so callers that maintain their own priority
 * ordering (e.g. the live-queue IncRem injector) can reuse the exact same weighting.
 * NOTE: the caller must ensure `sorted` is in ascending priority order — this does
 * not re-sort. Mutates `sorted` in place.
 *
 * @param weightK Decay steepness; defaults to DEFAULT_WEIGHT_K (the Weighted-Shield curve).
 */
export function applyPriorityWeightedLottery<T>(
  sorted: T[],
  randomness: number,
  weightK: number = DEFAULT_WEIGHT_K
): T[] {
  const N = sorted.length;
  const r = Math.min(1, Math.max(0, randomness));
  const numLottery = Math.floor(r * N);
  if (numLottery < 2 || N < 2) {
    // Nothing meaningful to randomise — leave strict priority order.
    return sorted;
  }

  // 1. Choose which positions become "lottery slots". The rest keep strict order.
  //    Uniform over the whole array, so the disturbance magnitude matches the old
  //    swap count, but the REFILL is weighted (below) instead of uniform.
  const slots = pickDistinctIndices(N, numLottery);
  slots.sort((a, b) => a - b); // earliest slot first

  // 2. The items currently in those slots form the pool. Each carries a
  //    Weighted-Shield weight from its ORIGINAL rank-percentile.
  const pool = slots.map((idx) => {
    const percentile = ((idx + 1) / N) * 100;
    const weight = Math.exp((-weightK * percentile) / 100);
    return { item: sorted[idx], weight };
  });

  // 3. Weighted random ordering WITHOUT replacement (Efraimidis–Spirakis):
  //    key = u^(1/w); largest keys first ⇒ draws ∝ weight, in O(n log n).
  const ordered = pool
    .map((entry) => ({ entry, key: Math.pow(Math.random(), 1 / entry.weight) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.entry.item);

  // 4. Write the weighted ordering back into the (front-to-back) lottery slots,
  //    so higher-priority pool members land in the earlier positions.
  for (let s = 0; s < slots.length; s++) {
    sorted[slots[s]] = ordered[s];
  }

  return sorted;
}

/**
 * Sorts `items` ascending by priority, then injects randomness through the
 * priority-weighted lottery (see applyPriorityWeightedLottery).
 *
 * @param weightK Decay steepness; defaults to DEFAULT_WEIGHT_K (the Weighted-Shield curve).
 */
export function applySortingCriteria<T extends { priority: number }>(
  items: T[],
  randomness: number,
  weightK: number = DEFAULT_WEIGHT_K
): T[] {
  // Guard clause to handle undefined or null input
  if (!items) {
    return [];
  }

  // Sort by priority first (ascending: lower number = higher priority = front).
  const sorted = [...items].sort((a, b) => a.priority - b.priority);
  return applyPriorityWeightedLottery(sorted, randomness, weightK);
}