// lib/card_priority/persistence.ts
//
// The single place the card-priority cache is written, and the local-storage
// copy that lets the next startup skip most of the build.
//
// WHY A CHOKE POINT
//
// The session cache is authoritative for the UI, and about a dozen places write
// it: the two full builds, every incremental flush, the deferred phase, the
// batch cleanup, and two optimistic pushes in priority.tsx. Routing them all
// through writeCardPriorityCache keeps the dirty-set bookkeeping below in one
// place instead of asking every writer to remember it.
//
// WHY THE COPY IS WRITTEN ONCE PER STARTUP, NOT ON EVERY CHANGE
//
// It was originally kept continuously in step with the session cache, on a 5s
// throttle. That was work whose output nothing consumed: this copy is read at
// exactly one moment, the next startup. Writing it during the session meant
// ~3.2 MB per flush — so a queue session answering steadily rewrote the whole
// store every five seconds, to record a handful of changed rows that the next
// startup would happily have re-read for itself.
//
// Now: the copy is written once, right after a build, and during the session
// only the IDs of changed rems are recorded (a few bytes each). The next startup
// re-reads those, merges, and writes the copy again.
//
// WHY A DIRTY SET AT ALL, WHEN updatedAt EXISTS
//
// Strictly it is needed only for hand edits. Every plugin-side priority write
// goes through setCardPriority, which writes the hidden prioritySource and
// lastUpdated slots, which moves the rem's `updatedAt` — and the warm path
// re-reads everything whose updatedAt is newer than the copy. A hand edit of the
// visible Priority property row changes a CHILD rem instead, leaving the tagged
// rem's updatedAt untouched (measured — lib/updated_at_probe.ts).
//
// Every change is recorded regardless, not just the hand edits. It costs bytes,
// and it removes the dependency on that updatedAt reasoning being exhaustive.
//
// THE TWO TIMESTAMPS, AND WHY THEY ARE NOT ONE
//
// `builtAt` is when the data was last read from the database in full — a cold
// build, and nothing else. `syncedAt` is when the copy was last brought up to
// date, which a warm start also does.
//
// They must not be collapsed. `syncedAt` is the baseline for the updatedAt
// delta, so it has to advance on every warm start. `builtAt` drives the
// staleness rebuild, whose whole purpose is to catch changes that leave no
// detectable trace; if a warm start advanced it, the deadline would reset on
// every launch and the rebuild would never happen. One timestamp doing both jobs
// silently disables the guard.
//
// SHAPE
//
// [remId, priority, source] tuples in ONE key — tuples because at 45k rows the
// repeated JSON keys of an object form roughly triple the bytes, one key because
// local storage was probed at 128 MB without complaint (lib/local_storage_probe.ts;
// do NOT size local keys against the ~896 KB synced ceiling). The card-derived
// fields — cardCount, dueCards, dueCardsOverdue, cardsNextRep, kbPercentile —
// are deliberately absent: due-ness moves with the clock, so they are recomputed
// from the single card.getAll() every launch regardless, and storing them would
// only create a second, staler copy.

import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { allCardPriorityInfoKey } from '../consts';
import { CardPriorityInfo, PrioritySource } from './types';

/**
 * Bump to invalidate every stored copy after a shape change.
 *
 * v2: one key instead of 23 chunks, and builtAt/syncedAt split out of savedAt.
 */
export const CARD_PRIORITY_STORE_VERSION = 2;

const STORE_KEY_PREFIX = 'card-priority-store';
const DIRTY_KEY_PREFIX = 'card-priority-dirty';
/** v1 keys, cleaned up on sight. */
const LEGACY_META_PREFIX = 'card-priority-store-meta';
const LEGACY_CHUNK_PREFIX = 'card-priority-store-chunk';

/** At most one dirty-set flush per this interval, however many changes arrive. */
const DIRTY_FLUSH_THROTTLE_MS = 10000;

export type StoredRow = [RemId, number, PrioritySource];

export interface StoreMeta {
  version: number;
  kbId: string;
  /** When the data was last read from the database IN FULL. Only a cold build
   *  may advance this — see the header note on the two timestamps. */
  builtAt: number;
  /** When the copy was last brought up to date. Baseline for the updatedAt
   *  delta; a warm start advances it. */
  syncedAt: number;
  count: number;
}

