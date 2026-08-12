import { Card, PluginRem, RNPlugin, RemId } from '@remnote/plugin-sdk';
import { allCardPriorityInfoKey, cardPriorityCacheRefreshKey, orphanRemIdsKey } from '../consts';
import {
  CardPriorityInfo,
  PrioritySource,
  calculateCardRemPercentilesFromCards,
  CARD_PRIORITY_CODE,
  PRIORITY_SLOT,
} from './types';
import { getCardPriority, calculateNewPriority, setCardPriority } from './index';
import {
  writeCardPriorityCache,
  loadPersistedCardPriorities,
  persistCardPriorityStore,
  markCardPriorityDirty,
  loadDirtySet,
  flushDirtySet,
} from './persistence';
import dayjs from 'dayjs';
import * as _ from 'remeda';

let cacheUpdateTimer: ReturnType<typeof setTimeout> | null = null;
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

      // Record the changed ids for the next startup to re-read. The persisted
      // copy is no longer rewritten here — it is read only at startup, so
      // keeping it live was ~3.2MB of work per flush that nothing consumed.
      for (const remId of updatesToProcess.keys()) {
        markCardPriorityDirty(plugin, remId);
      }

      // Convert map back to array.
      const updatedCache = Array.from(cacheMap.values());

      if (needsHeavyRecalc) {
        // Per-card universe: kbPercentile is the rem's mean-rank percentile
        // across the expanded card population (matches Weighted Shield).
        const percentileByRem = calculateCardRemPercentilesFromCards(updatedCache);
        const enrichedCache = updatedCache.map((info) => ({
          ...info,
          kbPercentile: percentileByRem[info.remId] ?? 0,
        }));
        await writeCardPriorityCache(plugin, enrichedCache);
      } else {
        await writeCardPriorityCache(plugin, updatedCache);
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
 * from existing cardPriority tags. Applies the same per-rem-call elimination
 * tricks as loadCardPriorityCache: bucket cards from one card.getAll(), use
 * the PluginRem objects from taggedRem() directly, and rely on getCardPriority's
 * parallelized slot reads.
 *
 * @param plugin Plugin instance
 */
export async function buildOptimizedCardPriorityCache(plugin: RNPlugin) {
  console.log('[Card Priority Cache] Building optimized cache from pre-tagged priorities...');
  const startTime = Date.now();

  const allCards = await plugin.card.getAll();
  const cardRemIds = allCards ? _.uniq(allCards.map((c) => c.remId)) : [];
  console.log(`[Card Priority Cache] Found ${cardRemIds.length} rems with cards`);

  // Bucket cards by rem once.
  const cardsByRem = new Map<RemId, Card[]>();
  for (const c of allCards || []) {
    const arr = cardsByRem.get(c.remId);
    if (arr) arr.push(c);
    else cardsByRem.set(c.remId, [c]);
  }

  const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
  const taggedForInheritanceRems = (await cardPriorityPowerup?.taggedRem()) || [];
  const inheritanceRemIdSet = new Set<RemId>(taggedForInheritanceRems.map((r) => r._id));
  console.log(`[Card Priority Cache] Found ${inheritanceRemIdSet.size} rems tagged with cardPriority powerup`);

  const untaggedWithCards: string[] = cardRemIds.filter((id) => !inheritanceRemIdSet.has(id));
  const totalUnique = inheritanceRemIdSet.size + untaggedWithCards.length;
  console.log(
    `[Card Priority Cache] Total ${totalUnique} rems to process (${taggedForInheritanceRems.length} tagged + ${untaggedWithCards.length} untagged-with-cards)`
  );

  if (totalUnique === 0) {
    console.log('[Card Priority Cache] No cards or cardPriority tags found. Setting empty cache.');
    // Genuinely empty: this KB has no cards and no tags, so an empty mirror is
    // the truth, not an absence of data.
    await writeCardPriorityCache(plugin, []);
    await persistCardPriorityStore(plugin, [], Date.now(), Date.now());
    return;
  }

  const cardPriorityInfos: CardPriorityInfo[] = [];
  const batchSize = 100;

  // Pass 1: tagged rems via PluginRem (no findOne / hasPowerup).
  let lastTaggedDecade = -1;
  for (let i = 0; i < taggedForInheritanceRems.length; i += batchSize) {
    const batch = taggedForInheritanceRems.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (rem) => {
        const preloadedCards = cardsByRem.get(rem._id) || [];
        return await getCardPriority(plugin, rem, { preloadedCards });
      })
    );

    cardPriorityInfos.push(...(batchResults.filter((info) => info !== null) as CardPriorityInfo[]));

    const processed = Math.min(i + batchSize, taggedForInheritanceRems.length);
    const decade = Math.floor((processed / taggedForInheritanceRems.length) * 100 / 10) * 10;
    if (decade > lastTaggedDecade) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `[Card Priority Cache] Pass 1 (tagged) progress: ${decade}% (${processed}/${taggedForInheritanceRems.length}) — ${elapsed}s elapsed`
      );
      lastTaggedDecade = decade;
    }
  }

  // Pass 2: untagged rems with cards (require findOne; will walk ancestors).
  const pass2Start = Date.now();
  let lastUntaggedDecade = -1;
  for (let i = 0; i < untaggedWithCards.length; i += batchSize) {
    const batch = untaggedWithCards.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (remId) => {
        const rem = await plugin.rem.findOne(remId);
        if (!rem) return null;
        const preloadedCards = cardsByRem.get(remId) || [];
        return await getCardPriority(plugin, rem, { preloadedCards });
      })
    );

    cardPriorityInfos.push(...(batchResults.filter((info) => info !== null) as CardPriorityInfo[]));

    const processed = Math.min(i + batchSize, untaggedWithCards.length);
    const decade = Math.floor((processed / Math.max(1, untaggedWithCards.length)) * 100 / 10) * 10;
    if (decade > lastUntaggedDecade) {
      const elapsed = Math.round((Date.now() - pass2Start) / 1000);
      console.log(
        `[Card Priority Cache] Pass 2 (untagged) progress: ${decade}% (${processed}/${untaggedWithCards.length}) — ${elapsed}s elapsed`
      );
      lastUntaggedDecade = decade;
    }
  }

  console.log(`[Card Priority Cache] Found ${cardPriorityInfos.length} raw entries. Calculating percentiles...`);

  const percentileByRem = calculateCardRemPercentilesFromCards(cardPriorityInfos);
  const enrichedInfos = cardPriorityInfos.map((info) => ({
    ...info,
    kbPercentile: percentileByRem[info.remId] ?? 0,
  }));

  // Full rebuild (the 'Update all inherited Card Priorities' command): mirror it
  // immediately rather than five seconds later.
  await writeCardPriorityCache(plugin, enrichedInfos);
  // 'Update all inherited Card Priorities' reads every priority from the DB, so
  // it is a cold build by any other name and may advance builtAt.
  await persistCardPriorityStore(plugin, enrichedInfos, startTime, startTime);
  const totalTime = Math.round((Date.now() - startTime) / 1000);
  console.log(`[Card Priority Cache] Successfully built and enriched cache with ${enrichedInfos.length} entries in ${totalTime}s.`);
}


