import { QueueInteractionScore, RNPlugin } from '@remnote/plugin-sdk';
import {
  powerupCode,
  repHistorySlotCode,
  dismissedPowerupCode,
  dismissedHistorySlotCode,
  flashcardResponseTimeLimitId,
} from './consts';
import { tryParseJson } from './utils';
import {
  DailyAggregate,
  PeriodStats,
  UNKNOWN_KB_ID,
  getLocalDateKey,
} from './queue_aggregates';
import type { PracticedQueueSession } from '../widgets/practiced_queues';
import type { IncrementalRep } from './incremental_rem/types';
import { repCountsForStats } from './incremental_rem/types';
import { getIESetting } from './settings';

export const AUTHORITATIVE_AGGREGATES_KEY = 'authoritativeDailyAggregates';
export const AUTHORITATIVE_LAST_COMPUTED_KEY = 'authoritativeAggregatesLastComputed';

/** Per-KB shard of the store above. Holds the same compact shape with a single
 *  partition in it, so every decoder here works on a shard unchanged. */
export function authoritativeShardKey(kbId: string): string {
  return `${AUTHORITATIVE_AGGREGATES_KEY}_${kbId}`;
}

/** Measured per-key ceiling, in UTF-16 bytes — the unit RemNote counts in.
 *  See `calibratePerKeyLimit` in synced_key_audit.ts. */
const PER_KEY_UTF16_LIMIT = 896 * 1024;

/** UTF-16 bytes of a value's JSON. `String.length` counts UTF-16 code units, so
 *  the byte figure is twice that — the earlier size warnings here compared the
 *  raw length against a byte limit and so under-reported by half. */
function utf16Bytes(value: unknown): number {
  return (JSON.stringify(value) ?? '').length * 2;
}

// ---------------------------------------------------------------------------
// Storage format
//
// This key holds one bucket per (day, knowledge base) for the user's ENTIRE
// review history, so it grows forever — roughly 175 bytes per bucket in the
// original `DailyAggregate[]` form, of which the six numbers that carry the
// actual data were a minority: every bucket repeated eight field names and a
// 24-character kbId. At ~7,250 buckets that reached 1.21MB and blew past
// RemNote's 900KB per-key ceiling, so every recompute was silently rejected and
// the dashboard's authoritative figures froze.
//
// Buckets are therefore stored keyed by kbId → date → a positional row, which
// writes the kbId once per KB instead of once per day and drops the field names
// entirely. Same data, ~5x smaller. `ids` is not stored at all: the authoritative
// walk never populates it (findOrCreateBucket creates an empty array and nothing
// pushes to it) — it exists only on the listener-derived aggregates, which live
// under a different key and keep their original format.
//
// Reads accept either shape, so no migration step is needed: the next successful
// recompute rewrites the key in the compact form.
// ---------------------------------------------------------------------------

/** [totalTime, cardsCount, cardsTime, incRemsCount, incRemsTime, forgotCount] — times in ms. */
type CompactRow = [number, number, number, number, number, number];

interface CompactAggregateStore {
  /** Format version. Absent/array ⇒ the legacy `DailyAggregate[]` form. */
  v: 2;
  /** kbId → date (YYYY-MM-DD) → row */
  kbs: Record<string, Record<string, CompactRow>>;
}

function isCompactStore(raw: unknown): raw is CompactAggregateStore {
  return !!raw && !Array.isArray(raw) && typeof raw === 'object' && (raw as any).v === 2;
}

/** Accepts either storage shape (or junk) and returns plain buckets. */
export function decodeAuthoritativeAggregates(raw: unknown): DailyAggregate[] {
  if (!raw) return [];

  if (isCompactStore(raw)) {
    const out: DailyAggregate[] = [];
    for (const [kbId, byDate] of Object.entries(raw.kbs || {})) {
      for (const [date, row] of Object.entries(byDate || {})) {
        if (!Array.isArray(row)) continue;
        out.push({
          date,
          kbId,
          totalTime: row[0] || 0,
          cardsCount: row[1] || 0,
          cardsTime: row[2] || 0,
          incRemsCount: row[3] || 0,
          incRemsTime: row[4] || 0,
          forgotCount: row[5] || 0,
          ids: [], // never populated for authoritative buckets; kept for shape compatibility
        });
      }
    }
    return out;
  }

  // Legacy: a plain array of DailyAggregate.
  if (Array.isArray(raw)) return raw.filter((b): b is DailyAggregate => !!b && typeof b === 'object');

  return [];
}

