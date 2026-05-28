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
import {
  allCardPriorityInfoKey,
  cardAnalyticsCacheKey,
  cardAnalyticsLastPeriodKey,
  fsrsWeightsId,
} from '../lib/consts';
import { parseWeightsString } from '../lib/fsrs';
import { Period, resolvePeriod, parseDateInput, formatDateForDisplay } from '../lib/period';
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

// --- Column tooltips -------------------------------------------------------
//
// Native `title` attribute — rendered by the OS as a hover tooltip.
// Multi-line via "\n". Kept terse so hover doesn't take a paragraph to read.

const GROUP_TOOLTIPS = {
  identity:
    'Which priority-percentile bucket this row represents, plus the raw priority range of its cards.',
  population:
    'Always-current snapshot of the cards in this bucket. NOT affected by the period filter — these describe the KB right now.',
  throughput:
    'Period-filtered — what happened during the selected time range. responseTime per rep is capped at the flashcard_response_time_limit setting (same convention as the Study Dashboard / Practiced Queues).',
  outcome:
    'Period-filtered — quality of recall during the selected time range.',
  fsrsToday:
    'Current FSRS model state averaged across cards that have been reviewed at least once. Always reflects today, regardless of period filter.',
} as const;

const COL_TOOLTIPS = {
  bucket:
    'Priority-percentile bucket. Cards are sorted ascending by their owning Rem\'s priority and split into 10 deciles of equal size.',
  absPrio:
    'Min–max RAW priority values (0–100) found in this bucket. The bucket label is the percentile range; this column shows the underlying priority numbers.',
  items:
    'Number of CARDS in this bucket. Each Rem contributes one entry per card it owns; paused/disabled cards are included.',
  due:
    'Cards whose nextRepetitionTime is in the past — RemNote would schedule them now. Disabled cards (no nextRepetitionTime) are not counted as due.',
  done:
    '% of cards already processed (not due) = (cards − due) / cards.',
  pctNew:
    '% of cards that have never been graded (no Again/Hard/Good/Easy in their effective history). Always-current.',
  pctStale:
    '% of cards overdue by more than 2× their last scheduled interval — i.e., now > lastRepDate + 2 × (nextRepDate − lastRepDate). High values suggest the schedule has drifted past usefulness. Always-current.',
  reps:
    'Total gradeable reps (Again / Hard / Good / Easy) in the period. Avg per card in parentheses. Period-filtered.',
  time:
    'Total response time in the period — each rep capped at flashcard_response_time_limit so a single long pause doesn\'t dominate. Avg per card in parentheses. Period-filtered.',
  cpm:
    'Cards per minute = totalGradeableReps / (totalTime in minutes), computed at bucket level (not averaged from per-card averages). Period-filtered.',
  tPerRep:
    'Average response time per rep = totalTime / totalGradeableReps. Period-filtered.',
  cost:
    'Time investment per card per year (min/y).\nPeriod = All → per-card lifetime cost: totalMinutes / coverageYears (coverage = nextRep − firstRep, or now − firstRep), averaged.\nFinite period → annualized: time-in-period / period-length, averaged over cards that had reps in the period.',
  lapses:
    'Average count of Again responses per non-new card. New cards are excluded from the denominator so never-reviewed cards don\'t dilute the average. Period-filtered.',
  retention:
    'Observed pass rate at the bucket level = (gradeableReps − Again) / gradeableReps. Period-filtered. Same definition as the Study Dashboard / Practiced Queues.',
  avgPR:
    'Average FSRS-predicted retrievability across every gradeable rep in the period, EXCEPT the first rep of each card / each post-RESET lifetime (the model has no prior state to predict from).\nFor learning/relearning reps where FSRS leaves r undefined, the forgetting curve is computed locally using the previous gradeable rep\'s stability — so Avg pR\'s denominator matches Retention\'s.',
  rDev:
    'Retention − Avg pR (percentage points).\nPositive: you remember better than FSRS expected (schedule could be relaxed).\nNegative: you forget more than predicted (schedule may be stale, or grading has been too generous).',
  grade:
    'Average grade across gradeable reps in the period: 1=Again, 2=Hard, 3=Good, 4=Easy.',
  d:
    'Current FSRS Difficulty (1–10), averaged across cards reviewed at least once. Lower = card behaves easier for you. Always-current.',
  r:
    'Current FSRS Retrievability AS OF NOW, averaged across reviewed cards. Decays as time since the last review grows; a high R means you\'re currently very likely to recall the card. Always-current.',
  s:
    'Current FSRS Stability in days, averaged across reviewed cards. Roughly: how long until R drops to ~90%. Higher = more durable memory. Always-current.',
} as const;

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
  cursor: 'help',
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
  cursor: 'help',
};