/**
 * Maximum age of a persisted blob that may still be used for a warm start.
 *
 * This is the backstop for the one change the warm path cannot see. A priority
 * hand-edited in the editor moves a CHILD rem and leaves the tagged rem's
 * `updatedAt` untouched (measured — lib/updated_at_probe.ts). While the plugin is
 * running that does not matter, because the GlobalRemChanged listener catches it
 * and the mirror is rewritten. But a hand edit made on ANOTHER DEVICE, or with
 * the plugin disabled, arrives with no signal the warm path can detect.
 *
 * A periodic cold rebuild bounds how long such an edit can stay wrong, turning an
 * unbounded silent staleness into "at most a week". Cheap: one cold build every
 * seven days instead of every launch.
 */
const MAX_WARM_STORE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many reused entries to spot-check against the database before trusting the
 * blob. Any mismatch aborts the warm start and falls back to a cold build.
 *
 * The sample is not looking for the hand-edit case above (a sample of 200 in
 * 45,000 would usually miss a single edited rem). It is looking for the blob
 * being wrong in bulk — a botched write, a KB restored from backup, an import
 * that rewrote priorities wholesale — where even a small sample hits it. It costs
 * one slot read each, so ~200 calls against the ~135,000 a cold build would pay.
 */
const WARM_SELF_CHECK_SAMPLE = 200;

