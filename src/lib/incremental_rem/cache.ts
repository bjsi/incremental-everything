import { ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import { allIncrementalRemKey, powerupCode } from '../consts';
import { IncrementalRem } from './types';
import { getIncrementalRemInfo } from './index';

/**
 * Updates the incremental rem cache in session storage.
 *
 * This helper function updates a single rem in the cache by:
 * 1. Reading the current cache
 * 2. Filtering out the old version of the rem
 * 3. Adding the new version
 * 4. Writing back to storage
 *
 * @param plugin Plugin instance
 * @param updatedIncRem The updated incremental rem to add/update in cache
 * @returns Promise that resolves when the cache is updated
 */
export async function updateIncrementalRemCache(
  plugin: RNPlugin,
  updatedIncRem: IncrementalRem
): Promise<void> {
  const allRems: IncrementalRem[] =
    (await plugin.storage.getSession(allIncrementalRemKey)) || [];
  const updatedAllRems = allRems
    .filter((r) => r.remId !== updatedIncRem.remId)
    .concat(updatedIncRem);
  await plugin.storage.setSession(allIncrementalRemKey, updatedAllRems);
}

/**
 * Removes an incremental rem from the session cache.
 *
 * Use this when a rem is no longer incremental (powerup removed) or deleted.
 *
 * @param plugin Plugin instance
 * @param remId The ID of the rem to remove from cache
 * @returns Promise that resolves when the cache is updated
 */
export async function removeIncrementalRemCache(
  plugin: RNPlugin,
  remId: string
): Promise<void> {
  const allRems: IncrementalRem[] =
    (await plugin.storage.getSession(allIncrementalRemKey)) || [];
  const updatedAllRems = allRems.filter((r) => r.remId !== remId);
  await plugin.storage.setSession(allIncrementalRemKey, updatedAllRems);
}

/**
 * Loads all Rems tagged with the Incremental powerup and caches them in session storage.
 *
 * Processes rems in batches to avoid overwhelming the API. Invalid rems are filtered out.
 *
 * @param plugin Plugin instance with powerup/rem/storage access
 * @param batchSize Number of rems to process per batch (default: 500)
 * @param batchDelayMs Delay in milliseconds between batches (default: 100)
 * @returns Array of successfully loaded IncrementalRem objects
 */
export async function loadIncrementalRemCache(
  plugin: ReactRNPlugin,
  batchSize: number = 500,
  batchDelayMs: number = 100
): Promise<IncrementalRem[]> {
  console.log('TRACKER: Incremental Rem tracker starting...');

  const powerup = await plugin.powerup.getPowerupByCode(powerupCode);
  const taggedRem = (await powerup?.taggedRem()) || [];
  console.log(`TRACKER: Found ${taggedRem.length} Incremental Rems. Starting batch processing...`);

  const updatedAllRem: IncrementalRem[] = [];
  const numBatches = Math.ceil(taggedRem.length / batchSize);

  for (let i = 0; i < taggedRem.length; i += batchSize) {
    const batch = taggedRem.slice(i, i + batchSize);
    console.log(`TRACKER: Processing IncRem batch ${Math.floor(i / batchSize) + 1} of ${numBatches}...`);

    const batchInfos = (
      await Promise.all(batch.map((rem) => getIncrementalRemInfo(plugin, rem)))
    ).filter(Boolean) as IncrementalRem[];

    updatedAllRem.push(...batchInfos);

    await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
  }

  console.log(`TRACKER: Processing complete. Final IncRem cache size is ${updatedAllRem.length}.`);
  await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
  console.log('TRACKER: Incremental Rem cache has been saved.');

  return updatedAllRem;
}
