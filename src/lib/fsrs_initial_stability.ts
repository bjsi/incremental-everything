/**
 * Initial-stability (w0–w3) calibration.
 *
 * FSRS assigns S₀(G) — the stability in days set by the very first grade a card
 * ever receives — from `w[0..3]` (Again/Hard/Good/Easy). Unlike every other
 * parameter, these are not learned by the recurrent fit: fsrs-optimizer derives
 * them in a dedicated pre-training pass (`Optimizer.initialize_parameters`,
 * historically `pretrain`) that looks at exactly one slice of the revlog —
 * the *first review that actually tests memory* after the initial grade.
 *
 * This module reproduces that pass over RemNote's repetition history so the
 * Calibration tab can answer "how assertive is FSRS being about w0–w3, and is
 * the data even capable of pinning them down?".
 *
 * The optimizer's pipeline, and what we mirror:
 *
 *   1. Keep the rep with `i == 2` — the first gradeable rep on a *later day*
 *      than the first grade. Same-day learning steps are dropped upstream by
 *      the `delta_t != 0` filter and the rep index is recomputed afterwards,
 *      so `delta_t` is always "days from the first grade to the first review
 *      on a subsequent day".
 *   2. Group by (first grade, exact delta_t) → observed retention + n.
 *   3. `remove_outliers`: drop the rarest / longest-interval delta_t groups
 *      until ~5% (min 20) of the reps are gone, then keep dropping groups only
 *      if n < 6 or delta_t exceeds 100 days (365 for Easy).
 *   4. Fit a single S per grade by count-weighted binomial log-loss against the
 *      power forgetting curve, with the observation Laplace-smoothed toward the
 *      collection's average recall and an L1 pull toward the FSRS default.
 *   5. Repair monotonicity (Again ≤ Hard ≤ Good ≤ Easy) and clamp to [1e-3, 100].
 *
 * Two deliberate divergences, both to expose what the optimizer hides:
 *
 *   - We also compute an **unregularised MLE** with a much wider upper bound
 *     plus a 95% profile-likelihood interval. When the optimizer reports a
 *     value pinned at its bound of 100, that number is a floor, not an
 *     estimate, and the interval says so.
 *   - We also fit **without** the outlier removal, so you can see how much of
 *     the answer came from step 3's truncation.
 *
 * The fit uses the optimizer's decay (the DEFAULT −0.1542), because decay is
 * only fit later in the main training loop and the pre-training pass never sees
 * `w[20]`. The "what FSRS currently predicts" column uses *your* `w[20]`. Those
 * are genuinely two different curve families; the panel shows both rather than
 * silently mixing them.
 */

import { forgettingCurve } from './fsrs';

// --- Constants ------------------------------------------------------------

/** Decay hard-wired into fsrs-optimizer's parameter-initialisation step. */
export const PRETRAIN_DECAY = -0.1542;
export const PRETRAIN_FACTOR = Math.pow(0.9, 1 / PRETRAIN_DECAY) - 1;

/** Lower stability bound the optimizer uses in integer-delta_t mode. */
export const S0_MIN = 0.001;
/** Upper bound the optimizer clamps S₀ to — saturating here means "unidentified". */
export const S0_OPTIMIZER_MAX = 100;
/** Wider bound for the unregularised MLE so saturation at 100 stays visible. */
export const S0_MLE_MAX = 3650;

/** χ²(1) 95% cutoff / 2 — the standard profile-likelihood interval threshold. */
const PROFILE_THRESHOLD = 1.920729;

export const S0_GRADE_LABELS = ['Again', 'Hard', 'Good', 'Easy'];

/** FSRS v6 defaults for w0–w3, i.e. the L1 shrinkage target. */
export const S0_DEFAULTS = [0.212, 1.2931, 2.3065, 8.2956];

/**
 * Display buckets for the empirical forgetting curve. Log-spaced because the
 * interval distribution is: the mass sits at 1–2 days and the tail that
 * actually constrains S is thin.
 */
