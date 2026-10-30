import { RNPlugin } from '@remnote/plugin-sdk';
import { z } from 'zod';
import { schedulerCardsKeyPrefix } from './consts';
import { PER_KEY_UTF16_LIMIT, utf16Bytes } from './history_shards';

// ---------------------------------------------------------------------------
// RemNote's schedulers, imported from the local database
//
// The bridge sends plugins neither a Rem's scheduler nor its settings, so
// scripts/export_scheduler_cards.py reads them from the local database and the
// user imports the result: the Global Default Scheduler's settings, which fill the
// plugin's FSRS settings, and the cards on other schedulers. Only those exceptions
// are stored.
//
// Storage: synced and per KB, so the list reaches the user's other devices and
// other KBs don't pay for it. One small manifest key says what was imported, and
// the ids live in `<prefix>_<kbId>_<n>` shards. A shard is budgeted at under half
// of the 896KB per-key ceiling, which counts UTF-16 bytes, so about 11,000 ids
// fit in one key and a growing list adds a key instead of being rejected.
//
// Rejected writes are silent, so a save reads every key back. A shard records the
// generation it belongs to, so a partly written import reads as no list at all
// rather than as a smaller one.
// ---------------------------------------------------------------------------

export const SCHEDULER_SHARD_UTF16_BUDGET = 400 * 1024;
export const MAX_SCHEDULER_SHARDS = 20;

/** Room for a shard's JSON structure, in characters. */
const SHARD_OVERHEAD_CHARS = 512;
const ID_SEPARATOR = ' ';

export const SchedulerCardsExport = z.object({
  kind: z.literal('incremental-remnote-scheduler-cards'),
  version: z.literal(1),
  kbId: z.string().min(1),
  generatedAt: z.number(),
  totalCards: z.number().optional(),
  globalScheduler: z
    .object({
      id: z.string().min(1),
      type: z.string(),
      weights: z.array(z.number()).nullable(),
      targetRetention: z.number().nullable(),
    })
    .optional(),
  schedulers: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      type: z.string(),
      cards: z.array(z.string().min(1)),
    }),
  ),
});
export type SchedulerCardsExport = z.infer<typeof SchedulerCardsExport>;

export interface SchedulerInfo {
  id: string;
  name: string;
  /** RemNote's scheduler type: `fsrs`, `sm2`, `plugin`… */
  type: string;
  cardCount: number;
}

export interface SchedulerCardsManifest {
  generatedAt: number;
  shardCount: number;
  cardCount: number;
  schedulers: SchedulerInfo[];
}

export interface SchedulerCardsShard {
  generatedAt: number;
  /** Space-separated card ids per scheduler; `s` indexes `manifest.schedulers`. */
  chunks: { s: number; ids: string }[];
}

export function schedulerManifestKey(kbId: string): string {
  return `${schedulerCardsKeyPrefix}_${kbId}`;
}

export function schedulerShardKey(kbId: string, index: number): string {
  return `${schedulerCardsKeyPrefix}_${kbId}_${index}`;
}

export function schedulerTypeLabel(type: string): string {
  if (type === 'sm2') return 'Anki SM-2';
  if (type === 'fsrs') return 'FSRS';
  if (type === 'plugin') return 'Plugin';
  return type;
}

const FSRS_6_WEIGHT_COUNT = 21;
const FSRS_5_WEIGHT_COUNT = 19;
const DEFAULT_TARGET_RETENTION = 0.9;
/** The range of the plugin's Requested Retention setting. */
const MIN_RETENTION_PERCENT = 70;
const MAX_RETENTION_PERCENT = 99;

export interface FsrsSettingsPlan {
  /** New value of the FSRS Global Weights setting; '' means RemNote's defaults. Null keeps it. */
  weights: string | null;
  /** New value of the Requested Retention setting. Null keeps it. */
  retentionPercent: number | null;
  warnings: string[];
}

