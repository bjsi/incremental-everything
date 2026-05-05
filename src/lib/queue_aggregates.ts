import { RNPlugin } from '@remnote/plugin-sdk';
import type { PracticedQueueSession } from '../widgets/practiced_queues';

export const PRACTICED_QUEUES_HISTORY_KEY = 'practicedQueuesHistory';
export const DAILY_AGGREGATES_KEY = 'practicedQueuesDailyAggregates';
export const RAW_SESSION_WINDOW_DAYS = 30;
export const UNKNOWN_KB_ID = '__unknown__';

export interface DailyAggregate {
  date: string;
  kbId: string;
  totalTime: number;
  cardsCount: number;
  cardsTime: number;
  incRemsCount: number;
  incRemsTime: number;
  forgotCount: number;
  ids: string[];
}

export interface PeriodStats {
  totalTime: number;
  cardsCount: number;
  cardsTime: number;
  incRemsCount: number;
  incRemsTime: number;
  forgotCount: number;
}

export function getLocalDateKey(timestamp: number): string {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function rawCutoffDateKey(now: number = Date.now()): string {
  return getLocalDateKey(now - RAW_SESSION_WINDOW_DAYS * 86400000);
}

export function getAggregatedIdsSet(aggregates: DailyAggregate[] | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!aggregates) return set;
  for (const b of aggregates) {
    if (!b || !b.ids) continue;
    for (const id of b.ids) set.add(id);
  }
  return set;
}

export function totalAggregatedSessionCount(
  aggregates: DailyAggregate[] | null | undefined
): number {
  if (!aggregates) return 0;
  let n = 0;
  for (const b of aggregates) n += b?.ids?.length || 0;
  return n;
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

/**
 * Add `session` to `aggregates` (mutating). Returns true if it was added,
 * false if it was a duplicate (already in `aggregatedIdsSet` or in the bucket).
 *
 * If `aggregatedIdsSet` is provided, it is consulted first and updated on
 * insert — pass it across many calls to avoid recomputing from scratch.
 */
export function bucketSession(
  aggregates: DailyAggregate[],
  session: PracticedQueueSession,
  aggregatedIdsSet?: Set<string>
): boolean {
  if (!session || !session.id) return false;
  if (aggregatedIdsSet?.has(session.id)) return false;
  const date = getLocalDateKey(session.startTime);
  const kbId = session.kbId || UNKNOWN_KB_ID;
  const bucket = findOrCreateBucket(aggregates, date, kbId);
  if (bucket.ids.includes(session.id)) return false;
  bucket.totalTime += session.totalTime || 0;
  bucket.cardsCount += session.flashcardsCount || 0;
  bucket.cardsTime += session.flashcardsTime || 0;
  bucket.incRemsCount += session.incRemsCount || 0;
  bucket.incRemsTime += session.incRemsTime || 0;
  bucket.forgotCount += session.againCount || 0;
  bucket.ids.push(session.id);
  if (aggregatedIdsSet) aggregatedIdsSet.add(session.id);
  return true;
}

/**
 * Move sessions older than the raw-window into daily aggregates. Idempotent:
 * each session id is in exactly one bucket and `bucket.ids` is the dedup
 * source of truth. Also strips null entries that may have been left by a
 * partial write (e.g. when synced storage hit its quota).
 *
 * Write order is critical: aggregates first (additive, contains all data and
 * the dedup ids), then raw history (destructive shrink). If the second write
 * fails the next call will re-bucket the same sessions, which is a no-op via
 * the per-bucket id check.
 */
export async function rollOverOldSessions(
  plugin: RNPlugin
): Promise<{ rolled: number; removedNulls: number }> {
  const rawHistory =
    ((await plugin.storage.getSynced(PRACTICED_QUEUES_HISTORY_KEY)) as PracticedQueueSession[]) ||
    [];
  const validHistory = rawHistory.filter((s): s is PracticedQueueSession => !!s);
  const removedNulls = rawHistory.length - validHistory.length;

  const cutoffKey = rawCutoffDateKey();
  const recent: PracticedQueueSession[] = [];
  const old: PracticedQueueSession[] = [];
  for (const s of validHistory) {
    if (getLocalDateKey(s.startTime) >= cutoffKey) recent.push(s);
    else old.push(s);
  }

  if (old.length === 0 && removedNulls === 0) return { rolled: 0, removedNulls: 0 };

  const aggregates =
    ((await plugin.storage.getSynced(DAILY_AGGREGATES_KEY)) as DailyAggregate[]) || [];
  const idsSet = getAggregatedIdsSet(aggregates);

  let rolled = 0;
  for (const s of old) {
    if (bucketSession(aggregates, s, idsSet)) rolled++;
  }

  await plugin.storage.setSynced(DAILY_AGGREGATES_KEY, aggregates);
  await plugin.storage.setSynced(PRACTICED_QUEUES_HISTORY_KEY, recent);

  return { rolled, removedNulls };
}

/**
 * Sum stats across raw sessions (already kbId-filtered) and aggregate buckets
 * (already kbId-filtered) for the period [startMs, endMs). Raw and bucket
 * domains do not overlap by construction (rollover splits at a local-day
 * boundary), so they are summed without dedup.
 */
export function aggregatePeriodStats(
  rawSessions: PracticedQueueSession[],
  aggregates: DailyAggregate[],
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

  for (const s of rawSessions) {
    if (!s) continue;
    if (s.startTime < startMs) continue;
    if (endMs !== undefined && s.startTime >= endMs) continue;
    stats.totalTime += s.totalTime || 0;
    stats.cardsCount += s.flashcardsCount || 0;
    stats.cardsTime += s.flashcardsTime || 0;
    stats.incRemsCount += s.incRemsCount || 0;
    stats.incRemsTime += s.incRemsTime || 0;
    stats.forgotCount += s.againCount || 0;
  }

  const startKey = getLocalDateKey(startMs);
  const endKey =
    endMs !== undefined ? getLocalDateKey(endMs - 1) : getLocalDateKey(Date.now());

  for (const b of aggregates) {
    if (!b) continue;
    if (b.date < startKey) continue;
    if (b.date > endKey) continue;
    stats.totalTime += b.totalTime;
    stats.cardsCount += b.cardsCount;
    stats.cardsTime += b.cardsTime;
    stats.incRemsCount += b.incRemsCount;
    stats.incRemsTime += b.incRemsTime;
    stats.forgotCount += b.forgotCount;
  }

  return stats;
}

export function filterAggregatesForKb(
  aggregates: DailyAggregate[] | null | undefined,
  currentKbId: string
): DailyAggregate[] {
  if (!aggregates) return [];
  return aggregates.filter(
    (a) => !!a && (a.kbId === currentKbId || a.kbId === UNKNOWN_KB_ID)
  );
}
