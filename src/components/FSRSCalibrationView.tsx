/**
 * FSRS Calibration — third tab in the wsh popup.
 *
 * Two grids of observed retention vs FSRS-predicted retrievability:
 *   A) predicted R (5pp rows) × prior stability (5 day buckets)
 *   B) previous gradeable rep's grade × stability before that grade
 *
 * No session cache — recomputes from scratch on every period change. Heavy
 * lifting is the per-card FSRS replay (CPU only, no further async).
 */

import { usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  CellStats,
  FSRSCalibrationBreakdown,
  GRADE_ROW_LABELS,
  R_BUCKET_COUNT,
  S_BUCKET_LABELS,
  computeFSRSCalibrationBreakdown,
  rBucketLabel,
} from '../lib/fsrs_calibration';
import { fsrsCalibrationLastPeriodKey, fsrsWeightsId } from '../lib/consts';
import { parseWeightsString } from '../lib/fsrs';
import { Period, resolvePeriod } from '../lib/period';
import { PeriodPickerCompact } from './CardMemoryAnalyticsView';

// --- Formatting ----------------------------------------------------------

function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
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

// --- Color helpers -------------------------------------------------------

function retentionColor(r: number): string {
  if (!Number.isFinite(r)) return 'var(--rn-clr-content-tertiary)';
  if (r >= 90) return '#22c55e';
  if (r >= 80) return '#84cc16';
  if (r >= 70) return '#eab308';
  if (r >= 60) return '#f97316';
  return '#ef4444';
}

function rDevColor(pp: number): string {
  if (!Number.isFinite(pp)) return 'var(--rn-clr-content-tertiary)';
  const abs = Math.abs(pp);
  if (abs < 3) return 'var(--rn-clr-content-primary)';
  if (abs < 7) return '#eab308';
  // Negative = forgetting more than predicted (FSRS over-predicts) → red.
  // Positive = remembering better than predicted → blue.
  return pp < 0 ? '#ef4444' : '#3b82f6';
}

// --- Cell --------------------------------------------------------------

const cellTdStyle: React.CSSProperties = {
  padding: '4px 5px',
  fontSize: '10.5px',
  lineHeight: 1.25,
  whiteSpace: 'nowrap',
  textAlign: 'right',
  verticalAlign: 'middle',
  borderRight: '1px solid var(--rn-clr-background-tertiary)',
};

const headerThStyle: React.CSSProperties = {
  padding: '5px 6px',
  fontSize: '9.5px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--rn-clr-content-tertiary)',
  textAlign: 'center',
  whiteSpace: 'nowrap',
  background: 'var(--rn-clr-background-secondary)',
  borderBottom: '1px solid var(--rn-clr-background-tertiary)',
  borderRight: '1px solid var(--rn-clr-background-tertiary)',
};

const rowHeaderTdStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: '10.5px',
  fontWeight: 600,
  textAlign: 'left',
  whiteSpace: 'nowrap',
  background: 'var(--rn-clr-background-secondary)',
  borderRight: '1px solid var(--rn-clr-background-tertiary)',
  color: 'var(--rn-clr-content-secondary)',
};

function Cell({ c, emphasize }: { c: CellStats; emphasize?: boolean }) {
  if (c.reps === 0) {
    return (
      <td style={{ ...cellTdStyle, color: 'var(--rn-clr-content-tertiary)' }}>—</td>
    );
  }
  const tooltip = `n=${c.reps}\nRetention: ${fmtPct(c.retention, 2)}\nAvg pR: ${fmtPct(c.avgPredR, 2)}\nR-dev: ${fmtPP(c.rDevPP, 2)}`;
  return (
    <td
      style={{
        ...cellTdStyle,
        background: emphasize ? 'var(--rn-clr-background-secondary)' : undefined,
        fontWeight: emphasize ? 700 : 400,
      }}
      title={tooltip}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '1px' }}>
        <div style={{ fontSize: '9px', color: 'var(--rn-clr-content-tertiary)' }}>
          n={fmtInt(c.reps)}
        </div>
        <div style={{ color: retentionColor(c.retention), fontWeight: 700 }}>
          {fmtPct(c.retention, 1)}
        </div>
        <div style={{ fontSize: '9px', color: 'var(--rn-clr-content-tertiary)' }}>
          pR {c.avgPredR.toFixed(1)}
        </div>
        <div style={{ color: rDevColor(c.rDevPP), fontWeight: 600, fontSize: '9.5px' }}>
          {fmtPP(c.rDevPP, 1)}
        </div>
      </div>
    </td>
  );
}

