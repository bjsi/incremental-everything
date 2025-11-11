import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { allIncrementalRemKey, powerupCode } from '../../lib/consts';
import { IncrementalRem } from '../../lib/types';
import { getIncrementalRemInfo } from '../../lib/incremental_rem';

const BATCH_SIZE = 500;
const BATCH_DELAY_MS = 100;

export function registerIncrementalRemTracker(plugin: ReactRNPlugin) {
  plugin.track(async (rp) => {
    console.log('TRACKER: Incremental Rem tracker starting...');
    const powerup = await rp.powerup.getPowerupByCode(powerupCode);
    const taggedRem = (await powerup?.taggedRem()) || [];
    console.log(`TRACKER: Found ${taggedRem.length} Incremental Rems. Starting batch processing...`);

    const updatedAllRem: IncrementalRem[] = [];
    const numBatches = Math.ceil(taggedRem.length / BATCH_SIZE);

    for (let i = 0; i < taggedRem.length; i += BATCH_SIZE) {
      const batch = taggedRem.slice(i, i + BATCH_SIZE);
      console.log(`TRACKER: Processing IncRem batch ${Math.floor(i / BATCH_SIZE) + 1} of ${numBatches}...`);

      const batchInfos = (
        await Promise.all(batch.map((rem) => getIncrementalRemInfo(plugin, rem)))
      ).filter(Boolean) as IncrementalRem[];

      updatedAllRem.push(...batchInfos);

      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    console.log(`TRACKER: Processing complete. Final IncRem cache size is ${updatedAllRem.length}.`);
    await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
    console.log('TRACKER: Incremental Rem cache has been saved.');
  });
}