// ---------------------------------------------------------------------------
// Per-KB sharding
//
// The single key held every knowledge base's buckets. The dashboard only ever
// displays the current KB's, so the rest were read, rewritten and re-synced on
// every recompute purely to be filtered out — 51% of the key when this was
// measured, all of it belonging to KBs that had not been studied in for months.
//
// Each KB now owns `authoritativeDailyAggregates_<kbId>`, holding the same
// compact store with one partition in it. Keeping the shape identical means
// `decodeAuthoritativeAggregates` and `filterAuthoritativeForKb` work on a shard
// with no changes, and a shard read back by an older build still decodes.
//
// This does NOT trim history: buckets go back to 2016 here and the dashboard's
// "Ever" row depends on them. Sharding is what makes keeping all of it cheap.
// ---------------------------------------------------------------------------

/** Per-session guard, as in history_shards.ts: once the legacy key is drained,
 *  confirming that should cost one read per session and no more. */
let aggregatesMigrated = false;
let aggregatesMigrationInFlight: Promise<void> | null = null;

/**
 * Split the single aggregates key into per-KB shards.
 *
 * Subsumes the old v2 compaction pass: the legacy value is decoded whatever its
 * shape (v2 store or the original `DailyAggregate[]`), so an installation that
 * never compacted is migrated straight to sharded-and-compact in one step.
 *
 * Shards are written before the source is dropped, so an interruption leaves
 * duplicate data rather than missing data — the next run overwrites the shards
 * from the legacy key again.
 */
export async function migrateAuthoritativeAggregatesToShards(plugin: RNPlugin): Promise<void> {
  if (aggregatesMigrated) return;
  if (aggregatesMigrationInFlight) return aggregatesMigrationInFlight;
  aggregatesMigrationInFlight = runAggregatesMigration(plugin).finally(() => {
    aggregatesMigrationInFlight = null;
  });
  return aggregatesMigrationInFlight;
}

async function runAggregatesMigration(plugin: RNPlugin): Promise<void> {
  try {
    const raw = await plugin.storage.getSynced(AUTHORITATIVE_AGGREGATES_KEY);
    const buckets = decodeAuthoritativeAggregates(raw);
    if (buckets.length === 0) {
      aggregatesMigrated = true;
      return;
    }

    const byKb = new Map<string, DailyAggregate[]>();
    for (const bucket of buckets) {
      const kbId = bucket.kbId || UNKNOWN_KB_ID;
      const list = byKb.get(kbId);
      if (list) list.push(bucket);
      else byKb.set(kbId, [bucket]);
    }

    const sizes: string[] = [];
    for (const [kbId, kbBuckets] of byKb) {
      const payload = encodeAuthoritativeAggregates(kbBuckets);
      await plugin.storage.setSynced(authoritativeShardKey(kbId), payload);
      sizes.push(`${kbId.substring(0, 8)}…=${(utf16Bytes(payload) / 1024).toFixed(0)}KB`);
    }

    await plugin.storage.setSynced(AUTHORITATIVE_AGGREGATES_KEY, null);
    aggregatesMigrated = true;
    // Naming the source shape matters for support: an installation still holding
    // the original array was compacted AND sharded by this one pass, so a ~5x
    // drop in the totals below is expected rather than suspicious.
    const sourceShape = Array.isArray(raw) ? 'legacy array (never compacted)' : 'compact v2 store';
    console.log(
      `[AuthoritativeAggregates] Sharded ${buckets.length} buckets across ${byKb.size} KB(s): ` +
        `${sizes.join(', ')} — from a ${sourceShape} of ${(utf16Bytes(raw) / 1024).toFixed(0)}KB in one key.`
    );
  } catch (err) {
    console.warn('[AuthoritativeAggregates] Sharding migration failed', err);
  }
}

