import { RNPlugin } from '@remnote/plugin-sdk';
import { currentIncRemKey } from './consts';

export const getCurrentIncrementalRem = async (plugin: RNPlugin) => {
  const remId = await plugin.storage.getSession<string>(currentIncRemKey);
  const rem = await plugin.rem.findOne(remId);
  return rem;
};

export const setCurrentIncrementalRem = async (plugin: RNPlugin, remId: string | undefined) => {
  return await plugin.storage.setSession(currentIncRemKey, remId);
};