/**
 * Builds a CardPriorityInfo from a stored priority/source plus the rem's cards,
 * with NO database access at all.
 *
 * This is what makes the warm path worth having: the card-derived fields are the
 * bulk of a CardPriorityInfo, and every one of them is computable locally from
 * the single card.getAll() the build already does. Only priority and source ever
 * needed a slot read, and those are what the blob holds.
 *
 * Kept deliberately in step with getCardPriority's arithmetic — the `?? Infinity`
 * on nextRepetitionTime is what implicitly excludes disabled cards from due
 * counts, and diverging here would give warm and cold builds different due counts.
 */
function buildInfoFromStore(
  remId: RemId,
  stored: { priority: number; source: PrioritySource },
  cards: Card[]
): CardPriorityInfo {
  const now = Date.now();
  const startOfToday = dayjs().startOf('day').valueOf();
  return {
    remId,
    priority: stored.priority,
    source: stored.source,
    // The blob does not carry lastUpdated (dropping it is a third of its bytes,
    // and only one comparison reads it). Zero means "unknown", which makes
    // flushCacheUpdates treat any incoming update as newer — the DB-wins
    // direction, which is the safe one for a value we did not read.
    lastUpdated: 0,
    cardCount: cards.length,
    dueCards: cards.filter((c) => (c.nextRepetitionTime ?? Infinity) <= now).length,
    dueCardsOverdue: cards.filter((c) => (c.nextRepetitionTime ?? Infinity) <= startOfToday).length,
    cardsNextRep: cards.map((c) => c.nextRepetitionTime ?? null),
  };
}

/**
 * Attempts Phase 1 from the persisted blob, reading slots only for rems that
 * changed.
 *
 * Returns null to mean "do a cold build" — for a missing/invalid blob, an
 * expired one, or a self-check that disagrees with the database. Never returns a
 * partially-trusted result: the caller should not have to reason about degrees.
 */
