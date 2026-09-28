/**
 * Forgetting Curve — the retrievability a card's repetition history implies,
 * with a per-grade forecast of what answering it right now would do.
 *
 * Two stacked panels sharing one x axis, after SuperMemo's "Memory Status":
 *
 *   R  the curve itself. Solid through the past, four dashed branches into the
 *      future — one per answer button — with Good drawn heavier because it is
 *      the answer that describes the card's normal trajectory.
 *   S  the stability staircase underneath, labelled with the ×SInc each
 *      repetition bought. This is the part a plain forgetting curve hides: two
 *      cards can sit at the same R today and be on completely different paths.
 *
 * The x axis defaults to logarithmic, which is the point of building this
 * instead of porting Anki's. A mature card spends minutes in learning and years
 * in review; on a linear axis the first day is a single pixel and everything
 * interesting about the card's early life is invisible. `buildForgettingCurveSeries`
 * samples in whichever coordinate is being plotted, so both ends stay legible.
 *
 * Presentational only — it takes a prebuilt series and renders it. Every figure
 * in it comes from the plugin's own FSRS settings, not from the scheduler
 * RemNote actually runs on the card.
 */
import { QueueInteractionScore } from '@remnote/plugin-sdk';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    CartesianGrid,
    ComposedChart,
    Line,
    ReferenceArea,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import {
    CURVE_GRADES,
    CurveGrade,
    CurveRepMarker,
    CurveRow,
    CurveScale,
    ForgettingCurveSeries,
    STABILITY_BRANCH_KEY,
    formatCurveDays,
    rebuildTicks,
} from '../lib/forgetting_curve';
import { scoreColor } from '../lib/rating_labels';
import { formatStabilityDays, getRetrievabilityColor } from '../lib/utils';

/**
 * Branch colours. Deliberately the same four as `scoreColor`, so "the green
 * line" and "the Good rating" are the same green everywhere in the plugin —
 * keyed by grade name here because a branch is a hypothetical answer, not a
 * recorded one.
 */
const GRADE_COLOR: Record<CurveGrade, string> = {
    again: scoreColor(QueueInteractionScore.AGAIN),
    hard: scoreColor(QueueInteractionScore.HARD),
    good: scoreColor(QueueInteractionScore.GOOD),
    easy: scoreColor(QueueInteractionScore.EASY),
};

const GRADE_LABEL: Record<CurveGrade, string> = {
    again: 'Again',
    hard: 'Hard',
    good: 'Good',
    easy: 'Easy',
};

/**
 * The past curve is coloured by retrievability, on the same scale the card info
 * bar uses for its R value — `getRetrievabilityColor`, sampled into gradient
 * stops. Same number, same colour, wherever the plugin shows it.
 *
 * A gradient anchored on the target instead put its red at 0%, so the colour
 * only left blue in territory no real card reaches: a card sitting at 75% —
 * which the info bar calls red — still drew as comfortably blue. Here red
 * saturates at 70% and everything below it, so the curve goes red when the card
 * is actually in trouble.
 */
const CURVE_GRADIENT_STOPS = [0, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1];


/**
 * How each line on the retrievability panel is drawn, in one table so the chart
 * and its legend cannot drift apart.
 *
 * The hierarchy is deliberate. What the card is *actually* doing — its history,
 * and that same history projected forward if it is never answered again — is
 * the heaviest thing on the plot. The four branches are hypotheses, drawn
 * lighter, with Good picked out because it describes the normal trajectory.
 *
 * The projection cannot rely on colour to separate it from the branches: it is
 * painted by retrievability, so on a healthy card it is green — the same green
 * as Good. The dash length is what distinguishes it, and the gap between `14 6`
 * and `5 4` is wide enough to read at any zoom.
 */
const CURVE_STROKE = {
    history: { width: 3, dash: undefined as string | undefined, opacity: 1 },
    noReview: { width: 3, dash: '14 6', opacity: 1 },
    good: { width: 2, dash: '5 4', opacity: 1 },
    grade: { width: 1.2, dash: '2 3', opacity: 0.5 },
};

const strokeFor = (grade: CurveGrade) => (grade === 'good' ? CURVE_STROKE.good : CURVE_STROKE.grade);

/**
 * How long a legend swatch is.
 *
 * Long enough for the longest dash pattern to repeat: at 18px a `14 6` drew one
 * dash and a sliver of gap, so the line the reader most needs to recognise —
 * the projection — was the one whose key looked solid.
 */
const SWATCH_LENGTH = 30;

/** A legend key that draws the line it stands for, rather than a solid bar. */
function LineSwatch({
    color,
    width,
    dash,
    opacity = 1,
    gradientId,
}: {
    color?: string;
    width: number;
    dash?: string;
    opacity?: number;
    /**
     * Paints the swatch with the retrievability scale instead of a flat colour,
     * for the two lines that are drawn that way on the chart. Needs an id of its
     * own: a gradient defined in the plot's svg cannot be referenced from here.
     */
    gradientId?: string;
}) {
    return (
        <svg
            width={SWATCH_LENGTH}
            height={8}
            style={{ display: 'inline-block', verticalAlign: 'middle' }}
        >
            {gradientId && (
                <defs>
                    {/* `userSpaceOnUse`, not the default: a gradient in bounding
                        box units needs a box with area, and a horizontal line
                        has no height — SVG then declines to render the element
                        at all, so the swatch came out empty. */}
                    <linearGradient
                        id={gradientId}
                        gradientUnits="userSpaceOnUse"
                        x1={0}
                        y1={0}
                        x2={SWATCH_LENGTH}
                        y2={0}
                    >
                        {CURVE_GRADIENT_STOPS.map((r) => (
                            <stop key={r} offset={`${r * 100}%`} stopColor={getRetrievabilityColor(r)} />
                        ))}
                    </linearGradient>
                </defs>
            )}
            <line
                x1={0}
                y1={4}
                x2={SWATCH_LENGTH}
                y2={4}
                stroke={gradientId ? `url(#${gradientId})` : color}
                strokeWidth={width}
                strokeDasharray={dash}
                strokeOpacity={opacity}
            />
        </svg>
    );
}
const STABILITY_COLOR = '#6366f1';