/**
 * This KB's stored aggregates, in whatever shape they are on disk. Returned raw
 * so callers keep using `filterAuthoritativeForKb` / `decodeAuthoritativeAggregates`
 * exactly as before.
 */
export async function readAuthoritativeAggregates(
  plugin: RNPlugin,
  kbId: string
): Promise<unknown> {
  await migrateAuthoritativeAggregatesToShards(plugin);
  return plugin.storage.getSynced(authoritativeShardKey(kbId));
}

export function encodeAuthoritativeAggregates(buckets: DailyAggregate[]): CompactAggregateStore {
  const kbs: Record<string, Record<string, CompactRow>> = {};
  for (const b of buckets) {
    if (!b || !b.date || !b.kbId) continue;
    // Times are milliseconds accumulated from reviewTimeSeconds * 1000, so they
    // are whole numbers already; rounding only guards against float drift
    // producing a 17-digit literal in the JSON.
    const row: CompactRow = [
      Math.round(b.totalTime || 0),
      Math.round(b.cardsCount || 0),
      Math.round(b.cardsTime || 0),
      Math.round(b.incRemsCount || 0),
      Math.round(b.incRemsTime || 0),
      Math.round(b.forgotCount || 0),
    ];
    (kbs[b.kbId] ||= {})[b.date] = row;
  }
  return { v: 2, kbs };
}

// Days strictly before this local date are not fully reliable for IncRem stats:
// the Dismissed powerup (which preserves history when a rem is no longer
// Incremental) was introduced on 2026-01-30 (commit fc21734). Reviews on rems
// that were dismissed BEFORE that date had their history wiped along with the
// powerup removal, so the authoritative walk cannot see them. For dates older
// than the cutoff, prefer listener-derived incRem stats (the live tracker
// captured them at the time). Cards are unaffected — card.repetitionHistory
// has always been the source of truth.
export const INCREM_AUTHORITATIVE_CUTOFF_DATE = '2026-01-30';

export const DEFAULT_RESPONSE_TIME_LIMIT_SEC = 180;
const HISTORY_FETCH_CHUNK = 50;

export interface ProgressUpdate {
  percent: number;
  label: string;
}

export interface ComputeOptions {
  onProgress?: (update: ProgressUpdate) => void;
  signal?: AbortSignal;
}

function findOrCreateBucket(
  buckets: DailyAggregate[],
  date: string,
  kbId: string
): DailyAggregate {
  let b = buckets.find((x) => x && x.date === date && x.kbId === kbId);
  if (!b) {
    b = {
      date,
      kbId,
      totalTime: 0,
      cardsCount: 0,
      cardsTime: 0,
      incRemsCount: 0,
      incRemsTime: 0,
      forgotCount: 0,
      ids: [],
    };
    buckets.push(b);
  }
  return b;
}

function isRealCardScore(score: number | undefined): boolean {
  if (score === undefined) return false;
  // Reviews that count: AGAIN (0), HARD (0.5), GOOD (1), EASY (1.5).
  // Filtered out: TOO_EARLY (0.01), VIEWED_AS_LEECH (2), RESET (3),
  // MANUAL_DATE (4), MANUAL_EASE (5) — these are not real reviews and
  // should not contribute to cardsCount/cardsTime/forgotCount.
  return (
    score === QueueInteractionScore.AGAIN ||
    score === QueueInteractionScore.HARD ||
    score === QueueInteractionScore.GOOD ||
    score === QueueInteractionScore.EASY
  );
}

// Real-review predicate for stats. Delegates to the shared repCountsForStats so
// the Study Dashboard, the scheduler (via repCountsForScheduling) and the
// history-transfer collector can't drift. Note this INCLUDES 'importedRep'
// (reviews imported from removed flashcards count for time/rep totals).
function isRealIncRemRep(eventType: IncrementalRep['eventType']): boolean {
  return repCountsForStats(eventType);
}