interface StoredBlob {
  meta: StoreMeta;
  rows: StoredRow[];
}

async function currentKbId(plugin: RNPlugin): Promise<string | null> {
  try {
    return (await plugin.kb.getCurrentKnowledgeBaseData())?._id ?? null;
  } catch {
    return null;
  }
}

const storeKey = (kbId: string) => `${STORE_KEY_PREFIX}::${kbId}`;
const dirtyKey = (kbId: string) => `${DIRTY_KEY_PREFIX}::${kbId}`;

// ── Session cache ───────────────────────────────────────────────────────────

/**
 * Writes the card-priority cache that the UI reads.
 *
 * Always awaited and never deferred: every widget reads this key, including
 * card_info_bar during a queue session, and a priority that took five seconds to
 * appear would read as a failed save.
 *
 * This no longer touches local storage. Changed rems are recorded via
 * markCardPriorityDirty, and the copy is written once per startup instead.
 */
export async function writeCardPriorityCache(
  plugin: RNPlugin,
  infos: CardPriorityInfo[]
): Promise<void> {
  await plugin.storage.setSession(allCardPriorityInfoKey, infos);
}

// ── Dirty set ───────────────────────────────────────────────────────────────

let dirtyIds = new Set<RemId>();
let dirtyFlushTimer: ReturnType<typeof setTimeout> | null = null;
let lastDirtyFlush = 0;

/**
 * Records that a rem's priority changed, for the next startup to re-read.
 *
 * Synchronous and non-throwing by construction — it runs inside the cache flush,
 * on the path taken by every priority change.
 */
export function markCardPriorityDirty(plugin: RNPlugin, remId: RemId): void {
  dirtyIds.add(remId);
  scheduleDirtyFlush(plugin);
}

/**
 * A THROTTLE, not a debounce. The timer starts on the first change of a burst
 * and is never postponed, so the set reaches disk within DIRTY_FLUSH_THROTTLE_MS
 * of the first change. A debounce would push the deadline forward on every
 * change, and a queue session — which changes priorities continuously — could
 * run for an hour without the set ever being written.
 */
function scheduleDirtyFlush(plugin: RNPlugin): void {
  if (dirtyFlushTimer) return;
  const wait = Math.max(0, DIRTY_FLUSH_THROTTLE_MS - (Date.now() - lastDirtyFlush));
  dirtyFlushTimer = setTimeout(() => {
    dirtyFlushTimer = null;
    lastDirtyFlush = Date.now();
    flushDirtySet(plugin).catch((err) =>
      console.error('[CardPriority store] dirty-set flush failed:', err)
    );
  }, wait);
}

/**
 * Merges the in-memory set into the stored one.
 *
 * Merges rather than overwrites: a previous session may have ended before its
 * own flush landed, and dropping those ids would lose exactly the hand edits the
 * set exists to record.
 */
export async function flushDirtySet(plugin: RNPlugin): Promise<void> {
  if (dirtyIds.size === 0) return;
  const kbId = await currentKbId(plugin);
  if (!kbId) return;
  const existing = (await plugin.storage.getLocal<RemId[]>(dirtyKey(kbId))) || [];
  const merged = new Set([...existing, ...dirtyIds]);
  await plugin.storage.setLocal(dirtyKey(kbId), [...merged]);
}

export async function loadDirtySet(plugin: RNPlugin): Promise<Set<RemId>> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return new Set();
  return new Set((await plugin.storage.getLocal<RemId[]>(dirtyKey(kbId))) || []);
}

async function clearDirtySet(plugin: RNPlugin, kbId: string): Promise<void> {
  dirtyIds = new Set();
  if (dirtyFlushTimer) {
    clearTimeout(dirtyFlushTimer);
    dirtyFlushTimer = null;
  }
  await plugin.storage.setLocal(dirtyKey(kbId), []);
}

// ── Persisted copy ──────────────────────────────────────────────────────────

/**
 * Writes the copy. Called once per startup, right after a build.
 *
 * @param builtAt pass the previous copy's builtAt on a warm start, and `now` on
 *   a cold one. Getting this wrong in the warm direction disables the staleness
 *   rebuild entirely — see the header note.
 * @param syncedAt the moment the build STARTED reading, not the moment it
 *   finished. Anything changed while it ran is then re-read next time rather
 *   than falling into the gap between the read and the write.
 */
