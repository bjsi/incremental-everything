import { RNPlugin } from '@remnote/plugin-sdk';

export const DEFAULT_RANDOMNESS = 0;
// Default is now the number of cards, e.g., 6 cards per incremental rem.
export const DEFAULT_CARDS_PER_REM = 6; 

export const setSortingRandomness = async (plugin: RNPlugin, randomness: number) => {
  randomness = Math.min(1, Math.max(0, randomness));
  await plugin.storage.setSynced('randomness', randomness);
};

export const getSortingRandomness = async (plugin: RNPlugin) => {
  const val = (await plugin.storage.getSynced('randomness')) as number;
  return val == null ? DEFAULT_RANDOMNESS : val;
};

export type CardsPerRem = 'no-rem' | 'no-cards' | number;

export const getCardsPerRem = async (plugin: RNPlugin): Promise<CardsPerRem> => {
	const val = await plugin.storage.getSynced('cardsPerRem');
	if (val === 'no-rem' || val === 'no-cards' || typeof val === 'number') {
		return val;
	}
	return DEFAULT_CARDS_PER_REM;
}

export const setCardsPerRem = async (plugin: RNPlugin, value: CardsPerRem) => {
	await plugin.storage.setSynced('cardsPerRem', value);
}


// Add new functions for flashcard randomness
export const DEFAULT_CARD_RANDOMNESS = 0.1;

export const setCardRandomness = async (plugin: RNPlugin, randomness: number) => {
  randomness = Math.min(1, Math.max(0, randomness));
  await plugin.storage.setSynced('cardRandomness', randomness);
};

export const getCardRandomness = async (plugin: RNPlugin) => {
  const val = (await plugin.storage.getSynced('cardRandomness')) as number;
  return val == null ? DEFAULT_CARD_RANDOMNESS : val;
};

// Add function to apply sorting with randomness
export function applySortingCriteria<T extends { priority: number }>(
  items: T[],
  randomness: number
): T[] {
	// Guard clause to handle undefined or null input
  if (!items) {
    return [];
  }

  // Sort by priority first
  const sorted = [...items].sort((a, b) => a.priority - b.priority);
  
  // Apply randomness through controlled swaps
  const numSwaps = Math.floor(randomness * items.length);
  
  for (let i = 0; i < numSwaps; i++) {
    const idx1 = Math.floor(Math.random() * sorted.length);
    const idx2 = Math.floor(Math.random() * sorted.length);
    [sorted[idx1], sorted[idx2]] = [sorted[idx2], sorted[idx1]];
  }
  
  return sorted;
}