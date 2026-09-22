/**
 * Forgetting curve series — a card's repetition history replayed into the
 * retrievability curve FSRS implies, plus a per-grade forecast of what
 * answering it right now would do to that curve.
 *
 * WHY THIS IS NOT JUST ANKI'S VERSION
 *
 * Anki samples the curve at a fixed step of `min(maxDays / 1000, 1)` days. That
 * is right for a linear time axis, and wrong for a logarithmic one: on a card
 * four years old, a fixed daily step puts ~1 sample in the whole learning phase
 * and ~1400 in the final interval, so the early life of the card — the part a
 * log axis exists to show — collapses into a single spike. Here each segment is
 * sampled evenly *in the coordinate being plotted*, so the visual density is the
 * same at ten minutes and at ten years.
 *
 * That is also why `scale` is an input to the builder rather than a property of
 * the chart: the sampling has to follow the axis.
 *
 * WHAT THE FORECAST MEANS
 *
 * The four branches answer "if I graded this card right now, where would the
 * curve go?". Each starts at the present moment at R = 100% (that is what a
 * review does) and decays with the stability that grade would produce —
 * `FSRSState.nextS`, which already distinguishes the post-lapse path for Again
 * from the recall path for the other three.
 *
 * All of this describes the plugin's *model* of the card. It is only RemNote's
 * scheduling if the configured weights and retention match the scheduler that
 * card is really on — see `describeCurveMismatch`.
 */
import { QueueInteractionScore, RepetitionStatusInterface } from '@remnote/plugin-sdk';
import {
    DEFAULT_REQUESTED_RETENTION,
    FSRSState,
    computeFSRSState,
    computeFSRSStatesPerReview,
    forgettingCurve,
    intervalFactorForRetention,
    resolveWeights,
} from './fsrs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One minute, expressed in days: the hard floor for the log axis. */
const MIN_FLOOR_DAYS = 1 / 1440;

/** Samples drawn across each inter-review segment of the past curve. */
const SAMPLES_PER_SEGMENT = 48;

/** Samples drawn across each forecast branch. */
const SAMPLES_PER_BRANCH = 64;

export type CurveScale = 'log' | 'linear';

export type CurveGrade = 'again' | 'hard' | 'good' | 'easy';

export const CURVE_GRADES: CurveGrade[] = ['again', 'hard', 'good', 'easy'];

/**
 * One row of the chart's data array.
 *
 * Recharts wants a single flat array with one x per row, so the past curve and
 * the four forecast branches share it: past rows carry `r`, forecast rows carry
 * the four grade keys, and the single row at "now" carries both so the lines
 * meet instead of leaving a gap. A row with `r: null` is a deliberate break in
 * the past line (a Reset wiped the memory state).
 */
export interface CurveRow {
    /** Plotted x — days, or log10(days), depending on the scale asked for. */
    x: number;
    /** Days since the first counted review. */
    days: number;
    /** Absolute time (ms). */
    t: number;
    /** Retrievability 0–100 along the past curve, null outside it. */
    r?: number | null;
    /** Stability (days) governing the segment this row sits in. */
    s?: number | null;
    /**
     * log10(s), so the stability panel can plot a linear axis and label it back
     * in days. Recharts' own log scale needs an explicit domain and misbehaves
     * around zero; transforming the data instead is deterministic.
     */
    sLog?: number | null;
    again?: number | null;
    hard?: number | null;
    good?: number | null;
    easy?: number | null;
}

/** A repetition, positioned on the same x scale as the curve. */
export interface CurveRepMarker {
    /** 1-based index among counted (gradeable) reviews. */
    index: number;
    t: number;
    days: number;
    x: number;
    score: QueueInteractionScore;
    /** Difficulty after this review. */
    d: number;
    /** Stability after this review (days). */
    s: number;
    /** Stability before it, null on the first review. */
    sBefore: number | null;
    /** s / sBefore — SuperMemo's stability increase. Null on the first review. */
    sInc: number | null;
    /** R at the moment of this review (0–1), null on the first. */
    rAtReview: number | null;
    /** Interval this stability implies at the target retention (days). */
    optimumDays: number;
    /** log10(s) — see `CurveRow.sLog`. */
    sLog: number;
}

export interface CurveBranch {
    grade: CurveGrade;
    /** Stability (days) this grade would leave the card with. */
    stability: number;
    /** Interval that stability implies at the target retention (days). */
    intervalDays: number;
}

export interface CurveTick {
    value: number;
    label: string;
}