async function tryWarmPhase1(
  plugin: RNPlugin,
  taggedRems: PluginRem[],
  cardsByRem: Map<RemId, Card[]>
): Promise<{ infos: CardPriorityInfo[]; builtAt: number } | null> {
  const store = await loadPersistedCardPriorities(plugin);
  if (!store) return null;

  // Staleness is measured from builtAt — the last FULL read of the database —
  // never from syncedAt. A warm start advances syncedAt, so using that here
  // would push the deadline forward on every launch and the rebuild this guard
  // exists to force would never happen.
  const age = Date.now() - store.meta.builtAt;
  if (age > MAX_WARM_STORE_AGE_MS) {
    console.log(
      `[Card Priority Cache] Stored cache was last fully rebuilt ${Math.round(age / 86400000)}d ago ` +
        `(max ${MAX_WARM_STORE_AGE_MS / 86400000}d) — cold build to pick up any off-device hand edits.`
    );
    return null;
  }

  // Anything changed while the plugin was running, recorded as it happened. This
  // is what covers hand edits, which move a child rem and so never show up in
  // the updatedAt comparison below.
  //
  // Flushed first: the in-memory set is written on a 10s throttle, so a change
  // made moments before this build would still be sitting in memory and would be
  // read back as absent.
  await flushDirtySet(plugin);
  const dirty = await loadDirtySet(plugin);

  // Partition on the free `updatedAt` already present in the taggedRem payload:
  // no call is made to decide whether a rem needs re-reading.
  const reusable: PluginRem[] = [];
  const mustRead: PluginRem[] = [];
  for (const rem of taggedRems) {
    const stored = store.byRem.get(rem._id);
    if (!stored) {
      mustRead.push(rem); // newly tagged since the copy was written
    } else if (dirty.has(rem._id)) {
      mustRead.push(rem); // changed in a previous session, recorded at the time
    } else if (typeof rem.updatedAt === 'number' && rem.updatedAt > store.meta.syncedAt) {
      mustRead.push(rem); // touched since the copy was written
    } else {
      reusable.push(rem);
    }
  }

  console.log(
    `[Card Priority Cache] Warm start: ${reusable.length} rems from store, ` +
      `${mustRead.length} to re-read (${dirty.size} from the dirty set; ` +
      `last full rebuild ${Math.round(age / 60000)}min ago).`
  );

  // Spot-check before trusting the reused majority.
  if (reusable.length > 0) {
    const step = Math.max(1, Math.floor(reusable.length / WARM_SELF_CHECK_SAMPLE));
    const sample: PluginRem[] = [];
    for (let i = 0; i < reusable.length && sample.length < WARM_SELF_CHECK_SAMPLE; i += step) {
      sample.push(reusable[i]);
    }

    const mismatches = (
      await Promise.all(
        sample.map(async (rem) => {
          const live = await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);
          const stored = store.byRem.get(rem._id)!;
          const liveNum = parseInt(live);
          return !isNaN(liveNum) && liveNum === stored.priority ? null : rem._id;
        })
      )
    ).filter(Boolean);

    if (mismatches.length > 0) {
      console.warn(
        `[Card Priority Cache] Warm start self-check failed: ${mismatches.length}/${sample.length} ` +
          `sampled rems disagree with the store (e.g. ${mismatches.slice(0, 3).join(', ')}). Cold build.`
      );
      return null;
    }
  }

  const infos: CardPriorityInfo[] = [];
  for (const rem of reusable) {
    infos.push(buildInfoFromStore(rem._id, store.byRem.get(rem._id)!, cardsByRem.get(rem._id) || []));
  }

  const batchSize = 100;
  for (let i = 0; i < mustRead.length; i += batchSize) {
    const batch = mustRead.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((rem) =>
        getCardPriority(plugin, rem, { preloadedCards: cardsByRem.get(rem._id) || [] })
      )
    );
    for (const info of results) if (info) infos.push(info);
  }

  return { infos, builtAt: store.meta.builtAt };
}

/**
 * Builds the Card Priority Cache (distinct from the IncRem cache).
 *
 * Phase 1: Load pre-tagged cards (synchronous, blocks startup briefly)
 * Phase 2: Process untagged cards in the background
 *
 * Phase 1 optimization: instead of iterating uniqueRemIds and round-tripping
 * findOne + hasPowerup for each rem, we use the PluginRem objects already
 * returned by taggedRem() (every one of them has the powerup by definition)
 * and bucket cards from a single plugin.card.getAll() call so each rem's
 * cards arrive locally without an extra rem.getCards() round-trip.
 *
 * @param plugin Plugin instance
 */
