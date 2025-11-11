import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { loadIncrementalRemCache } from '../../lib/cache';

export function registerIncrementalRemTracker(plugin: ReactRNPlugin) {
  plugin.track(async (rp) => {
    await loadIncrementalRemCache(rp);
  });
}