function BucketRow({
  b,
  isOverall,
  idx,
  isSubset,
}: {
  b: CardBucketStats;
  isOverall: boolean;
  idx: number;
  isSubset?: boolean;
}) {
  const dim = !isOverall && !isSubset && b.cards === 0 ? 0.3 : 1;
  const baseBg = isSubset
    // Subset (threshold-driven) row — distinct tint so it doesn't look like a bucket.
    ? 'rgba(59, 130, 246, 0.08)'
    : isOverall
      ? 'var(--rn-clr-background-tertiary)'
      : idx % 2 === 0
        ? 'transparent'
        : 'var(--rn-clr-background-secondary)';

  const trStyle: React.CSSProperties = {
    background: baseBg,
    opacity: dim,
    borderTop:
      isOverall || isSubset ? '2px solid var(--rn-clr-background-tertiary)' : 'none',
    borderBottom: '1px solid var(--rn-clr-background-tertiary)',
    fontWeight: isOverall || isSubset ? 700 : 400,
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
      <td style={{ ...cellStyle, textAlign: 'left', fontWeight: isOverall || isSubset ? 700 : 500 }}>
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
      <td style={cellStyle}>
        {fmtNum(b.avgCostMinPerYear, 1)}
        <span style={{ color: 'var(--rn-clr-content-tertiary)', marginLeft: '2px' }}>min/y</span>
      </td>
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
      <td style={cellStyle}>{fmtNum(b.avgD, 1)}</td>
      <td style={{ ...cellStyle, color: retentionColor(b.avgRtoday), fontWeight: 600 }}>
        {fmtPct(b.avgRtoday, 1)}
      </td>
      <td style={cellStyle}>{fmtStabilityDays(b.avgS)}</td>
    </tr>
  );
}