export const S0_DT_BUCKETS: { lo: number; hi: number; label: string }[] = [
  { lo: 1, hi: 1, label: '1 d' },
  { lo: 2, hi: 2, label: '2 d' },
  { lo: 3, hi: 4, label: '3–4 d' },
  { lo: 5, hi: 7, label: '5–7 d' },
  { lo: 8, hi: 14, label: '8–14 d' },
  { lo: 15, hi: 30, label: '15–30 d' },
  { lo: 31, hi: 60, label: '31–60 d' },
  { lo: 61, hi: 120, label: '61–120 d' },
  { lo: 121, hi: 240, label: '121–240 d' },
  { lo: 241, hi: Infinity, label: '> 240 d' },
];

// --- Accumulator ----------------------------------------------------------

export interface S0GradeAcc {
  /** exact delta_t (whole days, ≥ 1) → { reps, reps that were not Again } */
  byDeltaT: Map<number, { n: number; retained: number }>;
  /** distinct card lifetimes contributing */
  cards: number;
  /** lifetimes where same-day learning steps sat between the grade and the outcome */
  withIntermediateReps: number;
  /** Σ of the retrievability FSRS *actually* predicted at the outcome rep */
  sumActualPredR: number;
  actualPredRN: number;
}

export function makeS0Accs(): S0GradeAcc[] {
  return Array.from({ length: 4 }, () => ({
    byDeltaT: new Map<number, { n: number; retained: number }>(),
    cards: 0,
    withIntermediateReps: 0,
    sumActualPredR: 0,
    actualPredRN: 0,
  }));
}

export function addS0Observation(
  accs: S0GradeAcc[],
  gradeRow: number,
  deltaT: number,
  retained: boolean,
  hadIntermediateReps: boolean,
  actualPredR: number | null,
) {
  if (gradeRow < 0 || gradeRow > 3) return;
  if (!Number.isFinite(deltaT) || deltaT < 1) return;
  const acc = accs[gradeRow];
  const key = Math.round(deltaT);
  let slot = acc.byDeltaT.get(key);
  if (!slot) {
    slot = { n: 0, retained: 0 };
    acc.byDeltaT.set(key, slot);
  }
  slot.n++;
  if (retained) slot.retained++;
  acc.cards++;
  if (hadIntermediateReps) acc.withIntermediateReps++;
  if (actualPredR !== null && Number.isFinite(actualPredR)) {
    acc.sumActualPredR += actualPredR;
    acc.actualPredRN++;
  }
}

// --- Result shape ---------------------------------------------------------

export interface S0BucketStats {
  label: string;
  reps: number;
  /** reps surviving the optimizer's outlier filter */
  keptReps: number;
  /** observed retention, 0..100 (raw, unsmoothed) */
  retention: number;
  /** Wilson 95% bounds on `retention`, 0..100 */
  ciLo: number;
  ciHi: number;
  /** rep-weighted R implied by the CURRENT w[G] and w[20], 0..100 */
  predR: number;
  /** rep-weighted R implied by the refit S₀ (pre-training decay), 0..100 */
  fitR: number;
  /** retention − predR, percentage points */
  devPP: number;
}

export type S0Verdict =
  | 'no-data'
  | 'thin'
  | 'unidentified'
  | 'extrapolating'
  | 'calibrated'
  | 'understated'
  | 'overstated';

export interface S0GradeStats {
  grade: number;
  label: string;
  reps: number;
  keptReps: number;
  droppedReps: number;
  distinctDeltaT: number;
  medianDeltaT: number;
  maxDeltaT: number;
  keptMaxDeltaT: number;
  /** share of outcomes preceded by same-day learning steps, 0..100 */
  intermediateShare: number;

  currentS0: number;
  defaultS0: number;
  /** faithful reproduction of the optimizer's pre-training fit */
  fittedS0: number;
  fittedSaturated: boolean;
  /** count-weighted RMSE of the faithful fit against the smoothed observations */
  rmse: number;
  /** unregularised MLE (no L1, wide bound) */
  mleS0: number;
  mleLo: number;
  mleHi: number;
  mleSaturated: boolean;
  /** MLE without the optimizer's outlier removal — truncation sensitivity */
  unfilteredS0: number;

