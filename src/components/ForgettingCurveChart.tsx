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
 * in it comes from the FSRS settings in the plugin's own settings, not from the
 * scheduler RemNote actually runs on the card; `warning` is where the caller
 * says so when the two look like they disagree.
 */
import { QueueInteractionScore } from '@remnote/plugin-sdk';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    CartesianGrid,
    ComposedChart,
    Line,
    ReferenceLine,
    ResponsiveContainer,
    Scatter,
    LabelList,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import {
    CURVE_GRADES,
    CurveGrade,
    CurveScale,
    ForgettingCurveSeries,
    formatCurveDays,
    rebuildTicks,
} from '../lib/forgetting_curve';
import { scoreColor } from '../lib/rating_labels';
import { formatStabilityDays } from '../lib/utils';

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

/** The past curve. Deliberately not one of the four grade colours. */
const PAST_COLOR = '#0ea5e9';
const STABILITY_COLOR = '#6366f1';

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

/** How many staggered rows the labels may use before one is dropped. */
const LABEL_ROWS = 2;

/** Vertical step between those rows, in px. */
const LABEL_ROW_HEIGHT = 11;

export interface ForgettingCurveChartProps {
    series: ForgettingCurveSeries;
    /** Height of the retrievability panel in px. */
    height?: number;
    /** Draw the stability staircase under the curve. */
    showStability?: boolean;
    /** Rendered above the chart in amber when the model may not match the scheduler. */
    warning?: string | null;
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
            {s !== null && (
                <div>
                    <span className="rn-clr-content-secondary">Stability:</span>{' '}
                    <strong>{formatStabilityDays(s)}</strong>
                </div>
            )}
            {isFuture && (
                <div className="mt-1 pt-1 rn-clr-border-opaque border-t">
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

export function ForgettingCurveChart({
    series,
    height = 220,
    showStability = true,
    warning,
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

    const ticks = useMemo(
        () => (plotWidth > 0 ? rebuildTicks(series, plotWidth) : series.ticks),
        [series, plotWidth],
    );

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
    const repPoints = useMemo(
        () =>
            series.reps.map((r) => ({
                x: r.x,
                sLog: r.sLog,
                s: r.s,
                sIncLabel: r.sInc !== null ? `×${r.sInc.toFixed(2)}` : '',
            })),
        [series],
    );

    const sLogDomain = useMemo((): [number, number] => {
        const values = repPoints.map((p) => p.sLog);
        if (values.length === 0) return [0, 1];
        const lo = Math.min(...values);
        const hi = Math.max(...values);
        const spread = hi - lo;
        // A card whose stability never moved would otherwise get a zero-height
        // axis; keep a quarter of a decade so the staircase has somewhere to sit.
        return [lo - Math.max(spread * 0.15, 0.15), hi + Math.max(spread * 0.2, 0.25)];
    }, [repPoints]);

    /**
     * Which row each ×SInc label gets, or -1 for "too crowded to draw".
     *
     * Walking left to right, a label takes the highest row whose last label is
     * far enough behind it. Two rows absorb most clustering; anything still
     * colliding after that is dropped rather than drawn on top of its
     * neighbour. Nothing is lost by dropping one — the repetition table in the
     * history popup lists every SInc, and hovering the curve gives the
     * stability either side of it.
     */
    const labelRows = useMemo(() => {
        const span = series.xDomain[1] - series.xDomain[0] || 1;
        const minGap = span * LABEL_MIN_GAP;
        const lastAt = new Array(LABEL_ROWS).fill(-Infinity);
        return series.reps.map((r) => {
            if (r.sInc === null) return -1;
            for (let row = 0; row < LABEL_ROWS; row++) {
                if (r.x - lastAt[row] >= minGap) {
                    lastAt[row] = r.x;
                    return row;
                }
            }
            return -1;
        });
    }, [series]);

    // Recharts types label `content` props as `any`; narrow at the boundary.
    const renderSIncLabel = (raw: any) => {
        const { x, y, index } = raw as { x?: number; y?: number; index?: number };
        if (typeof x !== 'number' || typeof y !== 'number' || typeof index !== 'number') return null;
        const row = labelRows[index] ?? -1;
        const text = repPoints[index]?.sIncLabel;
        if (row < 0 || !text) return null;
        // A label centred on the first repetition would hang off the left edge
        // and be clipped, so anchor it to the plot edge instead.
        const nearLeft = x < STABILITY_PLOT_LEFT + 16;
        return (
            <text
                x={nearLeft ? STABILITY_PLOT_LEFT : x}
                y={y - 9 - row * LABEL_ROW_HEIGHT}
                textAnchor={nearLeft ? 'start' : 'middle'}
                fontSize={9}
                fill="currentColor"
                // A halo, so a label crossing the staircase or a gridline stays
                // readable without a solid box behind it.
                stroke="var(--rn-clr-background-primary)"
                strokeWidth={3}
                paintOrder="stroke"
            >
                {text}
            </text>
        );
    };

    const grades = series.branches.map((b) => b.grade);

    return (
        <div className="w-full" ref={containerRef}>
            <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                <h3 className="text-sm font-bold uppercase rn-clr-content-tertiary tracking-wider">
                    {title}
                </h3>
                <div className="flex items-center gap-2">
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

            {warning && (
                <div className="mb-2 px-2 py-1 text-[11px] rounded border border-amber-400 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40">
                    {warning}
                </div>
            )}

            {/* Legend. Compact enough to sit above the plot rather than steal
                width from it, and it doubles as the key for the rep markers. */}
            <div className="flex items-center gap-3 flex-wrap text-[10px] rn-clr-content-tertiary mb-1">
                <span className="flex items-center gap-1">
                    <span style={{ width: 14, height: 2, background: PAST_COLOR, display: 'inline-block' }} />
                    History
                </span>
                {grades.map((g) => (
                    <span key={g} className="flex items-center gap-1">
                        <span
                            style={{
                                width: 14,
                                height: g === 'good' ? 3 : 2,
                                background: GRADE_COLOR[g],
                                opacity: g === 'good' ? 1 : 0.6,
                                display: 'inline-block',
                            }}
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
                >
                    <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                    <XAxis
                        dataKey="x"
                        type="number"
                        domain={series.xDomain}
                        ticks={tickValues}
                        tickFormatter={tickFormatter}
                        tick={{ fontSize: 10 }}
                        allowDataOverflow
                    />
                    <YAxis
                        domain={series.yDomain}
                        width={Y_AXIS_WIDTH}
                        tick={{ fontSize: 10 }}
                        tickFormatter={(v: number) => `${Math.round(v)}%`}
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
                    <ReferenceLine
                        x={series.nowX}
                        stroke="currentColor"
                        strokeOpacity={0.45}
                        label={{ value: 'now', position: 'insideTopRight', fontSize: 9, fill: 'currentColor' }}
                    />

                    {/* One tick per repetition, coloured by the answer given. */}
                    {series.reps.map((r) => (
                        <ReferenceLine
                            key={`rep-${r.index}`}
                            x={r.x}
                            stroke={scoreColor(r.score)}
                            strokeOpacity={0.35}
                            strokeWidth={1}
                        />
                    ))}

                    <Line
                        type="monotone"
                        dataKey="r"
                        stroke={PAST_COLOR}
                        strokeWidth={1.8}
                        dot={false}
                        isAnimationActive={false}
                        connectNulls={false}
                        name="History"
                    />

                    {grades.map((g) => (
                        <Line
                            key={g}
                            type="monotone"
                            dataKey={g}
                            stroke={GRADE_COLOR[g]}
                            strokeWidth={g === 'good' ? 2.4 : 1.2}
                            strokeOpacity={g === 'good' ? 1 : 0.55}
                            strokeDasharray={g === 'good' ? '6 3' : '3 3'}
                            dot={false}
                            isAnimationActive={false}
                            connectNulls
                            name={GRADE_LABEL[g]}
                        />
                    ))}
                </ComposedChart>
            </ResponsiveContainer>

            {showStability && repPoints.length > 0 && (
                <ResponsiveContainer width="100%" height={Math.max(130, Math.round(height * 0.62))} debounce={50}>
                    <ComposedChart data={series.rows} margin={STABILITY_MARGIN}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                        <XAxis
                            dataKey="x"
                            type="number"
                            domain={series.xDomain}
                            ticks={tickValues}
                            tickFormatter={tickFormatter}
                            tick={{ fontSize: 10 }}
                            allowDataOverflow
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
                        <Scatter data={repPoints} dataKey="sLog" fill={STABILITY_COLOR} isAnimationActive={false}>
                            <LabelList dataKey="sIncLabel" content={renderSIncLabel} />
                        </Scatter>
                    </ComposedChart>
                </ResponsiveContainer>
            )}

            {showStability && (
                <div className="text-[10px] rn-clr-content-tertiary mt-0.5 text-center">
                    Stability after each repetition (log scale), labelled with the ×SInc it bought
                </div>
            )}
        </div>
    );
}

export default ForgettingCurveChart;
