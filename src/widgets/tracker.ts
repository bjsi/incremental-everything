import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { IncrementalRem } from '../lib/types';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { allIncrementalRemKey, powerupCode } from '../lib/consts';

/**
 * Keeps the session cache of Incremental Rems in sync by tracking
 * changes to the powerup and refreshing the stored list in batches.
 */
export const registerIncrementalRemTracker = (plugin: ReactRNPlugin) => {
  plugin.track(async (rp) => {
    console.log('TRACKER: Incremental Rem tracker starting...');
    const powerup = await rp.powerup.getPowerupByCode(powerupCode);
    const taggedRem = (await powerup?.taggedRem()) || [];
    console.log(
      `TRACKER: Found ${taggedRem.length} Incremental Rems. Starting batch processing...`
    );

    const updatedAllRem: IncrementalRem[] = [];
    const batchSize = 500;
    const delayBetweenBatches = 100; // milliseconds
    const numBatches = Math.ceil(taggedRem.length / batchSize);

    for (let i = 0; i < taggedRem.length; i += batchSize) {
      const batch = taggedRem.slice(i, i + batchSize);
      console.log(
        `TRACKER: Processing IncRem batch ${Math.floor(i / batchSize) + 1} of ${numBatches}...`
      );

      const batchInfos = (
        await Promise.all(batch.map((rem) => getIncrementalRemInfo(plugin, rem)))
      ).filter(Boolean) as IncrementalRem[];

      updatedAllRem.push(...batchInfos);

      await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
    }

    console.log(
      `TRACKER: Processing complete. Final IncRem cache size is ${updatedAllRem.length}.`
    );
    await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
    console.log('TRACKER: Incremental Rem cache has been saved.');
  });
};
