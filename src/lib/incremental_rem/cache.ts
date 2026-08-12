import { ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import { allIncrementalRemKey, allIncrementalRemSlimKey, powerupCode } from '../consts';
import { IncrementalRem } from './types';
import { getIncrementalRemFromRem } from './index';

/**
 * The only fields queue item selection actually uses. See
 * {@link allIncrementalRemSlimKey} for why this projection exists.
 *
 * `IncrementalRem` is structurally assignable to this, so consumers can fall
 * back to the full cache without mapping.
 */
export type SlimIncRem = {
  remId: string;
  nextRepDate: number;
  priority: number;
};

const toSlim = (r: IncrementalRem): SlimIncRem => ({
  remId: r.remId,
  nextRepDate: r.nextRepDate,
  priority: r.priority,
});

/**
 * THE writer for the IncRem session cache. Use this instead of calling
 * `setSession(allIncrementalRemKey, …)` directly.
 *
 * It exists so the full cache and its slim projection cannot drift. Queue item
 * selection reads only the slim key, so any writer that updates membership,
 * `priority` or `nextRepDate` without updating both would silently feed the
 * queue stale data — new IncRems would never be offered, and changed priorities
 * would not reorder.
 *
 * The one deliberate exception is `history_notes.ts`, which patches only the
 * `history` field of an entry already present. None of the three slim fields can
 * change there, so its inlined write (kept inline to avoid an import cycle)
 * stays correct.
 */
export async function writeIncRemCaches(
  plugin: RNPlugin,
  allRems: IncrementalRem[]
): Promise<void> {
  await Promise.all([
    plugin.storage.setSession(allIncrementalRemKey, allRems),
    plugin.storage.setSession(allIncrementalRemSlimKey, allRems.map(toSlim)),
  ]);
}

/**
 * Ids of every Rem known to carry the Incremental powerup, as of the last full
 * cache load in THIS realm.
 *
 * Used only as a fast-path filter, never as a source of truth: a hit means "go
 * read the real data", a miss means "this Rem has never been incremental, don't
 * bother". It exists so the GlobalRemChanged listener — which fires for every
 * Rem edit in the knowledge base, thousands of times a session — stops pulling
 * the entire 7.99MB cache across the bridge just to discover that the changed
 * Rem was never incremental in the first place.
 *
 * Staleness is safe in the direction that matters. A Rem made incremental since
 * the last load is missing from the set, so its cache lookup is skipped — but
 * the caller's existing fallback reads the Rem's own slots directly, which is
 * where that history lives anyway. A Rem removed since the last load lingers in
 * the set, costing one unnecessary lookup.
 *
 * Only populated in the realm that runs `loadIncrementalRemCache` (the index
 * widget, via the tracker). Elsewhere it stays empty, and `isKnownIncRemId`
 * reports "unknown" so callers keep their old behaviour.
 */
const knownIncRemIds = new Set<string>();
let knownIncRemIdsPopulated = false;

/**
 * Three-state on purpose: `true` = known incremental, `false` = known NOT
 * incremental, `undefined` = no index in this realm, decide some other way.
 */
export function isKnownIncRemId(remId: string): boolean | undefined {
  if (!knownIncRemIdsPopulated) return undefined;
  return knownIncRemIds.has(remId);
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
  // The slim projection is derived from the array already in hand, so keeping it
  // in sync costs one extra write and no extra read.
  await writeIncRemCaches(plugin, updatedAllRems);
  if (knownIncRemIdsPopulated) knownIncRemIds.add(updatedIncRem.remId);
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
  await writeIncRemCaches(plugin, updatedAllRems);
  knownIncRemIds.delete(remId);
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

  console.log('[IncRem Cache] Loading started...');
  const startTime = Date.now();
  const powerup = await plugin.powerup.getPowerupByCode(powerupCode);
  const taggedRem = (await powerup?.taggedRem()) || [];


  const updatedAllRem: IncrementalRem[] = [];
  const numBatches = Math.ceil(taggedRem.length / batchSize);

  for (let i = 0; i < taggedRem.length; i += batchSize) {
    const batch = taggedRem.slice(i, i + batchSize);


    const batchInfos = (
      await Promise.all(batch.map((rem) => getIncrementalRemFromRem(plugin, rem)))
    ).filter(Boolean) as IncrementalRem[];

    updatedAllRem.push(...batchInfos);

    await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
  }


  await writeIncRemCaches(plugin, updatedAllRem);
  await plugin.storage.setSession('inc_rem_cache_fully_loaded', true);

  // Refresh this realm's fast-path index from the authoritative load.
  knownIncRemIds.clear();
  for (const r of updatedAllRem) knownIncRemIds.add(r.remId);
  knownIncRemIdsPopulated = true;

  const elapsed = Date.now() - startTime;
  console.log(`[IncRem Cache] Loading complete: ${updatedAllRem.length} IncRems loaded in ${elapsed}ms`);

  return updatedAllRem;
}