export interface ForgettingCurveSeries {
    rows: CurveRow[];
    reps: CurveRepMarker[];
    branches: CurveBranch[];
    ticks: CurveTick[];
    /** [min, max] for the x axis, in plotted units. */
    xDomain: [number, number];
    /** [min, 100] for the y axis. */
    yDomain: [number, number];
    /** Plotted x of the present moment. */
    nowX: number;
    nowT: number;
    /** Retrievability now, 0–100. */
    nowR: number;
    /** Target retention as a percentage, for the reference line. */
    targetPercent: number;
    /** The memory state the forecast branches were derived from. */
    state: FSRSState;
    scale: CurveScale;
}

export interface BuildCurveOptions {
    weights?: number[] | null;
    /** 0–1. Defaults to the FSRS 90%. */
    targetRetention?: number;
    /** Overridable for tests. */
    now?: number;
    scale?: CurveScale;
    /** Draw the four per-grade branches past "now". Default true. */
    forecast?: boolean;
}

// ---------------------------------------------------------------------------
// Axis helpers
// ---------------------------------------------------------------------------

const TICK_CANDIDATES: CurveTick[] = [
    { value: 1 / 1440, label: '1m' },
    { value: 5 / 1440, label: '5m' },
    { value: 10 / 1440, label: '10m' },
    { value: 30 / 1440, label: '30m' },
    { value: 1 / 24, label: '1h' },
    { value: 6 / 24, label: '6h' },
    { value: 12 / 24, label: '12h' },
    { value: 1, label: '1d' },
    { value: 3, label: '3d' },
    { value: 7, label: '1w' },
    { value: 14, label: '2w' },
    { value: 30, label: '1mo' },
    { value: 90, label: '3mo' },
    { value: 180, label: '6mo' },
    { value: 365, label: '1y' },
    { value: 730, label: '2y' },
    { value: 1825, label: '5y' },
    { value: 3650, label: '10y' },
];

