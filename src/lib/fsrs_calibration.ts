/**
 * FSRS Calibration analytics — replays every card's repetition history to
 * evaluate how well FSRS's predicted retrievability matches observed retention,
 * sliced two ways:
 *
 *   Grid A — predicted R (20 rows, 5pp each) × prior stability (5 day buckets).
 *            "Was FSRS right about how likely I was to remember this?"
 *
 *   Grid B — previous gradeable rep's grade (4 rows: Again/Hard/Good/Easy) ×
 *            stability that existed BEFORE that previous grading (5 day buckets).
 *            "When I press Hard vs Easy, does FSRS adjust stability sensibly?"
 *
 * Avg pR convention matches `card_analytics.ts` so R-dev numbers are comparable:
 *   - skip the first gradeable rep of each post-RESET lifetime (no prior state),
 *   - for learning/relearning reps where FSRS leaves r=null, fall back to the
 *     forgetting curve computed from the previous gradeable rep's stability.
 */

import { RNPlugin, QueueInteractionScore } from '@remnote/plugin-sdk';
import { computeFSRSStatesPerReview, forgettingCurve, resolveWeights } from './fsrs';

// --- Bucket layout --------------------------------------------------------

/** 20 rows of 5pp each: 0–5%, 5–10%, …, 95–100%. */
export const R_BUCKET_COUNT = 20;

/** Five stability buckets in days, half-open lower / closed upper except the last. */
export const S_BUCKET_BOUNDS_DAYS: number[] = [30, 183, 365, 1095];
export const S_BUCKET_LABELS: string[] = ['≤1mo', '1–6mo', '6mo–1y', '1–3y', '>3y'];
export const S_BUCKET_COUNT = S_BUCKET_LABELS.length;

export const GRADE_ROW_LABELS: string[] = ['Again', 'Hard', 'Good', 'Easy'];

function stabilityBucket(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return -1;
  for (let i = 0; i < S_BUCKET_BOUNDS_DAYS.length; i++) {
    if (days <= S_BUCKET_BOUNDS_DAYS[i]) return i;
  }
  return S_BUCKET_BOUNDS_DAYS.length;
}

function rBucket(predR: number): number {
  // predR is 0..1; clamp and floor into 20 bins.
  const v = Math.max(0, Math.min(0.99999, predR));
  return Math.min(R_BUCKET_COUNT - 1, Math.floor(v * R_BUCKET_COUNT));
}

// --- Cell shape -----------------------------------------------------------

export interface CellStats {
  reps: number;
  retention: number; // 0..100
  avgPredR: number;  // 0..100
  rDevPP: number;    // retention - avgPredR
}

interface CellAcc {
  reps: number;
  retained: number;  // reps that were NOT Again
  sumPredR: number;  // sum of predicted r (0..1)
}

function makeAcc(): CellAcc { return { reps: 0, retained: 0, sumPredR: 0 }; }

function addAcc(a: CellAcc, b: CellAcc) {
  a.reps += b.reps;
  a.retained += b.retained;
  a.sumPredR += b.sumPredR;
}

function finalize(acc: CellAcc): CellStats {
  if (acc.reps === 0) return { reps: 0, retention: NaN, avgPredR: NaN, rDevPP: NaN };
  const retention = (acc.retained / acc.reps) * 100;
  const avgPredR = (acc.sumPredR / acc.reps) * 100;
  return { reps: acc.reps, retention, avgPredR, rDevPP: retention - avgPredR };
}

// --- Breakdown -----------------------------------------------------------

export interface FSRSCalibrationBreakdown {
  // Grid A: R bucket × S bucket
  gridA: CellStats[][];         // [R row 0..19][S col 0..4]
  gridARowTotals: CellStats[];  // length 20
  gridAColTotals: CellStats[];  // length 5
  gridAOverall: CellStats;

