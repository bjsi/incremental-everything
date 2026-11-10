import { PluginRem, ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import { allIncrementalRemKey, allIncrementalRemSlimKey, powerupCode } from '../consts';
import { IncrementalRem } from './types';
import { getIncrementalRemFromRem } from './index';
import {
  INCREM_MAX_WARM_STORE_AGE_MS,
  loadPersistedIncRems,
  persistIncRemStore,
  snapshotIncRemDirtySet,
} from './persistence';

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
 * Applies several cache changes with one read and one write — an IncRem to
 * upsert, or `null` to remove it. For a caller that changes many rems at once
 * (the tracker's review jobs), where one updateIncrementalRemCache per rem
 * would move the whole cache across the bridge every time.
 */
export async function applyIncRemCacheChanges(
  plugin: RNPlugin,
  changes: Map<string, IncrementalRem | null>
): Promise<void> {
  if (changes.size === 0) return;
  const allRems: IncrementalRem[] =
    (await plugin.storage.getSession(allIncrementalRemKey)) || [];
  const upserts = [...changes.values()].filter((r): r is IncrementalRem => r !== null);
  await writeIncRemCaches(
    plugin,
    allRems.filter((r) => !changes.has(r.remId)).concat(upserts)
  );
  if (knownIncRemIdsPopulated) {
    for (const [remId, entry] of changes) {
      if (entry) knownIncRemIds.add(remId);
      else knownIncRemIds.delete(remId);
    }
  }
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

// ── Loading ─────────────────────────────────────────────────────────────────

/**
 * Rems read at once on a load. Each read is a short chain of mostly sequential
 * calls, so this is roughly the number of calls the load keeps in flight. The
 * bridge serves calls at a fixed rate whatever the scheduling (see
 * lib/updated_at_probe.ts), so a small window costs the load almost nothing — and
 * it is what lets a widget's call get answered in milliseconds instead of waiting
 * behind thousands (the old 500-Rem Promise.all batches kept ~5,000 in flight).
 */
const LOAD_CONCURRENCY = 24;

/** Reused entries compared against the database before trusting the copy. */
const WARM_SELF_CHECK_SAMPLE = 100;

/** More disagreements than this share of the sample means the copy is wrong in bulk. */
const WARM_SELF_CHECK_MAX_MISMATCH_SHARE = 0.05;

/** The copy (~8 MB) is written this long after a load, clear of the startup rush. */
const PERSIST_DELAY_MS = 30_000;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readIncRems(plugin: RNPlugin, rems: PluginRem[]): Promise<IncrementalRem[]> {
  const read = await mapWithConcurrency(rems, LOAD_CONCURRENCY, (rem) =>
    getIncrementalRemFromRem(plugin, rem, { knownTagged: true }).catch((err) => {
      console.warn('[IncRem Cache] Failed to read', rem._id, err);
      return null;
    })
  );
  return read.filter((r): r is IncrementalRem => r !== null);
}

/**
 * Whether a stored entry still matches the database. History is compared by
 * length and last date, which every review and priority change moves. One
 * drift is not a disagreement: an IncRem with no next-rep date at all resolves
 * to "due now" (today's midnight), so its live value moves forward every day.
 */
function sameEntry(stored: IncrementalRem, live: IncrementalRem, startOfToday: number): boolean {
  if (stored.priority !== live.priority) return false;
  if ((stored.prioritySource ?? 'slot') !== (live.prioritySource ?? 'slot')) return false;
  if ((stored.createdAt ?? null) !== (live.createdAt ?? null)) return false;
  const sh = stored.history ?? [];
  const lh = live.history ?? [];
  if (sh.length !== lh.length) return false;
  if (sh.length > 0 && sh[sh.length - 1]?.date !== lh[lh.length - 1]?.date) return false;
  if (stored.nextRepDate !== live.nextRepDate) {
    const dueNowDrift = live.nextRepDate === startOfToday && stored.nextRepDate <= live.nextRepDate;
    if (!dueNowDrift) return false;
  }
  return true;
}

type WarmLoad = {
  entries: IncrementalRem[];
  /** Whether the entries differ from the stored copy (so it must be rewritten). */
  changed: boolean;
  builtAt: number;
};

/**
 * Builds the cache from the stored copy, reading only the IncRems that changed.
 * Returns null to mean "cold load": no usable copy, a copy past its age, or a
 * self-check that disagrees with the database in bulk.
 */
async function tryWarmLoad(
  plugin: RNPlugin,
  taggedRem: PluginRem[],
  dirty: Set<string>
): Promise<WarmLoad | null> {
  const store = await loadPersistedIncRems(plugin);
  if (!store) return null;

  const age = Date.now() - store.meta.builtAt;
  if (age > INCREM_MAX_WARM_STORE_AGE_MS) {
    console.log(
      `[IncRem Cache] Stored copy was last fully read ${Math.round(age / 86400000)}d ago ` +
        `(max ${INCREM_MAX_WARM_STORE_AGE_MS / 86400000}d) — cold load to pick up any off-device hand edits.`
    );
    return null;
  }

  const reusable: PluginRem[] = [];
  const mustRead: PluginRem[] = [];
  for (const rem of taggedRem) {
    if (!store.byRem.has(rem._id)) mustRead.push(rem); // made incremental since the copy
    else if (dirty.has(rem._id)) mustRead.push(rem); // changed while the plugin was running
    else if (typeof rem.updatedAt === 'number' && rem.updatedAt > store.meta.syncedAt) mustRead.push(rem);
    else reusable.push(rem);
  }

  console.log(
    `[IncRem Cache] Warm start: ${reusable.length} IncRems from the stored copy, ${mustRead.length} to re-read ` +
      `(${dirty.size} in the dirty set; last full read ${Math.round(age / 60000)}min ago).`
  );

  // Spot-check an even spread of the reused majority.
  const step = Math.max(1, Math.floor(reusable.length / WARM_SELF_CHECK_SAMPLE));
  const sample: PluginRem[] = [];
  for (let i = 0; i < reusable.length && sample.length < WARM_SELF_CHECK_SAMPLE; i += step) {
    sample.push(reusable[i]);
  }
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const live = await readIncRems(plugin, sample);
  const liveById = new Map(live.map((r) => [r.remId, r]));
  const mismatched = new Map<string, IncrementalRem | null>();
  for (const rem of sample) {
    const fresh = liveById.get(rem._id) ?? null;
    if (!fresh || !sameEntry(store.byRem.get(rem._id)!, fresh, startOfToday)) mismatched.set(rem._id, fresh);
  }
  if (mismatched.size > Math.max(1, Math.floor(sample.length * WARM_SELF_CHECK_MAX_MISMATCH_SHARE))) {
    console.warn(
      `[IncRem Cache] Warm start self-check failed: ${mismatched.size}/${sample.length} sampled IncRems ` +
        `disagree with the stored copy (e.g. ${[...mismatched.keys()].slice(0, 3).join(', ')}). Cold load.`
    );
    return null;
  }
  if (mismatched.size > 0) {
    console.log(
      `[IncRem Cache] Self-check: ${mismatched.size}/${sample.length} sampled IncRems had changed ` +
        `without a trace (${[...mismatched.keys()].join(', ')}) — refreshed from the database.`
    );
  }

  const reread = await readIncRems(plugin, mustRead);
  const entries: IncrementalRem[] = [];
  for (const rem of reusable) {
    if (mismatched.has(rem._id)) {
      const fresh = mismatched.get(rem._id);
      if (fresh) entries.push(fresh);
    } else {
      entries.push(store.byRem.get(rem._id)!);
    }
  }
  entries.push(...reread);

  const changed = mustRead.length > 0 || mismatched.size > 0 || entries.length !== store.byRem.size;
  return { entries, changed, builtAt: store.meta.builtAt };
}

/**
 * Loads all Rems tagged with the Incremental powerup into the session cache.
 *
 * Warm when it can (lib/incremental_rem/persistence.ts): the stored copy, with
 * only the IncRems that changed read again. Cold otherwise: every IncRem read,
 * LOAD_CONCURRENCY at a time. Either way the copy is written again shortly after.
 */
export async function loadIncrementalRemCache(
  plugin: ReactRNPlugin,
  opts?: { forceCold?: boolean }
): Promise<IncrementalRem[]> {
  console.log('[IncRem Cache] Loading started...' + (opts?.forceCold ? ' (FORCED COLD)' : ''));
  // Taken before anything is read, so a change made while the load runs is newer
  // than syncedAt and gets re-read next time.
  const startTime = Date.now();
  const powerup = await plugin.powerup.getPowerupByCode(powerupCode);
  const taggedRem = (await powerup?.taggedRem()) || [];
  const dirty = await snapshotIncRemDirtySet(plugin).catch(() => new Set<string>());

  let warm: WarmLoad | null = null;
  if (!opts?.forceCold) {
    try {
      warm = await tryWarmLoad(plugin, taggedRem, dirty);
    } catch (err) {
      console.warn('[IncRem Cache] Warm start failed — cold load.', err);
    }
  }
  const updatedAllRem = warm ? warm.entries : await readIncRems(plugin, taggedRem);

  await writeIncRemCaches(plugin, updatedAllRem);
  await plugin.storage.setSession('inc_rem_cache_fully_loaded', true);

  // Refresh this realm's fast-path index from the authoritative load.
  knownIncRemIds.clear();
  for (const r of updatedAllRem) knownIncRemIds.add(r.remId);
  knownIncRemIdsPopulated = true;

  const elapsed = Date.now() - startTime;
  console.log(
    `[IncRem Cache] Loading complete (${warm ? 'WARM' : 'COLD'}): ${updatedAllRem.length} IncRems loaded in ${elapsed}ms`
  );

  const builtAt = warm ? warm.builtAt : startTime;
  const entriesToWrite = warm && !warm.changed ? null : updatedAllRem;
  setTimeout(() => {
    persistIncRemStore(plugin, entriesToWrite, updatedAllRem.length, builtAt, startTime, dirty).catch((err) =>
      console.error('[IncRem store] persist failed:', err)
    );
  }, PERSIST_DELAY_MS);

  return updatedAllRem;
}
