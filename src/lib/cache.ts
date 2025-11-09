// in lib/cache.ts

import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { allCardPriorityInfoKey } from './consts';
import { CardPriorityInfo, getCardPriority } from './cardPriority';
import * as _ from 'remeda';

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
export async function updateCardPriorityInCache(plugin: RNPlugin, remId: RemId, isLightUpdate = false) {
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