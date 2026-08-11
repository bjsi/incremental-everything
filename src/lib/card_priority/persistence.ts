// lib/card_priority/persistence.ts
//
// The single place the card-priority cache is written, and the local-storage
// mirror that makes a warm start possible.
//
// WHY A CHOKE POINT
//
// The session cache is authoritative for the UI, and about a dozen places write
// it: the two full builds, every incremental flush, the deferred phase, the
// batch cleanup, and two optimistic pushes in priority.tsx. A persisted mirror
// that each of those has to remember to update is a mirror that will drift —
// the next writer added won't know it exists. Routing every write through
// writeCardPriorityCache makes "local is updated alongside the cache"
// structurally true rather than a convention.
//
// WHY THE MIRROR IS DEBOUNCED
//
// Persisting is ~23 setLocal calls for a 45k library (about 4.7MB across chunks,
// measured). Doing that inside flushCacheUpdates — which runs on every single
// priority change, including every answer during a queue session — would put a
// multi-megabyte write on an interactive path. So incremental writes schedule a
// throttled persist and full rebuilds persist immediately.
//
// To be clear about what is deferred: ONLY the local mirror. The session cache —
// which every widget reads, including the in-queue card_info_bar — is written and
// awaited on every call, so a priority set during a session is visible to the UI
// at once. Deferring that would show a stale value and read as a failed write.
//
// The throttle cannot lose data, because it is not the only signal. A change
// that lands within the debounce window and is then cut off by a quit is still
// caught on the next warm start: the plugin wrote it through setCardPriority,
// which writes the hidden prioritySource/lastUpdated slots, which moves the
// rem's `updatedAt` — and the warm start re-reads every rem whose `updatedAt` is
// newer than the stored snapshot. The mirror is an optimisation; `updatedAt` is
// the correctness backstop. (This is exactly why hand edits are the hard case:
// they move a child rem and leave `updatedAt` alone. See lib/updated_at_probe.ts.)
//
// SHAPE
//
// [remId, priority, source] tuples — tuples rather than objects because at 45k
// rows the repeated JSON keys roughly triple the bytes. The card-derived fields
// (cardCount, dueCards, dueCardsOverdue, cardsNextRep, kbPercentile) are
// deliberately NOT stored: due-ness moves with the clock, so they must be
// recomputed from the single card.getAll() every launch regardless, and storing
// them would only create a second, staler copy.

import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { allCardPriorityInfoKey } from '../consts';
import { CardPriorityInfo, PrioritySource } from './types';

/** Bump to invalidate every stored blob after a shape change. */
export const CARD_PRIORITY_STORE_VERSION = 1;

const META_KEY_PREFIX = 'card-priority-store-meta';
const CHUNK_KEY_PREFIX = 'card-priority-store-chunk';
/** Rows per chunk. 2000 measured at ~211KB UTF-16, well clear of the 896KB
 *  per-key ceiling observed on synced storage. */
const CHUNK_SIZE = 2000;
/** Coalescing window for the mirror. Note this throttles the LOCAL write only —
 *  the session cache is always written immediately, since it is what the UI reads. */
const PERSIST_THROTTLE_MS = 5000;

export type StoredRow = [RemId, number, PrioritySource];

export interface StoreMeta {
  version: number;
  kbId: string;
  savedAt: number;
  count: number;
  chunkCount: number;
}

async function currentKbId(plugin: RNPlugin): Promise<string | null> {
  try {
    return (await plugin.kb.getCurrentKnowledgeBaseData())?._id ?? null;
  } catch {
    return null;
  }
}

const metaKey = (kbId: string) => `${META_KEY_PREFIX}::${kbId}`;
const chunkKey = (kbId: string, i: number) => `${CHUNK_KEY_PREFIX}::${kbId}::${i}`;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingInfos: CardPriorityInfo[] | null = null;

/**
 * Writes the card-priority cache.
 *
 * The session write is always awaited — it is what every widget reads, and a
 * deferred one would show stale priorities. The local mirror is scheduled unless
 * `immediate` is set.
 *
 * @param persist  false for writes that must NOT reach the mirror. Used where an
 *   empty session cache means "not built in this context" rather than "there are
 *   no priorities" — light mode and the flashcard-prioritisation opt-in being
 *   off. Persisting [] there would wipe a good blob on the next mobile session.
 * @param immediate true for full rebuilds (cold start, the Update command), where
 *   the mirror should land with the cache rather than five seconds later.
 */
export async function writeCardPriorityCache(
  plugin: RNPlugin,
  infos: CardPriorityInfo[],
  opts?: { persist?: boolean; immediate?: boolean }
): Promise<void> {
  await plugin.storage.setSession(allCardPriorityInfoKey, infos);

  if (opts?.persist === false) return;

  if (opts?.immediate) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    pendingInfos = null;
    await persistCardPriorityCache(plugin, infos);
    return;
  }

  // A THROTTLE, not a debounce, and the difference matters. The timer starts on
  // the first write of a burst and is never postponed by later ones (hence the
  // early return below), so the mirror is guaranteed to land within
  // PERSIST_THROTTLE_MS of the first change. A debounce would keep pushing the
  // deadline forward on every write, and a queue session — which writes on every
  // answer — could run for an hour without the mirror ever being saved.
  //
  // The value written is the LATEST infos, not the one that opened the window,
  // so the single write still reflects the newest state.
  pendingInfos = infos;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const toPersist = pendingInfos;
    pendingInfos = null;
    if (toPersist) {
      persistCardPriorityCache(plugin, toPersist).catch((err) =>
        console.error('[CardPriority store] throttled persist failed:', err)
      );
    }
  }, PERSIST_THROTTLE_MS);
}

