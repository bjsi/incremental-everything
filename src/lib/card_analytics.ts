/**
 * Card Priority × Memory Analytics — replays every card's FSRS history and
 * aggregates per-card stats into 10 priority-percentile buckets plus an
 * overall KB row. Used by the new tab in WeightedShieldPopupView.
 *
 * Card population follows the `card.getAll()` + filter-by-remId pattern so
 * disabled / paused cards are included (matching other batch flows).
 * Priority is inherited from the owning Rem (read from the existing
 * allCardPriorityInfoKey cache); cards from rems missing in that cache are
 * skipped.
 */

import { RNPlugin, QueueInteractionScore } from '@remnote/plugin-sdk';
import { CardPriorityInfo } from './card_priority/types';
import { computeFSRSState, computeFSRSStatesPerReview } from './fsrs';

export interface CardBucketStats {
  label: string;          // "0-10%" or "All KB"
  priorityRange: string;  // e.g. "6-12", or "—"
  // Population
  cards: number;
  due: number;
  donePct: number;        // 0-100, (cards - due) / cards
  newCount: number;
  newPct: number;
  staleCount: number;
  stalePct: number;
  // Throughput — all aggregates use gradeable reps (Again/Hard/Good/Easy)
  // over the full history, with each rep's responseTime capped at cardCapMs
  // (matches study_dashboard / practiced_queues).
  totReps: number;        // total gradeable reps
  totTimeMs: number;      // total capped response time
  avgReps: number;        // totReps / cards
  avgTimeMs: number;      // totTimeMs / cards
  cpm: number;            // totReps / (totTimeMs / 60_000)
  avgTimePerRepMs: number;// totTimeMs / totReps
  avgCostMinPerYear: number; // mean of per-card cost over cards with cost
  // Outcome
  avgLapses: number;      // mean over non-new cards
  retention: number;      // 0-100, (gradeableReps - agains) / gradeableReps
  avgPredR: number;       // 0-100, mean predicted R over every step where r != null
  rDevPP: number;         // retention - avgPredR (percentage points)
  avgGrade: number;       // 1-4
  // FSRS current state (today)
  avgD: number;
  avgRtoday: number;      // 0-100
  avgS: number;           // days
}

export interface CardAnalyticsBreakdown {
  buckets: CardBucketStats[];   // length 10
  overall: CardBucketStats;
  totalCards: number;
  computedAt: number;
  /** Cards seen from card.getAll() whose rem was missing from the priority cache (skipped). */
  cardsSkippedNoPriority: number;
  /**
   * Whether pre-RESET history was excluded. Persisted in the cache so the view
   * can sync the toggle to the data it's showing and recompute on mismatch.
   */
  ignorePreReset: boolean;
}

interface AccData {
  count: number;
  minPriority: number;
  maxPriority: number;
  due: number;
  newCount: number;
  staleCount: number;
  // Throughput aggregates (all over gradeable reps in the FULL history, capped responseTime)
  totGradeableReps: number;
  totTimeMs: number;
  totAgains: number;
  // Outcome aggregates
  totLapses: number;
  nonNewCards: number;
  sumCost: number;
  cardsWithCost: number;
  sumPredR: number;
  predRCount: number;
  sumGrade: number;
  gradeCount: number;
  // FSRS aggregates
  sumD: number;
  sumS: number;
  sumRtoday: number;
  fsrsCount: number;
}

interface PerCardStats {
  isDue: boolean;
  isNew: boolean;
  isStale: boolean;
  /** Gradeable repetitions over the FULL history (matches study_dashboard.cardReps). */
  gradeableReps: number;
  /** Sum of response time across gradeable reps, each capped at cardCapMs. */
  totalTimeMs: number;
  agains: number;
  lapses: number;
  cost: number | null;
  sumPredR: number;
  predRCount: number;
  sumGrade: number;
  gradeCount: number;
  d: number | null;
  s: number | null;
  rToday: number | null;
}

