import { RNPlugin } from '@remnote/plugin-sdk';
import {
  flashcardHistoryTextLimit,
  flashcardHistoryMaxEntries,
  remHistoryTextLimit,
  remHistoryMaxEntries,
} from './consts';
import type { FlashcardHistoryData } from '../widgets/flashcard_history';
import type { RemHistoryData } from '../widgets/rem_history';

// ---------------------------------------------------------------------------
// Per-KB history shards
//
// `flashcardHistoryData` and `remData` used to be one synced key each, holding
// every knowledge base's entries in a single array. Both widgets then threw away
// every entry belonging to another KB at render time, so the cost of the other
// KBs was pure overhead — paid on every read, every write and every sync.
//
// The flashcard list reached 1009KB and hit RemNote's per-item ceiling, after
// which EVERY write was rejected and the sidebar silently froze. The ceiling was
// measured (debug widget → "Calibrate size ceiling"): 458,752 characters accepted
// regardless of alphabet, i.e. 896KB counted in UTF-16 bytes — exactly twice the
// UTF-8 figure the key audit reports. That factor of two is why a list that
// looked like 57% of the limit was actually over it.
//
// Each KB now owns a shard, `<legacyKey>_<kbId>`, and three limits keep a shard
// small: a character cap on the stored preview text, an entry cap, and a byte
// budget that trims further when entries are unusually fat. The byte budget is
// the only one that actually bounds the key — an entry cap cannot, because entry
// size varies by 3x — so it is the backstop that makes a rejected write
// impossible rather than merely unlikely.
// ---------------------------------------------------------------------------

/** Ceiling measured empirically, in UTF-16 bytes. RemNote documents 900KB. */
export const PER_KEY_UTF16_LIMIT = 896 * 1024;
/** Budget per shard. Sized to sit above what a full shard weighs in practice
 *  (500 entries × 400 preview characters ≈ 400KB) so the entry cap is what
 *  normally binds and this stays a backstop, while still leaving ~40% of the
 *  ceiling unused for the entries that run long. */
export const HISTORY_SHARD_UTF16_BUDGET = 550 * 1024;

/** Partition used for entries written before the plugin recorded a kbId. */
export const UNPARTITIONED_KB_ID = 'global';

export interface HistoryShardSpec<T> {
  /** The original single-key name; still read once, to migrate out of it. */
  legacyKey: string;
  maxEntries: number;
  /** Which KB an entry belongs to. */
  getKbId: (entry: T) => string | undefined;
  /** Stable identity within a shard, for dedupe and for React keys. */
  getId: (entry: T) => string;
  /** Drop dead fields and cap the preview text. Applied to every entry written,
   *  including old ones passing through migration. */
  compact: (entry: T) => T;
}

export function shardKey<T>(spec: HistoryShardSpec<T>, kbId: string | undefined): string {
  return `${spec.legacyKey}_${kbId || UNPARTITIONED_KB_ID}`;
}

/** UTF-16 bytes of a value's JSON — the unit RemNote's per-item limit counts. */
export function utf16Bytes(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? '').length * 2;
  } catch {
    return 0;
  }
}

function truncate(text: string | undefined, limit: number): string | undefined {
  if (typeof text !== 'string') return text;
  return text.length > limit ? text.substring(0, limit) : text;
}

// --- the two lists ---------------------------------------------------------

/**
 * `key` was a `Math.random()` float stored purely as the widget's row identity,
 * and `open` was the persisted expand/collapse flag, dead since row state moved
 * into the component. Together they cost ~37KB across a full list while carrying
 * nothing a reader needs: identity is derived from fields the entry already has.
 */
