/**
 * Grid D — initial stability (w0–w3) calibration.
 *
 * Renders `S0Breakdown`: a summary of what fsrs-optimizer's parameter-
 * initialisation pass would derive for w0–w3 from this collection, how that
 * compares to the weights currently in use, and — the part the optimizer never
 * shows you — whether the data can pin those numbers down at all.
 */

import React from 'react';
import {
  S0Breakdown,
  S0BucketStats,
  S0GradeStats,
  S0Verdict,
} from '../lib/fsrs_initial_stability';

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

/** Stability in days, with a precision that stays readable across 0.1 → 3650. */
function fmtS(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

// --- Colors --------------------------------------------------------------

function rDevColor(pp: number): string {
  if (!Number.isFinite(pp)) return 'var(--rn-clr-content-tertiary)';
  const abs = Math.abs(pp);
  if (abs < 3) return 'var(--rn-clr-content-primary)';
  if (abs < 7) return '#eab308';
  return pp < 0 ? '#ef4444' : '#3b82f6';
}

function ratioColor(r: number): string {
  if (!Number.isFinite(r)) return 'var(--rn-clr-content-tertiary)';
  if (r >= 0.8 && r <= 1.25) return 'var(--rn-clr-content-primary)';
  if (r >= 0.5 && r <= 2) return '#eab308';
  return r > 1 ? '#3b82f6' : '#ef4444';
}

const VERDICT_META: Record<S0Verdict, { label: string; color: string; title: string }> = {
  'no-data': {
    label: 'no data',
    color: '#9ca3af',
    title: 'No first-exposure reps for this grade in the selected period.',
  },
  thin: {
    label: 'thin data',
    color: '#eab308',
    title:
      'Under 200 first-exposure reps. The optimizer caps its solver iterations at the rep count, so with data this thin it barely moves off the FSRS default — and neither should you.',
  },
  unidentified: {
    label: 'unidentified',
    color: '#a855f7',
    title:
      'The likelihood keeps improving all the way to the upper bound: your reviews never ran long enough to see this grade forget. The fitted value is a floor, not an estimate.',
  },
  extrapolating: {
    label: 'extrapolating',
    color: '#f97316',
    title:
      'Fewer than 5% of reps were observed at or beyond the fitted stability, so the curve is being extended past the data that constrains it.',
  },
  calibrated: {
    label: 'calibrated',
    color: '#22c55e',
    title: 'The refit lands within 25% of the weight currently in use.',
  },
  understated: {
    label: 'S₀ too low',
    color: '#3b82f6',
    title:
      'Your data says this grade earns a substantially longer first interval than the current weight gives it — FSRS is under-stating initial stability.',
  },
  overstated: {
    label: 'S₀ too high',
    color: '#ef4444',
    title:
      'Your data says this grade earns a substantially shorter first interval than the current weight gives it — FSRS is over-stating initial stability.',
  },
};

// --- Shared cell styles --------------------------------------------------

const thStyle: React.CSSProperties = {
  padding: '5px 6px',
  fontSize: '9.5px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--rn-clr-content-tertiary)',
  textAlign: 'right',
  whiteSpace: 'nowrap',
  background: 'var(--rn-clr-background-secondary)',
  borderBottom: '1px solid var(--rn-clr-background-tertiary)',
  borderRight: '1px solid var(--rn-clr-background-tertiary)',
};

const tdStyle: React.CSSProperties = {
  padding: '4px 6px',
  fontSize: '10.5px',
  lineHeight: 1.3,
  whiteSpace: 'nowrap',
  textAlign: 'right',
  verticalAlign: 'middle',
  borderRight: '1px solid var(--rn-clr-background-tertiary)',
};

const rowHeadStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: 'left',
  fontWeight: 700,
  background: 'var(--rn-clr-background-secondary)',
  color: 'var(--rn-clr-content-secondary)',
};

const tableWrapStyle: React.CSSProperties = {
  overflowX: 'auto',
  borderRadius: '6px',
  border: '1px solid var(--rn-clr-background-tertiary)',
};

function VerdictBadge({ v }: { v: S0Verdict }) {
  const m = VERDICT_META[v];
  return (
    <span
      title={m.title}
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: '999px',
        fontSize: '9px',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
        color: '#fff',
        background: m.color,
        cursor: 'help',
      }}
    >
      {m.label}
    </span>
  );
}

// --- Summary table -------------------------------------------------------

