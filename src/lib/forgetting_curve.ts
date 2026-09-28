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
 * card is really on, which the plugin API gives no way to check.
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

/**
 * Where the log axis starts once a card has lived a day, whatever its learning
 * steps did.
 *
 * Every decade gets the same width on a log axis, so a card whose second rep
 * came four minutes after its first used to open at two minutes and spend
 * nearly half the chart on its first day — hours nobody reviews against. Half
 * a day, rather than one, so a rep at one day still sits clear of the left
 * edge instead of stacking on the first review. Sub-day reps collapse onto
 * that edge. A card younger than a day has nothing else to show, so it keeps
 * the minute-level axis.
 */
const LOG_AXIS_FLOOR_DAYS = 0.5;

/** Samples drawn across each inter-review segment of the past curve. */
const SAMPLES_PER_SEGMENT = 48;

/** Samples drawn across each forecast branch, which now spans several decades. */
const SAMPLES_PER_BRANCH = 128;

export type CurveScale = 'log' | 'linear';

export type CurveGrade = 'again' | 'hard' | 'good' | 'easy';

export const CURVE_GRADES: CurveGrade[] = ['again', 'hard', 'good', 'easy'];

/**
 * How far the forecast is *computed*, as a retrievability the Easy branch — the
 * longest-lived of the four — has to fall to.
 *
 * This is not what the chart shows on opening; it is how far out it can be
 * zoomed. It costs nothing at rest, because the view opens on `INITIAL_VIEW`
 * instead — it only means that somebody who keeps scrolling out can follow
 * every branch well past the next repetition and watch it decay, rather than
 * hitting a wall where the data stops.
 *
 * Half is the coin-flip point: the memory is as likely gone as recalled, which
 * is a natural end for a forgetting curve and a number a reader can interpret
 * without being told. It is also as far as is worth going. FSRS v6 decays by a
 * power law with a very heavy tail, so each step down costs a lot of axis —
 * 70% arrives at 9× the stability, 50% at 90×, 40% at 387× — and past the half
 * way point the curve is nearly flat, so the extra decades of width buy a
 * longer and longer stretch of almost nothing. At 50% a fully zoomed-out log
 * axis still spends about two thirds of its width on the card's real history.
 */
const HORIZON_RETENTION = 0.5;

/**
 * Where the forecast is *shown* on opening — which branch is followed, and to
 * what retrievability, expressed as an offset from the target.
 *
 * The two scales are asked different questions, so one view cannot serve
 * both.
 *
 * A log axis compresses whatever you put at its right-hand end, so following
 * the longest branch (Easy) all the way to the target costs almost no width and
 * buys the whole of the next stability: you see where this card could be after
 * one more good answer. Nothing earlier is squeezed to pay for it.
 *
 * A linear axis has no such mercy. Every day added to the right steals width
 * from every day already drawn, so a horizon chosen for the far future flattens
 * the repetitions that have actually happened into the first few pixels — the
 * part being analysed. It therefore follows the representative branch (Good)
 * and stops while it is still well clear of the target, keeping the plot on the
 * current stability rather than on a future one.
 */
const INITIAL_VIEW: Record<CurveScale, { grade: CurveGrade; offsetFromTarget: number }> = {
    log: { grade: 'easy', offsetFromTarget: 0 },
    linear: { grade: 'good', offsetFromTarget: 0.06 },
};

/**
 * A floor on how far the opening view reaches past `now`, as a share of the
 * card's age.
 *
 * The retention rules above size the view by the *forecast's* own timescale,
 * which breaks down after a lapse: stability collapses to days while the
 * history is still years, so the window ends a few days past `now` and the four
 * branches are squeezed into a fraction of a percent of the width — the one
 * thing a reader looking at a just-lapsed card wants to see.
 *
 * Taking whichever is longer keeps the whole history on screen (the alternative
 * was trimming the left edge, which loses it) and only binds when the forecast
 * is short relative to the card's life, which is exactly the broken case.
 */
const MIN_FORECAST_AGE_SHARE = 0.4;

/**
 * Elapsed days at which a memory of stability `s` has decayed to `retention`.
 *
 * The inversion of the forgetting curve. `intervalFactorForRetention` is the
 * same formula, but it clamps its argument to the band where an *interval* is
 * meaningful (50%–99.5%); the horizon deliberately reaches past that, so it
 * cannot be borrowed here.
 */