function AnalyticsTable({ breakdown }: { breakdown: CardAnalyticsBreakdown }) {
  // Threshold slider — drives the "Priority ≤ T" subset row at the bottom of
  // the table. Lookup into the pre-finalized prefix table is O(1), so dragging
  // is smooth without any recomputation.
  const hasPrefix = Array.isArray(breakdown.byPriorityPrefix)
    && breakdown.byPriorityPrefix.length === 101;
  const [threshold, setThreshold] = React.useState<number>(100);
  const subsetRow: CardBucketStats | null = hasPrefix
    ? { ...breakdown.byPriorityPrefix[threshold], label: `Priority ≤ ${threshold}` }
    : null;

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
            <th style={groupHeaderStyle} colSpan={2} title={GROUP_TOOLTIPS.identity}>
              Identity
            </th>
            <th style={groupHeaderStyle} colSpan={5} title={GROUP_TOOLTIPS.population}>
              Population
            </th>
            <th style={groupHeaderStyle} colSpan={5} title={GROUP_TOOLTIPS.throughput}>
              Throughput
            </th>
            <th style={groupHeaderStyle} colSpan={6} title={GROUP_TOOLTIPS.outcome}>
              Outcome
            </th>
            <th style={groupHeaderStyle} colSpan={3} title={GROUP_TOOLTIPS.fsrsToday}>
              FSRS today
            </th>
          </tr>
          {/* Column header row */}
          <tr style={{ borderBottom: '2px solid var(--rn-clr-background-tertiary)' }}>
            <th style={{ ...headerCellStyle, textAlign: 'left' }} title={COL_TOOLTIPS.bucket}>Bucket</th>
            <th style={{ ...headerCellStyle, textAlign: 'center' }} title={COL_TOOLTIPS.absPrio}>
              Abs.Prio
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.items}>
              Items
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.due}>
              Due
            </th>
            <th style={{ ...headerCellStyle, textAlign: 'center' }} title={COL_TOOLTIPS.done}>
              Done
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.pctNew}>
              %New
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.pctStale}>
              %Stale
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.reps}>
              Reps
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.time}>
              Time
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.cpm}>
              CPM
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.tPerRep}>
              t/rep
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.cost}>
              Cost
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.lapses}>
              Lapses
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.retention}>
              Retention
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.avgPR}>
              Avg pR
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.rDev}>
              R-dev
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.grade}>
              Grade
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.d}>
              D
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.r}>
              R
            </th>
            <th style={headerCellStyle} title={COL_TOOLTIPS.s}>
              S
            </th>
          </tr>
        </thead>
        <tbody>
          {breakdown.buckets.map((b, i) => (
            <BucketRow key={i} b={b} isOverall={false} idx={i} />
          ))}
          <BucketRow b={breakdown.overall} isOverall={true} idx={-1} />
          {hasPrefix && subsetRow && (
            <>
              <tr style={{ background: 'var(--rn-clr-background-secondary)' }}>
                <td colSpan={20} style={{ padding: '8px 10px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      fontSize: '11px',
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: 'var(--rn-clr-content-secondary)',
                        whiteSpace: 'nowrap',
                      }}
                      title="Recomputes the bottom row over every card whose owning Rem priority is ≤ this threshold. All current filters (period, ignore reps before last RESET) apply."
                    >
                      Threshold (Abs.Priority ≤)
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={threshold}
                      onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
                      style={{ flex: 1, accentColor: '#3b82f6' }}
                      aria-label="Absolute priority threshold"
                    />
                    <span
                      style={{
                        fontFamily: 'monospace',
                        fontWeight: 700,
                        minWidth: '44px',
                        textAlign: 'right',
                        color: 'var(--rn-clr-content-primary)',
                      }}
                    >
                      {threshold}
                    </span>
                    {/* Relative percentile of the chosen threshold within the
                        per-card universe — same metric as the WeightedShield
                        popup's "Rel %ile". Reflects the share of cards whose
                        owning Rem priority is ≤ T. */}
                    {(() => {
                      const total = breakdown.overall?.cards ?? 0;
                      const relPctile = total > 0 ? (subsetRow.cards / total) * 100 : 0;
                      return (
                        <span
                          title="Share of cards in the universe whose owning Rem priority is ≤ the threshold"
                          style={{
                            fontSize: '10.5px',
                            color: 'var(--rn-clr-content-secondary)',
                            whiteSpace: 'nowrap',
                            paddingLeft: '6px',
                            borderLeft: '1px solid var(--rn-clr-background-tertiary)',
                          }}
                        >
                          <span
                            style={{
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                              fontWeight: 700,
                              color: 'var(--rn-clr-content-tertiary)',
                              marginRight: '4px',
                            }}
                          >
                            Rel %ile
                          </span>
                          <span style={{ fontWeight: 700, color: 'var(--rn-clr-content-primary)' }}>
                            {relPctile.toFixed(1)}%
                          </span>
                        </span>
                      );
                    })()}
                  </div>
                </td>
              </tr>
              <BucketRow b={subsetRow} isOverall={false} idx={-1} isSubset={true} />
            </>
          )}
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
  { id: 'since', label: 'Since…' },
  { id: 'custom', label: 'Custom' },
];

// --- Custom date text inputs (flexible parsing, commit on blur/Enter) ------

const dateInputStyle: React.CSSProperties = {
  fontSize: '10.5px',
  padding: '2px 4px',
  border: '1px solid var(--rn-clr-background-tertiary)',
  borderRadius: '4px',
  width: '88px',
  background: 'var(--rn-clr-background-primary)',
  color: 'var(--rn-clr-content-primary)',
};