  /** fittedS0 / currentS0 */
  ratio: number;
  /** share of reps observed at delta_t ≥ mleS0, 0..100 */
  coverage: number;

  observedRetention: number;
  /** retention the CURRENT w[G] predicts over the same reps, 0..100 */
  predRetention: number;
  /** what FSRS actually predicted at these reps (includes same-day step updates), 0..100 */
  actualPredR: number;

  verdict: S0Verdict;
  buckets: S0BucketStats[];
}

export interface S0Breakdown {
  grades: S0GradeStats[];
  /** pooled recall used for the Laplace pseudo-observation, 0..1 */
  averageRecall: number;
  /** decay the fit ran with (the optimizer's default) */
  fitDecay: number;
  /** decay the current weights carry */
  currentDecay: number;
  totalReps: number;
  /** monotonicity repairs the optimizer would have applied, as human-readable notes */
  monotonicityNotes: string[];
  /** w0–w3 the optimizer would emit for this collection, post-repair and clamp */
  suggestedW: (number | null)[];
}

// --- Numerics -------------------------------------------------------------

interface FitPoint {
  deltaT: number;
  /** target recall for the loss (Laplace-smoothed when the optimizer smooths) */
  r: number;
  n: number;
}

function curve(t: number, s: number, decay: number, factor: number): number {
  return forgettingCurve(t, s, decay, factor);
}

function logLoss(s: number, pts: FitPoint[], decay: number, factor: number): number {
  let acc = 0;
  for (const p of pts) {
    let y = curve(p.deltaT, s, decay, factor);
    if (!Number.isFinite(y)) y = 0.5;
    y = Math.min(Math.max(y, 1e-9), 1 - 1e-9);
    acc += -(p.r * Math.log(y) + (1 - p.r) * Math.log(1 - y)) * p.n;
  }
  return acc;
}

/**
 * Bounded 1-D minimisation in log-space: coarse grid to bracket the global
 * minimum (the loss is unimodal in S but the scale spans five orders of
 * magnitude), then golden-section to polish. Unlike scipy's `maxiter`-capped
 * L-BFGS-B call in the optimizer, this always runs to convergence — so a value
 * here that sits far from the FSRS default is the data talking, not an
 * early-stopped solver.
 */
function minimizeScalar(f: (s: number) => number, lo: number, hi: number, gridN = 400): number {
  const logLo = Math.log(lo);
  const logHi = Math.log(hi);
  let bestX = lo;
  let bestY = Infinity;
  let bestI = 0;
  const xs: number[] = new Array(gridN);
  for (let i = 0; i < gridN; i++) {
    const x = Math.exp(logLo + ((logHi - logLo) * i) / (gridN - 1));
    xs[i] = x;
    const y = f(x);
    if (y < bestY) {
      bestY = y;
      bestX = x;
      bestI = i;
    }
  }
  let a = xs[Math.max(0, bestI - 1)];
  let b = xs[Math.min(gridN - 1, bestI + 1)];
  const gr = (Math.sqrt(5) - 1) / 2;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let k = 0; k < 100 && b - a > 1e-7 * Math.max(1, b); k++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = f(d);
    }
  }
  const x = (a + b) / 2;
  return f(x) <= bestY ? x : bestX;
}

/**
 * 95% profile-likelihood interval: the S range whose log-loss stays within
 * χ²(1)/2 of the minimum. Bisects outward on each side; if the loss never
 * clears the threshold before a bound, the interval is reported open at that
 * bound (which is exactly the "the data cannot pin this down" signal).
 */
