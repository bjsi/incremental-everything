// lib/incremental_rem/persistence.ts
//
// The local-storage copy of the IncRem cache that lets a startup skip most of
// the load: the same design as the card-priority store
// (lib/card_priority/persistence.ts — read its header first), applied to IncRems.
//
// WHY
//
// A cold load reads every IncRem's slots: hasPowerup, two Daily Document date
// references (rich text → findOne → Date, three calls each), the history and the
// priority — about ten bridge calls per IncRem, ~66,000 on a 6,500-IncRem
// library. The stall diagnostics caught that flood at startup: 8,700 calls in
// 10 s, 536 in flight, and a widget waiting 12 s for a single answer while the
// plugin's other frames queued behind it.
//
// Unlike the card-priority cache, nothing an IncRem entry holds moves with the
// clock — nextRepDate, priority, history and createdAt change only when someone
// writes to the Rem — so a stored entry can be served as it is.
//
// THE CHANGE SIGNALS
//
// 1. `updatedAt`, free in the taggedRem() payload. Every review writes the hidden
//    History slot, and every priority change records a 'priorityChange' entry
//    there too (setIncRemPriority); hidden slot values live on the tagged Rem
//    itself, so those writes move its updatedAt. Covers plugin writes made on
//    other devices, which arrive by sync.
// 2. The dirty set, for what updatedAt misses: a hand edit of the visible
//    Priority or Next Rep Date row changes a CHILD Rem (the property), not the
//    IncRem. The index's GlobalRemChanged listener records the IncRem (directly,
//    or through the property child's parent) for the next startup to re-read.
// 3. A self-check of a sample against the database, and a full rebuild after
//    MAX_WARM_STORE_AGE_MS, for whatever leaves no trace (a hand edit made on
//    another device).
//
// SHAPE
//
// Two keys per knowledge base: the entries (one array, ~8 MB, mostly history) and
// a small meta key. The entries are rewritten only when the load changed
// something, because writing 8 MB costs a second or two of bridge time; the meta
// key advances syncedAt on every load. builtAt (last FULL read) and syncedAt
// (baseline for the updatedAt delta) are kept apart for the reason given in the
// card-priority store: one timestamp doing both jobs silently disables the
// staleness rebuild.

import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { IncrementalRem } from './types';

/** Bump to invalidate every stored copy after a shape change. */
export const INCREM_STORE_VERSION = 1;

/** Past this age since the last full read, the next load is a cold one. */
export const INCREM_MAX_WARM_STORE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const ROWS_KEY_PREFIX = 'increm-store-rows';
const META_KEY_PREFIX = 'increm-store-meta';
const DIRTY_KEY_PREFIX = 'increm-store-dirty';

/** At most one dirty-set flush per this interval (a throttle, not a debounce). */
const DIRTY_FLUSH_THROTTLE_MS = 5000;

export interface IncRemStoreMeta {
  version: number;
  kbId: string;
  /** When the data was last read from the database IN FULL. Only a cold load advances it. */
  builtAt: number;
  /** When the copy was last brought up to date: the baseline for the updatedAt delta. */
  syncedAt: number;
  count: number;
}

export interface LoadedIncRemStore {
  meta: IncRemStoreMeta;
  byRem: Map<RemId, IncrementalRem>;
}

async function currentKbId(plugin: RNPlugin): Promise<string | null> {
  try {
    return (await plugin.kb.getCurrentKnowledgeBaseData())?._id ?? null;
  } catch {
    return null;
  }
}

const rowsKey = (kbId: string) => `${ROWS_KEY_PREFIX}::${kbId}`;
const metaKey = (kbId: string) => `${META_KEY_PREFIX}::${kbId}`;
const dirtyKey = (kbId: string) => `${DIRTY_KEY_PREFIX}::${kbId}`;

// ── Dirty set ───────────────────────────────────────────────────────────────

/** Marked in this realm and not yet flushed. */
let pendingDirty = new Set<RemId>();
/** Marked in this realm since the current load took its snapshot of the stored set. */
let markedSinceSnapshot = new Set<RemId>();
let dirtyFlushTimer: ReturnType<typeof setTimeout> | null = null;
let lastDirtyFlush = 0;

/**
 * Records that an IncRem changed, for the next startup to re-read. Synchronous
 * and cheap: it runs on the GlobalRemChanged hot path. Marking a Rem that turns
 * out not to be an IncRem is harmless — the next load only looks at tagged Rems.
 */
export function markIncRemDirty(plugin: RNPlugin, remId: RemId): void {
  pendingDirty.add(remId);
  markedSinceSnapshot.add(remId);
  if (dirtyFlushTimer) return;
  const wait = Math.max(0, DIRTY_FLUSH_THROTTLE_MS - (Date.now() - lastDirtyFlush));
  dirtyFlushTimer = setTimeout(() => {
    dirtyFlushTimer = null;
    lastDirtyFlush = Date.now();
    flushIncRemDirtySet(plugin).catch((err) =>
      console.error('[IncRem store] dirty-set flush failed:', err)
    );
  }, wait);
}