/** What the Global Default Scheduler means for the plugin's FSRS settings. */
export function planFsrsSettings(
  scheduler: NonNullable<SchedulerCardsExport['globalScheduler']>,
): FsrsSettingsPlan {
  if (scheduler.type !== 'fsrs') {
    return {
      weights: null,
      retentionPercent: null,
      warnings: [
        `Your Global Default Scheduler is ${schedulerTypeLabel(scheduler.type)}, not FSRS-6, so the ` +
          "plugin's FSRS figures only estimate your cards. The FSRS settings stay as they are.",
      ],
    };
  }

  const warnings: string[] = [];
  let weights: string | null = '';
  const count = scheduler.weights?.length;
  if (count === FSRS_5_WEIGHT_COUNT) {
    warnings.push(`Your Global Default Scheduler has ${count} FSRS-5 weights, not the 21 of FSRS-6.`);
  } else if (count !== undefined && count !== FSRS_6_WEIGHT_COUNT) {
    weights = null;
    warnings.push(`Your Global Default Scheduler has ${count} FSRS weights, not the 21 of FSRS-6, so they weren't used.`);
  }
  if (weights !== null && scheduler.weights) weights = scheduler.weights.join(', ');

  const retention = Math.round((scheduler.targetRetention ?? DEFAULT_TARGET_RETENTION) * 1000) / 10;
  const usable = retention >= MIN_RETENTION_PERCENT && retention <= MAX_RETENTION_PERCENT;
  if (!usable) {
    warnings.push(
      `Your target retention of ${retention}% is outside the plugin's ${MIN_RETENTION_PERCENT}–` +
        `${MAX_RETENTION_PERCENT}% range, so Requested Retention stays as it is.`,
    );
  }

  return { weights, retentionPercent: usable ? retention : null, warnings };
}

export function buildSchedulerStorage(
  data: SchedulerCardsExport,
  budgetUtf16 = SCHEDULER_SHARD_UTF16_BUDGET,
): { manifest: SchedulerCardsManifest; shards: SchedulerCardsShard[] } {
  const maxChars = Math.floor(budgetUtf16 / 2) - SHARD_OVERHEAD_CHARS;
  const shards: SchedulerCardsShard[] = [];
  let chunks: SchedulerCardsShard['chunks'] = [];
  let usedChars = 0;

  const closeShard = () => {
    if (chunks.length > 0) shards.push({ generatedAt: data.generatedAt, chunks });
    chunks = [];
    usedChars = 0;
  };

  data.schedulers.forEach((scheduler, s) => {
    let ids: string[] = [];
    const flush = () => {
      if (ids.length > 0) chunks.push({ s, ids: ids.join(ID_SEPARATOR) });
      ids = [];
    };
    for (const id of scheduler.cards) {
      if (usedChars + id.length + ID_SEPARATOR.length > maxChars) {
        flush();
        closeShard();
      }
      ids.push(id);
      usedChars += id.length + ID_SEPARATOR.length;
    }
    flush();
  });
  closeShard();

  return {
    shards,
    manifest: {
      generatedAt: data.generatedAt,
      shardCount: shards.length,
      cardCount: data.schedulers.reduce((sum, scheduler) => sum + scheduler.cards.length, 0),
      schedulers: data.schedulers.map(({ id, name, type, cards }) => ({
        id,
        name,
        type,
        cardCount: cards.length,
      })),
    },
  };
}

export async function getSchedulerManifest(
  plugin: RNPlugin,
  kbId: string,
): Promise<SchedulerCardsManifest | null> {
  return (await plugin.storage.getSynced<SchedulerCardsManifest>(schedulerManifestKey(kbId))) ?? null;
}