function SummaryTable({ data }: { data: S0Breakdown }) {
  return (
    <div style={tableWrapStyle}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left', background: 'var(--rn-clr-background-tertiary)' }}>
              First grade
            </th>
            <th style={thStyle} title="First-exposure reps: the first review on a later day than the first grade.">
              Reps
            </th>
            <th style={thStyle} title="The w0–w3 value currently in use (floored at 0.1, as FSRS does).">
              Current w
            </th>
            <th style={thStyle} title="FSRS v6 stock default for this grade.">
              Default
            </th>
            <th
              style={thStyle}
              title="What fsrs-optimizer's initialisation pass would derive from your data: outlier-filtered, Laplace-smoothed, L1-shrunk toward the default, clamped to 100 days."
            >
              Refit S₀
            </th>
            <th
              style={thStyle}
              title="Unregularised maximum likelihood with a 3650-day bound, and the 95% profile-likelihood interval. This is what the data alone supports; a bound-to-bound interval means it supports almost nothing."
            >
              MLE [95% CI]
            </th>
            <th
              style={thStyle}
              title="Same MLE without the optimizer's outlier removal. A big gap from the MLE column means the answer is an artefact of that truncation step."
            >
              Unfiltered
            </th>
            <th style={thStyle} title="Refit S₀ ÷ current w. Above 1 = your first intervals are shorter than the data warrants.">
              Ratio
            </th>
            <th
              style={thStyle}
              title="Share of reps actually observed at or beyond the fitted stability. Below ~5% the fit is extrapolating past its evidence."
            >
              Coverage
            </th>
            <th style={thStyle}>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {data.grades.map((g) => (
            <tr
              key={g.grade}
              style={{
                borderBottom: '1px solid var(--rn-clr-background-tertiary)',
                background: g.grade % 2 === 0 ? 'transparent' : 'var(--rn-clr-background-secondary)',
              }}
            >
              <td style={rowHeadStyle}>{g.label}</td>
              <td
                style={tdStyle}
                title={
                  g.droppedReps > 0
                    ? `${fmtInt(g.reps)} first-exposure reps, ${fmtInt(g.droppedReps)} of them discarded by the outlier filter before fitting`
                    : `${fmtInt(g.reps)} first-exposure reps`
                }
              >
                {fmtInt(g.reps)}
                {g.droppedReps > 0 && (
                  <span style={{ fontSize: '9px', color: 'var(--rn-clr-content-tertiary)' }}>
                    {' '}
                    (−{fmtInt(g.droppedReps)})
                  </span>
                )}
              </td>
              <td style={{ ...tdStyle, fontWeight: 700 }}>{fmtS(g.currentS0)}</td>
              <td style={{ ...tdStyle, color: 'var(--rn-clr-content-tertiary)' }}>{fmtS(g.defaultS0)}</td>
              <td style={{ ...tdStyle, fontWeight: 700 }}>
                {fmtS(g.fittedS0)}
                {g.fittedSaturated && (
                  <span title="Pinned at the optimizer's 100-day clamp." style={{ color: '#a855f7' }}>
                    {' '}
                    ⚠
                  </span>
                )}
              </td>
              <td style={tdStyle}>
                {fmtS(g.mleS0)}
                <span style={{ fontSize: '9px', color: 'var(--rn-clr-content-tertiary)' }}>
                  {' '}
                  [{fmtS(g.mleLo)} – {fmtS(g.mleHi)}]
                </span>
              </td>
              <td style={{ ...tdStyle, color: 'var(--rn-clr-content-secondary)' }}>{fmtS(g.unfilteredS0)}</td>
              <td style={{ ...tdStyle, color: ratioColor(g.ratio), fontWeight: 700 }}>
                {Number.isFinite(g.ratio) ? `${g.ratio.toFixed(2)}×` : '—'}
              </td>
              <td style={tdStyle}>{fmtPct(g.coverage, 1)}</td>
              <td style={{ ...tdStyle, textAlign: 'center' }}>
                <VerdictBadge v={g.verdict} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Per-grade forgetting curve -----------------------------------------

function BucketRow({ b }: { b: S0BucketStats }) {
  if (b.reps === 0) {
    return (
      <tr style={{ borderBottom: '1px solid var(--rn-clr-background-tertiary)', opacity: 0.45 }}>
        <td style={rowHeadStyle}>{b.label}</td>
        <td style={tdStyle} colSpan={5}>
          —
        </td>
      </tr>
    );
  }
  const excluded = b.keptReps === 0;
  const partial = !excluded && b.keptReps < b.reps;
  return (
    <tr
      style={{
        borderBottom: '1px solid var(--rn-clr-background-tertiary)',
        opacity: excluded ? 0.5 : 1,
      }}
      title={
        excluded
          ? 'Entirely removed by the optimizer’s outlier filter before fitting.'
          : partial
            ? `${b.keptReps.toLocaleString()} of ${b.reps.toLocaleString()} reps survived the outlier filter.`
            : undefined
      }
    >
      <td style={rowHeadStyle}>
        {b.label}
        {excluded && <span style={{ color: '#f97316', fontWeight: 400 }}> ✕</span>}
        {partial && <span style={{ color: '#eab308', fontWeight: 400 }}> ◐</span>}
      </td>
      <td style={tdStyle}>{fmtInt(b.reps)}</td>
      <td style={{ ...tdStyle, fontWeight: 700 }}>{fmtPct(b.retention, 1)}</td>
      <td style={{ ...tdStyle, fontSize: '9.5px', color: 'var(--rn-clr-content-tertiary)' }}>
        {fmtPct(b.ciLo, 1)} – {fmtPct(b.ciHi, 1)}
      </td>
      <td style={tdStyle}>{fmtPct(b.predR, 1)}</td>
      <td style={{ ...tdStyle, color: rDevColor(b.devPP), fontWeight: 700 }}>{fmtPP(b.devPP, 1)}</td>
      <td style={{ ...tdStyle, color: 'var(--rn-clr-content-secondary)' }}>{fmtPct(b.fitR, 1)}</td>
    </tr>
  );
}

function GradeCurve({ g }: { g: S0GradeStats }) {
  if (g.reps === 0) return null;
  return (
    <div style={{ marginBottom: '14px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: '10px',
          marginBottom: '5px',
        }}
      >
        <div style={{ fontSize: '12px', fontWeight: 700 }}>First grade: {g.label}</div>
        <VerdictBadge v={g.verdict} />
        <div style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)' }}>
          {fmtInt(g.reps)} reps · median interval {fmtInt(g.medianDeltaT)} d · longest{' '}
          {fmtInt(g.maxDeltaT)} d (fit saw up to {fmtInt(g.keptMaxDeltaT)} d) · fit RMSE{' '}
          {Number.isFinite(g.rmse) ? g.rmse.toFixed(4) : '—'}
        </div>
      </div>
      <div
        style={{
          fontSize: '10px',
          color: 'var(--rn-clr-content-tertiary)',
          marginBottom: '6px',
          lineHeight: 1.5,
        }}
      >
        Observed {fmtPct(g.observedRetention, 1)} vs {fmtPct(g.predRetention, 1)} predicted from the
        current w[{g.grade}] ={' '}
        <strong>{fmtS(g.currentS0)} d</strong> → overall{' '}
        <span style={{ color: rDevColor(g.observedRetention - g.predRetention), fontWeight: 700 }}>
          {fmtPP(g.observedRetention - g.predRetention, 1)}
        </span>
        . FSRS's own prediction at these reps averaged {fmtPct(g.actualPredR, 1)}
        {Number.isFinite(g.intermediateShare) && g.intermediateShare > 0.5 && (
          <>
            {' '}
            — it differs from the w[{g.grade}] curve because {fmtPct(g.intermediateShare, 0)} of these
            outcomes had same-day learning steps in between, which move S before the interval starts
          </>
        )}
        .
      </div>
      <div style={tableWrapStyle}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: 'left', background: 'var(--rn-clr-background-tertiary)' }}>
                First interval
              </th>
              <th style={thStyle}>Reps</th>
              <th style={thStyle}>Observed R</th>
              <th style={thStyle} title="Wilson 95% score interval on the observed rate.">
                95% CI
              </th>
              <th style={thStyle} title={`Predicted from the current w[${g.grade}] and your w20 decay.`}>
                Pred R (current)
              </th>
              <th style={thStyle} title="Observed − predicted. Negative = FSRS over-predicted.">
                Dev
              </th>
              <th style={thStyle} title="Predicted from the refit S₀, using the optimizer's own −0.1542 decay.">
                Refit R
              </th>
            </tr>
          </thead>
          <tbody>
            {g.buckets.map((b) => (
              <BucketRow key={b.label} b={b} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Panel ---------------------------------------------------------------

export function FSRSInitialStabilityPanel({ data }: { data: S0Breakdown }) {
  const suggested = data.suggestedW
    .map((v) => (v === null ? '—' : v.toFixed(4)))
    .join(', ');

  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '4px' }}>
        D · Initial stability (w0–w3) — how well-founded is your first interval?
      </div>
      <div
        style={{
          fontSize: '10.5px',
          color: 'var(--rn-clr-content-tertiary)',
          marginBottom: '10px',
          lineHeight: 1.5,
        }}
      >
        <strong>w0–w3</strong> are the stability, in days, that FSRS assigns from the very first
        grade a card ever gets. They are the only parameters not learned by the recurrent fit:
        fsrs-optimizer derives them in a separate pass that looks at exactly one slice of history —
        each card's first grade paired with the outcome of the{' '}
        <em>first review on a later calendar day</em> (same-day learning steps are skipped, exactly
        as the optimizer drops its <code>delta_t == 0</code> rows). This panel reproduces that pass
        over your collection.
        <ul style={{ marginTop: '4px', marginBottom: '4px', paddingLeft: '18px' }}>
          <li>
            <strong>Refit S₀</strong> is the faithful reproduction: observations grouped by exact
            interval, the rarest and longest groups discarded by the optimizer's outlier filter,
            each group's rate Laplace-smoothed toward your average recall of{' '}
            {fmtPct(data.averageRecall * 100, 2)}, an L1 pull of{' '}
            <code>|S − default| / 16</code> toward the stock value, and the result clamped to 100
            days.
          </li>
          <li>
            <strong>MLE [95% CI]</strong> drops the L1 pull and the 100-day ceiling and adds a
            profile-likelihood interval. This is the honest answer to "how assertive is FSRS
            entitled to be": an interval running to the 3650-day bound means your reviews never ran
            long enough to see this grade forget, so the fitted number is a <em>floor</em>, not an
            estimate.
          </li>
          <li>
            <strong>Unfiltered</strong> refits without the outlier removal. A large gap from the MLE
            column means the optimizer's truncation step — which caps intervals at 100 days for
            Again/Hard/Good and 365 for Easy — is doing most of the work.
          </li>
          <li>
            The fit runs at the optimizer's hard-wired decay of{' '}
            <code>{data.fitDecay.toFixed(4)}</code>, because the initialisation pass never sees
            w20; the "Pred R (current)" column uses <em>your</em> decay of{' '}
            <code>{data.currentDecay.toFixed(4)}</code>. Those are two different curve families, so
            both are labelled rather than mixed.
          </li>
        </ul>
      </div>

      {data.totalReps === 0 ? (
        <div
          style={{
            padding: '14px',
            borderRadius: '6px',
            border: '1px dashed var(--rn-clr-background-tertiary)',
            fontSize: '11px',
            color: 'var(--rn-clr-content-tertiary)',
            textAlign: 'center',
          }}
        >
          No first-exposure reps in this period. w0–w3 can only be assessed from cards whose{' '}
          <em>first</em> grade — and the review that followed it on a later day — both fall inside
          the selected range, so short periods will usually come up empty. Widen the period to
          "All".
        </div>
      ) : (
        <SummaryTable data={data} />
      )}

      <div
        style={{
          margin: '8px 0 16px',
          padding: '8px 12px',
          borderRadius: '6px',
          background: 'var(--rn-clr-background-secondary)',
          border: '1px solid var(--rn-clr-background-tertiary)',
          fontSize: '10.5px',
          lineHeight: 1.55,
          color: 'var(--rn-clr-content-secondary)',
        }}
      >
        <div>
          <strong>w0–w3 this collection implies:</strong>{' '}
          <code style={{ fontSize: '11px' }}>[{suggested}]</code>{' '}
          <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            — post-monotonicity-repair and clamped, i.e. the vector fsrs-optimizer would hand to its
            training loop as a starting point. Training then moves these further; the L2 prior that
            holds them near this seed uses standard deviations of 6.43 / 9.66 / 17.58 / 27.85, which
            is a very loose leash.
          </span>
        </div>
        {data.monotonicityNotes.length > 0 && (
          <div style={{ marginTop: '6px' }}>
            <strong>Monotonicity repairs applied</strong>{' '}
            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              (FSRS forces Again ≤ Hard ≤ Good ≤ Easy by overwriting the value backed by fewer reps
              — not by averaging):
            </span>
            <ul style={{ marginTop: '3px', marginBottom: 0, paddingLeft: '18px' }}>
              {data.monotonicityNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '2px' }}>
        Empirical first-interval forgetting curves
      </div>
      <div
        style={{
          fontSize: '10.5px',
          color: 'var(--rn-clr-content-tertiary)',
          marginBottom: '8px',
          lineHeight: 1.5,
        }}
      >
        One table per first grade. Rows marked <span style={{ color: '#f97316' }}>✕</span> were
        removed wholesale by the outlier filter before fitting;{' '}
        <span style={{ color: '#eab308' }}>◐</span> means partially removed. Read the{' '}
        <strong>95% CI</strong> column before believing any deviation: a −8pp miss with a ±2pp
        interval is real, the same miss with a ±15pp interval is noise. The buckets are log-spaced
        because the interval distribution is — the mass sits at 1–2 days while the long tail, which
        is what actually constrains S₀, is thin.
      </div>

      {data.grades.map((g) => (
        <GradeCurve key={g.grade} g={g} />
      ))}
    </div>
  );
}