function profileInterval(
  f: (s: number) => number,
  sHat: number,
  lo: number,
  hi: number,
): { lo: number; hi: number } {
  const target = f(sHat) + PROFILE_THRESHOLD;

  let left = lo;
  if (f(lo) > target) {
    let a = Math.log(lo);
    let b = Math.log(sHat);
    for (let k = 0; k < 60; k++) {
      const m = (a + b) / 2;
      if (f(Math.exp(m)) > target) a = m;
      else b = m;
    }
    left = Math.exp(b);
  }

  let right = hi;
  if (f(hi) > target) {
    let a = Math.log(sHat);
    let b = Math.log(hi);
    for (let k = 0; k < 60; k++) {
      const m = (a + b) / 2;
      if (f(Math.exp(m)) > target) b = m;
      else a = m;
    }
    right = Math.exp(a);
  }

  return { lo: left, hi: right };
}

/** Wilson score interval — honest at the small n that the long-interval buckets carry. */
function wilson(k: number, n: number): { lo: number; hi: number } {
  if (n <= 0) return { lo: NaN, hi: NaN };
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    lo: Math.max(0, (centre - half) / denom),
    hi: Math.min(1, (centre + half) / denom),
  };
}

/**
 * Port of fsrs-optimizer's `remove_outliers`, applied per first-grade group.
 * Returns the set of delta_t values the optimizer would discard before fitting.
 */
function outlierDeltaTs(
  points: { deltaT: number; n: number }[],
  gradeRow: number,
): Set<number> {
  const dropped = new Set<number>();
  const total = points.reduce((a, p) => a + p.n, 0);
  if (total === 0) return dropped;
  // Easy gets a 365-day ceiling, every other grade 100 — `group.name[0] != "4"`.
  const maxDt = gradeRow === 3 ? 365 : 100;
  const budget = Math.max(total * 0.05, 20);
  // Rarest first; ties broken by the longest interval first.
  const order = [...points].sort((a, b) => a.n - b.n || b.deltaT - a.deltaT);
  let removed = 0;
  for (const p of order) {
    if (removed + p.n >= budget) {
      if (p.n < 6 || p.deltaT > maxDt) {
        dropped.add(p.deltaT);
        removed += p.n;
      }
    } else {
      dropped.add(p.deltaT);
      removed += p.n;
    }
  }
  return dropped;
}

// --- Finalize -------------------------------------------------------------

function verdictFor(
  reps: number,
  mleSaturated: boolean,
  coverage: number,
  ratio: number,
): S0Verdict {
  if (reps === 0) return 'no-data';
  if (reps < 200) return 'thin';
  if (mleSaturated) return 'unidentified';
  if (coverage < 5) return 'extrapolating';
  if (ratio > 1.25) return 'understated';
  if (ratio < 0.75) return 'overstated';
  return 'calibrated';
}