function makeAcc(): AccData {
  return {
    count: 0,
    minPriority: Infinity,
    maxPriority: -Infinity,
    due: 0,
    newCount: 0,
    staleCount: 0,
    totGradeableReps: 0,
    totTimeMs: 0,
    totAgains: 0,
    totLapses: 0,
    nonNewCards: 0,
    sumCost: 0,
    cardsWithCost: 0,
    sumPredR: 0,
    predRCount: 0,
    sumGrade: 0,
    gradeCount: 0,
    sumD: 0,
    sumS: 0,
    sumRtoday: 0,
    fsrsCount: 0,
  };
}

function isGradeable(score: QueueInteractionScore): boolean {
  return (
    score === QueueInteractionScore.AGAIN ||
    score === QueueInteractionScore.HARD ||
    score === QueueInteractionScore.GOOD ||
    score === QueueInteractionScore.EASY
  );
}

function gradeValue(score: QueueInteractionScore): number | null {
  switch (score) {
    case QueueInteractionScore.AGAIN: return 1;
    case QueueInteractionScore.HARD: return 2;
    case QueueInteractionScore.GOOD: return 3;
    case QueueInteractionScore.EASY: return 4;
    default: return null;
  }
}

function computeCardStats(
  card: any,
  weights: number[] | null,
  now: number,
  cardCapMs: number,
  ignorePreReset: boolean,
): PerCardStats {
  const history = card.repetitionHistory ?? [];
  const sorted = [...history].sort((a: any, b: any) => a.date - b.date);

  // Default iteration set is the FULL history (matches study_dashboard /
  // practiced_queues). When the user opts in via the "ignore pre-RESET" toggle
  // — useful after imports that bring foreign repetition histories — we slice
  // off everything up to and including the last RESET.
  let iter: any[] = sorted;
  if (ignorePreReset) {
    const lastResetIdx = sorted.map((h: any) => h.score).lastIndexOf(QueueInteractionScore.RESET);
    if (lastResetIdx !== -1) iter = sorted.slice(lastResetIdx + 1);
  }

  let gradeableReps = 0;
  let totalTimeMs = 0;
  let agains = 0;
  let sumGrade = 0;
  let gradeCount = 0;
  let firstGradeableDate: number | null = null;

  for (const h of iter) {
    if (!isGradeable(h.score)) continue;
    gradeableReps++;
    const t = Math.min(Math.max(0, h.responseTime || 0), cardCapMs);
    totalTimeMs += t;
    if (h.score === QueueInteractionScore.AGAIN) agains++;
    const g = gradeValue(h.score);
    if (g !== null) {
      sumGrade += g;
      gradeCount++;
    }
    if (firstGradeableDate === null) firstGradeableDate = h.date;
  }

  const isNew = gradeableReps === 0;
  const lapses = agains;

  // Due: matches card_priority/index.ts convention exactly.
  const nextRep = card.nextRepetitionTime as number | undefined;
  const isDue = (nextRep ?? Infinity) <= now;

  // Stale: matches flashcard_repetition_history.tsx — overdue by > 2× last interval.
  let isStale = false;
  const lastRep = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  if (lastRep && nextRep && nextRep > lastRep.date) {
    const lastInterval = nextRep - lastRep.date;
    const staleDate = lastRep.date + 2 * lastInterval;
    isStale = now > staleDate;
  }

  // Cost: matches flashcard_repetition_history.tsx coverage-based formula,
  // anchored on the first gradeable rep of the full history. responseTime is
  // already capped above, so a single outlier doesn't blow up the per-card cost.
  let cost: number | null = null;
  const firstRepDate = firstGradeableDate;
  if (firstRepDate && totalTimeMs > 0) {
    const totalMinutes = totalTimeMs / 60000;
    const yearMs = 1000 * 60 * 60 * 24 * 365;
    if (nextRep && nextRep > now) {
      const coverageYears = (nextRep - firstRepDate) / yearMs;
      if (coverageYears > 0) cost = totalMinutes / coverageYears;
    } else {
      const ageYears = (now - firstRepDate) / yearMs;
      if (ageYears > 0) cost = totalMinutes / ageYears;
    }
  }

  // Predicted R at every step (skip first/learning where r is null).
  let sumPredR = 0;
  let predRCount = 0;
  let d: number | null = null;
  let s: number | null = null;
  let rToday: number | null = null;

  if (!isNew) {
    try {
      const steps = computeFSRSStatesPerReview(history, weights);
      for (const step of steps) {
        if (step.r !== null && !Number.isNaN(step.r)) {
          sumPredR += step.r;
          predRCount++;
        }
      }
      const state = computeFSRSState(history, weights);
      if (state) {
        d = state.d;
        s = state.s;
        rToday = state.r;
      }
    } catch {
      // FSRS failure on a single card is non-fatal — its FSRS-derived stats just stay null.
    }
  }

  return {
    isDue,
    isNew,
    isStale,
    gradeableReps,
    totalTimeMs,
    agains,
    lapses,
    cost,
    sumPredR,
    predRCount,
    sumGrade,
    gradeCount,
    d,
    s,
    rToday,
  };
}