function CustomDateInputs({
  customStart,
  customEnd,
  disabled,
  onCustomChange,
}: {
  customStart: string;
  customEnd: string;
  disabled: boolean;
  onCustomChange: (s: string, e: string) => void;
}) {
  // Local draft state — allows free typing without triggering recomputation.
  const [draftStart, setDraftStart] = React.useState(formatDateForDisplay(customStart));
  const [draftEnd, setDraftEnd] = React.useState(formatDateForDisplay(customEnd));

  // Sync drafts when the canonical values change externally (e.g. period preset selected).
  React.useEffect(() => {
    setDraftStart(formatDateForDisplay(customStart));
  }, [customStart]);
  React.useEffect(() => {
    setDraftEnd(formatDateForDisplay(customEnd));
  }, [customEnd]);

  const commitStart = () => {
    const parsed = parseDateInput(draftStart);
    if (parsed) {
      setDraftStart(formatDateForDisplay(parsed));
      if (parsed !== customStart) onCustomChange(parsed, customEnd);
    } else if (draftStart === '') {
      if (customStart !== '') onCustomChange('', customEnd);
    } else {
      // Invalid — revert to last good value
      setDraftStart(formatDateForDisplay(customStart));
    }
  };

  const commitEnd = () => {
    const parsed = parseDateInput(draftEnd);
    if (parsed) {
      setDraftEnd(formatDateForDisplay(parsed));
      if (parsed !== customEnd) onCustomChange(customStart, parsed);
    } else if (draftEnd === '') {
      if (customEnd !== '') onCustomChange(customStart, '');
    } else {
      setDraftEnd(formatDateForDisplay(customEnd));
    }
  };

  const isStartInvalid = draftStart !== '' && !parseDateInput(draftStart);
  const isEndInvalid = draftEnd !== '' && !parseDateInput(draftEnd);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '6px' }}>
      <input
        type="text"
        placeholder="DD/MM/YYYY"
        value={draftStart}
        disabled={disabled}
        onChange={(e) => setDraftStart(e.target.value)}
        onBlur={commitStart}
        onKeyDown={(e) => { if (e.key === 'Enter') commitStart(); }}
        style={{
          ...dateInputStyle,
          borderColor: isStartInvalid ? '#ef4444' : undefined,
        }}
      />
      <input
        type="date"
        className="date-picker-icon-only"
        value={customStart}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          setDraftStart(formatDateForDisplay(v));
          onCustomChange(v, customEnd);
        }}
        title="Pick from calendar"
        tabIndex={-1}
      />
      <span style={{ fontSize: '10.5px', color: 'var(--rn-clr-content-tertiary)' }}>→</span>
      <input
        type="text"
        placeholder="DD/MM/YYYY"
        value={draftEnd}
        disabled={disabled}
        onChange={(e) => setDraftEnd(e.target.value)}
        onBlur={commitEnd}
        onKeyDown={(e) => { if (e.key === 'Enter') commitEnd(); }}
        style={{
          ...dateInputStyle,
          borderColor: isEndInvalid ? '#ef4444' : undefined,
        }}
      />
      <input
        type="date"
        className="date-picker-icon-only"
        value={customEnd}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          setDraftEnd(formatDateForDisplay(v));
          onCustomChange(customStart, v);
        }}
        title="Pick from calendar"
        tabIndex={-1}
      />
    </div>
  );
}

