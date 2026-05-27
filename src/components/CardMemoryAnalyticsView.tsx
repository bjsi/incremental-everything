/**
 * Card Priority × Memory Analytics — full-width tab inside the wsh popup.
 *
 * Replays FSRS over every card in the KB (lazy on first compute) and shows
 * per-priority-percentile-bucket aggregates plus a consolidated "All KB" row.
 * Results are cached in session storage; a "Cached X ago — Recompute" pill
 * lets the user invalidate.
 */

import { usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  CardAnalyticsBreakdown,
  CardBucketStats,
  computeCardAnalyticsBreakdown,
} from '../lib/card_analytics';
import { CardPriorityInfo } from '../lib/card_priority/types';
import { allCardPriorityInfoKey, cardAnalyticsCacheKey, fsrsWeightsId } from '../lib/consts';
import { parseWeightsString } from '../lib/fsrs';
import { Period, resolvePeriod } from '../lib/period';
import { formatTimeAgo } from '../lib/utils';

// --- Formatting helpers ---------------------------------------------------

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

function fmtPct(n: number, decimals = 1): string {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(decimals)}%`;
}

function fmtPP(n: number, decimals = 1): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}pp`;
}

function fmtNum(n: number, decimals = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(decimals);
}

function fmtTimeShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}

function fmtStabilityDays(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '—';
  if (days < 30) return `${days.toFixed(1)}d`;
  if (days < 365) return `${(days / 30.436875).toFixed(1)}mo`;
  return `${(days / 365.25).toFixed(1)}y`;
}

// --- Color helpers --------------------------------------------------------

function retentionColor(r: number): string {
  if (r >= 90) return '#22c55e';
  if (r >= 80) return '#84cc16';
  if (r >= 70) return '#eab308';
  if (r >= 60) return '#f97316';
  return '#ef4444';
}

function rDevColor(pp: number): string {
  const abs = Math.abs(pp);
  if (abs < 3) return 'var(--rn-clr-content-primary)';
  if (abs < 7) return '#eab308';
  return pp < 0 ? '#ef4444' : '#3b82f6';
}

function gradeColor(g: number): string {
  if (g >= 3) return '#22c55e';
  if (g >= 2.5) return '#eab308';
  return '#ef4444';
}

// --- View states ----------------------------------------------------------

type ComputeState = 'idle' | 'computing' | 'ready';

interface ProgressInfo {
  done: number;
  total: number;
}

// --- Table -----------------------------------------------------------------

const cellStyle: React.CSSProperties = {
  padding: '4px 5px',
  fontSize: '10.5px',
  lineHeight: 1.3,
  whiteSpace: 'nowrap',
  textAlign: 'right',
};

const headerCellStyle: React.CSSProperties = {
  padding: '4px 5px',
  fontSize: '9.5px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
  color: 'var(--rn-clr-content-tertiary)',
  textAlign: 'right',
  whiteSpace: 'nowrap',
};

const groupHeaderStyle: React.CSSProperties = {
  padding: '3px 5px',
  fontSize: '9px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--rn-clr-content-secondary)',
  textAlign: 'center',
  background: 'var(--rn-clr-background-secondary)',
  borderBottom: '1px solid var(--rn-clr-background-tertiary)',
};