function accumulate(acc: AccData, stats: PerCardStats, priority: number) {
  acc.count++;
  if (priority < acc.minPriority) acc.minPriority = priority;
  if (priority > acc.maxPriority) acc.maxPriority = priority;
  if (stats.isDue) acc.due++;
  if (stats.isNew) acc.newCount++;
  if (stats.isStale) acc.staleCount++;

  acc.totGradeableReps += stats.gradeableReps;
  acc.totTimeMs += stats.totalTimeMs;
  acc.totAgains += stats.agains;

  if (!stats.isNew) {
    acc.totLapses += stats.lapses;
    acc.nonNewCards++;
  }
  if (stats.cost !== null) {
    acc.sumCost += stats.cost;
    acc.cardsWithCost++;
  }

  acc.sumPredR += stats.sumPredR;
  acc.predRCount += stats.predRCount;
  acc.sumGrade += stats.sumGrade;
  acc.gradeCount += stats.gradeCount;

  if (stats.d !== null && stats.s !== null && stats.rToday !== null) {
    acc.sumD += stats.d;
    acc.sumS += stats.s;
    acc.sumRtoday += stats.rToday;
    acc.fsrsCount++;
  }
}

function finalize(acc: AccData, label: string): CardBucketStats {
  const cards = acc.count;
  const priorityRange =
    cards > 0 && Number.isFinite(acc.minPriority) && Number.isFinite(acc.maxPriority)
      ? `${acc.minPriority}-${acc.maxPriority}`
      : '—';
  const donePct = cards > 0 ? ((cards - acc.due) / cards) * 100 : 100;
  const newPct = cards > 0 ? (acc.newCount / cards) * 100 : 0;
  const stalePct = cards > 0 ? (acc.staleCount / cards) * 100 : 0;
  const avgReps = cards > 0 ? acc.totGradeableReps / cards : 0;
  const avgTimeMs = cards > 0 ? acc.totTimeMs / cards : 0;
  const cpm = acc.totTimeMs > 0 ? acc.totGradeableReps / (acc.totTimeMs / 60000) : 0;
  const avgTimePerRepMs = acc.totGradeableReps > 0 ? acc.totTimeMs / acc.totGradeableReps : 0;
  const avgCost = acc.cardsWithCost > 0 ? acc.sumCost / acc.cardsWithCost : 0;
  const avgLapses = acc.nonNewCards > 0 ? acc.totLapses / acc.nonNewCards : 0;
  const retention =
    acc.totGradeableReps > 0
      ? ((acc.totGradeableReps - acc.totAgains) / acc.totGradeableReps) * 100
      : 0;
  const avgPredR = acc.predRCount > 0 ? (acc.sumPredR / acc.predRCount) * 100 : 0;
  // R-deviation only meaningful when both retention and predicted R have a basis.
  const rDevPP = acc.totGradeableReps > 0 && acc.predRCount > 0 ? retention - avgPredR : 0;
  const avgGrade = acc.gradeCount > 0 ? acc.sumGrade / acc.gradeCount : 0;
  const avgD = acc.fsrsCount > 0 ? acc.sumD / acc.fsrsCount : 0;
  const avgS = acc.fsrsCount > 0 ? acc.sumS / acc.fsrsCount : 0;
  const avgRtoday = acc.fsrsCount > 0 ? (acc.sumRtoday / acc.fsrsCount) * 100 : 0;

  return {
    label,
    priorityRange,
    cards,
    due: acc.due,
    donePct,
    newCount: acc.newCount,
    newPct,
    staleCount: acc.staleCount,
    stalePct,
    totReps: acc.totGradeableReps,
    totTimeMs: acc.totTimeMs,
    avgReps,
    avgTimeMs,
    cpm,
    avgTimePerRepMs,
    avgCostMinPerYear: avgCost,
    avgLapses,
    retention,
    avgPredR,
    rDevPP,
    avgGrade,
    avgD,
    avgRtoday,
    avgS,
  };
}