/** Merges this realm's pending ids into the stored set (never overwrites it). */
export async function flushIncRemDirtySet(plugin: RNPlugin): Promise<void> {
  if (pendingDirty.size === 0) return;
  const kbId = await currentKbId(plugin);
  if (!kbId) return;
  const flushing = pendingDirty;
  pendingDirty = new Set();
  try {
    const existing = (await plugin.storage.getLocal<RemId[]>(dirtyKey(kbId))) || [];
    await plugin.storage.setLocal(dirtyKey(kbId), [...new Set([...existing, ...flushing])]);
  } catch (err) {
    flushing.forEach((id) => pendingDirty.add(id));
    throw err;
  }
}

/**
 * Flushes, then reads the stored set: the ids a load must re-read. Starts the
 * "marked since snapshot" window, so ids marked while the load runs survive the
 * clear that follows the persist.
 */
export async function snapshotIncRemDirtySet(plugin: RNPlugin): Promise<Set<RemId>> {
  await flushIncRemDirtySet(plugin);
  markedSinceSnapshot = new Set();
  const kbId = await currentKbId(plugin);
  if (!kbId) return new Set();
  return new Set((await plugin.storage.getLocal<RemId[]>(dirtyKey(kbId))) || []);
}

/**
 * Removes the snapshot's ids from the stored set once the copy holds them,
 * keeping any id marked again since the snapshot was taken.
 */
async function clearSnapshotFromDirtySet(
  plugin: RNPlugin,
  kbId: string,
  snapshot: Set<RemId>
): Promise<void> {
  await flushIncRemDirtySet(plugin);
  const stored = (await plugin.storage.getLocal<RemId[]>(dirtyKey(kbId))) || [];
  const keep = stored.filter((id) => !snapshot.has(id) || markedSinceSnapshot.has(id));
  await plugin.storage.setLocal(dirtyKey(kbId), keep);
}

// ── Persisted copy ──────────────────────────────────────────────────────────

/**
 * Reads the copy for the current KB, or null (meaning "cold load") when it is
 * absent, of another schema version, or of another knowledge base. Staleness is
 * the caller's policy.
 */
export async function loadPersistedIncRems(plugin: RNPlugin): Promise<LoadedIncRemStore | null> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return null;

  const meta = await plugin.storage.getLocal<IncRemStoreMeta>(metaKey(kbId));
  if (!meta) return null;
  if (meta.version !== INCREM_STORE_VERSION) {
    console.log(`[IncRem store] version ${meta.version} != ${INCREM_STORE_VERSION} — cold load.`);
    return null;
  }
  if (meta.kbId !== kbId) {
    console.warn('[IncRem store] copy belongs to another KB — cold load.');
    return null;
  }

  const rows = await plugin.storage.getLocal<IncrementalRem[]>(rowsKey(kbId));
  if (!Array.isArray(rows) || rows.length !== meta.count) {
    console.warn(
      `[IncRem store] entries missing or incomplete (${Array.isArray(rows) ? rows.length : 'none'} ` +
        `of ${meta.count}) — cold load.`
    );
    return null;
  }

  const byRem = new Map<RemId, IncrementalRem>();
  for (const row of rows) {
    if (row && typeof row.remId === 'string') byRem.set(row.remId, row);
  }
  return { meta, byRem };
}

/**
 * Writes the copy after a load.
 *
 * @param entries the full list, or null to keep the stored entries (the load
 *   changed nothing) and advance only the meta key.
 * @param builtAt the previous builtAt on a warm load, the load's start on a cold one.
 * @param syncedAt when the load STARTED reading, so anything changed while it ran
 *   is re-read next time.
 * @param dirtySnapshot the ids the load re-read, cleared from the stored set.
 */
export async function persistIncRemStore(
  plugin: RNPlugin,
  entries: IncrementalRem[] | null,
  count: number,
  builtAt: number,
  syncedAt: number,
  dirtySnapshot: Set<RemId>
): Promise<void> {
  const startedAt = Date.now();
  const kbId = await currentKbId(plugin);
  if (!kbId) {
    console.warn('[IncRem store] no KB id — skipping persist.');
    return;
  }

  if (entries) await plugin.storage.setLocal(rowsKey(kbId), entries);
  const meta: IncRemStoreMeta = { version: INCREM_STORE_VERSION, kbId, builtAt, syncedAt, count };
  await plugin.storage.setLocal(metaKey(kbId), meta);
  // Only after the copy is written: these ids are represented in it now.
  await clearSnapshotFromDirtySet(plugin, kbId, dirtySnapshot);

  console.log(
    `[IncRem store] ${entries ? `persisted ${count} IncRems` : `entries unchanged (${count}), meta advanced`} ` +
      `in ${Date.now() - startedAt}ms`
  );
}

/** Drops the copy, so the next load is a cold one. */
export async function clearPersistedIncRems(plugin: RNPlugin): Promise<void> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return;
  await plugin.storage.setLocal(metaKey(kbId), null);
  await plugin.storage.setLocal(rowsKey(kbId), null);
  await plugin.storage.setLocal(dirtyKey(kbId), []);
}