function BucketRow({ b, isOverall, idx }: { b: CardBucketStats; isOverall: boolean; idx: number }) {
  const dim = !isOverall && b.cards === 0 ? 0.3 : 1;
  const baseBg = isOverall
    ? 'var(--rn-clr-background-tertiary)'
    : idx % 2 === 0
      ? 'transparent'
      : 'var(--rn-clr-background-secondary)';

  const trStyle: React.CSSProperties = {
    background: baseBg,
    opacity: dim,
    borderTop: isOverall ? '2px solid var(--rn-clr-background-tertiary)' : 'none',
    borderBottom: '1px solid var(--rn-clr-background-tertiary)',
    fontWeight: isOverall ? 700 : 400,
  };

  // Done bar — like MiniBar in the other tab, but more compact.
  const doneBar = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
      <div
        style={{
          width: '32px',
          height: '6px',
          borderRadius: '3px',
          background: 'var(--rn-clr-background-tertiary, #e5e7eb)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.max(0, Math.min(100, b.donePct))}%`,
            height: '100%',
            background:
              b.donePct >= 100
                ? '#22c55e'
                : b.donePct >= 50
                  ? '#eab308'
                  : '#ef4444',
          }}
        />
      </div>
      <span style={{ minWidth: '32px', textAlign: 'right' }}>{fmtPct(b.donePct, 0)}</span>
    </div>
  );

  return (
    <tr style={trStyle}>
      {/* Identity */}
      <td style={{ ...cellStyle, textAlign: 'left', fontWeight: isOverall ? 700 : 500 }}>
        {b.label}
      </td>
      <td style={{ ...cellStyle, textAlign: 'center', color: 'var(--rn-clr-content-tertiary)' }}>
        {b.priorityRange}
      </td>
      {/* Population */}
      <td style={cellStyle}>{fmtInt(b.cards)}</td>
      <td
        style={{
          ...cellStyle,
          color: b.due > 0 ? '#ef4444' : 'var(--rn-clr-content-tertiary)',
          fontWeight: b.due > 0 ? 700 : 'inherit',
        }}
      >
        {fmtInt(b.due)}
      </td>
      <td style={cellStyle}>{doneBar}</td>
      <td style={cellStyle}>{fmtPct(b.newPct, 0)}</td>
      <td
        style={{
          ...cellStyle,
          color: b.stalePct >= 20 ? '#ef4444' : b.stalePct >= 5 ? '#eab308' : 'inherit',
        }}
      >
        {fmtPct(b.stalePct, 0)}
      </td>
      {/* Throughput */}
      <td style={cellStyle}>
        {fmtInt(b.totReps)}{' '}
        <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>({fmtNum(b.avgReps, 1)})</span>
      </td>
      <td style={cellStyle}>
        {fmtTimeShort(b.totTimeMs)}{' '}
        <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>({fmtTimeShort(b.avgTimeMs)})</span>
      </td>
      <td style={cellStyle}>{fmtNum(b.cpm, 1)}</td>
      <td style={cellStyle}>{fmtTimeShort(b.avgTimePerRepMs)}</td>
      <td style={cellStyle}>{fmtNum(b.avgCostMinPerYear, 1)}</td>
      {/* Outcome */}
      <td style={cellStyle}>{fmtNum(b.avgLapses, 2)}</td>
      <td style={{ ...cellStyle, color: retentionColor(b.retention), fontWeight: 600 }}>
        {fmtPct(b.retention, 1)}
      </td>
      <td style={cellStyle}>{fmtPct(b.avgPredR, 1)}</td>
      <td style={{ ...cellStyle, color: rDevColor(b.rDevPP), fontWeight: 600 }}>
        {fmtPP(b.rDevPP, 1)}
      </td>
      <td style={{ ...cellStyle, color: gradeColor(b.avgGrade), fontWeight: 600 }}>
        {fmtNum(b.avgGrade, 1)}
      </td>
      {/* FSRS */}
      <td style={cellStyle}>{fmtNum(b.avgD, 2)}</td>
      <td style={{ ...cellStyle, color: retentionColor(b.avgRtoday), fontWeight: 600 }}>
        {fmtPct(b.avgRtoday, 1)}
      </td>
      <td style={cellStyle}>{fmtStabilityDays(b.avgS)}</td>
    </tr>
  );
}