/**
 * The rule marking a lapse. Deeper and far more opaque than the other three,
 * which sit back as context: a lapse is the one repetition worth spotting from
 * across the chart, because it is what explains a collapse in the staircase
 * below and a curve that restarts from a much lower stability.
 */
const LAPSE_MARKER_COLOR = '#dc2626';

const Y_AXIS_WIDTH = 38;

/**
 * Horizontal margins, shared by both panels. They have to match exactly or the
 * two plot areas drift apart and the shared x axis stops being shared.
 */
const CHART_MARGIN_LEFT = 8;
/**
 * Wider than the left, because the axis now always carries a tick on the right
 * edge and a centred "14.6y" needs half its width past the end of the plot.
 */
const CHART_MARGIN_RIGHT = 24;

/**
 * The stability panel's margins. `top` is generous on purpose: the ×SInc
 * labels are drawn above their dots, in two staggered rows, and recharts clips
 * to the svg rather than to the plot area — so the margin is the only thing
 * standing between a label on the topmost dot and being cut in half.
 */
const STABILITY_MARGIN = { top: 30, right: CHART_MARGIN_RIGHT, bottom: 4, left: CHART_MARGIN_LEFT };

/** Left edge of the stability plot area, for keeping labels off the y axis. */
const STABILITY_PLOT_LEFT = STABILITY_MARGIN.left + Y_AXIS_WIDTH;

/**
 * Minimum horizontal separation between two ×SInc labels, as a fraction of the
 * x domain. Below this they overlap into an unreadable smear — which is exactly
 * what a linear axis does to a card's early repetitions.
 */
const LABEL_MIN_GAP = 0.07;

/** Extra height above the data, as a fraction of its range — see `yPlotDomain`. */
const Y_HEADROOM = 0.04;

/** Labelled gridlines on the retrievability axis. */
const Y_TICK_COUNT = 5;

/** Multiplier applied to the visible span by one notch of the wheel. */
const ZOOM_STEP = 1.25;

/** Tightest window the reader may zoom to, as a divisor of the opening span. */
const MAX_ZOOM_IN = 50;

/** How many staggered rows the labels may use before one is dropped. */
const LABEL_ROWS = 2;

/** Vertical step between those rows, in px. */
const LABEL_ROW_HEIGHT = 11;

/** Baseline of a first-row label above its dot, in px. */
const LABEL_BASE_OFFSET = 9;

/**
 * Height of the label text above its own baseline, in px, plus a little: the
 * halo stroke widens it, and a label flush against the clip edge still looks
 * cut even when it technically is not.
 */
const LABEL_TEXT_ASCENT = 12;

/** Fixed so the stability plot's height is known arithmetic, not a guess. */
const STABILITY_X_AXIS_HEIGHT = 22;

/** Likewise for the retrievability plot, whose gradient needs pixel positions. */
const CURVE_X_AXIS_HEIGHT = 24;
const CURVE_MARGIN_TOP = 6;
const CURVE_MARGIN_BOTTOM = 0;

export interface ForgettingCurveChartProps {
    series: ForgettingCurveSeries;
    /** Height of the retrievability panel in px. */
    height?: number;
    /** Draw the stability staircase under the curve. */
    showStability?: boolean;
    scale: CurveScale;
    onScaleChange?: (scale: CurveScale) => void;
    /** Trailing controls for the header row (e.g. a close button). */
    headerRight?: React.ReactNode;
    title?: string;
}

interface TooltipEntry {
    dataKey?: string | number;
    value?: number | string;
    payload?: Record<string, unknown>;
}

