import { QueueInteractionScore, RNPlugin } from '@remnote/plugin-sdk';
import {
  powerupCode,
  repHistorySlotCode,
  dismissedPowerupCode,
  dismissedHistorySlotCode,
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

export const AUTHORITATIVE_AGGREGATES_KEY = 'authoritativeDailyAggregates';
export const AUTHORITATIVE_LAST_COMPUTED_KEY = 'authoritativeAggregatesLastComputed';

const FLASHCARD_RESPONSE_TIME_LIMIT_SETTING = 'flashcard_response_time_limit';
const DEFAULT_RESPONSE_TIME_LIMIT_SEC = 180;
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

function isRealIncRemRep(eventType: IncrementalRep['eventType']): boolean {
  // Counts as a real review:
  //   - undefined / 'rep' (default review)
  //   - 'executeRepetition' (editor-triggered review)
  //   - 'rescheduledInQueue' (counts per IncrementalRep type comment)
  // Excluded:
  //   - 'rescheduledInEditor', 'manualDateReset' (slot edits, not reviews)
  //   - 'madeIncremental', 'dismissed' (lifecycle markers)
  return (
    eventType === undefined ||
    eventType === 'rep' ||
    eventType === 'executeRepetition' ||
    eventType === 'rescheduledInQueue'
  );
}

async function processHistorySlots(
  plugin: RNPlugin,
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
  const responseTimeCapMs =
    ((await plugin.settings.getSetting<number>(FLASHCARD_RESPONSE_TIME_LIMIT_SETTING)) ||
      DEFAULT_RESPONSE_TIME_LIMIT_SEC) * 1000;

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
      const t = Math.min(Math.max(0, rep.responseTime || 0), responseTimeCapMs);
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
    plugin,
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
    plugin,
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
 * Replace only the current KB's buckets in synced storage; preserve other KBs.
 * Stamps the last-computed timestamp.
 */
export async function saveAuthoritativeAggregates(
  plugin: RNPlugin,
  currentKbBuckets: DailyAggregate[]
): Promise<void> {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  const existing =
    ((await plugin.storage.getSynced(AUTHORITATIVE_AGGREGATES_KEY)) as DailyAggregate[]) || [];
  const otherKbs = existing.filter((b) => !!b && b.kbId !== kbId && b.kbId !== UNKNOWN_KB_ID);
  await plugin.storage.setSynced(AUTHORITATIVE_AGGREGATES_KEY, [...otherKbs, ...currentKbBuckets]);
  await plugin.storage.setSynced(AUTHORITATIVE_LAST_COMPUTED_KEY, Date.now());
}

export function filterAuthoritativeForKb(
  aggregates: DailyAggregate[] | null | undefined,
  currentKbId: string
): DailyAggregate[] {
  if (!aggregates) return [];
  return aggregates.filter((a) => !!a && a.kbId === currentKbId);
}

/**
 * Combined period-stats with authoritative as the base and listener-derived
 * data filling gaps.
 *
 * Rules:
 *   - Authoritative buckets: summed within the period.
 *   - Sessions with startTime > lastComputed: summed (post-recompute additions
 *     for "today" or any later day).
 *   - Sessions with startTime <= lastComputed: skipped (already in authoritative).
 *   - Listener-aggregate buckets with date > lastComputed's local-day key:
 *     summed (gap fill for older days the recompute didn't cover — only
 *     possible if a newer recompute is pending).
 *   - Listener-aggregate buckets with date <= lastComputed's day key: skipped
 *     (already in authoritative).
 *
 * If `authoritative` is empty (never computed for this KB), the function falls
 * back to summing rawSessions + listenerAggregates with no cutoff — equivalent
 * to the current listener-only behavior.
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
  const cutoffDayKey = hasAuthoritative ? getLocalDateKey(lastComputed) : '';

  // Authoritative buckets
  for (const b of authoritative) {
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

  // Raw sessions: include pre-cutoff only when no authoritative coverage exists.
  for (const s of rawSessions) {
    if (!s) continue;
    if (s.startTime < startMs) continue;
    if (endMs !== undefined && s.startTime >= endMs) continue;
    if (hasAuthoritative && s.startTime <= lastComputed) continue;
    stats.totalTime += s.totalTime || 0;
    stats.cardsCount += s.flashcardsCount || 0;
    stats.cardsTime += s.flashcardsTime || 0;
    stats.incRemsCount += s.incRemsCount || 0;
    stats.incRemsTime += s.incRemsTime || 0;
    stats.forgotCount += s.againCount || 0;
  }

  // Listener-aggregate buckets: only days strictly after the authoritative
  // cutoff day. Without a cutoff, fall back to the original "all in window"
  // behavior.
  for (const b of listenerAggregates) {
    if (!b) continue;
    if (b.date < startKey) continue;
    if (b.date > endKey) continue;
    if (hasAuthoritative && b.date <= cutoffDayKey) continue;
    stats.totalTime += b.totalTime;
    stats.cardsCount += b.cardsCount;
    stats.cardsTime += b.cardsTime;
    stats.incRemsCount += b.incRemsCount;
    stats.incRemsTime += b.incRemsTime;
    stats.forgotCount += b.forgotCount;
  }

  return stats;
}