export function finalizeS0(
  accs: S0GradeAcc[],
  w: number[],
  averageRecall: number,
): S0Breakdown {
  const currentDecay = -w[20];
  const currentFactor = Math.pow(0.9, 1 / currentDecay) - 1;
  const avgRecall =
    Number.isFinite(averageRecall) && averageRecall > 0 && averageRecall < 1
      ? averageRecall
      : 0.9;

  const grades: S0GradeStats[] = [];
  let totalReps = 0;

  for (let g = 0; g < 4; g++) {
    const acc = accs[g];
    const raw = [...acc.byDeltaT.entries()]
      .map(([deltaT, v]) => ({ deltaT, n: v.n, retained: v.retained }))
      .sort((a, b) => a.deltaT - b.deltaT);
    const reps = raw.reduce((a, p) => a + p.n, 0);
    totalReps += reps;

    const currentS0 = Math.max(w[g], 0.1); // `initStability` floors at 0.1
    const defaultS0 = S0_DEFAULTS[g];

    if (reps === 0) {
      grades.push({
        grade: g,
        label: S0_GRADE_LABELS[g],
        reps: 0,
        keptReps: 0,
        droppedReps: 0,
        distinctDeltaT: 0,
        medianDeltaT: NaN,
        maxDeltaT: NaN,
        keptMaxDeltaT: NaN,
        intermediateShare: NaN,
        currentS0,
        defaultS0,
        fittedS0: NaN,
        fittedSaturated: false,
        rmse: NaN,
        mleS0: NaN,
        mleLo: NaN,
        mleHi: NaN,
        mleSaturated: false,
        unfilteredS0: NaN,
        ratio: NaN,
        coverage: NaN,
        observedRetention: NaN,
        predRetention: NaN,
        actualPredR: NaN,
        verdict: 'no-data',
        buckets: [],
      });
      continue;
    }

    const dropped = outlierDeltaTs(raw, g);
    const kept = raw.filter((p) => !dropped.has(p.deltaT));
    const keptReps = kept.reduce((a, p) => a + p.n, 0);
    // Degenerate collections can lose everything to the filter; fall back to raw
    // so the panel still reports something rather than NaN.
    const fitRows = kept.length > 0 ? kept : raw;

    const smoothed: FitPoint[] = fitRows.map((p) => ({
      deltaT: p.deltaT,
      // Laplace: one pseudo-observation at the collection's average recall.
      r: (p.retained + avgRecall) / (p.n + 1),
      n: p.n,
    }));
    const rawSmoothed: FitPoint[] = raw.map((p) => ({
      deltaT: p.deltaT,
      r: (p.retained + avgRecall) / (p.n + 1),
      n: p.n,
    }));

    // 1. Faithful pre-training fit: smoothed + L1 shrinkage, clamped to 100.
    const faithfulObjective = (s: number) =>
      logLoss(s, smoothed, PRETRAIN_DECAY, PRETRAIN_FACTOR) +
      Math.abs(s - defaultS0) / 16;
    const fittedS0 = minimizeScalar(faithfulObjective, S0_MIN, S0_OPTIMIZER_MAX);

    // 2. Unregularised MLE + profile interval, on the wide bound.
    const mleObjective = (s: number) => logLoss(s, smoothed, PRETRAIN_DECAY, PRETRAIN_FACTOR);
    const mleS0 = minimizeScalar(mleObjective, S0_MIN, S0_MLE_MAX);
    const { lo: mleLo, hi: mleHi } = profileInterval(mleObjective, mleS0, S0_MIN, S0_MLE_MAX);

    // 3. Same MLE without the optimizer's truncation.
    const unfilteredS0 = minimizeScalar(
      (s: number) => logLoss(s, rawSmoothed, PRETRAIN_DECAY, PRETRAIN_FACTOR),
      S0_MIN,
      S0_MLE_MAX,
    );

    // Weighted RMSE of the faithful fit against the smoothed observations,
    // matching the `root_mean_squared_error(..., sample_weight=count)` the
    // optimizer prints on its forgetting-curve plots.
    let sqSum = 0;
    let wSum = 0;
    for (const p of smoothed) {
      const e = p.r - curve(p.deltaT, fittedS0, PRETRAIN_DECAY, PRETRAIN_FACTOR);
      sqSum += e * e * p.n;
      wSum += p.n;
    }
    const rmse = wSum > 0 ? Math.sqrt(sqSum / wSum) : NaN;

    // Descriptives over the full (unfiltered) observation set.
    let retainedTotal = 0;
    let predSum = 0;
    let coveredReps = 0;
    for (const p of raw) {
      retainedTotal += p.retained;
      predSum += curve(p.deltaT, currentS0, currentDecay, currentFactor) * p.n;
      if (p.deltaT >= mleS0) coveredReps += p.n;
    }
    // Median over the rep-weighted interval distribution, walked on the
    // distinct-delta_t histogram rather than an expanded array.
    let seen = 0;
    let medianDeltaT = raw[0].deltaT;
    const half = (reps - 1) / 2;
    for (const p of raw) {
      seen += p.n;
      if (seen > half) {
        medianDeltaT = p.deltaT;
        break;
      }
    }

    // Buckets for the curve table.
    const buckets: S0BucketStats[] = S0_DT_BUCKETS.map((b) => {
      let n = 0;
      let ret = 0;
      let pr = 0;
      let fr = 0;
      let keptN = 0;
      for (const p of raw) {
        if (p.deltaT < b.lo || p.deltaT > b.hi) continue;
        n += p.n;
        ret += p.retained;
        pr += curve(p.deltaT, currentS0, currentDecay, currentFactor) * p.n;
        fr += curve(p.deltaT, fittedS0, PRETRAIN_DECAY, PRETRAIN_FACTOR) * p.n;
        if (!dropped.has(p.deltaT)) keptN += p.n;
      }
      if (n === 0) {
        return {
          label: b.label,
          reps: 0,
          keptReps: 0,
          retention: NaN,
          ciLo: NaN,
          ciHi: NaN,
          predR: NaN,
          fitR: NaN,
          devPP: NaN,
        };
      }
      const retention = (ret / n) * 100;
      const predR = (pr / n) * 100;
      const ci = wilson(ret, n);
      return {
        label: b.label,
        reps: n,
        keptReps: keptN,
        retention,
        ciLo: ci.lo * 100,
        ciHi: ci.hi * 100,
        predR,
        fitR: (fr / n) * 100,
        devPP: retention - predR,
      };
    });

    const coverage = (coveredReps / reps) * 100;
    const ratio = currentS0 > 0 ? fittedS0 / currentS0 : NaN;
    const mleSaturated = mleS0 >= S0_MLE_MAX * 0.99;

    grades.push({
      grade: g,
      label: S0_GRADE_LABELS[g],
      reps,
      keptReps,
      droppedReps: reps - keptReps,
      distinctDeltaT: raw.length,
      medianDeltaT,
      maxDeltaT: raw[raw.length - 1].deltaT,
      keptMaxDeltaT: fitRows[fitRows.length - 1].deltaT,
      intermediateShare: (acc.withIntermediateReps / acc.cards) * 100,
      currentS0,
      defaultS0,
      fittedS0,
      fittedSaturated: fittedS0 >= S0_OPTIMIZER_MAX * 0.99,
      rmse,
      mleS0,
      mleLo,
      mleHi,
      mleSaturated,
      unfilteredS0,
      ratio,
      coverage,
      observedRetention: (retainedTotal / reps) * 100,
      predRetention: (predSum / reps) * 100,
      actualPredR: acc.actualPredRN > 0 ? (acc.sumActualPredR / acc.actualPredRN) * 100 : NaN,
      verdict: verdictFor(reps, mleSaturated, coverage, ratio),
      buckets,
    });
  }

  // --- Monotonicity repair, exactly as the optimizer applies it -------------
  // Pairs and order matter: the value backed by MORE reps overwrites the other.
  const suggested: (number | null)[] = grades.map((g) =>
    Number.isFinite(g.fittedS0) ? g.fittedS0 : null,
  );
  const notes: string[] = [];
  const pairs: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [0, 2],
    [1, 3],
    [0, 3],
  ];
  for (const [small, big] of pairs) {
    const a = suggested[small];
    const b = suggested[big];
    if (a === null || b === null || a <= b) continue;
    const winner = grades[small].reps > grades[big].reps ? small : big;
    const loser = winner === small ? big : small;
    notes.push(
      `${S0_GRADE_LABELS[small]} (${a.toFixed(2)} d) > ${S0_GRADE_LABELS[big]} (${b.toFixed(2)} d)` +
        ` → ${S0_GRADE_LABELS[loser]} overwritten with ${S0_GRADE_LABELS[winner]}'s value` +
        ` (${grades[winner].reps.toLocaleString()} reps vs ${grades[loser].reps.toLocaleString()})`,
    );
    suggested[loser] = suggested[winner];
  }
  for (let i = 0; i < 4; i++) {
    const v = suggested[i];
    if (v !== null) suggested[i] = Math.max(Math.min(S0_OPTIMIZER_MAX, v), S0_MIN);
  }

  return {
    grades,
    averageRecall: avgRecall,
    fitDecay: PRETRAIN_DECAY,
    currentDecay,
    totalReps,
    monotonicityNotes: notes,
    suggestedW: suggested,
  };
}