function daysUntilRetention(
    stability: number,
    retention: number,
    decay: number,
    factor: number,
): number {
    const r = Math.min(Math.max(retention, 0.01), 0.999);
    const days = (stability * (Math.pow(r, 1 / decay) - 1)) / factor;
    return Number.isFinite(days) && days > 0 ? days : stability;
}

/**
 * Sample points across a forecast branch, spaced geometrically in elapsed time
 * since the review.
 *
 * Not in the plotted coordinate, as the past segments are, because a branch now
 * runs orders of magnitude further than the window it opens in: spacing it
 * evenly across a linear axis would put every sample in the far tail and draw
 * the visible part as a straight line. A power-law curve bends hardest just
 * after the review and is nearly flat afterwards, so geometric spacing puts the
 * detail where the shape is — which is also where the reader is looking.
 */
function sampleBranchDays(nowDays: number, horizonDays: number, count: number): number[] {
    const span = horizonDays - nowDays;
    if (!(span > 0)) return [];
    const lo = Math.log10(Math.max(span * 1e-5, MIN_FLOOR_DAYS));
    const hi = Math.log10(span);
    if (!(hi > lo)) return [];
    const out: number[] = [];
    for (let i = 1; i < count; i++) {
        out.push(nowDays + Math.pow(10, lo + ((hi - lo) * i) / count));
    }
    return out;
}

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
    /**
     * log10 of the stability each grade would leave the card with, held from
     * `now` to the end of the forecast.
     *
     * Constant, because stability only moves when a card is reviewed: the value
     * is what that answer buys, and it keeps it until the review after. Separate
     * keys from the retrievability branches above because recharts addresses a
     * series by one flat key per row.
     */
    againSLog?: number | null;
    hardSLog?: number | null;
    goodSLog?: number | null;
    easySLog?: number | null;
    /**
     * The repetition dot, on the row that opens a repetition's segment and
     * nowhere else.
     *
     * The dots used to be a `Scatter` with its own short array. Recharts builds
     * the axis's categorical domain — which is what its tooltip resolves a
     * pointer position against — from the graphical items' data, so those seven
     * entries became the only positions the tooltip could report: anywhere in
     * the forecast it answered with the last repetition. Carrying the dots on
     * the shared rows keeps one array behind every series on the panel.
     */
    repSLog?: number | null;
    /** 1-based index of that repetition, for looking its label up. */
    repIndex?: number | null;
    /**
     * The card's own curve continued past `now` — what happens if it is never
     * answered again.
     *
     * The null action, and the baseline the four branches are read against: it
     * is the same memory on the same stability, so it carries straight on from
     * where the history line stops. Without it the chart ends at `now` as though
     * forgetting paused there, and the branches have nothing to be compared to.
     */
    noReview?: number | null;
}

/** Row key carrying each grade's forecast stability. */
export const STABILITY_BRANCH_KEY: Record<
    CurveGrade,
    'againSLog' | 'hardSLog' | 'goodSLog' | 'easySLog'
> = {
    again: 'againSLog',
    hard: 'hardSLog',
    good: 'goodSLog',
    easy: 'easySLog',
};

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
    /** [min, max] the x axis opens on, in plotted units. */
    xDomain: [number, number];
    /**
     * [min, max] the reader may zoom out to. Wider than `xDomain`: the forecast
     * is computed well past the window it opens in, so scrolling out keeps
     * finding curve instead of running off the end of the data.
     */
    xFullDomain: [number, number];
    /** [min, 100] for the y axis. */
    yDomain: [number, number];
    /** Plotted x of the present moment. */
    nowX: number;
    /** Days since the first counted review, at the present moment. */
    nowDays: number;
    nowT: number;
    /** Retrievability now, 0–100. */
    nowR: number;
    /** Target retention as a percentage, for the reference line. */
    targetPercent: number;
    /** The memory state the forecast branches were derived from. */
    state: FSRSState;
    scale: CurveScale;
    /** Axis bounds in days, kept so ticks can be rebuilt at a measured width. */
    floorDays: number;
    /** The full extent in days — what `xFullDomain` maps to. */
    axisMaxDays: number;
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
    // The forecast now reaches centuries when zoomed right out, and a ladder
    // that stopped at ten years left that whole stretch unlabelled.
    { value: 7305, label: '20y' },
    { value: 18262, label: '50y' },
    { value: 36525, label: '100y' },
    { value: 73050, label: '200y' },
    { value: 182625, label: '500y' },
    { value: 365250, label: '1000y' },
];

