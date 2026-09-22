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
import React, { useMemo } from 'react';
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
    const tickFormatter = useMemo(() => {
        const labels = new Map(series.ticks.map((t) => [t.value, t.label]));
        return (value: number) => labels.get(value) ?? formatCurveDays(
            series.scale === 'linear' ? value : Math.pow(10, value),
        );
    }, [series]);

    const tickValues = useMemo(() => series.ticks.map((t) => t.value), [series]);

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
        // A card whose stability never moved would otherwise get a zero-height
        // axis; keep at least half a decade so the staircase has somewhere to sit.
        const pad = Math.max((hi - lo) * 0.25, 0.25);
        return [lo - pad, hi + pad];
    }, [repPoints]);

    const grades = series.branches.map((b) => b.grade);

    return (
        <div className="w-full">
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
                <ComposedChart data={series.rows} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
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
                        width={38}
                        tick={{ fontSize: 10 }}
                        tickFormatter={(v: number) => `${Math.round(v)}%`}
                        allowDataOverflow
                    />
                    <Tooltip content={<CurveTooltip series={series} />} />

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
                <ResponsiveContainer width="100%" height={Math.max(90, Math.round(height * 0.5))} debounce={50}>
                    <ComposedChart data={series.rows} margin={{ top: 14, right: 10, bottom: 4, left: 0 }}>
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
                            width={38}
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
                            <LabelList
                                dataKey="sIncLabel"
                                position="top"
                                style={{ fontSize: 9, fill: 'currentColor' }}
                            />
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
