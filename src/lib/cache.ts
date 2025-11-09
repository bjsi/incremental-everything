// in lib/cache.ts

import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { allCardPriorityInfoKey } from './consts';
import { shouldUseLightMode } from './mobileUtils';
import { CardPriorityInfo, getCardPriority, autoAssignCardPriority } from './cardPriority';
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

// DEFERRED PROCESSING FUNCTION - Processes untagged cards in the background
async function processDeferredCards(plugin: RNPlugin, untaggedRemIds: string[]) {
  console.log(`DEFERRED: Starting background processing of ${untaggedRemIds.length} untagged cards...`);
  const startTime = Date.now();

  let processed = 0;
  let errorCount = 0;
  const batchSize = 30; // Small batches to avoid blocking UI
  const delayBetweenBatches = 100; // 100ms delay between batches

  try {
    for (let i = 0; i < untaggedRemIds.length; i += batchSize) {
      const batch = untaggedRemIds.slice(i, i + batchSize);
      const newPriorities: CardPriorityInfo[] = [];

      // Process this batch
      await Promise.all(batch.map(async (remId) => {
        try {
          const rem = await plugin.rem.findOne(remId);
          if (!rem) {
            errorCount++;
            return;
          }

          // Auto-assign priority (this will tag the rem)
          await autoAssignCardPriority(plugin, rem);

          // Get the newly assigned priority info
          const cardInfo = await getCardPriority(plugin, rem);
          if (cardInfo) {
            newPriorities.push(cardInfo);
          }

          processed++;
        } catch (error) {
          console.error(`DEFERRED: Error processing rem ${remId}:`, error);
          errorCount++;
        }
      }));

      // Update the cache incrementally
      if (newPriorities.length > 0) {
        const currentCache = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey) || [];
        const mergedCache = [...currentCache, ...newPriorities];

        // --- NEW: Re-calculate all percentiles for the updated cache ---
        const sortedMergedCache = _.sortBy(mergedCache, (info) => info.priority);
        const totalItems = sortedMergedCache.length;
        const enrichedCache = sortedMergedCache.map((info, index) => {
            const percentile = totalItems > 0 ? Math.round(((index + 1) / totalItems) * 100) : 0;
            return { ...info, kbPercentile: percentile };
        });

        await plugin.storage.setSession(allCardPriorityInfoKey, enrichedCache);
      }

      // Progress logging every 20% or 500 cards
      if (processed % Math.max(500, Math.floor(untaggedRemIds.length * 0.2)) === 0 ||
          processed === untaggedRemIds.length) {
        const progress = Math.round((processed / untaggedRemIds.length) * 100);
        console.log(`DEFERRED: Progress ${progress}% (${processed}/${untaggedRemIds.length})`);
      }

      // Yield to UI between batches (only if not the last batch)
      if (i + batchSize < untaggedRemIds.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }

    const totalTime = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `DEFERRED: Background processing complete! ` +
      `Processed ${processed} cards in ${totalTime}s ` +
      `(${errorCount} errors)`
    );

    // Final notification
    await plugin.app.toast(
      `✅ Background processing complete! All ${processed} card priorities are now cached.`
    );

    // If there were many untagged cards, suggest pre-computation again
    if (untaggedRemIds.length > 1000) {
      setTimeout(() => {
        plugin.app.toast(
          `💡 Tip: Run 'Pre-compute Card Priorities' to avoid background processing in future sessions`
        );
      }, 2000);
    }

  } catch (error) {
    console.error('DEFERRED: Fatal error during background processing:', error);
    await plugin.app.toast('⚠️ Background processing encountered an error. Some cards may not be cached.');
  }
}