/** Writes the list, or throws with the reason. A failure leaves no usable list behind. */
export async function saveSchedulerCards(
  plugin: RNPlugin,
  kbId: string,
  data: SchedulerCardsExport,
): Promise<SchedulerCardsManifest> {
  const { manifest, shards } = buildSchedulerStorage(data);
  if (shards.length > MAX_SCHEDULER_SHARDS) {
    throw new Error(
      `The list needs ${shards.length} storage keys, and the limit here is ${MAX_SCHEDULER_SHARDS}.`,
    );
  }
  const previous = await getSchedulerManifest(plugin, kbId);

  const writeAndVerify = async (key: string, value: SchedulerCardsManifest | SchedulerCardsShard) => {
    const bytes = utf16Bytes(value);
    if (bytes >= PER_KEY_UTF16_LIMIT) throw new Error(`${key} is too large to store (${bytes} bytes).`);
    await plugin.storage.setSynced(key, value);
    if (utf16Bytes(await plugin.storage.getSynced(key)) !== bytes) {
      throw new Error(`RemNote did not keep ${key} (${bytes} bytes).`);
    }
  };

  for (let i = 0; i < shards.length; i++) {
    await writeAndVerify(schedulerShardKey(kbId, i), shards[i]);
  }
  await writeAndVerify(schedulerManifestKey(kbId), manifest);
  for (let i = shards.length; i < (previous?.shardCount ?? 0); i++) {
    await plugin.storage.setSynced(schedulerShardKey(kbId, i), null);
  }

  indexCache = null;
  return manifest;
}

export async function clearSchedulerCards(plugin: RNPlugin, kbId: string): Promise<void> {
  const previous = await getSchedulerManifest(plugin, kbId);
  await plugin.storage.setSynced(schedulerManifestKey(kbId), null);
  for (let i = 0; i < (previous?.shardCount ?? 0); i++) {
    await plugin.storage.setSynced(schedulerShardKey(kbId, i), null);
  }
  indexCache = null;
}

// --- Lookups ---------------------------------------------------------------

/** cardId → index into `manifest.schedulers`. */
type SchedulerIndex = Map<string, number>;

/** Built once per iframe and generation, so a lookup costs no bridge traffic after the first. */
let indexCache: { key: string; index: Promise<SchedulerIndex | null> } | null = null;

async function readIndex(
  plugin: RNPlugin,
  kbId: string,
  manifest: SchedulerCardsManifest,
): Promise<SchedulerIndex | null> {
  const index: SchedulerIndex = new Map();
  for (let i = 0; i < manifest.shardCount; i++) {
    const shard = await plugin.storage.getSynced<SchedulerCardsShard>(schedulerShardKey(kbId, i));
    // Not fully synced yet, or left by an import that failed.
    if (!shard || shard.generatedAt !== manifest.generatedAt) return null;
    for (const { s, ids } of shard.chunks) {
      for (const id of ids.split(ID_SEPARATOR)) index.set(id, s);
    }
  }
  return index;
}

function getIndex(
  plugin: RNPlugin,
  kbId: string,
  manifest: SchedulerCardsManifest,
): Promise<SchedulerIndex | null> {
  const key = `${kbId}:${manifest.generatedAt}`;
  if (indexCache?.key === key) return indexCache.index;
  const index = readIndex(plugin, kbId, manifest);
  const entry = { key, index };
  indexCache = entry;
  // An incomplete list may finish syncing later, so only a complete one is kept.
  index.then(
    (result) => {
      if (!result && indexCache === entry) indexCache = null;
    },
    () => {
      if (indexCache === entry) indexCache = null;
    },
  );
  return index;
}

/** The scheduler of one card, or null when it is on the Global Default or no list is imported. */
export async function findCardScheduler(
  plugin: RNPlugin,
  kbId: string,
  cardId: string,
): Promise<SchedulerInfo | null> {
  const manifest = await getSchedulerManifest(plugin, kbId);
  if (!manifest) return null;
  const index = await getIndex(plugin, kbId, manifest);
  const s = index?.get(cardId);
  return s === undefined ? null : manifest.schedulers[s] ?? null;
}

/** Every listed card id, for the analytics filters. Null when no complete list is available. */
export async function getOtherSchedulerCardIds(plugin: RNPlugin): Promise<Set<string> | null> {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())?._id;
  if (!kbId) return null;
  const manifest = await getSchedulerManifest(plugin, kbId);
  if (!manifest) return null;
  const index = await getIndex(plugin, kbId, manifest);
  return index ? new Set(index.keys()) : null;
}
