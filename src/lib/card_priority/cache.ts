import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { allCardPriorityInfoKey, cardPriorityCacheRefreshKey } from '../consts';
import { CardPriorityInfo, PrioritySource } from './types';
import { getCardPriority, autoAssignCardPriority } from './index';
import * as _ from 'remeda';

let cacheUpdateTimer: NodeJS.Timeout | null = null;
let pendingUpdates = new Map<RemId, { info: CardPriorityInfo | null; isLight: boolean }>();
const lightModeOptimisticOverrides = new Map<RemId, { info: CardPriorityInfo; expiresAt: number }>();

export function getPendingCacheUpdate(remId: RemId): CardPriorityInfo | null | undefined {
  const update = pendingUpdates.get(remId);
  if (update?.info) {
    return update.info;
  }

  const override = lightModeOptimisticOverrides.get(remId);
  if (override && Date.now() < override.expiresAt) {
    return override.info;
  }

  return undefined;
}

let isFlushing = false;
let needsHeavyRecalcNextRound = false;

async function flushCacheUpdates(plugin: RNPlugin, forceHeavyRecalc = false) {
  if (pendingUpdates.size === 0 && !forceHeavyRecalc) return;

  if (isFlushing) {
    if (forceHeavyRecalc) needsHeavyRecalcNextRound = true;
    return; // Already flushing, the current loop will pick up any new updates added to pendingUpdates
  }

  isFlushing = true;

  try {
    while (pendingUpdates.size > 0 || needsHeavyRecalcNextRound || forceHeavyRecalc) {
      const updatesToProcess = new Map(pendingUpdates);
      pendingUpdates.clear();

      const runHeavy = forceHeavyRecalc || needsHeavyRecalcNextRound;
      forceHeavyRecalc = false;
      needsHeavyRecalcNextRound = false;

      if (updatesToProcess.size === 0 && !runHeavy) break;

      const cache = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];

      let needsHeavyRecalc = runHeavy;

      // Build a Map for O(1) lookups and updates
      const cacheMap = new Map<RemId, CardPriorityInfo>();
      for (const info of cache) {
        cacheMap.set(info.remId, info);
      }

      for (const [remId, update] of updatesToProcess.entries()) {
        const existing = cacheMap.get(remId);
        let priorityChanged = false;

        if (existing) {
          if (update.info) {
            // If this is an actively pushed update (manual or light UI action), 
            // or if it's strictly newer than the cache DB timestamp, we trust it over the DB snapshot.
            const isActivelyPushedUpdate = update.isLight || (update.info.lastUpdated && update.info.lastUpdated >= existing.lastUpdated);

            if (existing.priority !== update.info.priority || existing.source !== update.info.source) {
              priorityChanged = true;
            }

            const newPriorityForMap = isActivelyPushedUpdate ? update.info.priority : existing.priority;

            cacheMap.set(remId, {
              ...existing,
              ...update.info,
              priority: newPriorityForMap,
              source: isActivelyPushedUpdate ? update.info.source : existing.source,
              kbPercentile: existing.kbPercentile
            });
          } else {
            cacheMap.delete(remId);
            priorityChanged = true;
          }
        } else if (update.info) {
          cacheMap.set(remId, update.info);
          priorityChanged = true;
        }

        if (priorityChanged) {
          needsHeavyRecalc = true;
        }
      }

      // Convert map back to array.
      const updatedCache = Array.from(cacheMap.values());

      if (needsHeavyRecalc) {
        const sortedCache = _.sortBy(updatedCache, (info) => info.priority);
        const totalItems = sortedCache.length;
        const enrichedCache = sortedCache.map((info, index) => {
          const percentile = totalItems > 0 ? Math.round(((index + 1) / totalItems) * 100) : 0;
          return { ...info, kbPercentile: percentile };
        });
        await plugin.storage.setSession(allCardPriorityInfoKey, enrichedCache);
      } else {
        await plugin.storage.setSession(allCardPriorityInfoKey, updatedCache);
      }

      // Signal all listeners that the cache has been updated
      // This is crucial for UI components to refresh their priority displays
      await plugin.storage.setSession(cardPriorityCacheRefreshKey, Date.now());
    }
  } catch (err) {
    console.error(`[Cache] Error inside while loop:`, err);
  } finally {
    isFlushing = false;
  }
}