export async function persistCardPriorityStore(
  plugin: RNPlugin,
  infos: CardPriorityInfo[],
  builtAt: number,
  syncedAt: number
): Promise<void> {
  const startedAt = Date.now();
  const kbId = await currentKbId(plugin);
  if (!kbId) {
    console.warn('[CardPriority store] no KB id — skipping persist.');
    return;
  }

  const rows: StoredRow[] = infos.map((i) => [i.remId, i.priority, i.source]);
  const blob: StoredBlob = {
    meta: { version: CARD_PRIORITY_STORE_VERSION, kbId, builtAt, syncedAt, count: rows.length },
    rows,
  };

  await plugin.storage.setLocal(storeKey(kbId), blob);
  // Only after the copy is safely written: these ids are represented in it now,
  // and clearing them first would lose them if the write failed.
  await clearDirtySet(plugin, kbId);

  console.log(
    `[CardPriority store] persisted ${rows.length} rows in one key ` +
      `(${Date.now() - startedAt}ms), dirty set cleared`
  );
}

export interface LoadedStore {
  meta: StoreMeta;
  byRem: Map<RemId, { priority: number; source: PrioritySource }>;
}

/**
 * Reads the copy for the current KB.
 *
 * Returns null — meaning "cold build" — for everything that makes it
 * untrustworthy rather than merely old: absent, wrong schema version, or
 * belonging to another knowledge base. Staleness is deliberately NOT judged
 * here; that is the caller's policy, and it needs builtAt to apply it.
 */
export async function loadPersistedCardPriorities(
  plugin: RNPlugin
): Promise<LoadedStore | null> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return null;

  const blob = await plugin.storage.getLocal<StoredBlob>(storeKey(kbId));
  if (!blob?.meta || !Array.isArray(blob.rows)) {
    await cleanUpLegacyChunks(plugin, kbId);
    return null;
  }
  if (blob.meta.version !== CARD_PRIORITY_STORE_VERSION) {
    console.log(
      `[CardPriority store] version ${blob.meta.version} != ${CARD_PRIORITY_STORE_VERSION} — cold build.`
    );
    return null;
  }
  if (blob.meta.kbId !== kbId) {
    console.warn('[CardPriority store] copy belongs to another KB — cold build.');
    return null;
  }

  const byRem = new Map<RemId, { priority: number; source: PrioritySource }>();
  for (const [remId, priority, source] of blob.rows) {
    byRem.set(remId, { priority, source });
  }
  return { meta: blob.meta, byRem };
}

/**
 * Deletes the v1 chunk keys, which nothing reads any more.
 *
 * v1 wrote up to 23 numbered keys plus a meta key. Leaving them costs several
 * megabytes of dead local storage per knowledge base, and there is no migration
 * to do — the v2 copy is rebuilt from the database on the next cold build.
 */
async function cleanUpLegacyChunks(plugin: RNPlugin, kbId: string): Promise<void> {
  try {
    const legacyMeta = await plugin.storage.getLocal<{ chunkCount?: number }>(
      `${LEGACY_META_PREFIX}::${kbId}`
    );
    if (!legacyMeta) return;
    const count = legacyMeta.chunkCount ?? 0;
    for (let c = 0; c < count; c++) {
      await plugin.storage.setLocal(`${LEGACY_CHUNK_PREFIX}::${kbId}::${c}`, null);
    }
    await plugin.storage.setLocal(`${LEGACY_META_PREFIX}::${kbId}`, null);
    console.log(`[CardPriority store] removed ${count} legacy v1 chunk key(s).`);
  } catch (err) {
    console.warn('[CardPriority store] legacy cleanup failed (harmless):', err);
  }
}

export async function readCardPriorityStoreMeta(
  plugin: RNPlugin
): Promise<StoreMeta | null> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return null;
  const blob = await plugin.storage.getLocal<StoredBlob>(storeKey(kbId));
  return blob?.meta ?? null;
}

export async function clearPersistedCardPriorities(plugin: RNPlugin): Promise<void> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return;
  await plugin.storage.setLocal(storeKey(kbId), null);
  await clearDirtySet(plugin, kbId);
  await cleanUpLegacyChunks(plugin, kbId);
}