function AnalyticsTable({ breakdown }: { breakdown: CardAnalyticsBreakdown }) {
  return (
    <div style={{ overflowX: 'auto', borderRadius: '6px', border: '1px solid var(--rn-clr-background-tertiary)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1100px' }}>
        <colgroup>
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
        </colgroup>
        <thead>
          {/* Group header row — spans grouped sub-columns. */}
          <tr>
            <th style={groupHeaderStyle} colSpan={2}>
              Identity
            </th>
            <th style={groupHeaderStyle} colSpan={5}>
              Population
            </th>
            <th style={groupHeaderStyle} colSpan={5}>
              Throughput
            </th>
            <th style={groupHeaderStyle} colSpan={6}>
              Outcome
            </th>
            <th style={groupHeaderStyle} colSpan={3}>
              FSRS today
            </th>
          </tr>
          {/* Column header row */}
          <tr style={{ borderBottom: '2px solid var(--rn-clr-background-tertiary)' }}>
            <th style={{ ...headerCellStyle, textAlign: 'left' }}>Bucket</th>
            <th style={{ ...headerCellStyle, textAlign: 'center' }} title="Min–max absolute priority of cards in this bucket">
              Abs.Prio
            </th>
            <th style={headerCellStyle} title="Total cards in this bucket">
              Items
            </th>
            <th style={headerCellStyle} title="Cards with nextRepetitionTime ≤ now">
              Due
            </th>
            <th style={{ ...headerCellStyle, textAlign: 'center' }} title="% of cards already processed (not due)">
              Done
            </th>
            <th style={headerCellStyle} title="% of cards never graded">
              %New
            </th>
            <th style={headerCellStyle} title="% of cards overdue by &gt; 2× last interval">
              %Stale
            </th>
            <th style={headerCellStyle} title="Total reps (avg per card)">
              Reps
            </th>
            <th style={headerCellStyle} title="Total response time (avg per card)">
              Time
            </th>
            <th style={headerCellStyle} title="Cards per minute = totalGradeableReps / (totalTime in minutes)">
              CPM
            </th>
            <th style={headerCellStyle} title="Average response time per repetition">
              t/rep
            </th>
            <th style={headerCellStyle} title="Average per-card cost (minutes per year), coverage-based">
              Cost
            </th>
            <th style={headerCellStyle} title="Average lapses (Again responses) per non-new card">
              Lapses
            </th>
            <th style={headerCellStyle} title="Observed retention = (gradeable - Again) / gradeable">
              Retention
            </th>
            <th style={headerCellStyle} title="Average FSRS-predicted retrievability across every gradeable rep">
              Avg pR
            </th>
            <th style={headerCellStyle} title="Retention − Avg pR (percentage points)">
              R-dev
            </th>
            <th style={headerCellStyle} title="Average grade (1=Again, 2=Hard, 3=Good, 4=Easy)">
              Grade
            </th>
            <th style={headerCellStyle} title="Current FSRS Difficulty (1–10)">
              D
            </th>
            <th style={headerCellStyle} title="Current FSRS Retrievability (today)">
              R
            </th>
            <th style={headerCellStyle} title="Current FSRS Stability (days)">
              S
            </th>
          </tr>
        </thead>
        <tbody>
          {breakdown.buckets.map((b, i) => (
            <BucketRow key={i} b={b} isOverall={false} idx={i} />
          ))}
          <BucketRow b={breakdown.overall} isOverall={true} idx={-1} />
        </tbody>
      </table>
    </div>
  );
}

// --- Status bar ------------------------------------------------------------

// --- Period picker (compact, inline) -------------------------------------

const PERIOD_PRESETS: Array<{ id: Period; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'Last 7d' },
  { id: 'thisWeek', label: 'This Week' },
  { id: 'lastWeek', label: 'Last Week' },
  { id: 'month', label: 'Last 30d' },
  { id: 'thisMonth', label: 'This Month' },
  { id: 'lastMonth', label: 'Last Month' },
  { id: 'year', label: 'Last 365d' },
  { id: 'thisYear', label: 'This Year' },
  { id: 'lastYear', label: 'Last Year' },
  { id: 'all', label: 'All' },
  { id: 'custom', label: 'Custom' },
];

function PeriodPickerCompact({
  period,
  customStart,
  customEnd,
  disabled,
  onChange,
  onCustomChange,
}: {
  period: Period;
  customStart: string;
  customEnd: string;
  disabled: boolean;
  onChange: (p: Period) => void;
  onCustomChange: (s: string, e: string) => void;
}) {
  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: '3px 9px',
    fontSize: '10.5px',
    fontWeight: active ? 700 : 500,
    border: '1px solid var(--rn-clr-background-tertiary)',
    borderRadius: '4px',
    background: active ? '#3362f0' : 'var(--rn-clr-background-primary)',
    color: active ? 'white' : 'var(--rn-clr-content-primary)',
    cursor: disabled ? 'wait' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    whiteSpace: 'nowrap',
  });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '4px',
        marginBottom: '10px',
        padding: '8px 12px',
        borderRadius: '6px',
        background: 'var(--rn-clr-background-secondary)',
        border: '1px solid var(--rn-clr-background-tertiary)',
      }}
    >
      <span
        style={{
          fontSize: '10px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--rn-clr-content-tertiary)',
          marginRight: '4px',
        }}
      >
        Period
      </span>
      {PERIOD_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          disabled={disabled}
          onClick={() => onChange(p.id)}
          style={btnStyle(period === p.id)}
        >
          {p.label}
        </button>
      ))}
      {period === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '6px' }}>
          <input
            type="date"
            value={customStart}
            disabled={disabled}
            onChange={(e) => onCustomChange(e.target.value, customEnd)}
            style={{
              fontSize: '10.5px',
              padding: '2px 4px',
              border: '1px solid var(--rn-clr-background-tertiary)',
              borderRadius: '4px',
            }}
          />
          <span style={{ fontSize: '10.5px', color: 'var(--rn-clr-content-tertiary)' }}>→</span>
          <input
            type="date"
            value={customEnd}
            disabled={disabled}
            onChange={(e) => onCustomChange(customStart, e.target.value)}
            style={{
              fontSize: '10.5px',
              padding: '2px 4px',
              border: '1px solid var(--rn-clr-background-tertiary)',
              borderRadius: '4px',
            }}
          />
        </div>
      )}
    </div>
  );
}