/**
 * Compact label for an elapsed span given in days.
 *
 * Weeks give way to months at four of them rather than at two: the axis ticks
 * below step in whole months, and "4w" sitting where "1mo" belongs reads as a
 * different quantity. Years keep a decimal because this is what labels the far
 * end of the axis, which lands wherever the forecast happens to stop — "15y" on
 * a tick drawn at 14.6y is a small lie the reader has no way to catch.
 */
export function formatCurveDays(days: number): string {
    if (!Number.isFinite(days)) return '—';
    if (days <= 0) return '0';
    if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))}m`;
    if (days < 1) return `${Math.round(days * 24)}h`;
    if (days < 14) return `${days < 3 ? days.toFixed(1) : Math.round(days)}d`;
    if (days < 28) return `${Math.round(days / 7)}w`;
    if (days < 365) return `${Math.round(days / DAYS_PER_MONTH)}mo`;
    const years = (days / DAYS_PER_YEAR).toFixed(1);
    return `${years.endsWith('.0') ? years.slice(0, -2) : years}y`;
}

const DAYS_PER_MONTH = 365.25 / 12;
const DAYS_PER_YEAR = 365.25;

/**
 * Tick steps a reader recognises as round, each with the unit its multiples are
 * named in. Labelling a linear axis by multiples of its own step is what keeps
 * consecutive ticks distinct: a generic day-to-text formatter applied to a
 * one-week step produces "4w" and then "1mo" for 28 and 35 days, which look
 * like a jump backwards.
 */
const NICE_STEPS: { step: number; unit: number; suffix: string }[] = [
    { step: 1 / 1440, unit: 1 / 1440, suffix: 'm' },
    { step: 5 / 1440, unit: 1 / 1440, suffix: 'm' },
    { step: 15 / 1440, unit: 1 / 1440, suffix: 'm' },
    { step: 30 / 1440, unit: 1 / 1440, suffix: 'm' },
    { step: 1 / 24, unit: 1 / 24, suffix: 'h' },
    { step: 3 / 24, unit: 1 / 24, suffix: 'h' },
    { step: 6 / 24, unit: 1 / 24, suffix: 'h' },
    { step: 12 / 24, unit: 1 / 24, suffix: 'h' },
    { step: 1, unit: 1, suffix: 'd' },
    { step: 2, unit: 1, suffix: 'd' },
    { step: 3, unit: 1, suffix: 'd' },
    { step: 5, unit: 1, suffix: 'd' },
    { step: 7, unit: 7, suffix: 'w' },
    { step: 14, unit: 7, suffix: 'w' },
    { step: DAYS_PER_MONTH, unit: DAYS_PER_MONTH, suffix: 'mo' },
    { step: DAYS_PER_MONTH * 2, unit: DAYS_PER_MONTH, suffix: 'mo' },
    { step: DAYS_PER_MONTH * 3, unit: DAYS_PER_MONTH, suffix: 'mo' },
    { step: DAYS_PER_MONTH * 6, unit: DAYS_PER_MONTH, suffix: 'mo' },
    { step: DAYS_PER_YEAR, unit: DAYS_PER_YEAR, suffix: 'y' },
    { step: DAYS_PER_YEAR * 2, unit: DAYS_PER_YEAR, suffix: 'y' },
    { step: DAYS_PER_YEAR * 3, unit: DAYS_PER_YEAR, suffix: 'y' },
    { step: DAYS_PER_YEAR * 5, unit: DAYS_PER_YEAR, suffix: 'y' },
    { step: DAYS_PER_YEAR * 10, unit: DAYS_PER_YEAR, suffix: 'y' },
    { step: DAYS_PER_YEAR * 20, unit: DAYS_PER_YEAR, suffix: 'y' },
    { step: DAYS_PER_YEAR * 50, unit: DAYS_PER_YEAR, suffix: 'y' },
];

/**
 * Label for the far end of the axis.
 *
 * Unlike every other tick, this one sits wherever the range happens to stop
 * rather than on a round step, so it keeps a decimal when rounding would move
 * it: a window ending at 3.4 days must not be labelled "3d" directly after the
 * tick that really is three days. `formatCurveDays` stays rounder because it
 * also writes prose, where "7mo" beats "6.6mo".
 */
function edgeLabel(days: number): string {
    const withUnit = (value: number, suffix: string) => {
        const rounded = Math.round(value);
        return Math.abs(value - rounded) < 0.05
            ? `${rounded}${suffix}`
            : `${value.toFixed(1)}${suffix}`;
    };
    if (!Number.isFinite(days) || days <= 0) return formatCurveDays(days);
    if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))}m`;
    if (days < 1) return withUnit(days * 24, 'h');
    if (days < 14) return withUnit(days, 'd');
    if (days < 28) return withUnit(days / 7, 'w');
    if (days < 365) return withUnit(days / DAYS_PER_MONTH, 'mo');
    return withUnit(days / DAYS_PER_YEAR, 'y');
}