export const flashcardHistorySpec: HistoryShardSpec<FlashcardHistoryData> = {
  legacyKey: 'flashcardHistoryData',
  maxEntries: flashcardHistoryMaxEntries,
  getKbId: (e) => e.kbId,
  // Writers dedupe by cardId, so it is unique within a shard; the fallback only
  // matters for entries old enough to predate it.
  getId: (e) => e.cardId || `${e.remId}-${e.time}`,
  compact: (e) => ({
    remId: e.remId,
    cardId: e.cardId,
    time: e.time,
    kbId: e.kbId,
    text: truncate(e.text, flashcardHistoryTextLimit),
    _v: 1,
    score: e.score,
  }),
};

export const remHistorySpec: HistoryShardSpec<RemHistoryData> = {
  legacyKey: 'remData',
  maxEntries: remHistoryMaxEntries,
  getKbId: (e) => e.kbId,
  // The same rem can be visited repeatedly, so unlike cards the id must include
  // the timestamp.
  getId: (e) => `${e.remId}-${e.time}`,
  compact: (e) => ({
    remId: e.remId,
    time: e.time,
    kbId: e.kbId,
    text: truncate(e.text, remHistoryTextLimit),
    _v: 1,
  }),
};

// --- reading / writing a shard ---------------------------------------------

/** Cap by count, then by bytes. Returns a new array; never mutates the input. */
export function trimToBudget<T>(entries: T[], spec: HistoryShardSpec<T>): T[] {
  let trimmed = entries.length > spec.maxEntries ? entries.slice(0, spec.maxEntries) : entries;
  if (utf16Bytes(trimmed) <= HISTORY_SHARD_UTF16_BUDGET) return trimmed;

  // Over budget even at the entry cap — drop from the tail until it fits. Halving
  // converges in a handful of measurements instead of one per entry removed.
  let lo = 0;
  let hi = trimmed.length;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (utf16Bytes(trimmed.slice(0, mid)) <= HISTORY_SHARD_UTF16_BUDGET) lo = mid;
    else hi = mid;
  }
  trimmed = trimmed.slice(0, lo);
  console.warn(
    `[HistoryShards] "${spec.legacyKey}" shard exceeded its ${Math.round(
      HISTORY_SHARD_UTF16_BUDGET / 1024
    )}KB budget at the ${spec.maxEntries}-entry cap; kept ${lo} entries.`
  );
  return trimmed;
}

export async function readHistoryShard<T>(
  plugin: RNPlugin,
  spec: HistoryShardSpec<T>,
  kbId: string | undefined
): Promise<T[]> {
  await migrateLegacyHistory(plugin, spec);
  const raw = await plugin.storage.getSynced(shardKey(spec, kbId));
  return Array.isArray(raw) ? (raw as T[]) : [];
}

export async function writeHistoryShard<T>(
  plugin: RNPlugin,
  spec: HistoryShardSpec<T>,
  kbId: string | undefined,
  entries: T[]
): Promise<void> {
  await plugin.storage.setSynced(shardKey(spec, kbId), trimToBudget(entries.map(spec.compact), spec));
}

/**
 * Prepend one entry to a KB's shard, replacing any earlier entry with the same
 * identity. Returns false when that identity is already at the head, which is how
 * the callers avoid rewriting the whole array on a repeated event.
 *
 * The entry is built lazily, after the head check: the queue fires these events
 * repeatedly for the same card, and building one costs rem lookups and rich-text
 * flattening that the common case does not need.
 */
export async function prependHistoryEntry<T>(
  plugin: RNPlugin,
  spec: HistoryShardSpec<T>,
  kbId: string | undefined,
  id: string,
  build: () => Promise<T>
): Promise<boolean> {
  const existing = await readHistoryShard(plugin, spec, kbId);
  if (existing[0] && spec.getId(existing[0]) === id) return false;
  const entry = await build();
  const deduped = existing.filter((e) => spec.getId(e) !== id);
  await writeHistoryShard(plugin, spec, kbId, [entry, ...deduped]);
  return true;
}

export async function clearHistoryShard<T>(
  plugin: RNPlugin,
  spec: HistoryShardSpec<T>,
  kbId: string | undefined
): Promise<void> {
  await plugin.storage.setSynced(shardKey(spec, kbId), []);
}