function StatusBar({
  breakdown,
  ignorePreReset,
  onToggleIgnorePreReset,
  onRecompute,
  disabled,
}: {
  breakdown: CardAnalyticsBreakdown;
  ignorePreReset: boolean;
  onToggleIgnorePreReset: (next: boolean) => void;
  onRecompute: () => void;
  disabled: boolean;
}) {
  // Live-updating "X minutes ago" — re-render every 30s.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const ago = formatTimeAgo(breakdown.computedAt);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        marginBottom: '10px',
        padding: '8px 12px',
        borderRadius: '6px',
        background: 'var(--rn-clr-background-secondary)',
        border: '1px solid var(--rn-clr-background-tertiary)',
        fontSize: '11px',
      }}
    >
      <div style={{ color: 'var(--rn-clr-content-secondary)' }}>
        Computed <strong>{ago}</strong> over{' '}
        <strong>{breakdown.totalCards.toLocaleString()}</strong> cards.
        {breakdown.cardsSkippedNoPriority > 0 && (
          <span style={{ color: 'var(--rn-clr-content-tertiary)', marginLeft: '6px' }}>
            (skipped {breakdown.cardsSkippedNoPriority.toLocaleString()} without a known priority)
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            cursor: disabled ? 'wait' : 'pointer',
            opacity: disabled ? 0.6 : 1,
            color: 'var(--rn-clr-content-secondary)',
          }}
          title="Useful after importing documents with foreign repetition history: only count reps after the last RESET on each card."
        >
          <input
            type="checkbox"
            checked={ignorePreReset}
            disabled={disabled}
            onChange={(e) => onToggleIgnorePreReset(e.target.checked)}
            style={{ cursor: disabled ? 'wait' : 'pointer' }}
          />
          Ignore reps before last RESET
        </label>
        <button
          type="button"
          onClick={onRecompute}
          disabled={disabled}
          style={{
            padding: '4px 10px',
            fontSize: '11px',
            fontWeight: 600,
            borderRadius: '4px',
            border: '1px solid var(--rn-clr-background-tertiary)',
            background: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
            cursor: disabled ? 'wait' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          ↻ Recompute
        </button>
      </div>
    </div>
  );
}