/** Roughly how many evenly spaced ticks the linear axis's coarse tier aims for. */
const TARGET_LINEAR_TICKS = 6;

/**
 * Hard ceiling on ticks from one generated series.
 *
 * Every loop below steps by a positive amount towards a bound, so in normal use
 * this is never reached. It is here because these bounds come, ultimately, from
 * a pointer: a range carried across a scale change once produced an infinite
 * `maxDays`, and `i++` past `Number.MAX_SAFE_INTEGER` — or on `Infinity` — never
 * advances. A bounded loop cannot hang the widget, whatever it is handed.
 */
const MAX_GENERATED_TICKS = 64;

/** Width to reserve per tick label, in px, including breathing room. */
const TICK_LABEL_PX = 46;

/** Assumed plot width when the caller has not measured one. */
const DEFAULT_PLOT_WIDTH_PX = 560;

/** Bounds on the tick gap, as a fraction of the axis span, whatever the width. */
const TICK_GAP_MIN = 0.015;
const TICK_GAP_MAX = 0.12;

/**
 * Most subdivisions the linear axis's fine tier will place inside the first
 * coarse interval. Past this it stops being an aid and becomes a ruler.
 */
const MAX_SUB_DIVISIONS = 6;

/**
 * Separation two tick labels need, as a fraction of the axis span, at a given
 * plot width. Clamped at both ends: a very narrow chart would otherwise demand
 * more than a third of itself per label, a very wide one would pack them in.
 */
export function tickMinGap(plotWidthPx: number): number {
    const width = plotWidthPx > 0 ? plotWidthPx : DEFAULT_PLOT_WIDTH_PX;
    return Math.min(Math.max(TICK_LABEL_PX / width, TICK_GAP_MIN), TICK_GAP_MAX);
}

/** The smallest round step that is at least `raw` days. */
function pickStep(raw: number) {
    return NICE_STEPS.find((n) => n.step >= raw) ?? NICE_STEPS[NICE_STEPS.length - 1];
}

/**
 * Name a tick by multiples of its own step's unit, promoting whole years out of
 * months.
 *
 * Multiples of the step are what keep consecutive labels distinct — a generic
 * formatter on a one-week step names 28, 35 and 42 days all "1mo". The
 * promotion is so a fine tier stepping in months does not say "24mo" directly
 * beneath a coarse tier saying "3y".
 */
function stepLabel(days: number, nice: { step: number; unit: number; suffix: string }): string {
    if (nice.suffix === 'mo') {
        const years = days / DAYS_PER_YEAR;
        if (years >= 1 && Math.abs(years - Math.round(years)) < 1e-6) {
            return `${Math.round(years)}y`;
        }
        // Past a year, months stop reading as a quantity — "39mo" next to "3y"
        // is the same instant twice. A decimal year is only safe once the step
        // is a quarter or more, below which consecutive ticks round together.
        if (years >= 1 && nice.step >= DAYS_PER_MONTH * 3) {
            return `${years.toFixed(1)}y`;
        }
    }
    return `${Math.round(days / nice.unit)}${nice.suffix}`;
}

