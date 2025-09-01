import { RNPlugin } from '@remnote/plugin-sdk';

export const DEFAULT_RANDOMNESS = 0;
// Default is now the number of cards, e.g., 4 cards per incremental rem.
export const DEFAULT_CARDS_PER_REM = 4; 

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