/**
 * Replay FSRS over every card and aggregate per priority-percentile bucket.
 *
 * The expensive part is `plugin.card.getAll()` (one call) and the per-card
 * FSRS replay (CPU only — no further async). We yield to the event loop every
 * `YIELD_EVERY` cards so the popup stays responsive while progress updates.
 */
export async function computeCardAnalyticsBreakdown(
  plugin: RNPlugin,
  cardPriorityInfos: CardPriorityInfo[],
  weights: number[] | null,
  cardCapMs: number,
  ignorePreReset: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<CardAnalyticsBreakdown> {
  // Map remId → inherited rem priority. Filter out rems with explicit zero cards.
  const remPriority = new Map<string, number>();
  for (const info of cardPriorityInfos) {
    if (info.cardCount === undefined || info.cardCount > 0) {
      remPriority.set(info.remId, info.priority);
    }
  }

  // Pull every card from the KB (includes disabled/paused — matches batch.ts pattern).
  const allCards = (await plugin.card.getAll()) || [];

  const validCards: any[] = [];
  let cardsSkippedNoPriority = 0;
  for (const c of allCards) {
    if (remPriority.has(c.remId)) validCards.push(c);
    else cardsSkippedNoPriority++;
  }

  // Sort by inherited priority so we can bucket by 1-based index percentile.
  validCards.sort((a, b) => (remPriority.get(a.remId)! - remPriority.get(b.remId)!));

  const N = validCards.length;
  const bucketAccs: AccData[] = Array.from({ length: 10 }, makeAcc);
  const overallAcc = makeAcc();
  const now = Date.now();

  const YIELD_EVERY = 1500;

  if (onProgress) onProgress(0, N);

  for (let i = 0; i < N; i++) {
    const card = validCards[i];
    const priority = remPriority.get(card.remId)!;
    // 1-based index percentile so the last card lands at 100% → bucket index 9.
    const percentile = ((i + 1) / N) * 100;
    const bIdx = Math.min(Math.floor(percentile / 10), 9);

    const stats = computeCardStats(card, weights, now, cardCapMs, ignorePreReset);
    accumulate(bucketAccs[bIdx], stats, priority);
    accumulate(overallAcc, stats, priority);

    if ((i + 1) % YIELD_EVERY === 0) {
      if (onProgress) onProgress(i + 1, N);
      // Yield to the event loop so the progress bar can repaint.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  if (onProgress) onProgress(N, N);

  return {
    buckets: bucketAccs.map((acc, i) => finalize(acc, `${i * 10}-${(i + 1) * 10}%`)),
    overall: finalize(overallAcc, 'All KB'),
    totalCards: N,
    computedAt: Date.now(),
    cardsSkippedNoPriority,
    ignorePreReset,
  };
}