/** Evenly spaced round steps covering a range, as whole multiples of the step. */
function roundStepTicks(
    minDays: number,
    maxDays: number,
    toX: (days: number) => number,
): CurveTick[] {
    const out: CurveTick[] = [];
    const nice = pickStep((maxDays - minDays) / TARGET_LINEAR_TICKS);
    const first = Math.ceil(minDays / nice.step - 1e-9);
    if (!Number.isFinite(first)) return out;
    for (let i = first; out.length < MAX_GENERATED_TICKS; i++) {
        const days = i * nice.step;
        if (days > maxDays * (1 + 1e-9)) break;
        out.push({ value: toX(days), label: days === 0 ? '0' : stepLabel(days, nice) });
    }
    return out;
}

/**
 * Ticks for the x axis.
 *
 * The two scales need different treatment, and using one list for both is what
 * produced the two faults this replaces. `TICK_CANDIDATES` is spaced evenly in
 * *log* time, so on a log axis it is already well distributed — but on a linear
 * axis every candidate up to a month lands in the first few pixels of a
 * multi-year card and they overprint each other, while the largest candidate
 * that fits can sit far short of the right edge, leaving the entire tail of the
 * chart unlabelled.
 *
 * So: log picks from the candidates and drops any that would crowd its
 * neighbour; linear generates its own evenly spaced round steps. Both then
 * guarantee a tick at the right edge, because the end of the axis is a time the
 * reader needs — it is where the forecast stops.
 */