  // Grid B: previous grade × prior-to-prior stability
  gridB: CellStats[][];         // [grade row 0..3][S col 0..4]
  gridBRowTotals: CellStats[];  // length 4
  gridBColTotals: CellStats[];  // length 5
  gridBOverall: CellStats;

  totalCards: number;
  ignorePreReset: boolean;

  // Period metadata — mirrors CardAnalyticsBreakdown so the view can sync its
  // picker even though we don't persist a session cache.
  period: string;
  periodStartMs: number;
  periodEndMs: number;
  periodCustomStart: string;
  periodCustomEnd: string;
  computedAt: number;
}

export interface PeriodSpec {
  id: string;
  startMs: number;
  endMs: number;
  customStart: string;
  customEnd: string;
}

function isGradeable(score: QueueInteractionScore): boolean {
  return (
    score === QueueInteractionScore.AGAIN ||
    score === QueueInteractionScore.HARD ||
    score === QueueInteractionScore.GOOD ||
    score === QueueInteractionScore.EASY
  );
}

function gradeRow(score: QueueInteractionScore): number {
  switch (score) {
    case QueueInteractionScore.AGAIN: return 0;
    case QueueInteractionScore.HARD: return 1;
    case QueueInteractionScore.GOOD: return 2;
    case QueueInteractionScore.EASY: return 3;
    default: return -1;
  }
}