async function processHistorySlots(
  rems: { _id: string; getPowerupProperty: (p: string, s: string) => Promise<any> }[],
  pCode: string,
  slotCode: string,
  buckets: DailyAggregate[],
  kbId: string,
  options: ComputeOptions | undefined,
  fromPct: number,
  toPct: number,
  label: string
) {
  if (rems.length === 0) {
    options?.onProgress?.({ percent: toPct, label: `${label}: 0/0` });
    return;
  }
  for (let i = 0; i < rems.length; i += HISTORY_FETCH_CHUNK) {
    if (options?.signal?.aborted) throw new Error('Aborted');
    const chunk = rems.slice(i, i + HISTORY_FETCH_CHUNK);
    const histories = await Promise.all(
      chunk.map((r) =>
        r
          .getPowerupProperty(pCode, slotCode)
          .then((raw: any) => tryParseJson(raw))
          .catch(() => null)
      )
    );
    for (const history of histories) {
      if (!Array.isArray(history)) continue;
      for (const rep of history as IncrementalRep[]) {
        if (!rep || typeof rep.date !== 'number') continue;
        if (!isRealIncRemRep(rep.eventType)) continue;
        const b = findOrCreateBucket(buckets, getLocalDateKey(rep.date), kbId);
        b.incRemsCount += 1;
        const t = (rep.reviewTimeSeconds || 0) * 1000;
        b.incRemsTime += t;
        b.totalTime += t;
      }
    }
    const done = Math.min(i + HISTORY_FETCH_CHUNK, rems.length);
    const pct = fromPct + (toPct - fromPct) * (done / rems.length);
    options?.onProgress?.({ percent: pct, label: `${label}: ${done}/${rems.length}` });
  }
}

/**
 * Walk all cards + Incremental powerup + Dismissed powerup for the current KB
 * and bucket every real review into per-day aggregates. Heavy: O(cards + incRems
 * + dismissedRems) async calls. Cancellable via options.signal.
 */
export async function computeAuthoritativeAggregatesForCurrentKb(
  plugin: RNPlugin,
  options?: ComputeOptions
): Promise<DailyAggregate[]> {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  // Flashcard-only cap (matches the live tracker in queue_session.ts). IncRem
  // reviewTimeSeconds is intentionally NOT capped — an IncRem rep can legitimately
  // take many minutes (PDF reading, long passages), so capping would systematically
  // undercount IncRem time. Only flashcard responseTimes get clipped, since those
  // are quick-recall reviews where >180s usually indicates the user walked away.
  const flashcardResponseTimeCapMs =
    (await getIESetting(plugin, flashcardResponseTimeLimitId)) * 1000;

  const buckets: DailyAggregate[] = [];

  // ── 1. Cards ────────────────────────────────────────────────────────────
  options?.onProgress?.({ percent: 0, label: 'Loading cards…' });
  const allCards = (await plugin.card.getAll()) || [];
  if (options?.signal?.aborted) throw new Error('Aborted');
  options?.onProgress?.({
    percent: 0.05,
    label: `Processing ${allCards.length} cards…`,
  });

  let cardRepCount = 0;
  for (let i = 0; i < allCards.length; i++) {
    if (options?.signal?.aborted && i % 200 === 0) throw new Error('Aborted');
    const card = allCards[i];
    const history = card.repetitionHistory || [];
    for (const rep of history) {
      if (!rep || typeof rep.date !== 'number') continue;
      if (!isRealCardScore(rep.score)) continue;
      const b = findOrCreateBucket(buckets, getLocalDateKey(rep.date), kbId);
      const t = Math.min(Math.max(0, rep.responseTime || 0), flashcardResponseTimeCapMs);
      b.cardsCount += 1;
      b.cardsTime += t;
      b.totalTime += t;
      if (rep.score === QueueInteractionScore.AGAIN) b.forgotCount += 1;
      cardRepCount++;
    }
    if (i % 1000 === 0 && i > 0) {
      const pct = 0.05 + 0.35 * (i / allCards.length);
      options?.onProgress?.({
        percent: pct,
        label: `Cards: ${i}/${allCards.length}`,
      });
    }
  }
  options?.onProgress?.({
    percent: 0.4,
    label: `Cards done (${cardRepCount} reps)`,
  });

  // ── 2. Incremental powerup history ──────────────────────────────────────
  if (options?.signal?.aborted) throw new Error('Aborted');
  const incPowerup = await plugin.powerup.getPowerupByCode(powerupCode);
  const incRems = (await incPowerup?.taggedRem()) || [];
  options?.onProgress?.({
    percent: 0.42,
    label: `IncRems: 0/${incRems.length}`,
  });
  await processHistorySlots(
    incRems as any,
    powerupCode,
    repHistorySlotCode,
    buckets,
    kbId,
    options,
    0.42,
    0.75,
    'IncRems'
  );

  // ── 3. Dismissed powerup history ────────────────────────────────────────
  if (options?.signal?.aborted) throw new Error('Aborted');
  const dismPowerup = await plugin.powerup.getPowerupByCode(dismissedPowerupCode);
  const dismRems = (await dismPowerup?.taggedRem()) || [];
  options?.onProgress?.({
    percent: 0.77,
    label: `Dismissed: 0/${dismRems.length}`,
  });
  await processHistorySlots(
    dismRems as any,
    dismissedPowerupCode,
    dismissedHistorySlotCode,
    buckets,
    kbId,
    options,
    0.77,
    1.0,
    'Dismissed'
  );

  options?.onProgress?.({ percent: 1, label: 'Done' });
  return buckets;
}