export async function loadCardPriorityCache(
  plugin: RNPlugin,
  opts?: { forceCold?: boolean }
) {
  console.log(
    `[Card Priority Cache] Starting cache build with deferred loading...` +
      (opts?.forceCold ? ' (FORCED COLD — ignoring the saved copy)' : '')
  );

  const startTime = Date.now();

  const allCards = await plugin.card.getAll();
  const cardRemIds = allCards ? _.uniq(allCards.map((c) => c.remId)) : [];
  console.log(`[Card Priority Cache] Found ${cardRemIds.length} rems with cards`);

  // Bucket cards by rem once — replaces per-rem rem.getCards() inside getCardPriority.
  const cardsByRem = new Map<RemId, Card[]>();
  for (const c of allCards || []) {
    const arr = cardsByRem.get(c.remId);
    if (arr) arr.push(c);
    else cardsByRem.set(c.remId, [c]);
  }

  const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
  const taggedForInheritanceRems = (await cardPriorityPowerup?.taggedRem()) || [];
  const inheritanceRemIdSet = new Set<RemId>(taggedForInheritanceRems.map((r) => r._id));
  console.log(`[Card Priority Cache] Found ${inheritanceRemIdSet.size} rems tagged with cardPriority powerup`);

  // Untagged-with-cards = rems with cards that are NOT tagged. taggedRem()
  // already tells us which rems carry the powerup, so we can split without
  // per-rem hasPowerup checks.
  const untaggedRemIds: string[] = cardRemIds.filter((id) => !inheritanceRemIdSet.has(id));
  // Inheritance-only = rems tagged with cardPriority that have no cards of
  // their own (they exist purely so descendants can inherit the priority).
  const inheritanceOnlyCount = inheritanceRemIdSet.size - (cardRemIds.length - untaggedRemIds.length);
  const totalUnique = cardRemIds.length + inheritanceOnlyCount;
  console.log(
    `[Card Priority Cache] Total ${totalUnique} rems to process (${cardRemIds.length} with cards + ${inheritanceOnlyCount} inheritance-only)`
  );

  if (totalUnique === 0) {
    console.log('[Card Priority Cache] No cards or cardPriority tags found. Setting empty cache.');
    await writeCardPriorityCache(plugin, []);
    await persistCardPriorityStore(plugin, [], Date.now(), Date.now());
    return;
  }

  const phase1Start = Date.now();
  // Baseline for the NEXT startup's updatedAt delta. Taken before any reading
  // starts, so anything changed while this build runs is re-read next time
  // instead of falling into the gap between the read and the write.
  const syncStartedAt = Date.now();

  // Warm path first. It returns null for anything that makes the stored blob
  // untrustworthy — absent, wrong version, wrong KB, too old, or a self-check
  // that disagrees with the database — and the cold build below runs unchanged.
  // The cold build is not a degraded mode; it is what writes the blob the next
  // warm start depends on.
  //
  // forceCold skips it entirely. The 'Refresh Card Priority Cache' command exists
  // precisely for when the cache is suspected of being wrong, and answering that
  // by handing back the saved copy — which is derived from the same suspect state
  // — would make the command useless in the one situation anyone runs it. It
  // re-reads every slot from the database and rewrites the saved copy from what
  // it finds, so it also repairs the copy rather than merely bypassing it.
  const warmPriorities = opts?.forceCold
    ? null
    : await tryWarmPhase1(plugin, taggedForInheritanceRems, cardsByRem);

  if (warmPriorities) {
    const percentileByRemWarm = calculateCardRemPercentilesFromCards(warmPriorities.infos);
    const enrichedWarm = warmPriorities.infos.map((info) => ({
      ...info,
      kbPercentile: percentileByRemWarm[info.remId] ?? 0,
    }));
    await writeCardPriorityCache(plugin, enrichedWarm);
    // builtAt is CARRIED OVER, not refreshed: this build reused stored values for
    // most rems rather than reading them, so it is not a full verification and
    // must not reset the staleness deadline.
    await persistCardPriorityStore(plugin, enrichedWarm, warmPriorities.builtAt, syncStartedAt);

    const warmTime = Math.round((Date.now() - phase1Start) / 1000);
    const totalWarmTime = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `[Card Priority Cache] Phase 1 complete (WARM). ${enrichedWarm.length} rems in ${warmTime}s ` +
      `(total ${totalWarmTime}s including ${totalWarmTime - warmTime}s setup)`
    );
    if (enrichedWarm.length > 0) {
      await plugin.app.toast(`✅ Loaded ${enrichedWarm.length} card priorities in ${totalWarmTime}s`);
    }
    await schedulePhase2(plugin, untaggedRemIds, totalUnique);
    return;
  }

  console.log(`[Card Priority Cache] Phase 1 (COLD) - Loading ${taggedForInheritanceRems.length} pre-tagged rems...`);
  const taggedPriorities: CardPriorityInfo[] = [];

  // Rescheduling these calls was tried and did nothing: replacing the batch
  // barrier with a sliding window of workers moved throughput 465 -> 489 rem/s,
  // while the IncRem cache load and the card.getAll() setup — neither of them
  // touched — got 5.7% and 14% faster in the same run. That was machine variance,
  // not the change, so the batching below was kept for being simpler.
  //
  // What that experiment did NOT establish, despite an earlier note here claiming
  // it did, is a fixed IPC ceiling. Most runs sit at ~465-490 rem/s (~1,400 slot
  // reads/s), but one hit 2,972 rem/s — six times faster, same code. It was not
  // cold-start versus plugin-reload, as first guessed: the 97s run was a reload
  // too. What the fast run had just done was a full CardPriority snapshot, which
  // reads the very same three slots on the very same 45k rems, leaving RemNote's
  // own store hot for exactly this loop's next pass.
  //
  // So the number to plan against is the cold one. Never benchmark this
  // immediately after a snapshot capture or another full build.
  //
  // The durable lever is still FEWER calls. Phase 1 issues three per rem — the
  // priority, source and lastUpdated slots read in getCardPriority. The warm path
  // above removes nearly all of them; see lib/card_priority/persistence.ts, and
  // lib/updated_at_probe.ts for why rem.updatedAt alone cannot be trusted as the
  // change signal.
  const checkBatchSize = 100;
  let lastProgressLogged = -1;
  for (let i = 0; i < taggedForInheritanceRems.length; i += checkBatchSize) {
    const batch = taggedForInheritanceRems.slice(i, i + checkBatchSize);

    const batchResults = await Promise.all(
      batch.map(async (rem) => {
        const preloadedCards = cardsByRem.get(rem._id) || [];
        return await getCardPriority(plugin, rem, { preloadedCards });
      })
    );
    for (const info of batchResults) {
      if (info) taggedPriorities.push(info);
    }

    const processed = Math.min(i + checkBatchSize, taggedForInheritanceRems.length);
    const progress = Math.floor((processed / taggedForInheritanceRems.length) * 100);
    const decade = Math.floor(progress / 10) * 10;
    if (decade > lastProgressLogged) {
      const elapsed = Math.round((Date.now() - phase1Start) / 1000);
      console.log(
        `[Card Priority Cache] Phase 1 progress: ${decade}% (${processed}/${taggedForInheritanceRems.length}) — ${elapsed}s elapsed`
      );
      lastProgressLogged = decade;
    }
  }

  console.log(`[Card Priority Cache] Found ${taggedPriorities.length} tagged entries. Calculating percentiles...`);
  const percentileByRemPhase1 = calculateCardRemPercentilesFromCards(taggedPriorities);
  const enrichedTaggedPriorities = taggedPriorities.map((info) => ({
    ...info,
    kbPercentile: percentileByRemPhase1[info.remId] ?? 0,
  }));

  // Cold build: the mirror must land with it, so the next launch can start warm.
  await writeCardPriorityCache(plugin, enrichedTaggedPriorities);
  // Cold build: every priority came from the database, so this DOES advance
  // builtAt and restarts the staleness clock.
  await persistCardPriorityStore(plugin, enrichedTaggedPriorities, syncStartedAt, syncStartedAt);

  const phase1Ms = Date.now() - phase1Start;
  const phase1Time = Math.round(phase1Ms / 1000);
  const totalTime = Math.round((Date.now() - startTime) / 1000);
  // Throughput and concurrency are logged, not just the wall clock, so a pasted
  // log is comparable across runs on different-sized libraries and says which
  // scheduling strategy produced it. Setup is broken out because it is a fixed
  // card.getAll() + taggedRem() cost that no change to the loop below can move.
  const remsPerSec = phase1Ms > 0 ? Math.round((enrichedTaggedPriorities.length / phase1Ms) * 1000) : 0;
  console.log(
    `[Card Priority Cache] Phase 1 complete. Loaded and enriched ${enrichedTaggedPriorities.length} tagged rems ` +
    `in ${phase1Time}s (${remsPerSec} rem/s, batch ${checkBatchSize}; ` +
    `total ${totalTime}s including ${totalTime - phase1Time}s setup)`
  );

  if (enrichedTaggedPriorities.length > 0) {
    await plugin.app.toast(`✅ Loaded ${enrichedTaggedPriorities.length} pre-tagged card priorities in ${totalTime}s`);
  }

  await schedulePhase2(plugin, untaggedRemIds, totalUnique);
}