// Single-date variant for the 'since' period — only a start date matters;
// end is implicitly "now". Reuses customStart as the source of truth.
function SinceDateInput({
  customStart,
  disabled,
  onCustomChange,
  customEnd,
}: {
  customStart: string;
  customEnd: string;
  disabled: boolean;
  onCustomChange: (s: string, e: string) => void;
}) {
  const [draft, setDraft] = React.useState(formatDateForDisplay(customStart));
  React.useEffect(() => {
    setDraft(formatDateForDisplay(customStart));
  }, [customStart]);

  const commit = () => {
    const parsed = parseDateInput(draft);
    if (parsed) {
      setDraft(formatDateForDisplay(parsed));
      if (parsed !== customStart) onCustomChange(parsed, customEnd);
    } else if (draft === '') {
      if (customStart !== '') onCustomChange('', customEnd);
    } else {
      setDraft(formatDateForDisplay(customStart));
    }
  };

  const isInvalid = draft !== '' && !parseDateInput(draft);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '6px' }}>
      <span style={{ fontSize: '10.5px', color: 'var(--rn-clr-content-tertiary)' }}>From</span>
      <input
        type="text"
        placeholder="DD/MM/YYYY"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        style={{
          ...dateInputStyle,
          borderColor: isInvalid ? '#ef4444' : undefined,
        }}
      />
      <input
        type="date"
        className="date-picker-icon-only"
        value={customStart}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(formatDateForDisplay(v));
          onCustomChange(v, customEnd);
        }}
        title="Pick from calendar"
        tabIndex={-1}
      />
      <span style={{ fontSize: '10.5px', color: 'var(--rn-clr-content-tertiary)' }}>→ now</span>
    </div>
  );
}

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
        <CustomDateInputs
          customStart={customStart}
          customEnd={customEnd}
          disabled={disabled}
          onCustomChange={onCustomChange}
        />
      )}
      {period === 'since' && (
        <SinceDateInput
          customStart={customStart}
          customEnd={customEnd}
          disabled={disabled}
          onCustomChange={onCustomChange}
        />
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
        // Persist user prefs (period + ignorePreReset) across app restarts
        // (device-local). Stored independently from the session cache so it
        // survives full RemNote restarts when the in-memory cache is gone.
        plugin.storage
          .setLocal(cardAnalyticsLastPeriodKey, {
            period: p,
            customStart: cs,
            customEnd: ce,
            ignorePreReset: flag,
          })
          .catch(() => {});
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

  // Mount: prefer the in-memory session cache (instant). If absent, fall back
  // to the last-selected period saved in device-local storage so that re-opens
  // after a full RemNote restart still remember the user's choice. If neither
  // source is available, default to 'thisYear'.
  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      plugin.storage.getSession<CardAnalyticsBreakdown | null>(cardAnalyticsCacheKey),
      plugin.storage.getLocal<{
        period?: Period;
        customStart?: string;
        customEnd?: string;
        ignorePreReset?: boolean;
      } | null>(cardAnalyticsLastPeriodKey),
    ])
      .then(([c, saved]) => {
        if (cancelled) return;
        if (c && c.buckets && c.buckets.length === 10) {
          setCache(c);
          setIgnorePreReset(c.ignorePreReset ?? false);
          setPeriod(((c.period as Period) ?? 'thisYear'));
          setCustomStart(c.periodCustomStart ?? '');
          setCustomEnd(c.periodCustomEnd ?? '');
          setState('ready');
          return;
        }
        // No session cache — restore last-selected prefs from local storage.
        const p = (saved?.period ?? 'thisYear') as Period;
        const cs = saved?.customStart ?? '';
        const ce = saved?.customEnd ?? '';
        const flag = saved?.ignorePreReset ?? false;
        setPeriod(p);
        setCustomStart(cs);
        setCustomEnd(ce);
        setIgnorePreReset(flag);
        // 'custom' / 'since' without a usable start date can't compute — skip
        // the auto-compute and wait for the user to type / pick one.
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
    // For 'custom' and 'since', the start date drives the filter — only
    // recompute once it's been provided. Other presets are self-contained.
    if (p === 'custom') return;
    if (p === 'since' && !customStart) return;
    compute(ignorePreReset, p, customStart, customEnd);
  };
  const handleCustomChange = (s: string, e: string) => {
    setCustomStart(s);
    setCustomEnd(e);
    // Both 'custom' and 'since' use customStart, so either should recompute
    // when their relevant date(s) are populated.
    if (period === 'custom') {
      compute(ignorePreReset, 'custom', s, e);
    } else if (period === 'since' && s) {
      compute(ignorePreReset, 'since', s, e);
    }
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
            expressed in <em>minutes per year (min/y)</em>: lifetime per-card coverage when
            period = All; otherwise annualized as <em>time-in-period / period-length</em>{' '}
            averaged across cards with reps in the period. <strong>Avg pR</strong> averages the FSRS-predicted retrievability at the moment
            of every gradeable rep (skipping only the first rep of each card / each
            post-RESET lifetime, which has no prior model state). For learning and
            relearning reps — where FSRS leaves <em>r</em> undefined — the forgetting
            curve is computed from the previous gradeable rep's stability so that Avg pR
            and Retention share the same denominator.{' '}
            <strong>R-dev = Retention − Avg pR</strong> in percentage points:
            positive means you remember better than FSRS expected, negative means worse.{' '}
            <strong>Lapses</strong> are averaged only over non-new cards.
          </div>
        </>
      )}
    </div>
  );
}