// CARD PRIORITIES CACHING FUNCTION - With deferred loading for untagged cards
export async function cacheAllCardPriorities(plugin: RNPlugin) {
  console.log('CACHE: Starting intelligent cache build with deferred loading...');

  const startTime = Date.now();

  const allCards = await plugin.card.getAll();
  const cardRemIds = allCards ? _.uniq(allCards.map(c => c.remId)) : [];
  console.log(`CACHE: Found ${cardRemIds.length} rems with cards`);

  // CRITICAL FIX: Also get rems that are tagged with cardPriority for inheritance
  const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
  const taggedForInheritanceRems = (await cardPriorityPowerup?.taggedRem()) || [];
  const inheritanceRemIds = taggedForInheritanceRems.map(r => r._id);
  console.log(`CACHE: Found ${inheritanceRemIds.length} rems tagged with cardPriority powerup`);

  // Combine both sets of remIds (cards + inheritance-only)
  const uniqueRemIds = _.uniq([...cardRemIds, ...inheritanceRemIds]);
  console.log(`CACHE: Total ${uniqueRemIds.length} rems to process (${cardRemIds.length} with cards + ${inheritanceRemIds.length - cardRemIds.length} inheritance-only)`);

  if (uniqueRemIds.length === 0) {
    console.log('CACHE: No cards or cardPriority tags found. Setting empty cache.');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
    return;
  }

  // Step 1: Quickly load all pre-tagged cards for immediate use
  console.log('CACHE: Phase 1 - Loading pre-tagged cards...');
  const taggedPriorities: CardPriorityInfo[] = [];
  const untaggedRemIds: string[] = [];

  // Process in batches to check what's tagged
  const checkBatchSize = 100;
  for (let i = 0; i < uniqueRemIds.length; i += checkBatchSize) {
    const batch = uniqueRemIds.slice(i, i + checkBatchSize);

    await Promise.all(batch.map(async (remId) => {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) return;

      const hasPowerup = await rem.hasPowerup('cardPriority');
      if (hasPowerup) {
        // It's tagged - get the info quickly
        const cardInfo = await getCardPriority(plugin, rem);
        if (cardInfo) {
          taggedPriorities.push(cardInfo);
        }
      } else {
        // Not tagged - queue for deferred processing
        untaggedRemIds.push(remId);
      }
    }));
  }

  // --- PERCENTILE CALCULATION LOGIC ---
  console.log(`CACHE: Found ${taggedPriorities.length} tagged entries. Calculating percentiles...`);
  const sortedInfos = _.sortBy(taggedPriorities, (info) => info.priority);
  const totalItems = sortedInfos.length;
  const enrichedTaggedPriorities = sortedInfos.map((info, index) => {
    const percentile = totalItems > 0 ? Math.round(((index + 1) / totalItems) * 100) : 0;
    return { ...info, kbPercentile: percentile };
  });

  // Set the initial cache with tagged cards (instant availability)
  await plugin.storage.setSession(allCardPriorityInfoKey, enrichedTaggedPriorities);

  const phase1Time = Math.round((Date.now() - startTime) / 1000);
  console.log(`CACHE: Phase 1 complete. Loaded and enriched ${enrichedTaggedPriorities.length} tagged cards in ${phase1Time}s`);
  console.log(`CACHE: Found ${untaggedRemIds.length} untagged cards for deferred processing`);

  if (enrichedTaggedPriorities.length > 0) {
    await plugin.app.toast(`✅ Loaded ${enrichedTaggedPriorities.length} card priorities instantly`);
  }

  if (untaggedRemIds.length > 0) {
    const untaggedPercentage = Math.round((untaggedRemIds.length / uniqueRemIds.length) * 100);
    if (untaggedPercentage > 20) {
      await plugin.app.toast(
        `⏳ Processing ${untaggedRemIds.length} untagged cards in background... ` +
        `Consider running 'Pre-compute Card Priorities' for instant startups!`
      );
    }

    setTimeout(async () => {
      await processDeferredCards(plugin, untaggedRemIds);
    }, 3000);
  } else {
    console.log('CACHE: All cards are pre-tagged! No deferred processing needed.');
    await plugin.app.toast('✅ All card priorities loaded instantly!');
  }
}

export async function initializeCardPriorityCache(plugin: RNPlugin) {
  const useLightMode = await shouldUseLightMode(plugin);
  if (!useLightMode) {
    await cacheAllCardPriorities(plugin);
  } else {
    console.log('CACHE: Light mode enabled. Skipping card priority cache build.');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
  }
}
