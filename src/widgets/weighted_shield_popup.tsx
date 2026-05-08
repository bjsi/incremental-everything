import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { WeightedShieldBreakdown } from '../lib/utils';

interface WeightedShieldPopupContext {
  kbBreakdown: WeightedShieldBreakdown;
  docBreakdown?: WeightedShieldBreakdown | null;
  itemLabel: string;
}

const WEIGHT_K = 2.3026;

function SubsetStatsPanel({
  sortedItems,
  totalWeight,
}: {
  sortedItems: { priority: number; isDue: boolean }[];
  totalWeight: number;
}) {
  const N = sortedItems.length;
  const minPriority = N > 0 ? sortedItems[0].priority : 0;
  const maxPriority = N > 0 ? sortedItems[N - 1].priority : 100;

  // Slider range. If all items share a priority, widen by 1 so the slider isn't degenerate.
  const sliderMin = Math.floor(minPriority);
  const sliderMax = Math.max(Math.ceil(maxPriority), sliderMin + 1);

  const [threshold, setThreshold] = React.useState<number>(Math.round(maxPriority));

  // Prefix sums of weight and due count, indexed [0..N]: cum[i] = sum over items 0..i-1.
  const prefix = React.useMemo(() => {
    const cumWeight = new Float64Array(N + 1);
    const cumDue = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) {
      const percentile = ((i + 1) / N) * 100;
      const w = Math.exp((-WEIGHT_K * percentile) / 100);
      cumWeight[i + 1] = cumWeight[i] + w;
      cumDue[i + 1] = cumDue[i] + (sortedItems[i].isDue ? 1 : 0);
    }
    return { cumWeight, cumDue };
  }, [sortedItems, N]);

  const stats = React.useMemo(() => {
    if (N === 0) return null;
    // Largest index hi such that sortedItems[i].priority <= threshold for all i < hi.
    let lo = 0;
    let hi = N;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedItems[mid].priority <= threshold) lo = mid + 1;
      else hi = mid;
    }
    const count = lo;
    if (count === 0) {
      return {
        count: 0,
        due: 0,
        processedPct: 0,
        meanWeight: 0,
        weightShare: 0,
        relPercentile: 0,
      };
    }
    const due = prefix.cumDue[count];
    const weightSum = prefix.cumWeight[count];
    const processedPct = ((count - due) / count) * 100;
    const meanWeight = weightSum / count;
    const weightShare = totalWeight > 0 ? (weightSum / totalWeight) * 100 : 0;
    const relPercentile = (count / N) * 100;
    return { count, due, processedPct, meanWeight, weightShare, relPercentile };
  }, [threshold, sortedItems, N, prefix, totalWeight]);

  if (N === 0) return null;

  const cellStyle: React.CSSProperties = {
    padding: '4px 6px',
    borderRight: '1px solid var(--rn-clr-background-tertiary)',
    fontSize: '11px',
    lineHeight: '1.3',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: '10px',
    color: 'var(--rn-clr-content-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontWeight: 600,
  };
  const valueStyle: React.CSSProperties = {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--rn-clr-content-primary)',
  };

  return (
    <div style={{
      marginTop: '10px',
      padding: '8px 10px',
      borderRadius: '6px',
      background: 'var(--rn-clr-background-secondary)',
      border: '1px solid var(--rn-clr-background-tertiary)',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        marginBottom: '6px',
      }}>
        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--rn-clr-content-secondary)' }}>
          Threshold (Absolute Priority ≤)
        </span>
        <input
          type="range"
          min={sliderMin}
          max={sliderMax}
          step={1}
          value={threshold}
          onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
          style={{ flex: 1 }}
        />
        <span style={{
          fontFamily: 'monospace',
          fontSize: '12px',
          fontWeight: 700,
          minWidth: '52px',
          textAlign: 'right',
          color: 'var(--rn-clr-content-primary)',
        }}>
          {threshold}
        </span>
      </div>

      {stats && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          border: '1px solid var(--rn-clr-background-tertiary)',
          borderRadius: '4px',
          background: 'var(--rn-clr-background-primary)',
          overflow: 'hidden',
        }}>
          <div style={cellStyle}>
            <div style={labelStyle}>Rel %ile</div>
            <div style={valueStyle}>{stats.relPercentile.toFixed(1)}%</div>
          </div>
          <div style={cellStyle}>
            <div style={labelStyle}>Items</div>
            <div style={valueStyle}>{stats.count.toLocaleString()}</div>
          </div>
          <div style={cellStyle}>
            <div style={labelStyle}>Due</div>
            <div style={{ ...valueStyle, color: stats.due > 0 ? '#ef4444' : 'inherit' }}>
              {stats.due.toLocaleString()}
            </div>
          </div>
          <div style={cellStyle}>
            <div style={labelStyle}>% Done</div>
            <div style={{ ...valueStyle, color: stats.processedPct >= 50 ? '#22c55e' : 'inherit' }}>
              {stats.processedPct.toFixed(1)}%
            </div>
          </div>
          <div style={cellStyle}>
            <div style={labelStyle}>Avg W</div>
            <div style={{ ...valueStyle, fontFamily: 'monospace' }}>
              {stats.meanWeight.toFixed(3)}
            </div>
          </div>
          <div style={{ ...cellStyle, borderRight: 'none' }}>
            <div style={labelStyle}>W Share</div>
            <div style={valueStyle}>{stats.weightShare.toFixed(1)}%</div>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniBar({ processedPct }: { processedPct: number }) {
  return (
    <div style={{
      width: '44px',
      height: '8px',
      borderRadius: '4px',
      background: 'var(--rn-clr-background-tertiary, #e5e7eb)',
      overflow: 'hidden',
      display: 'inline-block',
      verticalAlign: 'middle',
    }}>
      <div style={{
        width: `${processedPct}%`,
        height: '100%',
        borderRadius: processedPct >= 100 ? '4px' : '4px 0 0 4px',
        background: processedPct >= 100
          ? '#22c55e'
          : processedPct >= 50
            ? '#eab308'
            : '#ef4444',
        transition: 'width 0.3s ease',
      }} />
    </div>
  );
}

