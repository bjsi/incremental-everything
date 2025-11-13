import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { loadIncrementalRemCache } from '../lib/incremental_rem/cache';

export function registerIncrementalRemTracker(plugin: ReactRNPlugin) {
  plugin.track(async (rp) => {
    await loadIncrementalRemCache(rp);
  });
}