// --- Grid table ---------------------------------------------------------

function GridTable({
  title,
  blurb,
  rowHeader,
  rowLabels,
  colHeader,
  colLabels,
  cells,
  rowTotals,
  colTotals,
  overall,
}: {
  title: string;
  blurb: React.ReactNode;
  rowHeader: string;
  rowLabels: string[];
  colHeader: string;
  colLabels: string[];
  cells: CellStats[][];
  rowTotals: CellStats[];
  colTotals: CellStats[];
  overall: CellStats;
}) {
  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '4px' }}>{title}</div>
      <div
        style={{
          fontSize: '10.5px',
          color: 'var(--rn-clr-content-tertiary)',
          marginBottom: '8px',
          lineHeight: 1.5,
        }}
      >
        {blurb}
      </div>
      <div
        style={{
          overflowX: 'auto',
          borderRadius: '6px',
          border: '1px solid var(--rn-clr-background-tertiary)',
        }}
      >
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th
                style={{
                  ...headerThStyle,
                  textAlign: 'left',
                  background: 'var(--rn-clr-background-tertiary)',
                }}
                title={`Rows: ${rowHeader}  /  Columns: ${colHeader}`}
              >
                {rowHeader} ↓ / {colHeader} →
              </th>
              {colLabels.map((l) => (
                <th key={l} style={headerThStyle}>
                  {l}
                </th>
              ))}
              <th
                style={{
                  ...headerThStyle,
                  background: 'var(--rn-clr-background-tertiary)',
                }}
              >
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {cells.map((row, r) => (
              <tr
                key={r}
                style={{
                  borderBottom: '1px solid var(--rn-clr-background-tertiary)',
                  background: r % 2 === 0 ? 'transparent' : 'var(--rn-clr-background-secondary)',
                }}
              >
                <td style={rowHeaderTdStyle}>{rowLabels[r]}</td>
                {row.map((c, ci) => (
                  <Cell key={ci} c={c} />
                ))}
                <Cell c={rowTotals[r]} emphasize />
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid var(--rn-clr-background-tertiary)' }}>
              <td style={{ ...rowHeaderTdStyle, fontWeight: 700, color: 'var(--rn-clr-content-primary)' }}>
                Total
              </td>
              {colTotals.map((c, ci) => (
                <Cell key={ci} c={c} emphasize />
              ))}
              <Cell c={overall} emphasize />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Status bar (period info + recompute + ignorePreReset) ---------------

function StatusBar({
  breakdown,
  ignorePreReset,
  onToggleIgnorePreReset,
  onRecompute,
  disabled,
}: {
  breakdown: FSRSCalibrationBreakdown;
  ignorePreReset: boolean;
  onToggleIgnorePreReset: (next: boolean) => void;
  onRecompute: () => void;
  disabled: boolean;
}) {
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
        Replayed FSRS over <strong>{breakdown.totalCards.toLocaleString()}</strong> cards.
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

function ProgressDisplay({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? (done / total) * 100 : 0;
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
        {done.toLocaleString()} / {total.toLocaleString()} cards ({pct.toFixed(0)}%)
      </div>
    </div>
  );
}

// --- Main view ----------------------------------------------------------

type ComputeState = 'idle' | 'computing' | 'ready';

export function FSRSCalibrationView() {
  const plugin = usePlugin();

  const [state, setState] = React.useState<ComputeState>('idle');
  const [data, setData] = React.useState<FSRSCalibrationBreakdown | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [error, setError] = React.useState<string | null>(null);
  const [ignorePreReset, setIgnorePreReset] = React.useState<boolean>(false);
  const [period, setPeriod] = React.useState<Period>('thisYear');
  const [customStart, setCustomStart] = React.useState<string>('');
  const [customEnd, setCustomEnd] = React.useState<string>('');

  const compute = React.useCallback(
    async (flag: boolean, p: Period, cs: string, ce: string) => {
      setError(null);
      setState('computing');
      setProgress({ done: 0, total: 0 });
      try {
        const weightsRaw = await plugin.settings.getSetting<string>(fsrsWeightsId);
        const weights = parseWeightsString(weightsRaw);
        const { startMs, endMs } = resolvePeriod(p, cs, ce);
        const breakdown = await computeFSRSCalibrationBreakdown(
          plugin as any,
          weights,
          flag,
          { id: p, startMs, endMs, customStart: cs, customEnd: ce },
          (done, total) => setProgress({ done, total }),
        );
        plugin.storage
          .setLocal(fsrsCalibrationLastPeriodKey, {
            period: p,
            customStart: cs,
            customEnd: ce,
            ignorePreReset: flag,
          })
          .catch(() => {});
        setData(breakdown);
        setState('ready');
      } catch (e: any) {
        console.error('[FSRSCalibration] compute failed', e);
        setError(e?.message || String(e));
        setState('idle');
      }
    },
    [plugin],
  );

  React.useEffect(() => {
    let cancelled = false;
    plugin.storage
      .getLocal<{
        period?: Period;
        customStart?: string;
        customEnd?: string;
        ignorePreReset?: boolean;
      } | null>(fsrsCalibrationLastPeriodKey)
      .then((saved) => {
        if (cancelled) return;
        const p = (saved?.period ?? 'thisYear') as Period;
        const cs = saved?.customStart ?? '';
        const ce = saved?.customEnd ?? '';
        const flag = saved?.ignorePreReset ?? false;
        setPeriod(p);
        setCustomStart(cs);
        setCustomEnd(ce);
        setIgnorePreReset(flag);
        const hasUsableStart = !!cs;
        if ((p === 'custom' || p === 'since') && !hasUsableStart) {
          setState('idle');
        } else {
          compute(flag, p, cs, ce);
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
    if (p === 'custom') return;
    if (p === 'since' && !customStart) return;
    compute(ignorePreReset, p, customStart, customEnd);
  };
  const handleCustomChange = (s: string, e: string) => {
    setCustomStart(s);
    setCustomEnd(e);
    if (period === 'custom') {
      compute(ignorePreReset, 'custom', s, e);
    } else if (period === 'since' && s) {
      compute(ignorePreReset, 'since', s, e);
    }
  };

  const rRowLabels = React.useMemo(
    () => Array.from({ length: R_BUCKET_COUNT }, (_, i) => rBucketLabel(i)),
    [],
  );

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

      {state === 'computing' && <ProgressDisplay done={progress.done} total={progress.total} />}

      {state === 'ready' && data && (
        <>
          <StatusBar
            breakdown={data}
            ignorePreReset={ignorePreReset}
            onToggleIgnorePreReset={handleToggleIgnorePreReset}
            onRecompute={() => compute(ignorePreReset, period, customStart, customEnd)}
            disabled={state !== 'ready'}
          />

          <GridTable
            title="A · Predicted retrievability × Prior stability"
            blurb={
              <>
                Every gradeable rep in the period (skipping the first rep of each post-RESET
                lifetime) is placed into a cell by its FSRS-predicted retrievability at the
                moment of the rep (rows, 5pp each) and the stability set by the previous
                gradeable rep (columns). Each cell shows <em>n</em> reps, observed{' '}
                <strong>Retention</strong>, average <strong>pR</strong>, and{' '}
                <strong>R-dev = Retention − pR</strong> in percentage points. Negative R-dev
                (red) means FSRS over-predicted; positive (blue) means you recall better than
                expected.
              </>
            }
            rowHeader="Predicted R"
            rowLabels={rRowLabels}
            colHeader="Prior stability"
            colLabels={S_BUCKET_LABELS}
            cells={data.gridA}
            rowTotals={data.gridARowTotals}
            colTotals={data.gridAColTotals}
            overall={data.gridAOverall}
          />

          <GridTable
            title="B · Previous grade × Stability before that grade"
            blurb={
              <>
                Every gradeable rep with at least two prior gradeable reps in its lifetime is
                placed by the <em>previous</em> rep's grade (rows) and the stability that
                existed <em>before that previous grading</em> (columns) — i.e. the stability
                FSRS was acting on when the previous Hard/Good/Easy/Again was applied. Same
                cell metrics as Grid A. Use this to ask: does my Hard/Easy actually move the
                next outcome the way FSRS predicts?
              </>
            }
            rowHeader="Previous grade"
            rowLabels={GRADE_ROW_LABELS}
            colHeader="Stability before prev. grade"
            colLabels={S_BUCKET_LABELS}
            cells={data.gridB}
            rowTotals={data.gridBRowTotals}
            colTotals={data.gridBColTotals}
            overall={data.gridBOverall}
          />
        </>
      )}
    </div>
  );
}