/**
 * Kicks off the deferred phase, or closes out the build when there is nothing
 * deferred. Shared by the warm and cold paths so they cannot drift on what
 * "finished" means — notably the card_priority_cache_fully_loaded flag, which
 * the inheritance cascade reads to decide whether the cache can be trusted as a
 * has-cards index.
 */
async function schedulePhase2(
  plugin: RNPlugin,
  untaggedRemIds: string[],
  totalUnique: number
) {
  console.log(`[Card Priority Cache] Found ${untaggedRemIds.length} untagged rems with cards for deferred processing`);

  if (untaggedRemIds.length === 0) {
    console.log('[Card Priority Cache] All rems with cards are pre-tagged! No deferred processing needed.');
    await plugin.app.toast('✅ All card priorities loaded!');
    await plugin.storage.setSession('card_priority_cache_fully_loaded', true);
    return;
  }

  const untaggedPercentage = Math.round((untaggedRemIds.length / totalUnique) * 100);
  if (untaggedPercentage > 20) {
    await plugin.app.toast(`⏳ Processing ${untaggedRemIds.length} untagged rems in background... `);
  }

  setTimeout(async () => {
    await processDeferredCardPriorityCache(plugin, untaggedRemIds);
  }, 3000);
}

/**
 * Processes untagged cards in the background and incrementally updates the cache.
 *
 * @param plugin Plugin instance
 * @param untaggedRemIds Array of rem IDs that don't have cardPriority tags yet
 */