/** Writes the mirror now, bypassing the throttle. */
export async function persistCardPriorityCache(
  plugin: RNPlugin,
  infos: CardPriorityInfo[]
): Promise<void> {
  const startedAt = Date.now();
  const kbId = await currentKbId(plugin);
  if (!kbId) {
    console.warn('[CardPriority store] no KB id — skipping persist.');
    return;
  }

  const rows: StoredRow[] = infos.map((i) => [i.remId, i.priority, i.source]);
  const chunkCount = Math.ceil(rows.length / CHUNK_SIZE);

  const previous = await plugin.storage.getLocal<StoreMeta>(metaKey(kbId));

  for (let c = 0; c < chunkCount; c++) {
    await plugin.storage.setLocal(
      chunkKey(kbId, c),
      rows.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE)
    );
  }

  // Drop chunks left over from a larger previous save, or a shrunken cache would
  // be read back with stale rows appended to it.
  if (previous && previous.chunkCount > chunkCount) {
    for (let c = chunkCount; c < previous.chunkCount; c++) {
      await plugin.storage.setLocal(chunkKey(kbId, c), null);
    }
  }

  // Meta last: it is what marks the blob complete, so a save interrupted midway
  // through the chunks is not mistaken for a usable one on the next launch.
  const meta: StoreMeta = {
    version: CARD_PRIORITY_STORE_VERSION,
    kbId,
    savedAt: Date.now(),
    count: rows.length,
    chunkCount,
  };
  await plugin.storage.setLocal(metaKey(kbId), meta);

  // Timed because the throttle interval was chosen as a precaution, not from a
  // measurement: nobody has clocked what a multi-megabyte chunked setLocal
  // actually costs. The bridge throughput measured elsewhere (~1,800-2,000
  // calls/s) came from tiny slot reads and says nothing about ~150KB payloads.
  // If this reliably logs single-digit milliseconds the throttle can go; if it
  // logs seconds, it needs to be longer or the writes need to be incremental.
  console.log(
    `[CardPriority store] persisted ${rows.length} rows in ${chunkCount} chunks ` +
      `(${Math.round(Date.now() - startedAt)}ms, ${chunkCount + 2} IPC calls)`
  );
}

export interface LoadedStore {
  meta: StoreMeta;
  /** remId -> {priority, source}, ready to merge against a fresh taggedRem list. */
  byRem: Map<RemId, { priority: number; source: PrioritySource }>;
}

/**
 * Reads the mirror for the current KB.
 *
 * Returns null — meaning "do a cold build" — for every condition that makes the
 * blob untrustworthy rather than merely old: absent, written by a different
 * schema version, or belonging to another knowledge base. Staleness is NOT
 * judged here; that is the caller's policy.
 */
export async function loadPersistedCardPriorities(
  plugin: RNPlugin
): Promise<LoadedStore | null> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return null;

  const meta = await plugin.storage.getLocal<StoreMeta>(metaKey(kbId));
  if (!meta) return null;

  if (meta.version !== CARD_PRIORITY_STORE_VERSION) {
    console.log(
      `[CardPriority store] version ${meta.version} != ${CARD_PRIORITY_STORE_VERSION} — cold build.`
    );
    return null;
  }
  if (meta.kbId !== kbId) {
    console.warn('[CardPriority store] blob belongs to another KB — cold build.');
    return null;
  }

  const byRem = new Map<RemId, { priority: number; source: PrioritySource }>();
  for (let c = 0; c < meta.chunkCount; c++) {
    const chunk = await plugin.storage.getLocal<StoredRow[]>(chunkKey(kbId, c));
    if (!chunk) {
      console.warn(`[CardPriority store] chunk ${c} missing — cold build.`);
      return null;
    }
    for (const [remId, priority, source] of chunk) {
      byRem.set(remId, { priority, source });
    }
  }

  return { meta, byRem };
}

/**
 * Reads just the meta key — no chunks.
 *
 * Separate from loadPersistedCardPriorities because that one pulls all 23 chunks
 * and materialises 45k rows, which is far too much work to render a status line.
 */
export async function readCardPriorityStoreMeta(
  plugin: RNPlugin
): Promise<StoreMeta | null> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return null;
  return (await plugin.storage.getLocal<StoreMeta>(metaKey(kbId))) ?? null;
}

export async function clearPersistedCardPriorities(plugin: RNPlugin): Promise<void> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return;
  const meta = await plugin.storage.getLocal<StoreMeta>(metaKey(kbId));
  if (meta) {
    for (let c = 0; c < meta.chunkCount; c++) {
      await plugin.storage.setLocal(chunkKey(kbId, c), null);
    }
  }
  await plugin.storage.setLocal(metaKey(kbId), null);
}
