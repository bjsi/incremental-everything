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

// Days strictly before this local date are not fully reliable for IncRem stats:
// the Dismissed powerup (which preserves history when a rem is no longer
// Incremental) was introduced on 2026-01-30 (commit fc21734). Reviews on rems
// that were dismissed BEFORE that date had their history wiped along with the
// powerup removal, so the authoritative walk cannot see them. For dates older
// than the cutoff, prefer listener-derived incRem stats (the live tracker
// captured them at the time). Cards are unaffected — card.repetitionHistory
// has always been the source of truth.
export const INCREM_AUTHORITATIVE_CUTOFF_DATE = '2026-01-30';

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