export async function computeFSRSCalibrationBreakdown(
  plugin: RNPlugin,
  weights: number[] | null,
  ignorePreReset: boolean,
  period: PeriodSpec,
  onProgress?: (done: number, total: number) => void,
): Promise<FSRSCalibrationBreakdown> {
  const { startMs, endMs } = period;
  const { w } = resolveWeights(weights);
  const DECAY = -w[20];
  const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

  const allCards = (await plugin.card.getAll()) || [];

  // Pre-allocate the accumulators for both grids.
  const accA: CellAcc[][] = Array.from({ length: R_BUCKET_COUNT }, () =>
    Array.from({ length: S_BUCKET_COUNT }, makeAcc),
  );
  const accB: CellAcc[][] = Array.from({ length: 4 }, () =>
    Array.from({ length: S_BUCKET_COUNT }, makeAcc),
  );

  const N = allCards.length;
  const YIELD_EVERY = 1500;
  if (onProgress) onProgress(0, N);

  for (let cardIdx = 0; cardIdx < N; cardIdx++) {
    const card = allCards[cardIdx];
    const history = card.repetitionHistory ?? [];
    if (history.length === 0) continue;

    const sorted = [...history].sort((a: any, b: any) => a.date - b.date);
    let effective: any[] = sorted;
    if (ignorePreReset) {
      const lastResetIdx = sorted.map((h: any) => h.score).lastIndexOf(QueueInteractionScore.RESET);
      if (lastResetIdx !== -1) effective = sorted.slice(lastResetIdx + 1);
    }

    let steps;
    try {
      steps = computeFSRSStatesPerReview(effective, weights);
    } catch {
      continue; // single-card failure is non-fatal
    }

    // Indices (within `effective`) of the most recent gradeable rep and the
    // one before that. Both reset on every RESET so a fresh lifetime starts
    // with no prior state.
    let lastGradeableIdx: number | null = null;
    let lastLastGradeableIdx: number | null = null;

    for (let i = 0; i < effective.length; i++) {
      const h = effective[i];
      if (h.score === QueueInteractionScore.RESET) {
        lastGradeableIdx = null;
        lastLastGradeableIdx = null;
        continue;
      }
      if (!isGradeable(h.score)) continue;

      // First gradeable rep of the lifetime: nothing to predict from.
      if (lastGradeableIdx === null) {
        lastGradeableIdx = i;
        continue;
      }

      // For every subsequent rep, derive predR using FSRS state from the
      // previous gradeable rep. Period filter applies only to whether we
      // ACCUMULATE this rep; pointer updates still happen so later reps in
      // the period get the right reference.
      const inPeriod = h.date >= startMs && h.date < endMs;
      if (inPeriod) {
        const prevS = steps[lastGradeableIdx]?.s ?? 0;
        const prevDate = effective[lastGradeableIdx].date;
        const elapsedDays = (h.date - prevDate) / (1000 * 60 * 60 * 24);

        let predR: number | null = steps[i]?.r ?? null;
        if (predR === null && prevS > 0 && elapsedDays >= 0) {
          predR = forgettingCurve(elapsedDays, prevS, DECAY, FACTOR);
        }

        if (predR !== null && Number.isFinite(predR)) {
          const retained = h.score !== QueueInteractionScore.AGAIN ? 1 : 0;

          // ----- Grid A: predR × prior S -----
          const sColA = stabilityBucket(prevS);
          const rRowA = rBucket(predR);
          if (sColA >= 0) {
            const cell = accA[rRowA][sColA];
            cell.reps++;
            cell.retained += retained;
            cell.sumPredR += predR;
          }

          // ----- Grid B: previous grade × stability before that prev grade -----
          if (lastLastGradeableIdx !== null) {
            const prevGrade = gradeRow(effective[lastGradeableIdx].score);
            const prevPrevS = steps[lastLastGradeableIdx]?.s ?? 0;
            const sColB = stabilityBucket(prevPrevS);
            if (prevGrade >= 0 && sColB >= 0) {
              const cell = accB[prevGrade][sColB];
              cell.reps++;
              cell.retained += retained;
              cell.sumPredR += predR;
            }
          }
        }
      }

      // Advance the pointers regardless of period membership.
      lastLastGradeableIdx = lastGradeableIdx;
      lastGradeableIdx = i;
    }

    if ((cardIdx + 1) % YIELD_EVERY === 0) {
      if (onProgress) onProgress(cardIdx + 1, N);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  if (onProgress) onProgress(N, N);

  // ----- Finalize: cells + row totals + col totals + overall -----

  const finalizeGrid = (acc: CellAcc[][], rows: number) => {
    const cells: CellStats[][] = [];
    const rowTotals: CellStats[] = [];
    const colTotalsAcc: CellAcc[] = Array.from({ length: S_BUCKET_COUNT }, makeAcc);
    const overallAcc = makeAcc();
    for (let r = 0; r < rows; r++) {
      const row: CellStats[] = [];
      const rowAcc = makeAcc();
      for (let c = 0; c < S_BUCKET_COUNT; c++) {
        row.push(finalize(acc[r][c]));
        addAcc(rowAcc, acc[r][c]);
        addAcc(colTotalsAcc[c], acc[r][c]);
        addAcc(overallAcc, acc[r][c]);
      }
      cells.push(row);
      rowTotals.push(finalize(rowAcc));
    }
    const colTotals = colTotalsAcc.map(finalize);
    return { cells, rowTotals, colTotals, overall: finalize(overallAcc) };
  };

  const a = finalizeGrid(accA, R_BUCKET_COUNT);
  const b = finalizeGrid(accB, 4);

  return {
    gridA: a.cells,
    gridARowTotals: a.rowTotals,
    gridAColTotals: a.colTotals,
    gridAOverall: a.overall,
    gridB: b.cells,
    gridBRowTotals: b.rowTotals,
    gridBColTotals: b.colTotals,
    gridBOverall: b.overall,
    totalCards: N,
    ignorePreReset,
    period: period.id,
    periodStartMs: period.startMs,
    periodEndMs: period.endMs,
    periodCustomStart: period.customStart,
    periodCustomEnd: period.customEnd,
    computedAt: Date.now(),
  };
}

export function rBucketLabel(row: number): string {
  const lo = row * (100 / R_BUCKET_COUNT);
  const hi = (row + 1) * (100 / R_BUCKET_COUNT);
  return `${lo.toFixed(0)}–${hi.toFixed(0)}%`;
}