// --- migration off the single global key ------------------------------------

/** Per-session guard: once the legacy key is drained there is nothing to do, and
 *  every read would otherwise pay for confirming that. The in-flight map keeps
 *  concurrent readers (a widget mounting while the queue records a card) from
 *  each running the migration. */
const migrated = new Set<string>();
const migrationsInFlight = new Map<string, Promise<void>>();

/**
 * Split the legacy single-key list into per-KB shards, compacting every entry on
 * the way through. Runs at most once per session per list, and is a single cheap
 * read once the legacy key is empty.
 *
 * Entries that never recorded a kbId belong to the primary KB — that is the rule
 * the widgets' own filters used. We can only place them while running IN the
 * primary KB, so in any other KB they are left behind for a later session rather
 * than guessed at. Shards are written before the legacy key is drained, so an
 * interruption duplicates work rather than losing it.
 */
export async function migrateLegacyHistory<T>(
  plugin: RNPlugin,
  spec: HistoryShardSpec<T>
): Promise<void> {
  if (migrated.has(spec.legacyKey)) return;
  const inFlight = migrationsInFlight.get(spec.legacyKey);
  if (inFlight) return inFlight;
  const run = runLegacyMigration(plugin, spec).finally(() =>
    migrationsInFlight.delete(spec.legacyKey)
  );
  migrationsInFlight.set(spec.legacyKey, run);
  return run;
}

async function runLegacyMigration<T>(
  plugin: RNPlugin,
  spec: HistoryShardSpec<T>
): Promise<void> {
  let legacy: unknown;
  try {
    legacy = await plugin.storage.getSynced(spec.legacyKey);
  } catch (e) {
    console.warn(`[HistoryShards] Could not read "${spec.legacyKey}" to migrate it`, e);
    return;
  }
  if (!Array.isArray(legacy) || legacy.length === 0) {
    migrated.add(spec.legacyKey);
    return;
  }

  const entries = legacy as T[];
  let isPrimary = false;
  let currentKbId: string | undefined;
  try {
    isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
    currentKbId = (await plugin.kb.getCurrentKnowledgeBaseData())?._id;
  } catch {
    /* fall through: unplaceable entries stay in the legacy key */
  }

  const byKb = new Map<string, T[]>();
  const unplaceable: T[] = [];
  for (const entry of entries) {
    const kbId = spec.getKbId(entry) || (isPrimary ? currentKbId : undefined);
    if (!kbId) {
      unplaceable.push(entry);
      continue;
    }
    const bucket = byKb.get(kbId);
    if (bucket) bucket.push(entry);
    else byKb.set(kbId, [entry]);
  }

  try {
    for (const [kbId, incoming] of byKb) {
      const existing = ((await plugin.storage.getSynced(shardKey(spec, kbId))) as T[]) || [];
      const seen = new Set(existing.map(spec.getId));
      const merged = [...existing, ...incoming.filter((e) => !seen.has(spec.getId(e)))];
      await writeHistoryShard(plugin, spec, kbId, merged);
    }
    // Only now is it safe to give up the source.
    await plugin.storage.setSynced(spec.legacyKey, unplaceable.map(spec.compact));
    console.log(
      `[HistoryShards] Migrated ${entries.length} "${spec.legacyKey}" entries into ${byKb.size} ` +
        `per-KB shard(s)` +
        (unplaceable.length
          ? `; ${unplaceable.length} entry(ies) without a kbId left for a primary-KB session.`
          : '.')
    );
    // Marked done either way: whatever could not be placed cannot be placed by
    // THIS session (the KB it belongs to does not change under us), and retrying
    // on every read would rewrite the leftovers each time.
    migrated.add(spec.legacyKey);
  } catch (e) {
    console.error(`[HistoryShards] Migration of "${spec.legacyKey}" failed`, e);
  }
}