/**
 * Write the current KB's buckets to its own shard and stamp the last-computed
 * timestamp.
 *
 * Other knowledge bases are no longer this function's problem: they live in their
 * own keys, so the read-merge-preserve dance that used to guard them is gone, and
 * a recompute now writes only what it computed.
 */
export async function saveAuthoritativeAggregates(
  plugin: RNPlugin,
  currentKbBuckets: DailyAggregate[]
): Promise<void> {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  // Drain the legacy key first, or a later migration would resurrect this KB's
  // pre-recompute buckets over the ones being written now.
  await migrateAuthoritativeAggregatesToShards(plugin);

  const payload = encodeAuthoritativeAggregates(currentKbBuckets);

  // This key outgrew the per-key ceiling once already, and a write over it is
  // rejected rather than truncated — which is silent unless we look. Log the size
  // so a regression shows up in the console instead of as a dashboard that
  // mysteriously stops updating.
  const bytes = utf16Bytes(payload);
  const pctOfLimit = (bytes / PER_KEY_UTF16_LIMIT) * 100;
  if (pctOfLimit >= 50) {
    console.warn(
      `[AuthoritativeAggregates] ${kbId.substring(0, 8)}… shard is ${(bytes / 1024).toFixed(1)}KB — ` +
        `${pctOfLimit.toFixed(0)}% of the ${PER_KEY_UTF16_LIMIT / 1024}KB per-key limit (UTF-16). ` +
        'Consider rolling old days up into months.'
    );
  } else {
    console.log(
      `[AuthoritativeAggregates] Saving ${currentKbBuckets.length} buckets to the ` +
        `${kbId.substring(0, 8)}… shard, ${(bytes / 1024).toFixed(1)}KB ` +
        `(${pctOfLimit.toFixed(1)}% of the per-key limit).`
    );
  }

  await plugin.storage.setSynced(authoritativeShardKey(kbId), payload);
  await plugin.storage.setSynced(AUTHORITATIVE_LAST_COMPUTED_KEY, Date.now());
}

/**
 * Takes the raw stored value in EITHER format (legacy array or compact store)
 * and returns this KB's buckets. Callers pass whatever `getSynced` /
 * `useSyncedStorageState` handed them; decoding lives here so no consumer has
 * to know which shape is on disk.
 */
export function filterAuthoritativeForKb(
  aggregates: unknown,
  currentKbId: string
): DailyAggregate[] {
  return decodeAuthoritativeAggregates(aggregates).filter((a) => a.kbId === currentKbId);
}