function ProgressDisplay({ progress }: { progress: ProgressInfo }) {
  const pct = progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
  return (
    <div style={{ padding: '24px', textAlign: 'center' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px' }}>
        Replaying FSRS over every card…
      </div>
      <div
        style={{
          width: '100%',
          maxWidth: '420px',
          margin: '0 auto',
          height: '10px',
          borderRadius: '5px',
          background: 'var(--rn-clr-background-tertiary, #e5e7eb)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: '#3b82f6',
            transition: 'width 0.2s ease',
          }}
        />
      </div>
      <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
        {progress.done.toLocaleString()} / {progress.total.toLocaleString()} cards ({pct.toFixed(0)}%)
      </div>
    </div>
  );
}

// --- Main view -------------------------------------------------------------

export function CardMemoryAnalyticsView() {
  const plugin = usePlugin();

  const [state, setState] = React.useState<ComputeState>('idle');
  const [cache, setCache] = React.useState<CardAnalyticsBreakdown | null>(null);
  const [progress, setProgress] = React.useState<ProgressInfo>({ done: 0, total: 0 });
  const [error, setError] = React.useState<string | null>(null);
  // Default ignorePreReset → OFF (matches Study Dashboard).
  const [ignorePreReset, setIgnorePreReset] = React.useState<boolean>(false);
  // Period filter — same Period type used by the Study Dashboard. Default
  // 'thisYear' as requested. Custom dates are stored as raw "YYYY-MM-DD"
  // strings (the format <input type="date"> emits).
  const [period, setPeriod] = React.useState<Period>('thisYear');
  const [customStart, setCustomStart] = React.useState<string>('');
  const [customEnd, setCustomEnd] = React.useState<string>('');

  const compute = React.useCallback(
    async (flag: boolean, p: Period, cs: string, ce: string) => {
      setError(null);
      setState('computing');
      setProgress({ done: 0, total: 0 });
      try {
        const [infos, weightsRaw, capSec] = await Promise.all([
          plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey),
          plugin.settings.getSetting<string>(fsrsWeightsId),
          // Per-rep responseTime cap (seconds). Same setting the Study Dashboard
          // and Practiced Queues read so per-rep outliers don't dominate CPM.
          plugin.settings.getSetting<number>('flashcard_response_time_limit'),
        ]);
        const weights = parseWeightsString(weightsRaw);
        const cardCapMs = ((capSec ?? 180) as number) * 1000;
        const { startMs, endMs } = resolvePeriod(p, cs, ce);
        const breakdown = await computeCardAnalyticsBreakdown(
          plugin as any,
          infos ?? [],
          weights,
          cardCapMs,
          flag,
          { id: p, startMs, endMs, customStart: cs, customEnd: ce },
          (done, total) => setProgress({ done, total }),
        );
        await plugin.storage.setSession(cardAnalyticsCacheKey, breakdown);
        setCache(breakdown);
        setState('ready');
      } catch (e: any) {
        console.error('[CardMemoryAnalytics] compute failed', e);
        setError(e?.message || String(e));
        setState('idle');
      }
    },
    [plugin],
  );

  // Mount: prefer the session cache; fall back to auto-computing with the
  // default toggle value + default period. The cache stores its own
  // `ignorePreReset` and period so we sync the UI to whatever the cached data
  // was computed with.
  React.useEffect(() => {
    let cancelled = false;
    plugin.storage
      .getSession<CardAnalyticsBreakdown | null>(cardAnalyticsCacheKey)
      .then((c) => {
        if (cancelled) return;
        if (c && c.buckets && c.buckets.length === 10) {
          setCache(c);
          setIgnorePreReset(c.ignorePreReset ?? false);
          setPeriod(((c.period as Period) ?? 'thisYear'));
          setCustomStart(c.periodCustomStart ?? '');
          setCustomEnd(c.periodCustomEnd ?? '');
          setState('ready');
        } else {
          compute(false, 'thisYear', '', '');
        }
      })
      .catch(() => {
        if (!cancelled) compute(false, 'thisYear', '', '');
      });
    return () => {
      cancelled = true;
    };
  }, [plugin, compute]);

  const handleToggleIgnorePreReset = (next: boolean) => {
    setIgnorePreReset(next);
    compute(next, period, customStart, customEnd);
  };
  const handlePeriodChange = (p: Period) => {
    setPeriod(p);
    // For preset periods, ignore stale custom-date inputs.
    if (p !== 'custom') compute(ignorePreReset, p, customStart, customEnd);
  };
  const handleCustomChange = (s: string, e: string) => {
    setCustomStart(s);
    setCustomEnd(e);
    if (period === 'custom') compute(ignorePreReset, 'custom', s, e);
  };

  return (
    <div style={{ paddingTop: '4px' }}>
      {error && (
        <div
          style={{
            padding: '8px 12px',
            marginBottom: '10px',
            borderRadius: '6px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            fontSize: '12px',
          }}
        >
          Compute failed: {error}
        </div>
      )}

      <PeriodPickerCompact
        period={period}
        customStart={customStart}
        customEnd={customEnd}
        disabled={state === 'computing'}
        onChange={handlePeriodChange}
        onCustomChange={handleCustomChange}
      />
      {state === 'computing' && <ProgressDisplay progress={progress} />}
      {state === 'ready' && cache && (
        <>
          <StatusBar
            breakdown={cache}
            ignorePreReset={ignorePreReset}
            onToggleIgnorePreReset={handleToggleIgnorePreReset}
            onRecompute={() => compute(ignorePreReset, period, customStart, customEnd)}
            disabled={state !== 'ready'}
          />
          <AnalyticsTable breakdown={cache} />
          <div
            style={{
              marginTop: '10px',
              fontSize: '10.5px',
              color: 'var(--rn-clr-content-tertiary)',
              lineHeight: 1.5,
            }}
          >
            <strong>Reads:</strong> 10 priority-percentile buckets of cards (priority
            inherited from the owning Rem).{' '}
            <strong>Period-filtered</strong> (only reps in the chosen range):{' '}
            <em>Reps, Time, CPM, t/rep, Lapses, Retention, Avg pR, R-dev, Grade</em>. Each
            rep's <code>responseTime</code> is capped at the{' '}
            <code>flashcard_response_time_limit</code> setting — matches the Study Dashboard
            and Practiced Queues conventions.{' '}
            <strong>Always-current</strong> (KB state, unaffected by period):{' '}
            <em>Items, Due, Done, %New, %Stale, D, R, S</em>. <strong>Cost</strong> is
            lifetime per-card coverage when period = All; otherwise it's annualized as{' '}
            <em>time-in-period / period-length</em> averaged across cards with reps in the
            period. <strong>R-dev = Retention − Avg pR</strong> in percentage points:
            positive means you remember better than FSRS expected, negative means worse.{' '}
            <strong>Lapses</strong> are averaged only over non-new cards.
          </div>
        </>
      )}
    </div>
  );
}