/** Compact label for an elapsed span given in days. */
export function formatCurveDays(days: number): string {
    if (!Number.isFinite(days)) return '—';
    if (days <= 0) return '0';
    if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))}m`;
    if (days < 1) return `${Math.round(days * 24)}h`;
    if (days < 14) return `${days < 3 ? days.toFixed(1) : Math.round(days)}d`;
    if (days < 60) return `${Math.round(days / 7)}w`;
    if (days < 365) return `${Math.round(days / 30.44)}mo`;
    return `${(days / 365.25).toFixed(days < 3650 ? 1 : 0)}y`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type CurveEvent =
    | { kind: 'review'; t: number; score: QueueInteractionScore; d: number; s: number; sBefore: number | null; sInc: number | null; rAtReview: number | null }
    | { kind: 'reset'; t: number };

function gradeable(score: QueueInteractionScore): boolean {
    return (
        score === QueueInteractionScore.AGAIN ||
        score === QueueInteractionScore.HARD ||
        score === QueueInteractionScore.GOOD ||
        score === QueueInteractionScore.EASY
    );
}

/**
 * Pair every repetition with the memory state it produced.
 *
 * `computeFSRSStatesPerReview` returns one entry per raw history entry, in the
 * same order, so the two index together once the history is sorted the same way
 * it sorts them.
 */
function buildEvents(
    history: RepetitionStatusInterface[],
    weights?: number[] | null,
): CurveEvent[] {
    const sorted = [...history].sort((a, b) => a.date - b.date);
    const steps = computeFSRSStatesPerReview(sorted, weights);
    const events: CurveEvent[] = [];
    let previousS: number | null = null;

    sorted.forEach((rep, i) => {
        if (rep.score === QueueInteractionScore.RESET) {
            events.push({ kind: 'reset', t: rep.date });
            previousS = null;
            return;
        }
        if (!gradeable(rep.score)) return;

        const step = steps[i];
        if (!step) return;

        events.push({
            kind: 'review',
            t: rep.date,
            score: rep.score,
            d: step.d,
            s: step.s,
            sBefore: previousS,
            sInc: step.sInc,
            rAtReview: step.r,
        });
        previousS = step.s;
    });

    return events;
}

/**
 * Evenly spaced samples between two days-since-first values, in the plotted
 * coordinate rather than in raw time — the point of the module (see the header).
 */
function sampleDays(fromDays: number, toDays: number, count: number, scale: CurveScale, floorDays: number): number[] {
    const out: number[] = [];
    if (!(toDays > fromDays)) return out;

    if (scale === 'linear') {
        for (let i = 1; i < count; i++) out.push(fromDays + ((toDays - fromDays) * i) / count);
        return out;
    }

    const lo = Math.log10(Math.max(fromDays, floorDays));
    const hi = Math.log10(Math.max(toDays, floorDays));
    if (!(hi > lo)) return out;
    for (let i = 1; i < count; i++) {
        const d = Math.pow(10, lo + ((hi - lo) * i) / count);
        if (d > fromDays && d < toDays) out.push(d);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build everything the chart needs, or null when the card has no gradeable
 * history yet (a new card has no curve — there is no stability to decay).
 */
export function buildForgettingCurveSeries(
    history: RepetitionStatusInterface[] | undefined | null,
    options: BuildCurveOptions = {},
): ForgettingCurveSeries | null {
    const {
        weights = null,
        targetRetention = DEFAULT_REQUESTED_RETENTION,
        now = Date.now(),
        scale = 'log',
        forecast = true,
    } = options;

    if (!history || history.length === 0) return null;

    const events = buildEvents(history, weights);
    const reviews = events.filter((e): e is Extract<CurveEvent, { kind: 'review' }> => e.kind === 'review');
    if (reviews.length === 0) return null;

    const state = computeFSRSState(history, weights, targetRetention);
    if (!state) return null;

    const { w } = resolveWeights(weights);
    const decay = -w[20];
    const factor = Math.pow(0.9, 1 / decay) - 1;
    const intervalFactor = intervalFactorForRetention(targetRetention, decay, factor);

    // The curve is anchored on the first *counted* review, so a card whose
    // history opens with a Reset does not start with a dead stretch.
    const firstReviewTime = reviews[0].t;
    const toDays = (t: number) => (t - firstReviewTime) / MS_PER_DAY;

    const nowDays = Math.max(toDays(now), 0);

    // Forecast branches, and with them the horizon the x axis has to cover.
    const branches: CurveBranch[] = forecast
        ? CURVE_GRADES.map((grade) => ({
              grade,
              stability: state.nextS[grade],
              intervalDays: state.nextInterval[grade],
          }))
        : [];

    const horizonDays = forecast
        ? nowDays + Math.max(...branches.map((b) => b.intervalDays * 1.4), 1 / 24)
        : nowDays;

    // The log axis needs a positive floor. Derive it from the data so a card
    // with no sub-day steps does not waste three decades on minutes it never
    // spent, and clamp it so a same-second re-rating cannot drive it to zero.
    const positives = [
        ...reviews.map((r) => toDays(r.t)),
        nowDays,
    ].filter((d) => d > 0);
    const floorDays = Math.max(
        MIN_FLOOR_DAYS,
        positives.length > 0 ? Math.min(...positives) / 2 : MIN_FLOOR_DAYS,
    );

    /** Stability can be a fraction of a day; keep the log finite. */
    const toSLog = (s: number): number => Math.log10(Math.max(s, MIN_FLOOR_DAYS));

    const toX = (days: number): number =>
        scale === 'linear' ? days : Math.log10(Math.max(days, floorDays));

    const rows: CurveRow[] = [];
    const pushRow = (days: number, row: Omit<CurveRow, 'x' | 'days' | 't'>) => {
        rows.push({
            x: toX(days),
            days,
            t: firstReviewTime + days * MS_PER_DAY,
            ...row,
        });
    };

    // --- Past curve -------------------------------------------------------
    //
    // One segment per review: R snaps to 100% at the review, then decays with
    // the stability that review produced until the next event (or until now).
    const reps: CurveRepMarker[] = [];
    let repIndex = 0;

    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (event.kind === 'reset') {
            // Break the line: everything the card had is gone.
            pushRow(toDays(event.t), { r: null, s: null, sLog: null });
            continue;
        }

        repIndex += 1;
        const startDays = toDays(event.t);
        reps.push({
            index: repIndex,
            t: event.t,
            days: startDays,
            x: toX(startDays),
            score: event.score,
            d: event.d,
            s: event.s,
            sBefore: event.sBefore,
            sInc: event.sInc,
            rAtReview: event.rAtReview,
            optimumDays: event.s * intervalFactor,
            sLog: toSLog(event.s),
        });

        const next = events[i + 1];
        const endDays = next ? toDays(next.t) : nowDays;

        pushRow(startDays, { r: 100, s: event.s, sLog: toSLog(event.s) });
        for (const d of sampleDays(startDays, endDays, SAMPLES_PER_SEGMENT, scale, floorDays)) {
            pushRow(d, {
                r: forgettingCurve(d - startDays, event.s, decay, factor) * 100,
                s: event.s,
                sLog: toSLog(event.s),
            });
        }
        // Close the segment on its own last point so the drop is drawn in full
        // before the next review snaps it back to 100%.
        if (endDays > startDays) {
            pushRow(endDays, {
                r: forgettingCurve(endDays - startDays, event.s, decay, factor) * 100,
                s: event.s,
                sLog: toSLog(event.s),
            });
        }
    }

    const nowR = state.r * 100;

    // --- Forecast branches ------------------------------------------------
    if (forecast) {
        // The junction row carries the end of the past curve and the start of
        // all four branches, so the lines meet at a single point.
        const junction: CurveRow = {
            x: toX(nowDays),
            days: nowDays,
            t: now,
            r: nowR,
            s: state.s,
            sLog: toSLog(state.s),
        };
        for (const b of branches) junction[b.grade] = 100;
        rows.push(junction);

        for (const d of sampleDays(nowDays, horizonDays, SAMPLES_PER_BRANCH, scale, floorDays)) {
            const row: CurveRow = { x: toX(d), days: d, t: firstReviewTime + d * MS_PER_DAY };
            for (const b of branches) {
                row[b.grade] = forgettingCurve(d - nowDays, b.stability, decay, factor) * 100;
            }
            rows.push(row);
        }

        const tail: CurveRow = {
            x: toX(horizonDays),
            days: horizonDays,
            t: firstReviewTime + horizonDays * MS_PER_DAY,
        };
        for (const b of branches) {
            tail[b.grade] = forgettingCurve(horizonDays - nowDays, b.stability, decay, factor) * 100;
        }
        rows.push(tail);
    }

    rows.sort((a, b) => a.x - b.x);

    // --- Axes -------------------------------------------------------------
    const xMin = toX(scale === 'linear' ? 0 : floorDays);
    const xMax = toX(Math.max(horizonDays, nowDays, floorDays * 2));

    const observed: number[] = [];
    for (const row of rows) {
        for (const key of ['r', ...CURVE_GRADES] as const) {
            const v = row[key];
            if (typeof v === 'number' && Number.isFinite(v)) observed.push(v);
        }
    }
    const minObserved = observed.length > 0 ? Math.min(...observed) : 0;
    // Anki's headroom rule: pad the drop by 20% so the curve never touches the
    // floor of the plot, but never show more than the range that carries data.
    const yMin = Math.max(0, Math.min(minObserved, targetRetention * 100) - (100 - minObserved) * 0.2);

    const ticks = TICK_CANDIDATES.filter((t) => {
        const x = toX(t.value);
        return x >= xMin && x <= xMax;
    }).map((t) => ({ value: toX(t.value), label: t.label }));

    return {
        rows,
        reps,
        branches,
        ticks,
        xDomain: [xMin, xMax],
        yDomain: [Math.floor(yMin), 100],
        nowX: toX(nowDays),
        nowT: now,
        nowR,
        targetPercent: targetRetention * 100,
        state,
        scale,
    };
}

// ---------------------------------------------------------------------------
// Does this model actually describe the card's scheduler?
// ---------------------------------------------------------------------------

/**
 * Compare the next date the model predicts against the one RemNote actually
 * scheduled.
 *
 * The plugin has no way to read which scheduler a card is on, so every figure
 * here is computed from the weights and retention configured in plugin
 * settings. When the card is on Anki SM-2, on the legacy Exponential scheduler,
 * or on an FSRS scheduler with different weights, the curve is a plausible
 * picture of a card that is not this one. This is the cheap check that catches
 * it: if the interval RemNote gave is nowhere near the one the model implies,
 * say so rather than present the numbers as fact.
 *
 * Returns null when the two agree, or when there is nothing to compare.
 */
export function describeCurveMismatch(
    state: FSRSState,
    lastRepetitionTime: number | null | undefined,
    nextRepetitionTime: number | null | undefined,
    /** Ratio beyond which the two are called different. 2 = off by a factor of two. */
    tolerance = 2,
): string | null {
    if (!lastRepetitionTime || !nextRepetitionTime) return null;

    const actualDays = (nextRepetitionTime - lastRepetitionTime) / MS_PER_DAY;
    const modelledDays = state.s * state.intervalFactor;
    if (!(actualDays > 0) || !(modelledDays > 0)) return null;

    const ratio = actualDays / modelledDays;
    if (ratio >= 1 / tolerance && ratio <= tolerance) return null;

    return (
        `RemNote scheduled ${formatCurveDays(actualDays)} for this card, but these settings ` +
        `model ${formatCurveDays(modelledDays)}. The card is probably on a different scheduler ` +
        `(Anki SM-2, or FSRS with other weights) — treat the curve as an estimate.`
    );
}