/**
 * Combined period-stats: authoritative as the base, listener-derived data
 * filling gaps and supplementing pre-cutoff IncRem stats.
 *
 * Cards / forgotCount:
 *   - Always primarily from authoritative (card.repetitionHistory is canonical).
 *   - Listener fills gap days that are AFTER the authoritative compute (post-
 *     recompute sessions or buckets dated after lastComputedDayKey).
 *
 * IncRems (count + time):
 *   - For days >= INCREM_AUTHORITATIVE_CUTOFF_DATE (post-cutoff): authoritative
 *     wins; listener fills gaps after lastComputed.
 *   - For days <  cutoff (pre-cutoff): use per-day MAX(auth, listener) for each
 *     field independently. This way:
 *       · authoritative captures the count of reps still preserved in powerup
 *         history (more complete than listener for pre-listener era).
 *       · listener supplies wall-clock time for the era before
 *         reviewTimeSeconds was recorded (pre-2025-11-06) where auth time = 0.
 *       · if the user had rems dismissed-and-deleted before the Dismissed
 *         powerup existed, listener's count may exceed auth's; MAX takes it.
 *
 *   totalTime is recomputed at the end as cardsTime + incRemsTime.
 *
 * If `authoritative` is empty (never computed for this KB), the function falls
 * back to summing rawSessions + listenerAggregates with no cutoff — equivalent
 * to the original listener-only behavior.
 */
export function aggregatePeriodStatsCombined(
  authoritative: DailyAggregate[],
  rawSessions: PracticedQueueSession[],
  listenerAggregates: DailyAggregate[],
  lastComputed: number,
  startMs: number,
  endMs?: number
): PeriodStats {
  const stats: PeriodStats = {
    totalTime: 0,
    cardsCount: 0,
    cardsTime: 0,
    incRemsCount: 0,
    incRemsTime: 0,
    forgotCount: 0,
  };

  const hasAuthoritative = authoritative.length > 0 && lastComputed > 0;
  const startKey = getLocalDateKey(startMs);
  const endKey =
    endMs !== undefined ? getLocalDateKey(endMs - 1) : getLocalDateKey(Date.now());
  const lastComputedDayKey = hasAuthoritative ? getLocalDateKey(lastComputed) : '';
  const incRemCutoffKey = INCREM_AUTHORITATIVE_CUTOFF_DATE;

  // No authoritative yet → pure listener-summing fallback (cutoff irrelevant).
  if (!hasAuthoritative) {
    for (const s of rawSessions) {
      if (!s) continue;
      if (s.startTime < startMs) continue;
      if (endMs !== undefined && s.startTime >= endMs) continue;
      stats.cardsCount += s.flashcardsCount || 0;
      stats.cardsTime += s.flashcardsTime || 0;
      stats.incRemsCount += s.incRemsCount || 0;
      stats.incRemsTime += s.incRemsTime || 0;
      stats.forgotCount += s.againCount || 0;
    }
    for (const b of listenerAggregates) {
      if (!b) continue;
      if (b.date < startKey || b.date > endKey) continue;
      stats.cardsCount += b.cardsCount;
      stats.cardsTime += b.cardsTime;
      stats.incRemsCount += b.incRemsCount;
      stats.incRemsTime += b.incRemsTime;
      stats.forgotCount += b.forgotCount;
    }
    stats.totalTime = stats.cardsTime + stats.incRemsTime;
    return stats;
  }

  // Per-day pre-cutoff IncRem reconciliation (MAX strategy).
  const authPreByDay = new Map<string, { count: number; time: number }>();
  const listenerPreByDay = new Map<string, { count: number; time: number }>();
  const addListenerPre = (day: string, count: number, time: number) => {
    if (day >= incRemCutoffKey) return;
    if (day < startKey || day > endKey) return;
    const cur = listenerPreByDay.get(day) || { count: 0, time: 0 };
    cur.count += count;
    cur.time += time;
    listenerPreByDay.set(day, cur);
  };

  // Authoritative buckets — cards always summed; pre-cutoff IncRems deferred.
  for (const b of authoritative) {
    if (!b) continue;
    if (b.date < startKey || b.date > endKey) continue;
    stats.cardsCount += b.cardsCount;
    stats.cardsTime += b.cardsTime;
    stats.forgotCount += b.forgotCount;
    if (b.date >= incRemCutoffKey) {
      stats.incRemsCount += b.incRemsCount;
      stats.incRemsTime += b.incRemsTime;
    } else {
      authPreByDay.set(b.date, { count: b.incRemsCount, time: b.incRemsTime });
    }
  }

  // Sessions: post-recompute additions; pre-cutoff goes into listener-pre map.
  for (const s of rawSessions) {
    if (!s) continue;
    if (s.startTime < startMs) continue;
    if (endMs !== undefined && s.startTime >= endMs) continue;
    const sDayKey = getLocalDateKey(s.startTime);
    if (sDayKey < incRemCutoffKey) {
      addListenerPre(sDayKey, s.incRemsCount || 0, s.incRemsTime || 0);
      // Cards: authoritative already counted them; do NOT add session cards.
    } else if (s.startTime > lastComputed) {
      // Post-cutoff and not yet in authoritative.
      stats.cardsCount += s.flashcardsCount || 0;
      stats.cardsTime += s.flashcardsTime || 0;
      stats.incRemsCount += s.incRemsCount || 0;
      stats.incRemsTime += s.incRemsTime || 0;
      stats.forgotCount += s.againCount || 0;
    }
    // else: post-cutoff & pre-recompute → already in authoritative.
  }

  // Listener-aggregate buckets: pre-cutoff into listener-pre map; post-cutoff
  // gap-fill if dated after lastComputedDayKey.
  for (const b of listenerAggregates) {
    if (!b) continue;
    if (b.date < startKey || b.date > endKey) continue;
    if (b.date < incRemCutoffKey) {
      addListenerPre(b.date, b.incRemsCount, b.incRemsTime);
    } else if (b.date > lastComputedDayKey) {
      stats.cardsCount += b.cardsCount;
      stats.cardsTime += b.cardsTime;
      stats.incRemsCount += b.incRemsCount;
      stats.incRemsTime += b.incRemsTime;
      stats.forgotCount += b.forgotCount;
    }
  }

  // MAX-per-field for pre-cutoff IncRem days.
  const preDays = new Set<string>([...authPreByDay.keys(), ...listenerPreByDay.keys()]);
  for (const day of preDays) {
    const a = authPreByDay.get(day) || { count: 0, time: 0 };
    const l = listenerPreByDay.get(day) || { count: 0, time: 0 };
    stats.incRemsCount += Math.max(a.count, l.count);
    stats.incRemsTime += Math.max(a.time, l.time);
  }

  stats.totalTime = stats.cardsTime + stats.incRemsTime;
  return stats;
}