export async function updateCardPriorityCache(
  plugin: RNPlugin,
  remId: RemId,
  isLightUpdate = false,
  optimisticInfo?: Partial<CardPriorityInfo> | null
) {
  try {
    let updatedInfo: CardPriorityInfo | null = null;

    if (optimisticInfo && optimisticInfo.remId) {
      // Optimistic Path: Use provided info directly (fastest, no DB read)
      // We assume the caller provided enough info to be useful (at least remId, priority, source)
      // Check if we need to fetch other fields if they are missing? 
      // For now, assume if optimisticInfo is provided, it's intended to replace/merge.
      // But we need a base.
      // Strategy: If optimisticInfo is "complete enough", use it. Else fetch and merge.
      // For priority/source updates, we usually have previous info in cache.

      // Let's rely on the caller passing a mostly complete object if they avoid the DB read.
      // OR, we can read from the existing cache to fill gaps?
      // Reading from pendingUpdates or session cache takes time? No, session cache read is effectively sync if cached? 2 calls?

      // Simplest robust approach: If optimisticInfo has priority/source, use it.
      // If full object is passed, use it.
      if (optimisticInfo.cardCount !== undefined) {
        updatedInfo = optimisticInfo as CardPriorityInfo;
      } else {
        // Should fetch to be safe if incomplete, OR merging logic.
        // Let's implement fetch-then-merge for partial, OR skip-fetch for full.
        // For now, let's stick to the previous override logic BUT prefer optimistic if valid.
        const rem = await plugin.rem.findOne(remId);
        const fetched = rem ? await getCardPriority(plugin, rem) : null;
        if (fetched) {
          updatedInfo = { ...fetched, ...optimisticInfo };
        }
      }
    } else {
      // Standard Path: Fetch from DB
      const rem = await plugin.rem.findOne(remId);
      updatedInfo = rem ? await getCardPriority(plugin, rem) : null;
    }

    pendingUpdates.set(remId, { info: updatedInfo, isLight: isLightUpdate });

    // Inject into the 5-second TTL map so the UI can safely read it 
    // after React completes its async render cycles and before the DB commits
    if (updatedInfo && isLightUpdate) {
      lightModeOptimisticOverrides.set(remId, {
        info: updatedInfo,
        expiresAt: Date.now() + 5000
      });
    }

    // The flushCacheUpdates function now has an intelligent internal `isFlushing` loop
    // that prevents overlapping saves and safely batches rapid requests. 
    // We no longer need arbitrary `setTimeout` delays. We ask it to flush immediately.
    flushCacheUpdates(plugin).catch(e => {
      console.error('[Cache] Automated flush failed:', e);
    });
  } catch (e) {
    console.error('Error updating card priority cache for Rem:', remId, e);
  }
}

export async function flushCacheUpdatesNow(plugin: RNPlugin) {
  await flushCacheUpdates(plugin, true);
}

/**
 * Flushes pending cache updates immediately but respects the 'isLight'
 * flag of the pending updates. It does NOT force a heavy recalculation.
 * This is used for fast, in-queue UI updates.
 */
export async function flushLightCacheUpdates(plugin: RNPlugin) {
  await flushCacheUpdates(plugin);
}

/**
 * Builds an optimized cache from pre-tagged card priorities.
 *
 * This function is used after pre-computation to quickly build the cache
 * from existing cardPriority tags.
 *
 * @param plugin Plugin instance
 */