async function processDeferredCardPriorityCache(plugin: RNPlugin, untaggedRemIds: string[]) {
  console.log(`[Card Priority Cache] Phase 2 (deferred) - Starting background processing of ${untaggedRemIds.length} untagged cards...`);
  const startTime = Date.now();

  let processed = 0;
  let errorCount = 0;
  const notFoundRemIds: string[] = [];
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
              // The card store reports this rem, but the rem itself is gone —
              // i.e. an orphan card. Collect the IDs and log them once as a
              // group below (a per-rem warn here spams the console with an
              // async stack trace for every orphan).
              notFoundRemIds.push(remId);
              return;
            }

            // Read the current value BEFORE calculating, and pass it in.
            //
            // This third argument is not optional in spirit: calculateNewPriority's
            // first act is to return `existingPriority` unchanged when its source is
            // 'manual' or 'incremental'. Called without it (the previous behaviour)
            // that guard is dead code, and the function recomputes from scratch —
            // IncRem → ancestor → default — then the write below stamps the result
            // over whatever the user had set by hand.
            //
            // It stays invisible in normal use, because a rem with a manual priority
            // is tagged, and tagged rems never reach Phase 2 (they are filtered out
            // via the powerup's taggedRem() list in loadCardPriorityCache). The risk
            // is whenever that list under-reports — which it demonstrably does; it is
            // exactly what the debug widget's CardPriority Tag Audit exists to
            // measure. Any rem it omits reaches Phase 2 and, before this change,
            // had its manual priority recomputed away.
            //
            // NOTE: this is a latent bug fixed on its own merits. It is NOT the cause
            // of manual priorities being lost when importing between knowledge bases —
            // that was traced to RemNote's importer and reproduced with the plugin
            // fully disabled (see the wiki Troubleshooting entry).
            const existing = await getCardPriority(plugin, rem);
            const calculated = await calculateNewPriority(plugin, rem, existing);

            let cardInfo = existing;
            const unchanged =
              existing &&
              existing.priority === calculated.priority &&
              existing.source === calculated.source;

            if (!unchanged) {
              await setCardPriority(plugin, rem, calculated.priority, calculated.source);
              cardInfo = await getCardPriority(plugin, rem);
            }

            if (cardInfo) {
              newPriorities.push(cardInfo);
            }

            processed++;
          } catch (error) {
            console.error(`[Card Priority Cache] DEFERRED: Error processing rem ${remId}:`, error);
            errorCount++;
          }
        })
      );

      if (newPriorities.length > 0) {
        const currentCache = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
        const mergedCache = [...currentCache, ...newPriorities];

        const percentileByRemDeferred = calculateCardRemPercentilesFromCards(mergedCache);
        const enrichedCache = mergedCache.map((info) => ({
          ...info,
          kbPercentile: percentileByRemDeferred[info.remId] ?? 0,
        }));

        await writeCardPriorityCache(plugin, enrichedCache);
        await plugin.storage.setSession(cardPriorityCacheRefreshKey, Date.now());
      }

      if (
        processed % Math.max(500, Math.floor(untaggedRemIds.length * 0.2)) === 0 ||
        processed === untaggedRemIds.length
      ) {
        const progress = Math.round((processed / untaggedRemIds.length) * 100);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[Card Priority Cache] Phase 2 progress: ${progress}% (${processed}/${untaggedRemIds.length}) — ${elapsed}s elapsed`);
      }

      if (i + batchSize < untaggedRemIds.length) {
        await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
      }
    }

    const totalTime = Math.round((Date.now() - startTime) / 1000);
    const notFoundCount = notFoundRemIds.length;
    console.log(
      `[Card Priority Cache] Phase 2 complete. ` +
      `Processed ${processed} cards in ${totalTime}s ` +
      `(${notFoundCount} orphan rems skipped, ${errorCount} errors)`
    );

    // Persist orphan rem IDs so the 'Update all inherited Card Priorities'
    // cleanup can reuse them without re-scanning, and surface a non-destructive
    // suggestion. We deliberately do NOT auto-delete here: cache build runs at
    // startup before sync may have fully hydrated, so a transient null must not
    // trigger irreversible card removal.
    if (notFoundCount > 0) {
      console.log(`[Card Priority Cache] ${notFoundCount} orphan rem(s) (cards exist but rem not found):`);
      console.log(notFoundRemIds.join('\n'));
      await plugin.storage.setSession(orphanRemIdsKey, notFoundRemIds);
      setTimeout(() => {
        plugin.app.toast(
          `⚠️ ${notFoundCount} orphan card${notFoundCount === 1 ? '' : 's'} detected (their rem was deleted). ` +
          `Run 'Update all inherited Card Priorities' command to review and clean them up.`
        );
      }, 2500);
    } else {
      await plugin.storage.setSession(orphanRemIdsKey, []);
    }

    await plugin.app.toast(`✅ Background processing complete! All ${processed} card priorities are now cached (${totalTime}s).`);
    await plugin.storage.setSession('card_priority_cache_fully_loaded', true);

    if (untaggedRemIds.length > 1000) {
      setTimeout(() => {
        plugin.app.toast(
          `💡 Tip: Run 'Update all inherited Card Priorities' to avoid background processing in future sessions`
        );
      }, 2000);
    }
  } catch (error) {
    console.error('[Card Priority Cache] Phase 2 fatal error during background processing:', error);
    await plugin.app.toast('⚠️ Background processing encountered an error. Some cards may not be cached.');
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}