/**
 * Build a per-day diff between freshly-computed authoritative buckets and the
 * listener-derived stats (raw sessions + rolled-over aggregate buckets) for
 * the same KB. Logs the comparison to the console so the user can inspect
 * where listener-tracking under- or over-counted vs the authoritative walk.
 */
export function logAuthoritativeDiff(
  freshAuthoritative: DailyAggregate[],
  rawSessions: PracticedQueueSession[],
  listenerAggregates: DailyAggregate[],
  kbId: string
): void {
  type DayStats = {
    cardsCount: number;
    cardsTime: number;
    incRemsCount: number;
    incRemsTime: number;
    forgotCount: number;
  };
  const empty = (): DayStats => ({
    cardsCount: 0,
    cardsTime: 0,
    incRemsCount: 0,
    incRemsTime: 0,
    forgotCount: 0,
  });

  const authMap = new Map<string, DayStats>();
  for (const b of freshAuthoritative) {
    authMap.set(b.date, {
      cardsCount: b.cardsCount,
      cardsTime: b.cardsTime,
      incRemsCount: b.incRemsCount,
      incRemsTime: b.incRemsTime,
      forgotCount: b.forgotCount,
    });
  }

  const listenerMap = new Map<string, DayStats>();
  const addToListener = (day: string, src: Partial<DayStats>) => {
    const cur = listenerMap.get(day) || empty();
    cur.cardsCount += src.cardsCount || 0;
    cur.cardsTime += src.cardsTime || 0;
    cur.incRemsCount += src.incRemsCount || 0;
    cur.incRemsTime += src.incRemsTime || 0;
    cur.forgotCount += src.forgotCount || 0;
    listenerMap.set(day, cur);
  };
  for (const s of rawSessions) {
    if (!s) continue;
    addToListener(getLocalDateKey(s.startTime), {
      cardsCount: s.flashcardsCount,
      cardsTime: s.flashcardsTime,
      incRemsCount: s.incRemsCount,
      incRemsTime: s.incRemsTime,
      forgotCount: s.againCount,
    });
  }
  for (const b of listenerAggregates) {
    if (!b) continue;
    addToListener(b.date, b);
  }

  const allDays = Array.from(new Set([...authMap.keys(), ...listenerMap.keys()])).sort();

  let totalAuth = empty();
  let totalListener = empty();
  let daysWithDelta = 0;
  const daysWithMissingAuth: string[] = [];
  const daysWithMissingListener: string[] = [];
  const fmtTime = (ms: number) => `${Math.round(ms / 1000)}s`;

  console.groupCollapsed(
    `[Authoritative Diff] KB=${kbId} — ${allDays.length} day(s) compared (cutoff for IncRem reliability: ${INCREM_AUTHORITATIVE_CUTOFF_DATE})`
  );
  for (const day of allDays) {
    const a = authMap.get(day) || empty();
    const l = listenerMap.get(day) || empty();
    totalAuth = sumStats(totalAuth, a);
    totalListener = sumStats(totalListener, l);
    const dCards = a.cardsCount - l.cardsCount;
    const dCardsT = a.cardsTime - l.cardsTime;
    const dInc = a.incRemsCount - l.incRemsCount;
    const dIncT = a.incRemsTime - l.incRemsTime;
    const dForgot = a.forgotCount - l.forgotCount;
    const hasDelta =
      dCards !== 0 || dCardsT !== 0 || dInc !== 0 || dIncT !== 0 || dForgot !== 0;
    if (hasDelta) daysWithDelta++;
    if (!authMap.has(day) && listenerMap.has(day)) daysWithMissingAuth.push(day);
    if (authMap.has(day) && !listenerMap.has(day)) daysWithMissingListener.push(day);
    const preCutoff = day < INCREM_AUTHORITATIVE_CUTOFF_DATE ? ' (pre-cutoff)' : '';
    console.log(
      `${day}${preCutoff}: auth { c=${a.cardsCount}/${fmtTime(a.cardsTime)}, ir=${a.incRemsCount}/${fmtTime(a.incRemsTime)}, again=${a.forgotCount} } | listener { c=${l.cardsCount}/${fmtTime(l.cardsTime)}, ir=${l.incRemsCount}/${fmtTime(l.incRemsTime)}, again=${l.forgotCount} } | Δ c=${dCards >= 0 ? '+' : ''}${dCards}/${dCardsT >= 0 ? '+' : ''}${fmtTime(dCardsT)} ir=${dInc >= 0 ? '+' : ''}${dInc}/${dIncT >= 0 ? '+' : ''}${fmtTime(dIncT)} again=${dForgot >= 0 ? '+' : ''}${dForgot}`
    );
  }
  console.log(
    `── Totals ── auth: ${totalAuth.cardsCount} cards (${fmtTime(totalAuth.cardsTime)}), ${totalAuth.incRemsCount} incRems (${fmtTime(totalAuth.incRemsTime)}), ${totalAuth.forgotCount} again`
  );
  console.log(
    `── Totals ── listener: ${totalListener.cardsCount} cards (${fmtTime(totalListener.cardsTime)}), ${totalListener.incRemsCount} incRems (${fmtTime(totalListener.incRemsTime)}), ${totalListener.forgotCount} again`
  );
  console.log(
    `Days with non-zero deltas: ${daysWithDelta}/${allDays.length}; days missing in authoritative: ${daysWithMissingAuth.length}; days missing in listener: ${daysWithMissingListener.length}`
  );
  console.groupEnd();
}

function sumStats<T extends Record<string, number>>(a: T, b: Partial<T>): T {
  const out = { ...a } as any;
  for (const k of Object.keys(a)) out[k] = (a as any)[k] + ((b as any)[k] || 0);
  return out as T;
}
