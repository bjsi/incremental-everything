import { ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import { allIncrementalRemKey, powerupCode } from '../consts';
import { IncrementalRem } from './types';
import { getIncrementalRemFromRem } from './index';

/**
 * Checks if a rem is in the incremental cache (i.e., is an incremental rem).
 *
 * This is the preferred way to check if a rem has the incremental powerup,
 * as it uses the cache instead of making API calls.
 *
 * @param plugin Plugin instance
 * @param remId The ID of the rem to check
 * @returns Promise that resolves to true if the rem is incremental, false otherwise
 */
export async function isIncrementalRem(
  plugin: RNPlugin,
  remId: string | undefined
): Promise<boolean> {
  if (!remId) return false;
  const allRems: IncrementalRem[] =
    (await plugin.storage.getSession(allIncrementalRemKey)) || [];
  return allRems.some((r) => r.remId === remId);
}

/**
 * Gets all incremental rems from the cache.
 *
 * This is the preferred way to get all incremental rem data,
 * as it uses the cache instead of making API calls.
 *
 * @param plugin Plugin instance
 * @returns Promise that resolves to array of all IncrementalRem objects
 */
export async function getAllIncrementalRemsFromCache(
  plugin: RNPlugin
): Promise<IncrementalRem[]> {
  return (await plugin.storage.getSession(allIncrementalRemKey)) || [];
}

/**
 * Gets an incremental rem from the cache.
 *
 * This is the preferred way to get incremental rem data,
 * as it uses the cache instead of making API calls.
 *
 * @param plugin Plugin instance
 * @param remId The ID of the rem to get
 * @returns Promise that resolves to the IncrementalRem if found, null otherwise
 */
export async function getIncrementalRemFromCache(
  plugin: RNPlugin,
  remId: string | undefined
): Promise<IncrementalRem | null> {
  if (!remId) return null;
  const allRems = await getAllIncrementalRemsFromCache(plugin);
  return allRems.find((r) => r.remId === remId) || null;
}

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
      await Promise.all(batch.map((rem) => getIncrementalRemFromRem(plugin, rem)))
    ).filter(Boolean) as IncrementalRem[];

    updatedAllRem.push(...batchInfos);

    await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
  }

  console.log(`TRACKER: Processing complete. Final IncRem cache size is ${updatedAllRem.length}.`);
  await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
  console.log('TRACKER: Incremental Rem cache has been saved.');

  return updatedAllRem;
}
