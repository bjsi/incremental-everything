import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { WeightedShieldBreakdown } from '../lib/utils';

interface WeightedShieldPopupContext {
  kbBreakdown: WeightedShieldBreakdown;
  docBreakdown?: WeightedShieldBreakdown | null;
  itemLabel: string;
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
            <th style={{ textAlign: 'center', padding: '3px 6px' }} title="Absolute priority range covered by this bucket">Absolute Pri.</th>
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
      minHeight: '100%',
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