function CurveTooltip({
    active,
    payload,
    series,
}: {
    active?: boolean;
    payload?: TooltipEntry[];
    series: ForgettingCurveSeries;
}) {
    if (!active || !payload || payload.length === 0) return null;
    const row = payload[0]?.payload as Record<string, unknown> | undefined;
    if (!row) return null;

    const t = typeof row.t === 'number' ? row.t : null;
    const days = typeof row.days === 'number' ? row.days : null;
    const r = typeof row.r === 'number' ? row.r : null;
    const s = typeof row.s === 'number' ? row.s : null;
    const isFuture = t !== null && t > series.nowT;

    return (
        <div
            className="rn-clr-background-primary rn-clr-border-opaque border rounded-md px-2 py-1.5 text-xs shadow-lg"
            style={{ pointerEvents: 'none' }}
        >
            {t !== null && (
                <div className="font-semibold">
                    {new Date(t).toLocaleString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                    })}
                </div>
            )}
            {days !== null && (
                <div className="rn-clr-content-tertiary">
                    {formatCurveDays(days)} since first review
                </div>
            )}
            {r !== null && (
                <div>
                    <span className="rn-clr-content-secondary">Retrievability:</span>{' '}
                    <strong>{r.toFixed(1)}%</strong>
                </div>
            )}
            {s !== null && !isFuture && (
                <div>
                    <span className="rn-clr-content-secondary">Stability:</span>{' '}
                    <strong>{formatStabilityDays(s)}</strong>
                </div>
            )}
            {isFuture && (
                <div className="mt-1 pt-1 rn-clr-border-opaque border-t">
                    {typeof row.noReview === 'number' && (
                        <div className="rn-clr-content-secondary">
                            If not reviewed: <strong>{row.noReview.toFixed(1)}%</strong>
                        </div>
                    )}
                    {CURVE_GRADES.map((g) => {
                        const v = row[g];
                        if (typeof v !== 'number') return null;
                        return (
                            <div key={g} style={{ color: GRADE_COLOR[g] }}>
                                {GRADE_LABEL[g]}: <strong>{v.toFixed(1)}%</strong>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/**
 * The stability panel's tooltip.
 *
 * It exists so a ×SInc label that was too crowded to draw is still readable:
 * hovering a repetition gives the number, and the stability either side of it.
 * Without this, dropping a label would drop the value.
 *
 * It reads the pointer's position off `label` — the axis coordinate — and looks
 * everything else up itself, rather than trusting `payload[0]`. This panel
 * carries two series over two different arrays (the staircase over every sample,
 * the dots over the repetitions), and recharts indexes the second by a position
 * computed for the first: `payload[0].payload` was landing on whatever
 * repetition happened to share that index, so hovering the third one reported
 * the first.
 */
function StabilityTooltip({
    active,
    payload,
    label,
    series,
}: {
    active?: boolean;
    payload?: TooltipEntry[];
    label?: string | number;
    series: ForgettingCurveSeries;
}) {
    if (!active) return null;

    let x = Number(label);
    if (!Number.isFinite(x)) {
        for (const entry of payload ?? []) {
            const candidate = (entry?.payload as Record<string, unknown> | undefined)?.x;
            if (typeof candidate === 'number' && Number.isFinite(candidate)) {
                x = candidate;
                break;
            }
        }
    }
    if (!Number.isFinite(x)) return null;

    // Every repetition has two rows at the same x: the closing sample of the
    // segment it ends, carrying the OLD stability, and its own opening sample
    // carrying the new one. `<=` takes the later of a tie, so a boundary
    // resolves to the segment being entered rather than the one being left.
    // Two searches, because they answer different questions. `nearestRow` is
    // simply where the pointer is, and has to include the forecast: filtering to
    // rows carrying a stability excluded every one of them — they hold only the
    // branch keys — so the time never landed in the future and the per-grade
    // block below could not fire. `rowWithStability` is the staircase's value,
    // which exists only in the past.
    let nearestRow: CurveRow | null = null;
    let rowWithStability: CurveRow | null = null;
    for (const candidate of series.rows) {
        if (nearestRow === null || Math.abs(candidate.x - x) <= Math.abs(nearestRow.x - x)) {
            nearestRow = candidate;
        }
        if (typeof candidate.s !== 'number') continue;
        if (
            rowWithStability === null ||
            Math.abs(candidate.x - x) <= Math.abs(rowWithStability.x - x)
        ) {
            rowWithStability = candidate;
        }
    }

    const t = nearestRow ? nearestRow.t : null;

    let nearest: CurveRepMarker | null = null;
    for (const rep of series.reps) {
        if (nearest === null || Math.abs(rep.x - x) < Math.abs(nearest.x - x)) nearest = rep;
    }
    const span = series.xDomain[1] - series.xDomain[0];
    const onRep = nearest !== null && Math.abs(nearest.x - x) <= span * 0.02;

    // On a repetition, take the value from the repetition itself: it is what
    // that review left the card with, and it cannot be the neighbour's.
    const s =
        onRep && nearest
            ? nearest.s
            : rowWithStability && typeof rowWithStability.s === 'number'
              ? rowWithStability.s
              : null;
    const isFuture = t !== null && t > series.nowT;

    return (
        <div
            className="rn-clr-background-primary rn-clr-border-opaque border rounded-md px-2 py-1.5 text-xs shadow-lg"
            style={{ pointerEvents: 'none' }}
        >
            {t !== null && (
                <div className="font-semibold">
                    {new Date(t).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                    })}
                </div>
            )}
            {s !== null && !isFuture && (
                <div>
                    <span className="rn-clr-content-secondary">Stability:</span>{' '}
                    <strong>{formatStabilityDays(s)}</strong>
                </div>
            )}
            {isFuture && (
                <div className="mt-1 pt-1 rn-clr-border-opaque border-t">
                    {CURVE_GRADES.map((g) => {
                        const branch = series.branches.find((b) => b.grade === g);
                        if (!branch) return null;
                        // Again has no SInc: a lapse replaces stability through
                        // the post-forget formula rather than multiplying it.
                        const inc =
                            g === 'again' ? null : series.state.sInc[g as 'hard' | 'good' | 'easy'];
                        return (
                            <div key={g} style={{ color: GRADE_COLOR[g] }}>
                                {GRADE_LABEL[g]}: <strong>{formatStabilityDays(branch.stability)}</strong>
                                {inc !== null && (
                                    <span className="rn-clr-content-tertiary">
                                        {' '}
                                        (×{inc.toFixed(2)})
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
            {onRep && nearest && (
                <div className="mt-1 pt-1 rn-clr-border-opaque border-t">
                    <div style={{ color: scoreColor(nearest.score) }}>
                        Repetition {nearest.index}
                    </div>
                    {nearest.sInc !== null && nearest.sBefore !== null ? (
                        <div>
                            <strong>×{nearest.sInc.toFixed(2)}</strong>{' '}
                            <span className="rn-clr-content-tertiary">
                                ({formatStabilityDays(nearest.sBefore)} →{' '}
                                {formatStabilityDays(nearest.s)})
                            </span>
                        </div>
                    ) : (
                        <div className="rn-clr-content-tertiary">First review — nothing to grow from</div>
                    )}
                </div>
            )}
        </div>
    );
}

export function ForgettingCurveChart({
    series,
    height = 220,
    showStability = true,
    scale,
    onScaleChange,
    headerRight,
    title = 'Forgetting Curve',
}: ForgettingCurveChartProps) {
    // How wide the plot actually is, so the axis can earn more marks on a wide
    // chart than on a narrow one. The series ships ticks for an assumed width,
    // because the maths runs before anything is laid out; this replaces them
    // once the real width is known.
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [plotWidth, setPlotWidth] = useState(0);

    useEffect(() => {
        const el = containerRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const measure = (width: number) =>
            setPlotWidth(Math.max(0, width - Y_AXIS_WIDTH - CHART_MARGIN_LEFT - CHART_MARGIN_RIGHT));
        measure(el.clientWidth);
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) measure(entry.contentRect.width);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Zoom. `null` is the full axis; otherwise a visible range in plotted x
    // units, which both panels share because they share the axis.
    //
    // The range is tagged with the series it was taken from, and discarded
    // during render if it does not match. Clearing it in an effect is not
    // enough: an effect runs *after* the render it belongs to, so switching
    // scale drew one frame with a log range on a linear axis (or worse, the
    // reverse — a linear range put through 10^x is Infinity, which used to hang
    // the tick loop and take the whole widget down with it).
    const [zoom, setZoom] = useState<{ series: ForgettingCurveSeries; range: [number, number] } | null>(
        null,
    );
    const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

    const activeZoom = zoom && zoom.series === series ? zoom.range : null;

    // Drop the stale entry once the render that ignored it is done, so the
    // Reset control and the wheel handler see the same state the axis does.
    useEffect(() => {
        setZoom((current) => (current && current.series === series ? current : null));
        setDrag(null);
    }, [series]);

    const xDomain: [number, number] = activeZoom ?? series.xDomain;

    const ticks = useMemo(
        () => (plotWidth > 0 ? rebuildTicks(series, plotWidth, activeZoom ?? series.xDomain) : series.ticks),
        [series, plotWidth, activeZoom],
    );

    const visibleRows = useMemo(
        () => series.rows.filter((r) => r.x >= xDomain[0] && r.x <= xDomain[1]),
        [series.rows, xDomain],
    );

    // Zoomed in, the full 0–100% y axis would show a flat line in its top few
    // percent, so refit to what is actually on screen — keeping the target line
    // inside, since it is the thing the curve is read against.
    const yDomain = useMemo((): [number, number] => {
        if (!activeZoom) return series.yDomain;
        const values: number[] = [];
        for (const row of visibleRows) {
            for (const key of ['r', ...CURVE_GRADES] as const) {
                const v = row[key];
                if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
            }
        }
        if (values.length === 0) return series.yDomain;
        const lo = Math.min(...values, series.targetPercent);
        const hi = Math.max(...values, series.targetPercent);
        const pad = Math.max((hi - lo) * 0.12, 0.5);
        return [Math.max(0, lo - pad), Math.min(100, hi + pad)];
    }, [activeZoom, visibleRows, series]);

    /**
     * The axis is drawn a little taller than the data it holds.
     *
     * Every repetition puts a point at exactly 100%, and a domain that stops at
     * 100 puts those points on the boundary of the plot — where recharts clips
     * them, so each peak lost the upper half of its stroke and the highest
     * points of the whole chart were the ones you could not see. The ticks stay
     * on the real range, so the extra space is headroom and not a claim that
     * retrievability goes above 100%.
     */
    const yPlotDomain = useMemo((): [number, number] => {
        const [lo, hi] = yDomain;
        return [lo, hi + Math.max((hi - lo) * Y_HEADROOM, 0.3)];
    }, [yDomain]);

    const yTicks = useMemo(() => {
        const [lo, hi] = yDomain;
        const decimals = hi - lo < 5 ? 1 : 0;
        const seen = new Set<number>();
        const out: number[] = [];
        for (let i = 0; i < Y_TICK_COUNT; i++) {
            const value = Number((lo + ((hi - lo) * i) / (Y_TICK_COUNT - 1)).toFixed(decimals));
            if (!seen.has(value)) {
                seen.add(value);
                out.push(value);
            }
        }
        return out;
    }, [yDomain]);

    /**
     * The past curve's gradient, in the chart's own pixel space.
     *
     * An SVG gradient can only be positioned in user space, so the stops have to
     * be placed at the pixel heights of R = 0 and R = 100 — which means knowing
     * the plot's geometry rather than asking recharts for it. Hence the fixed
     * axis height above: with the container height, the margins and the domain,
     * the mapping is arithmetic. Running the vector between 0% and 100% (rather
     * than between the visible bounds) is what lets the middle stop sit at
     * exactly `targetPercent`, whatever the axis happens to be showing.
     */
    const gradientId = useMemo(
        () => `forgetting-curve-${Math.random().toString(36).slice(2, 9)}`,
        [],
    );

    const gradientEnds = useMemo(() => {
        const plotTop = CURVE_MARGIN_TOP;
        const plotBottom = height - CURVE_MARGIN_BOTTOM - CURVE_X_AXIS_HEIGHT;
        const [lo, hi] = yPlotDomain;
        const span = hi - lo || 1;
        const pixelFor = (value: number) =>
            plotBottom - ((value - lo) / span) * (plotBottom - plotTop);
        return { y0: pixelFor(0), y100: pixelFor(100) };
    }, [height, yPlotDomain]);

    const yTickFormatter = useMemo(() => {
        const narrow = yDomain[1] - yDomain[0] < 5;
        return (value: number) => `${narrow ? value.toFixed(1) : Math.round(value)}%`;
    }, [yDomain]);

    // Wheel zoom, anchored on the pointer so the moment under the cursor stays
    // put. Bound natively rather than through React's `onWheel`, which is
    // registered passive and so cannot stop the popup scrolling underneath.
    useEffect(() => {
        const el = containerRef.current;
        if (!el || plotWidth <= 0) return;

        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            // Zooming out runs to the full extent, which reaches far past the
            // window the chart opens on — that is the point of the two ranges.
            const [fullLo, fullHi] = series.xFullDomain;
            const [openLo, openHi] = series.xDomain;
            const fullSpan = fullHi - fullLo;
            const openSpan = openHi - openLo;
            if (!(fullSpan > 0) || !(openSpan > 0)) return;

            const plotLeft = el.getBoundingClientRect().left + CHART_MARGIN_LEFT + Y_AXIS_WIDTH;
            const fraction = Math.min(Math.max((event.clientX - plotLeft) / plotWidth, 0), 1);

            setZoom((current) => {
                // Start from what is on screen. Falling back to the whole extent
                // here meant the first notch of the wheel did not zoom out of
                // the opening window — it replaced it with the far tail, at
                // maximum span, from which nothing could widen further.
                const [lo, hi] =
                    current && current.series === series ? current.range : [openLo, openHi];
                const anchor = lo + fraction * (hi - lo);
                const scaled = (hi - lo) * (event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
                const span = Math.min(Math.max(scaled, openSpan / MAX_ZOOM_IN), fullSpan);

                let x0 = anchor - (anchor - lo) * (span / (hi - lo));
                if (x0 < fullLo) x0 = fullLo;
                if (x0 + span > fullHi) x0 = fullHi - span;
                const next: [number, number] = [Math.max(x0, fullLo), Math.min(x0 + span, fullHi)];

                // Back to the opening window: drop to null so the axis returns
                // to the ticks and y range it was built with. Anything else —
                // narrower or wider — is a view the reader chose.
                const atOpening =
                    Math.abs(next[0] - openLo) < openSpan * 1e-3 &&
                    Math.abs(next[1] - openHi) < openSpan * 1e-3;
                return atOpening ? null : { series, range: next };
            });
        };

        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [plotWidth, series]);

    const beginDrag = (e: { activeLabel?: string | number }) => {
        const x = Number(e?.activeLabel);
        if (Number.isFinite(x)) setDrag({ from: x, to: x });
    };

    const extendDrag = (e: { activeLabel?: string | number }) => {
        if (!drag) return;
        const x = Number(e?.activeLabel);
        if (Number.isFinite(x)) setDrag((d) => (d ? { ...d, to: x } : d));
    };

    const commitDrag = () => {
        if (!drag) return;
        let lo = Math.min(drag.from, drag.to);
        let hi = Math.max(drag.from, drag.to);
        setDrag(null);

        const openSpan = series.xDomain[1] - series.xDomain[0];
        // A click, or a selection too thin to be meant: leave the view alone.
        if (!(hi - lo >= openSpan * 0.005)) return;

        // Honour the same floor the wheel does, so a stray thin drag cannot
        // land on a window with nothing in it.
        const minSpan = openSpan / MAX_ZOOM_IN;
        if (hi - lo < minSpan) {
            const middle = (lo + hi) / 2;
            lo = middle - minSpan / 2;
            hi = middle + minSpan / 2;
        }
        const [fullLo, fullHi] = series.xFullDomain;
        setZoom({ series, range: [Math.max(lo, fullLo), Math.min(hi, fullHi)] });
    };

    const dragHandlers = {
        onMouseDown: beginDrag,
        onMouseMove: extendDrag,
        onMouseUp: commitDrag,
        onMouseLeave: commitDrag,
    };

    const tickFormatter = useMemo(() => {
        const labels = new Map(ticks.map((t) => [t.value, t.label]));
        return (value: number) => labels.get(value) ?? formatCurveDays(
            series.scale === 'linear' ? value : Math.pow(10, value),
        );
    }, [ticks, series.scale]);

    const tickValues = useMemo(() => ticks.map((t) => t.value), [ticks]);

    // The stability panel plots one point per repetition, so the ×SInc labels
    // have somewhere to hang. The staircase itself comes from the curve rows,
    // which already carry the stability governing each segment.
    /**
     * The repetition dots, each carrying the label it should draw and the row to
     * draw it on — or -1 for "too crowded here to be legible".
     *
     * Walking left to right, a label takes the highest row whose last label is
     * far enough behind it. Two rows absorb most clustering; anything still
     * colliding after that is dropped rather than drawn on top of its
     * neighbour, and zooming in recovers it, because the spacing is measured
     * against the *visible* span rather than the whole axis.
     *
     * The row travels in the datum rather than in a parallel array because the
     * shape that draws it is handed the datum, and nothing else: an index into a
     * second list is one recharts internal away from pointing at the wrong dot.
     */
    const repPoints = useMemo(() => {
        const span = xDomain[1] - xDomain[0] || 1;
        const minGap = span * LABEL_MIN_GAP;
        const lastAt = new Array(LABEL_ROWS).fill(-Infinity);
        return series.reps.map((r) => {
            let labelRow = -1;
            if (r.sInc !== null) {
                for (let row = 0; row < LABEL_ROWS; row++) {
                    if (r.x - lastAt[row] >= minGap) {
                        lastAt[row] = r.x;
                        labelRow = row;
                        break;
                    }
                }
            }
            return {
                index: r.index,
                x: r.x,
                sLog: r.sLog,
                s: r.s,
                sIncLabel: r.sInc !== null ? `×${r.sInc.toFixed(2)}` : '',
                labelRow,
            };
        });
    }, [series, xDomain]);

    // The stability panel's plot area, to the pixel. The ×SInc labels are drawn
    // inside it — recharts clips a Scatter to the plot on whichever axis has
    // `allowDataOverflow`, and this panel needs it on y so a zoomed range can
    // refit — so the headroom they need has to be reserved in the *domain*, not
    // in the margin. A margin is outside the clip and does nothing for them.
    const stabilityHeight = Math.max(150, Math.round(height * 0.68));
    const stabilityPlotHeight = Math.max(
        40,
        stabilityHeight - STABILITY_MARGIN.top - STABILITY_MARGIN.bottom - STABILITY_X_AXIS_HEIGHT,
    );

    /** Pixels of headroom the tallest label actually in use needs. */
    const labelReservePx = useMemo(() => {
        const topRow = repPoints.reduce((highest, p) => Math.max(highest, p.labelRow), -1);
        return topRow < 0 ? 0 : LABEL_BASE_OFFSET + topRow * LABEL_ROW_HEIGHT + LABEL_TEXT_ASCENT;
    }, [repPoints]);

    const sLogDomain = useMemo((): [number, number] => {
        // Everything drawn on this panel — the staircase and the four branches,
        // since Easy sits well above the steps and fitting to the steps alone
        // would clip it away.
        const values: number[] = [];
        for (const row of visibleRows) {
            for (const key of ['sLog', ...CURVE_GRADES.map((g) => STABILITY_BRANCH_KEY[g])] as const) {
                const v = row[key];
                if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
            }
        }
        if (values.length === 0) {
            for (const p of repPoints) values.push(p.sLog);
        }
        if (values.length === 0) return [0, 1];

        const lo = Math.min(...values);
        const dataTop = Math.max(...values);
        const spread = dataTop - lo;
        // A card whose stability never moved would otherwise get a zero-height
        // axis; keep a sliver of a decade so the staircase has somewhere to sit.
        const floor = lo - Math.max(spread * 0.15, 0.15);

        // Headroom is needed above the topmost *labelled* step, not above
        // everything on the panel. The branches carry no labels, and Easy can
        // sit a decade or more above the staircase — padding in proportion to
        // the whole range then pushed the ceiling into the hundreds of years and
        // squashed the part worth reading into a sliver.
        //
        // So: let Easy be the ceiling whenever it is already high enough to
        // clear the labels, and only pad past it when it is not. Solving
        // (top − dotsTop) / (top − floor) = reserve / plotHeight for `top`.
        const visibleDots = repPoints
            .filter((p) => p.x >= xDomain[0] && p.x <= xDomain[1])
            .map((p) => p.sLog);
        const headroom = Math.max(spread * 0.03, 0.05);
        if (visibleDots.length === 0) return [floor, dataTop + headroom];

        const fraction = Math.min(labelReservePx / stabilityPlotHeight, 0.45);
        const dotsTop = Math.max(...visibleDots);
        const neededForLabels = (dotsTop - fraction * floor) / (1 - fraction);
        return [floor, Math.max(dataTop + headroom, neededForLabels)];
    }, [repPoints, visibleRows, labelReservePx, stabilityPlotHeight, xDomain]);

    const repByIndex = useMemo(
        () => new Map(repPoints.map((p) => [p.index, p])),
        [repPoints],
    );

    /**
     * The dot and its ×SInc, drawn together.
     *
     * This was a `LabelList` with a `content` function, which recharts feeds
     * through `filterProps` and a `viewBox` guard before it ever reaches the
     * renderer — so whether a label appeared depended on internals, and some of
     * them silently did not. Drawing both from one renderer means the label
     * appears if and only if the dot does.
     *
     * It runs for every row, because the series spans them all; the rows that
     * are not a repetition carry no value and are skipped.
     */
    const renderRepPoint = (raw: any) => {
        const { cx, cy, payload, index } = raw as {
            cx?: number;
            cy?: number;
            index?: number;
            payload?: { repIndex?: number | null };
        };
        // Recharts types a dot renderer as returning an element, never null, so
        // the rows that are not a repetition return an empty group.
        const nothing = <g key={`no-rep-${index}`} />;
        if (typeof cx !== 'number' || typeof cy !== 'number' || !Number.isFinite(cy)) return nothing;

        const rep = typeof payload?.repIndex === 'number' ? repByIndex.get(payload.repIndex) : undefined;
        if (!rep) return nothing;

        const label = rep.sIncLabel;
        const row = rep.labelRow;
        // A label centred on the first repetition would hang off the left edge
        // and be clipped, so anchor it to the plot edge instead.
        const nearLeft = cx < STABILITY_PLOT_LEFT + 16;

        return (
            <g key={`rep-${rep.index}`}>
                <circle cx={cx} cy={cy} r={3} fill={STABILITY_COLOR} />
                {row >= 0 && label ? (
                    <text
                        x={nearLeft ? STABILITY_PLOT_LEFT : cx}
                        y={cy - 9 - row * LABEL_ROW_HEIGHT}
                        textAnchor={nearLeft ? 'start' : 'middle'}
                        fontSize={9}
                        fill="currentColor"
                        // A halo, so a label crossing the staircase or a
                        // gridline stays readable without a box behind it.
                        stroke="var(--rn-clr-background-primary)"
                        strokeWidth={3}
                        paintOrder="stroke"
                    >
                        {label}
                    </text>
                ) : null}
            </g>
        );
    };

    const grades = series.branches.map((b) => b.grade);

    return (
        <div
            className="w-full"
            ref={containerRef}
            onDoubleClick={() => setZoom(null)}
            title="Drag across the chart to zoom, scroll to zoom at the pointer, double-click to reset"
        >
            <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                <h3 className="text-sm font-bold uppercase rn-clr-content-tertiary tracking-wider">
                    {title}
                </h3>
                <div className="flex items-center gap-2">
                    {activeZoom && (
                        <button
                            onClick={() => setZoom(null)}
                            className="px-2 py-0.5 text-[10px] rounded-md border rn-clr-border-opaque rn-clr-content-secondary hover:rn-clr-background-secondary"
                            title="Show the whole timeline again (or double-click the chart)"
                        >
                            Reset zoom
                        </button>
                    )}
                    {onScaleChange && (
                        <div className="flex rn-clr-border-opaque border rounded-md overflow-hidden text-[10px]">
                            {(['log', 'linear'] as CurveScale[]).map((s) => (
                                <button
                                    key={s}
                                    onClick={() => onScaleChange(s)}
                                    className={`px-2 py-0.5 ${
                                        scale === s
                                            ? 'rn-clr-background-secondary font-semibold'
                                            : 'rn-clr-content-tertiary'
                                    }`}
                                    title={
                                        s === 'log'
                                            ? 'Logarithmic time — shows the learning steps and the long tail at once'
                                            : 'Linear time'
                                    }
                                >
                                    {s === 'log' ? 'Log' : 'Linear'}
                                </button>
                            ))}
                        </div>
                    )}
                    {headerRight}
                </div>
            </div>

            {/* Legend. Compact enough to sit above the plot rather than steal
                width from it, and it doubles as the key for the rep markers. */}
            <div className="flex items-center gap-3 flex-wrap text-[10px] rn-clr-content-tertiary mb-1">
                <span className="flex items-center gap-1">
                    <span
                        style={{
                            width: SWATCH_LENGTH,
                            height: CURVE_STROKE.history.width,
                            background: `linear-gradient(90deg, ${CURVE_GRADIENT_STOPS.map(
                                (r) => getRetrievabilityColor(r),
                            ).join(', ')})`,
                            display: 'inline-block',
                        }}
                    />
                    <span title="Coloured by retrievability, on the same scale as the card info bar: red at 70% and below, green at 100%">
                        History
                    </span>
                </span>
                {grades.length > 0 && (
                    <span className="flex items-center gap-1">
                        <LineSwatch
                            gradientId={`${gradientId}-swatch`}
                            width={CURVE_STROKE.noReview.width}
                            dash={CURVE_STROKE.noReview.dash}
                        />
                        <span
                            style={{ fontWeight: 600 }}
                            title="The card left alone: its own curve carried on past now, on the stability it already has"
                        >
                            If not reviewed
                        </span>
                    </span>
                )}
                {grades.map((g) => (
                    <span key={g} className="flex items-center gap-1">
                        <LineSwatch
                            color={GRADE_COLOR[g]}
                            width={strokeFor(g).width}
                            dash={strokeFor(g).dash}
                            opacity={strokeFor(g).opacity}
                        />
                        <span style={{ fontWeight: g === 'good' ? 700 : 400 }}>
                            If {GRADE_LABEL[g]}
                        </span>
                    </span>
                ))}
                <span className="flex items-center gap-1">
                    <span
                        style={{
                            width: 14,
                            height: 0,
                            borderTop: '1px dashed currentColor',
                            display: 'inline-block',
                        }}
                    />
                    Target {series.targetPercent.toFixed(0)}%
                </span>
            </div>

            <ResponsiveContainer width="100%" height={height} debounce={50}>
                <ComposedChart
                    data={series.rows}
                    margin={{ top: 6, right: CHART_MARGIN_RIGHT, bottom: 0, left: CHART_MARGIN_LEFT }}
                    {...dragHandlers}
                >
                    <defs>
                        <linearGradient
                            id={gradientId}
                            gradientUnits="userSpaceOnUse"
                            x1={0}
                            y1={gradientEnds.y0}
                            x2={0}
                            y2={gradientEnds.y100}
                        >
                            {CURVE_GRADIENT_STOPS.map((r) => (
                                <stop
                                    key={r}
                                    offset={`${r * 100}%`}
                                    stopColor={getRetrievabilityColor(r)}
                                />
                            ))}
                        </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.25} syncWithTicks />
                    <XAxis
                        dataKey="x"
                        type="number"
                        domain={xDomain}
                        ticks={tickValues}
                        tickFormatter={tickFormatter}
                        tick={{ fontSize: 10 }}
                        height={CURVE_X_AXIS_HEIGHT}
                        allowDataOverflow
                    />
                    <YAxis
                        domain={yPlotDomain}
                        ticks={yTicks}
                        width={Y_AXIS_WIDTH}
                        tick={{ fontSize: 10 }}
                        tickFormatter={yTickFormatter}
                        allowDataOverflow
                    />
                    <Tooltip
                        content={<CurveTooltip series={series} />}
                        // Keep it inside this chart: left free it drops out of
                        // the plot and lands on top of the stability panel.
                        allowEscapeViewBox={{ x: false, y: false }}
                        wrapperStyle={{ zIndex: 30, pointerEvents: 'none' }}
                    />

                    <ReferenceLine
                        y={series.targetPercent}
                        stroke="currentColor"
                        strokeDasharray="4 4"
                        strokeOpacity={0.5}
                    />
                    {/* One tick per repetition, coloured by the answer given —
                        and a lapse drawn to be found, since it is the event that
                        explains the stability collapse underneath it. */}
                    {series.reps.map((r) => {
                        const lapse = r.score === QueueInteractionScore.AGAIN;
                        return (
                            <ReferenceLine
                                key={`rep-${r.index}`}
                                x={r.x}
                                stroke={lapse ? LAPSE_MARKER_COLOR : scoreColor(r.score)}
                                strokeOpacity={lapse ? 0.9 : 0.35}
                                strokeWidth={lapse ? 1.6 : 1}
                            />
                        );
                    })}

                    <Line
                        type="monotone"
                        dataKey="r"
                        stroke={`url(#${gradientId})`}
                        strokeWidth={CURVE_STROKE.history.width}
                        dot={false}
                        isAnimationActive={false}
                        connectNulls={false}
                        name="History"
                    />

                    {/* The null action: this same memory, never answered again.
                        Drawn in the history's own gradient because it is the
                        history continuing, dashed because it has not happened. */}
                    <Line
                        type="monotone"
                        dataKey="noReview"
                        stroke={`url(#${gradientId})`}
                        strokeWidth={CURVE_STROKE.noReview.width}
                        strokeDasharray={CURVE_STROKE.noReview.dash}
                        dot={false}
                        isAnimationActive={false}
                        connectNulls
                        name="If not reviewed"
                    />

                    {grades.map((g) => (
                        <Line
                            key={g}
                            type="monotone"
                            dataKey={g}
                            stroke={GRADE_COLOR[g]}
                            strokeWidth={strokeFor(g).width}
                            strokeOpacity={strokeFor(g).opacity}
                            strokeDasharray={strokeFor(g).dash}
                            dot={false}
                            isAnimationActive={false}
                            connectNulls
                            name={GRADE_LABEL[g]}
                        />
                    ))}

                    {/* Declared after the series so it paints over them: it is a
                        marker for reading the chart against, and a curve running
                        across its label makes the label the thing being read. */}
                    <ReferenceLine
                        x={series.nowX}
                        stroke="currentColor"
                        strokeOpacity={0.5}
                        label={{
                            value: 'now',
                            position: 'insideTopRight',
                            fontSize: 9,
                            fill: 'currentColor',
                        }}
                    />

                    {drag && (
                        <ReferenceArea x1={drag.from} x2={drag.to} strokeOpacity={0.3} fill="#8884d8" />
                    )}
                </ComposedChart>
            </ResponsiveContainer>

            {showStability && repPoints.length > 0 && (
                <ResponsiveContainer width="100%" height={stabilityHeight} debounce={50}>
                    <ComposedChart data={series.rows} margin={STABILITY_MARGIN} {...dragHandlers}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.2} syncWithTicks />
                        <XAxis
                            dataKey="x"
                            type="number"
                            domain={xDomain}
                            ticks={tickValues}
                            tickFormatter={tickFormatter}
                            tick={{ fontSize: 10 }}
                            height={STABILITY_X_AXIS_HEIGHT}
                            allowDataOverflow
                        />
                        <Tooltip
                            content={<StabilityTooltip series={series} />}
                            allowEscapeViewBox={{ x: false, y: false }}
                            wrapperStyle={{ zIndex: 30, pointerEvents: 'none' }}
                        />
                        <YAxis
                            domain={sLogDomain}
                            width={Y_AXIS_WIDTH}
                            tick={{ fontSize: 9 }}
                            tickFormatter={(v: number) => formatStabilityDays(Math.pow(10, v))}
                            allowDataOverflow
                        />
                        <Line
                            type="stepAfter"
                            dataKey="sLog"
                            stroke={STABILITY_COLOR}
                            strokeWidth={1.8}
                            dot={false}
                            isAnimationActive={false}
                            connectNulls={false}
                        />
                        {/* What the next answer would leave the card at. Flat,
                            because stability only moves when a card is reviewed,
                            and in the branch colours so the two panels read as
                            one forecast. */}
                        {grades.map((g) => (
                            <Line
                                key={g}
                                type="linear"
                                dataKey={STABILITY_BRANCH_KEY[g]}
                                stroke={GRADE_COLOR[g]}
                                strokeWidth={strokeFor(g).width}
                                strokeOpacity={strokeFor(g).opacity}
                                strokeDasharray={strokeFor(g).dash}
                                dot={false}
                                isAnimationActive={false}
                                connectNulls
                            />
                        ))}

                        <Line
                            dataKey="repSLog"
                            stroke="none"
                            dot={renderRepPoint}
                            activeDot={false}
                            isAnimationActive={false}
                            connectNulls={false}
                        />

                        {drag && (
                            <ReferenceArea x1={drag.from} x2={drag.to} strokeOpacity={0.3} fill="#8884d8" />
                        )}
                    </ComposedChart>
                </ResponsiveContainer>
            )}

            {showStability && (
                <div className="text-[10px] rn-clr-content-tertiary mt-0.5 text-center">
                    Stability after each repetition (log scale), labelled with the ×SInc it bought
                    {grades.length > 0 && ' — and what the next answer would leave it at'}
                </div>
            )}
        </div>
    );
}

export default ForgettingCurveChart;
