import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { loadAllIncrementalRems } from '../../lib/incremental_rem';

export function registerIncrementalRemTracker(plugin: ReactRNPlugin) {
  plugin.track(async () => {
    await loadAllIncrementalRems(plugin);
  });
}