function buildTicks(
    scale: CurveScale,
    minDays: number,
    maxDays: number,
    toX: (days: number) => number,
    plotWidthPx = DEFAULT_PLOT_WIDTH_PX,
): CurveTick[] {
    // Bounds ultimately come from a pointer drag, so they are not trusted.
    if (!Number.isFinite(minDays) || !Number.isFinite(maxDays) || !(maxDays > minDays)) return [];

    const xMin = toX(minDays);
    const xMax = toX(maxDays);
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return [];
    const span = xMax - xMin || 1;
    const minGap = span * tickMinGap(plotWidthPx);
    const out: CurveTick[] = [];

    if (scale === 'linear') {
        const coarse = pickStep((maxDays - minDays) / TARGET_LINEAR_TICKS);
        out.push(...roundStepTicks(minDays, maxDays, toX));

        // A second, finer tier over the first coarse interval.
        //
        // A linear axis spreads a card's whole life across a span sized by its
        // forecast, so on a mature card every repetition lands in the first
        // fraction of it and the coarse tier leaves that stretch with nothing
        // between 0 and its first mark. Subdividing it puts readable marks where
        // the events actually are, as many as the width honestly allows — which
        // is also why this one respects the measured gap rather than a constant.
        // `minGap` is already in axis units, which on a linear axis are days.
        // The fine tier answers a problem the origin has — every repetition of a
        // mature card piled into the first fraction of the span — so it only
        // applies to a view that contains the origin. A zoomed range is narrow
        // enough that the coarse tier already resolves it.
        const slots = minDays <= 0 ? Math.floor(coarse.step / minGap) - 1 : 0;
        if (slots >= 1) {
            const target = coarse.step / Math.min(slots + 1, MAX_SUB_DIVISIONS);
            // The fine step must divide the coarse one exactly, or the last
            // subdivision lands a remainder short of the next coarse tick and
            // the two labels collide there — the one place the even spacing of
            // the tier cannot protect itself.
            const fine = NICE_STEPS.find(
                (n) =>
                    n.step >= target &&
                    n.step < coarse.step &&
                    Math.abs(coarse.step / n.step - Math.round(coarse.step / n.step)) < 1e-6,
            );
            if (fine) {
                for (
                    let d = fine.step;
                    d < coarse.step * (1 - 1e-9) && out.length < MAX_GENERATED_TICKS;
                    d += fine.step
                ) {
                    out.push({ value: toX(d), label: stepLabel(d, fine) });
                }
                out.sort((a, b) => a.value - b.value);
            }
        }
    } else {
        // An axis that starts at half a day has no sub-day stretch left to mark
        // but its own edge, and a "12h" there costs the 1d tick its place.
        const firstCandidate = minDays >= LOG_AXIS_FLOOR_DAYS ? 1 : 0;
        for (const candidate of TICK_CANDIDATES) {
            if (candidate.value < minDays || candidate.value > maxDays) continue;
            if (candidate.value < firstCandidate) continue;
            const x = toX(candidate.value);
            if (out.length > 0 && x - out[out.length - 1].value < minGap) continue;
            out.push({ value: x, label: candidate.label });
        }
        // The candidates are a decade ladder, so a window narrower than one rung
        // catches almost none of them. Zoomed that far in the axis is close to
        // linear anyway, so fall back to round steps across the window.
        if (out.length < 3) {
            out.length = 0;
            out.push(...roundStepTicks(minDays, maxDays, toX));
        }
    }

    // Safety net. Both branches space their own ticks, but a log axis warps
    // whatever is laid out in days, so re-check before anything is drawn.
    out.sort((a, b) => a.value - b.value);
    let kept = 0;
    for (let i = 1; i < out.length; i++) {
        if (out[i].value - out[kept].value >= minGap) out[++kept] = out[i];
    }
    out.length = Math.min(out.length, kept + 1);

    // The right edge, always. When it falls too close to the last tick for both
    // to fit, it takes that tick's place rather than crowding it.
    const endTick = { value: xMax, label: edgeLabel(maxDays) };
    const previous = out[out.length - 1];
    // It takes the last tick's place when the two would not both fit, and also
    // when they round to the same words: a range ending just past a tick gets
    // the same label twice otherwise, which reads as a stutter.
    if (!previous || (xMax - previous.value >= minGap && previous.label !== endTick.label)) {
        out.push(endTick);
    } else {
        out[out.length - 1] = endTick;
    }

    return out;
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

    // How far the forecast is computed — see `HORIZON_RETENTION`. Easy bounds it
    // because it outlives the other three, so following it guarantees all four
    // are drawn wherever the reader zooms to.
    const easyBranch = branches.find((b) => b.grade === 'easy');
    const horizonDays =
        forecast && easyBranch
            ? nowDays +
              Math.max(daysUntilRetention(easyBranch.stability, HORIZON_RETENTION, decay, factor), 1 / 24)
            : nowDays;

    // How far it is shown on opening — see `INITIAL_VIEW`.
    const view = INITIAL_VIEW[scale];
    const viewBranch = branches.find((b) => b.grade === view.grade);
    const viewRetention = Math.min(Math.max(targetRetention + view.offsetFromTarget, 0.5), 0.995);
    const viewDays =
        forecast && viewBranch
            ? Math.min(
                  Math.max(
                      nowDays +
                          Math.max(
                              daysUntilRetention(viewBranch.stability, viewRetention, decay, factor),
                              1 / 24,
                          ),
                      // ...or far enough out to be worth looking at at all.
                      nowDays * (1 + MIN_FORECAST_AGE_SHARE),
                  ),
                  horizonDays,
              )
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
        nowDays >= 1 ? LOG_AXIS_FLOOR_DAYS : 0,
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

        pushRow(startDays, {
            r: 100,
            s: event.s,
            sLog: toSLog(event.s),
            repSLog: toSLog(event.s),
            repIndex,
        });
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

    // Anchored on the last review rather than on `now`, so the projection is
    // literally the same segment carrying on rather than a new curve that
    // happens to start at the same height.
    const lastReview = reviews[reviews.length - 1];
    const lastReviewDays = toDays(lastReview.t);
    const noReviewAt = (d: number) =>
        forgettingCurve(d - lastReviewDays, lastReview.s, decay, factor) * 100;

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
        for (const b of branches) {
            junction[b.grade] = 100;
            junction[STABILITY_BRANCH_KEY[b.grade]] = toSLog(b.stability);
        }
        // Evaluated rather than taken from `state.r`: the state reads the wall
        // clock, so on any clock but the live one it lands a hair off the point
        // the history segment actually closed on, and the seam shows.
        junction.noReview = noReviewAt(nowDays);
        rows.push(junction);

        for (const d of sampleBranchDays(nowDays, horizonDays, SAMPLES_PER_BRANCH)) {
            const row: CurveRow = { x: toX(d), days: d, t: firstReviewTime + d * MS_PER_DAY };
            for (const b of branches) {
                row[b.grade] = forgettingCurve(d - nowDays, b.stability, decay, factor) * 100;
                row[STABILITY_BRANCH_KEY[b.grade]] = toSLog(b.stability);
            }
            row.noReview = noReviewAt(d);
            rows.push(row);
        }

        const tail: CurveRow = {
            x: toX(horizonDays),
            days: horizonDays,
            t: firstReviewTime + horizonDays * MS_PER_DAY,
        };
        for (const b of branches) {
            tail[b.grade] = forgettingCurve(horizonDays - nowDays, b.stability, decay, factor) * 100;
            tail[STABILITY_BRANCH_KEY[b.grade]] = toSLog(b.stability);
        }
        tail.noReview = noReviewAt(horizonDays);
        rows.push(tail);
    }

    rows.sort((a, b) => a.x - b.x);

    // --- Axes -------------------------------------------------------------
    const xMin = toX(scale === 'linear' ? 0 : floorDays);
    const axisMaxDays = Math.max(horizonDays, nowDays, floorDays * 2);
    const viewMaxDays = Math.max(Math.min(viewDays, axisMaxDays), nowDays, floorDays * 2);
    const xMax = toX(viewMaxDays);
    const xFullMax = toX(axisMaxDays);

    // Fitted to the opening view, not to everything computed. The rows run on
    // for decades past it, and letting the far tail set the floor would squash
    // the part being read into the top of the plot for the sake of a stretch
    // nobody has scrolled to. Zooming out refits, in the chart.
    const observed: number[] = [];
    for (const row of rows) {
        if (row.x > xMax) continue;
        for (const key of ['r', ...CURVE_GRADES] as const) {
            const v = row[key];
            if (typeof v === 'number' && Number.isFinite(v)) observed.push(v);
        }
    }
    const minObserved = observed.length > 0 ? Math.min(...observed) : 0;
    // Anki's headroom rule: pad the drop by 20% so the curve never touches the
    // floor of the plot, but never show more than the range that carries data.
    const yMin = Math.max(0, Math.min(minObserved, targetRetention * 100) - (100 - minObserved) * 0.2);

    const ticks = buildTicks(scale, scale === 'linear' ? 0 : floorDays, viewMaxDays, toX);

    return {
        rows,
        reps,
        branches,
        ticks,
        xDomain: [xMin, xMax],
        xFullDomain: [xMin, xFullMax],
        yDomain: [Math.floor(yMin), 100],
        nowX: toX(nowDays),
        nowDays,
        nowT: now,
        nowR,
        targetPercent: targetRetention * 100,
        state,
        scale,
        floorDays,
        axisMaxDays,
    };
}