export async function buildOptimizedCardPriorityCache(plugin: RNPlugin) {
  console.log('CACHE: Building optimized cache from pre-tagged priorities...');

  const allCards = await plugin.card.getAll();
  const cardRemIds = allCards ? _.uniq(allCards.map((c) => c.remId)) : [];
  console.log(`CACHE: Found ${cardRemIds.length} rems with cards`);

  const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
  const taggedForInheritanceRems = (await cardPriorityPowerup?.taggedRem()) || [];
  const inheritanceRemIds = taggedForInheritanceRems.map((r) => r._id);
  console.log(`CACHE: Found ${inheritanceRemIds.length} rems tagged with cardPriority powerup`);

  const uniqueRemIds = _.uniq([...cardRemIds, ...inheritanceRemIds]);
  console.log(
    `CACHE: Total ${uniqueRemIds.length} rems to process (${cardRemIds.length} with cards + ${inheritanceRemIds.length - cardRemIds.length
    } inheritance-only)`
  );

  if (uniqueRemIds.length === 0) {
    console.log('CACHE: No cards or cardPriority tags found. Setting empty cache.');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
    return;
  }

  const cardPriorityInfos: CardPriorityInfo[] = [];
  const batchSize = 100;

  for (let i = 0; i < uniqueRemIds.length; i += batchSize) {
    const batch = uniqueRemIds.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (remId) => {
        const rem = await plugin.rem.findOne(remId);
        if (!rem) return null;

        const cardInfo = await getCardPriority(plugin, rem);
        return cardInfo;
      })
    );

    cardPriorityInfos.push(...(batchResults.filter((info) => info !== null) as CardPriorityInfo[]));

    if (i % 1000 === 0) {
      console.log(`CACHE: Processed ${i}/${uniqueRemIds.length} rems...`);
    }
  }

  console.log(`CACHE: Found ${cardPriorityInfos.length} raw entries. Calculating percentiles...`);

  const sortedInfos = _.sortBy(cardPriorityInfos, (info) => info.priority);
  const totalItems = sortedInfos.length;
  const enrichedInfos = sortedInfos.map((info, index) => {
    const percentile = totalItems > 0 ? Math.round(((index + 1) / totalItems) * 100) : 0;
    return {
      ...info,
      kbPercentile: percentile,
    };
  });

  console.log(`CACHE: Successfully built and enriched cache with ${enrichedInfos.length} entries.`);
  await plugin.storage.setSession(allCardPriorityInfoKey, enrichedInfos);
}

/**
 * Intelligently caches all card priorities with deferred loading.
 *
 * Phase 1: Load pre-tagged cards
 * Phase 2: Process untagged cards in background
 *
 * @param plugin Plugin instance
 */
export async function loadCardPriorityCache(plugin: RNPlugin) {
  console.log('CACHE: Starting intelligent cache build with deferred loading...');

  const startTime = Date.now();

  const allCards = await plugin.card.getAll();
  const cardRemIds = allCards ? _.uniq(allCards.map((c) => c.remId)) : [];
  console.log(`CACHE: Found ${cardRemIds.length} rems with cards`);

  const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
  const taggedForInheritanceRems = (await cardPriorityPowerup?.taggedRem()) || [];
  const inheritanceRemIds = taggedForInheritanceRems.map((r) => r._id);
  console.log(`CACHE: Found ${inheritanceRemIds.length} rems tagged with cardPriority powerup`);

  const uniqueRemIds = _.uniq([...cardRemIds, ...inheritanceRemIds]);
  console.log(
    `CACHE: Total ${uniqueRemIds.length} rems to process (${cardRemIds.length} with cards + ${inheritanceRemIds.length - cardRemIds.length
    } inheritance-only)`
  );

  if (uniqueRemIds.length === 0) {
    console.log('CACHE: No cards or cardPriority tags found. Setting empty cache.');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
    return;
  }

  console.log('CACHE: Phase 1 - Loading pre-tagged cards...');
  const taggedPriorities: CardPriorityInfo[] = [];
  const untaggedRemIds: string[] = [];

  const checkBatchSize = 100;
  for (let i = 0; i < uniqueRemIds.length; i += checkBatchSize) {
    const batch = uniqueRemIds.slice(i, i + checkBatchSize);

    await Promise.all(
      batch.map(async (remId) => {
        const rem = await plugin.rem.findOne(remId);
        if (!rem) return;

        const hasPowerup = await rem.hasPowerup('cardPriority');
        if (hasPowerup) {
          const cardInfo = await getCardPriority(plugin, rem);
          if (cardInfo) {
            taggedPriorities.push(cardInfo);
          }
        } else {
          untaggedRemIds.push(remId);
        }
      })
    );
  }

  console.log(`CACHE: Found ${taggedPriorities.length} tagged entries. Calculating percentiles...`);
  const sortedInfos = _.sortBy(taggedPriorities, (info) => info.priority);
  const totalItems = sortedInfos.length;
  const enrichedTaggedPriorities = sortedInfos.map((info, index) => {
    const percentile = totalItems > 0 ? Math.round(((index + 1) / totalItems) * 100) : 0;
    return { ...info, kbPercentile: percentile };
  });

  await plugin.storage.setSession(allCardPriorityInfoKey, enrichedTaggedPriorities);

  const phase1Time = Math.round((Date.now() - startTime) / 1000);
  console.log(
    `CACHE: Phase 1 complete. Loaded and enriched ${enrichedTaggedPriorities.length} tagged cards in ${phase1Time}s`
  );
  console.log(`CACHE: Found ${untaggedRemIds.length} untagged cards for deferred processing`);

  if (enrichedTaggedPriorities.length > 0) {
    await plugin.app.toast(`✅ Loaded ${enrichedTaggedPriorities.length} pre-tagged card priorities`);
  }

  if (untaggedRemIds.length > 0) {
    const untaggedPercentage = Math.round((untaggedRemIds.length / uniqueRemIds.length) * 100);
    if (untaggedPercentage > 20) {
      await plugin.app.toast(
        `⏳ Processing ${untaggedRemIds.length} untagged cards in background... `
      );
    }

    setTimeout(async () => {
      await processDeferredCardPriorityCache(plugin, untaggedRemIds);
    }, 3000);
  } else {
    console.log('CACHE: All cards are pre-tagged! No deferred processing needed.');
    await plugin.app.toast('✅ All card priorities loaded!');
    await plugin.storage.setSession('card_priority_cache_fully_loaded', true);
  }
}

