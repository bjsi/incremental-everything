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

export const getRatioBetweenCardsAndIncrementalRem = async (plugin: RNPlugin) => {
  const val = (await plugin.storage.getSynced('ratioBetweenCardsAndIncrementalRem')) as number;
  return val == null ? DEFAULT_RATIO : val;
};

export const setRatioBetweenCardsAndIncrementalRem = async (plugin: RNPlugin, ratio: number) => {
  ratio = Math.min(1, Math.max(0, ratio));
  await plugin.storage.setSynced('ratioBetweenCardsAndIncrementalRem', ratio);
};