/**
 * Ticks for a series at a known plot width.
 *
 * The series ships a set built for an assumed width, because the maths runs
 * before anything is laid out. Once the chart knows how wide it really is it
 * calls this, and a wide chart earns more marks than a narrow one instead of
 * every chart being spaced for the narrowest.
 */
export function rebuildTicks(
    series: ForgettingCurveSeries,
    plotWidthPx: number,
    /** Visible range in plotted x units, when the reader has zoomed in. */
    domain?: [number, number],
): CurveTick[] {
    const linear = series.scale === 'linear';
    const toX = (days: number): number =>
        linear ? days : Math.log10(Math.max(days, series.floorDays));

    // On a log axis this is 10^x, which overflows to Infinity for an x that was
    // never a log coordinate — a range carried over from the linear scale, say.
    // Anything that does not come back finite means the domain does not belong
    // to this series, so the full range is the honest answer.
    const fromX = (x: number): number => {
        if (!Number.isFinite(x)) return NaN;
        const days = linear ? x : Math.pow(10, x);
        return Number.isFinite(days) ? days : NaN;
    };

    // Defaults to the window the chart OPENS on, not to everything computed:
    // the extent runs decades further, and a caller asking for "the ticks" wants
    // the ones it is about to draw.
    const lowest = linear ? 0 : series.floorDays;
    let minDays = lowest;
    let maxDays = fromX(series.xDomain[1]);

    if (domain) {
        const from = fromX(domain[0]);
        const to = fromX(domain[1]);
        if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
            minDays = Math.max(from, lowest);
            maxDays = Math.max(to, minDays * 1.0001);
        }
    }

    return buildTicks(series.scale, minDays, maxDays, toX, plotWidthPx);
}