/**
 * Processes untagged cards in the background and incrementally updates the cache.
 *
 * @param plugin Plugin instance
 * @param untaggedRemIds Array of rem IDs that don't have cardPriority tags yet
 */
async function processDeferredCardPriorityCache(plugin: RNPlugin, untaggedRemIds: string[]) {
  console.log(`DEFERRED: Starting background processing of ${untaggedRemIds.length} untagged cards...`);
  const startTime = Date.now();

  let processed = 0;
  let errorCount = 0;
  const batchSize = 30;
  const delayBetweenBatches = 100;

  try {
    await plugin.storage.setSession('plugin_operation_active', true);
    for (let i = 0; i < untaggedRemIds.length; i += batchSize) {
      const batch = untaggedRemIds.slice(i, i + batchSize);
      const newPriorities: CardPriorityInfo[] = [];

      await Promise.all(
        batch.map(async (remId) => {
          try {
            const rem = await plugin.rem.findOne(remId);
            if (!rem) {
              errorCount++;
              return;
            }

            await autoAssignCardPriority(plugin, rem);

            const cardInfo = await getCardPriority(plugin, rem);
            if (cardInfo) {
              newPriorities.push(cardInfo);
            }

            processed++;
          } catch (error) {
            console.error(`DEFERRED: Error processing rem ${remId}:`, error);
            errorCount++;
          }
        })
      );

      if (newPriorities.length > 0) {
        const currentCache = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
        const mergedCache = [...currentCache, ...newPriorities];

        const sortedMergedCache = _.sortBy(mergedCache, (info) => info.priority);
        const totalItems = sortedMergedCache.length;
        const enrichedCache = sortedMergedCache.map((info, index) => {
          const percentile = totalItems > 0 ? Math.round(((index + 1) / totalItems) * 100) : 0;
          return { ...info, kbPercentile: percentile };
        });

        await plugin.storage.setSession(allCardPriorityInfoKey, enrichedCache);
      }

      if (
        processed % Math.max(500, Math.floor(untaggedRemIds.length * 0.2)) === 0 ||
        processed === untaggedRemIds.length
      ) {
        const progress = Math.round((processed / untaggedRemIds.length) * 100);
        console.log(`DEFERRED: Progress ${progress}% (${processed}/${untaggedRemIds.length})`);
      }

      if (i + batchSize < untaggedRemIds.length) {
        await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
      }
    }

    const totalTime = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `DEFERRED: Background processing complete! ` +
      `Processed ${processed} cards in ${totalTime}s ` +
      `(${errorCount} errors)`
    );

    await plugin.app.toast(`✅ Background processing complete! All ${processed} card priorities are now cached.`);
    await plugin.storage.setSession('card_priority_cache_fully_loaded', true);

    if (untaggedRemIds.length > 1000) {
      setTimeout(() => {
        plugin.app.toast(
          `💡 Tip: Run 'Update all inherited Card Priorities' to avoid background processing in future sessions`
        );
      }, 2000);
    }
  } catch (error) {
    console.error('DEFERRED: Fatal error during background processing:', error);
    await plugin.app.toast('⚠️ Background processing encountered an error. Some cards may not be cached.');
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}