function BreakdownSection({
  breakdown,
  scopeLabel,
  itemLabel,
}: {
  breakdown: WeightedShieldBreakdown;
  scopeLabel: string;
  itemLabel: string;
}) {
  const shieldColor = breakdown.shieldValue >= 95
    ? '#22c55e'
    : breakdown.shieldValue >= 70
      ? '#eab308'
      : '#ef4444';

  return (
    <div style={{ marginBottom: '14px' }}>
      {/* Section header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '8px',
        paddingBottom: '6px',
        borderBottom: '1px solid var(--rn-clr-background-tertiary)',
      }}>
        <span style={{ fontWeight: 700, fontSize: '13px' }}>{scopeLabel}</span>
        <span style={{ fontSize: '15px', fontWeight: 700, color: shieldColor }}>
          ⚖️ {breakdown.shieldValue.toFixed(1)}%
        </span>
      </div>

      {/* Summary row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: '8px',
        marginBottom: '8px',
        fontSize: '12px',
        color: 'var(--rn-clr-content-secondary)',
      }}>
        <div>
          <span style={{ fontWeight: 600 }}>Total: </span>
          {breakdown.totalItems.toLocaleString()} {itemLabel.toLowerCase() === 'cards' ? 'Rems with Cards' : 'Incremental Rems'}
        </div>
        <div>
          <span style={{ fontWeight: 600, color: breakdown.dueItems > 0 ? '#ef4444' : 'inherit' }}>Due: </span>
          {breakdown.dueItems.toLocaleString()} ({breakdown.duePct}%)
        </div>
        <div>
          <span style={{ fontWeight: 600, color: '#22c55e' }}>Processed: </span>
          {(breakdown.totalItems - breakdown.dueItems).toLocaleString()}
          ({breakdown.totalItems > 0 ? (100 - breakdown.duePct).toFixed(1) : 0}%)
        </div>
      </div>

      {/* Weight summary */}
      <div style={{
        fontSize: '11px',
        color: 'var(--rn-clr-content-tertiary)',
        marginBottom: '10px',
        fontStyle: 'italic',
      }}>
        Weight processed: {breakdown.processedWeightPct.toFixed(1)}% of total weight
        &nbsp;({(breakdown.totalWeight - breakdown.dueWeight).toFixed(2)} / {breakdown.totalWeight.toFixed(2)})
      </div>

      {/* Bucket table */}
      <table style={{
        width: '100%',
        fontSize: '12px',
        borderCollapse: 'collapse',
        lineHeight: '1.6',
      }}>
        <thead>
          <tr style={{
            borderBottom: '2px solid var(--rn-clr-background-tertiary)',
            color: 'var(--rn-clr-content-tertiary)',
            fontWeight: 700,
            fontSize: '11px',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            <th style={{ textAlign: 'left', padding: '3px 6px' }}>Percentile bucket</th>
            <th style={{ textAlign: 'center', padding: '3px 6px' }} title="Absolute priority range covered by this bucket">Absolute Priority</th>
            <th style={{ textAlign: 'right', padding: '3px 6px' }}>Items</th>
            <th style={{ textAlign: 'right', padding: '3px 6px' }}>Due</th>
            <th style={{ textAlign: 'center', padding: '3px 6px', minWidth: '110px' }}>Done</th>
            <th style={{ textAlign: 'right', padding: '3px 6px' }} title="Mean exponential weight of items in this bucket">Avg W</th>
            <th style={{ textAlign: 'right', padding: '3px 6px' }} title="This bucket's share of total priority weight">W Share</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.buckets.map((bucket, i) => (
            <tr
              key={i}
              style={{
                borderBottom: '1px solid var(--rn-clr-background-tertiary)',
                opacity: bucket.total === 0 ? 0.3 : 1,
                background: i % 2 === 0 ? 'transparent' : 'var(--rn-clr-background-secondary)',
              }}
            >
              <td style={{ padding: '3px 6px', fontWeight: 500 }}>{bucket.label}</td>
              <td style={{ textAlign: 'center', padding: '3px 6px', color: 'var(--rn-clr-content-tertiary)', fontSize: '11px' }}>{bucket.priorityRange}</td>
              <td style={{ textAlign: 'right', padding: '3px 6px' }}>{bucket.total}</td>
              <td style={{
                textAlign: 'right',
                padding: '3px 6px',
                color: bucket.due > 0 ? '#ef4444' : 'var(--rn-clr-content-tertiary)',
                fontWeight: bucket.due > 0 ? 700 : 'inherit',
              }}>
                {bucket.due}
              </td>
              <td style={{ padding: '3px 6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <MiniBar processedPct={bucket.processedPct} />
                  <span style={{ minWidth: '38px', textAlign: 'right', fontSize: '11px' }}>
                    {bucket.processedPct}%
                  </span>
                </div>
              </td>
              <td style={{ textAlign: 'right', padding: '3px 6px', fontFamily: 'monospace', fontSize: '11px' }}>
                {bucket.meanWeight.toFixed(3)}
              </td>
              <td style={{ textAlign: 'right', padding: '3px 6px' }}>
                {bucket.weightShare}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {breakdown.sortedItems && breakdown.sortedItems.length > 0 && (
        <SubsetStatsPanel
          sortedItems={breakdown.sortedItems}
          totalWeight={breakdown.totalWeight}
        />
      )}
    </div>
  );
}

function WeightedShieldPopup() {
  const plugin = usePlugin();

  const [ctx, setCtx] = React.useState<WeightedShieldPopupContext | null>(null);

  React.useEffect(() => {
    plugin.widget.getWidgetContext<any>().then((c) => setCtx(c?.contextData as WeightedShieldPopupContext));
  }, []);

  if (!ctx) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--rn-clr-content-tertiary)' }}>
        Loading…
      </div>
    );
  }

  const itemLabel = ctx.itemLabel || 'items';

  return (
    <div style={{
      padding: '16px',
      fontFamily: 'var(--rn-font-family, system-ui, sans-serif)',
      fontSize: '13px',
      color: 'var(--rn-clr-content-primary)',
      background: 'var(--rn-clr-background-primary)',
      height: '100%',
      overflowY: 'auto',
      boxSizing: 'border-box',
    }}>
      {/* Title */}
      <div style={{
        fontSize: '15px',
        fontWeight: 700,
        marginBottom: '6px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        <span>⚖️ Weighted Shield Breakdown</span>
      </div>

      {/* Explanation */}
      <div style={{
        fontSize: '11px',
        color: 'var(--rn-clr-content-tertiary)',
        marginBottom: '14px',
        lineHeight: '1.5',
        borderBottom: '1px solid var(--rn-clr-background-tertiary)',
        paddingBottom: '10px',
      }}>
        Each {itemLabel.toLowerCase() === 'cards' ? 'rem with cards' : 'incremental rem'} is
        weighted by priority percentile: top-priority items (0%) carry ~10× the weight of
        bottom-priority items (100%), using W = e^(−2.3026 × p/100).
        The shield shows what fraction of total priority weight has been processed.
        Higher = better. Items in the current queue card count as "being processed".
      </div>

      {/* KB breakdown */}
      <BreakdownSection
        breakdown={ctx.kbBreakdown}
        scopeLabel="🌐 Knowledge Base"
        itemLabel={itemLabel}
      />

      {/* Doc breakdown */}
      {ctx.docBreakdown && (
        <div style={{ paddingTop: '8px', borderTop: '1px solid var(--rn-clr-background-tertiary)' }}>
          <BreakdownSection
            breakdown={ctx.docBreakdown}
            scopeLabel="📄 Document Scope"
            itemLabel={itemLabel}
          />
        </div>
      )}
    </div>
  );
}

renderWidget(WeightedShieldPopup);
