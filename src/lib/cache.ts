import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { allCardPriorityInfoKey, incrementalQueueActiveKey } from './consts';
import { CardPriorityInfo, getCardPriority } from './cardPriority';

// Debounce mechanism to batch cache writes
let cacheUpdateTimer: NodeJS.Timeout | null = null;
let pendingUpdates = new Map<RemId, CardPriorityInfo | null>();

async function flushCacheUpdates(plugin: RNPlugin) {
  if (pendingUpdates.size === 0) return;
  
  console.log(`CACHE-FLUSH: Writing ${pendingUpdates.size} batched updates to cache`);
  
  const cache = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
  
  // Apply all pending updates efficiently
  for (const [remId, updatedInfo] of pendingUpdates.entries()) {
    const index = cache.findIndex(info => info.remId === remId);
    
    if (index > -1) {
      if (updatedInfo) {
        // Update in place - NO COPY
        cache[index] = updatedInfo;
      } else {
        // Remove from cache
        cache.splice(index, 1);
      }
    } else if (updatedInfo) {
      // Add new item
      cache.push(updatedInfo);
    }
  }
  
  // Single write for all updates
  await plugin.storage.setSession(allCardPriorityInfoKey, cache);
  console.log(`CACHE-FLUSH: Complete. Cache size: ${cache.length}`);
  
  // Clear pending updates
  pendingUpdates.clear();
}

export async function updateCardPriorityInCache(plugin: RNPlugin, remId: RemId) {
  try {
    console.log(`CACHE-UPDATE: Queuing update for RemId: ${remId}`);
    
    const rem = await plugin.rem.findOne(remId);
    if (!rem) {
      return;
    }
    
    const updatedInfo = await getCardPriority(plugin, rem);
    
    // Add to pending updates
    pendingUpdates.set(remId, updatedInfo);
    
    // Clear existing timer
    if (cacheUpdateTimer) {
      clearTimeout(cacheUpdateTimer);
    }
    
    // Batch updates - flush after 200ms of no new updates
    cacheUpdateTimer = setTimeout(async () => {
      await flushCacheUpdates(plugin);
      cacheUpdateTimer = null;
    }, 200);
    
  } catch(e) {
    console.error("Error updating card priority cache for Rem:", remId, e);
  }
}

// Force immediate flush (call this on queue exit)
export async function flushCacheUpdatesNow(plugin: RNPlugin) {
  if (cacheUpdateTimer) {
    clearTimeout(cacheUpdateTimer);
    cacheUpdateTimer = null;
  }
  await flushCacheUpdates(plugin);
}