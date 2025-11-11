// in lib/cache.ts

import { RNPlugin, RemId, ReactRNPlugin } from '@remnote/plugin-sdk';
import { allCardPriorityInfoKey, allIncrementalRemKey, powerupCode } from './consts';
import { CardPriorityInfo, getCardPriority } from './cardPriority';
import { IncrementalRem } from './types';
import * as _ from 'remeda';
import { getIncrementalRemInfo } from './incremental_rem';

let cacheUpdateTimer: NodeJS.Timeout | null = null;
let pendingUpdates = new Map<RemId, { info: CardPriorityInfo | null; isLight: boolean }>();

async function flushCacheUpdates(plugin: RNPlugin, forceHeavyRecalc = false) {
  if (pendingUpdates.size === 0) return;
  
  // Check if any of the pending updates requires a heavy recalculation.
  const needsHeavyRecalc = forceHeavyRecalc || Array.from(pendingUpdates.values()).some(update => !update.isLight);

  console.log(`CACHE-FLUSH: Writing ${pendingUpdates.size} batched updates. Heavy Recalc: ${needsHeavyRecalc}`);
  
  const cache = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
  
  for (const [remId, update] of pendingUpdates.entries()) {
    const index = cache.findIndex(info => info.remId === remId);
    if (index > -1) {
      if (update.info) {
        // For a light update, we must preserve the old percentile
        const oldPercentile = cache[index].kbPercentile;
        cache[index] = { ...update.info, kbPercentile: oldPercentile };
      } else {
        cache.splice(index, 1);
      }
    } else if (update.info) {
      cache.push(update.info);
    }
  }
  
  if (needsHeavyRecalc) {
    console.log(`CACHE-FLUSH: Re-calculating percentiles for ${cache.length} items...`);
    const sortedCache = _.sortBy(cache, (info) => info.priority);
    const totalItems = sortedCache.length;
    const enrichedCache = sortedCache.map((info, index) => {
      const percentile = totalItems > 0 ? Math.round(((index + 1) / totalItems) * 100) : 0;
      return { ...info, kbPercentile: percentile };
    });
    await plugin.storage.setSession(allCardPriorityInfoKey, enrichedCache);
    console.log(`CACHE-FLUSH: Complete. Enriched cache size: ${enrichedCache.length}`);
  } else {
    // For a light update, just save the modified cache without re-sorting.
    await plugin.storage.setSession(allCardPriorityInfoKey, cache);
    console.log(`CACHE-FLUSH: Light update complete. Cache size: ${cache.length}`);
  }
  
  pendingUpdates.clear();
}

// Add a new 'isLightUpdate' parameter
export async function updateCardPriorityCache(plugin: RNPlugin, remId: RemId, isLightUpdate = false) {
  try {
    console.log(`CACHE-UPDATE: Queuing ${isLightUpdate ? 'light' : 'heavy'} update for RemId: ${remId}`);
    
    const rem = await plugin.rem.findOne(remId);
    const updatedInfo = rem ? await getCardPriority(plugin, rem) : null;
    
    pendingUpdates.set(remId, { info: updatedInfo, isLight: isLightUpdate });
    
    if (cacheUpdateTimer) clearTimeout(cacheUpdateTimer);
    
    cacheUpdateTimer = setTimeout(async () => {
      await flushCacheUpdates(plugin);
      cacheUpdateTimer = null;
    }, 200);
    
  } catch(e) {
    console.error("Error updating card priority cache for Rem:", remId, e);
  }
}

export async function flushCacheUpdatesNow(plugin: RNPlugin) {
  if (cacheUpdateTimer) {
    clearTimeout(cacheUpdateTimer);
    cacheUpdateTimer = null;
  }
  // Force a heavy recalculation when flushing manually
  await flushCacheUpdates(plugin, true);
}

/**
 * Flushes pending cache updates immediately but respects the 'isLight'
 * flag of the pending updates. It does NOT force a heavy recalculation.
 * This is used for fast, in-queue UI updates.
 */
export async function flushLightCacheUpdates(plugin: RNPlugin) {
  if (cacheUpdateTimer) {
    clearTimeout(cacheUpdateTimer);
    cacheUpdateTimer = null;
  }
  // Call without the 'true' flag to perform a light flush if possible.
  await flushCacheUpdates(plugin);
}

// ========== INCREMENTAL REM CACHE ==========

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