import { RNPlugin } from '@remnote/plugin-sdk';

export const DEFAULT_RANDOMNESS = 0;
export const DEFAULT_RATIO = 0.25;

export const setSortingRandomness = async (plugin: RNPlugin, randomness: number) => {
  randomness = Math.min(1, Math.max(0, randomness));
  await plugin.storage.setSynced('randomness', randomness);
};

export const getSortingRandomness = async (plugin: RNPlugin) => {
  const val = (await plugin.storage.getSynced('randomness')) as number;
  return val == null ? DEFAULT_RANDOMNESS : val;
};

export type Ratio = 'no-rem' | 'no-cards' | number;

export const getRatioBetweenCardsAndIncrementalRem = async (plugin: RNPlugin): Promise<Ratio> => {
  let ratio = (await plugin.storage.getSynced('ratioBetweenCardsAndIncrementalRem')) as Ratio;
  if (ratio === 1) {
    ratio = 'no-rem';
  } else if (ratio === 0) {
    ratio = 'no-cards';
  }
  return ratio == null ? DEFAULT_RATIO : ratio;
};

export const setRatioBetweenCardsAndIncrementalRem = async (plugin: RNPlugin, ratio: number) => {
  ratio = Math.min(1, Math.max(0, ratio));
  await plugin.storage.setSynced('ratioBetweenCardsAndIncrementalRem', ratio);
};

export const getNumCardsPerIncRem = async (plugin: RNPlugin): Promise<number | string> => {
  const ratio = await getRatioBetweenCardsAndIncrementalRem(plugin);
  return typeof ratio === 'number'
    ? Math.round(1 / ratio)
    : ratio === 'no-cards'
    ? 'Only Incremental Rem'
    : 'Only Flashcards';
};
