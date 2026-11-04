import React from 'react';
import { usePlugin } from '@remnote/plugin-sdk';
import { WeightedShieldBreakdown, computeWeightedShieldBreakdown } from '../lib/utils';

interface WeightedShieldTooltipProps {
  kbValue: number;
  docValue: number | null;
  allItems: Array<{ priority: number; remId: string }>;
  isDuePredicate: (item: any) => boolean;
  docItems?: Array<{ priority: number; remId: string }> | null;
  itemLabel?: string;
  /**
   * A separate universe for the popup's Queue Selection Odds panel. The
   * Priority Shield's joint universe is not one the queue draws from, so its
   * popup offers the IncRem universe there instead.
   */
  odds?: {
    kind: 'incRem' | 'card';
    allItems: Array<{ priority: number; remId: string }>;
    docItems?: Array<{ priority: number; remId: string }> | null;
    isDuePredicate: (item: any) => boolean;
  };
}

/**
 * Trigger button for the weighted shield breakdown popup.
 * On click, computes serializable breakdown data and opens a standalone
 * popup widget (weighted_shield_popup) via plugin.widget.openPopup().
 */
export function WeightedShieldTooltip({
  kbValue,
  docValue,
  allItems,
  isDuePredicate,
  docItems,
  itemLabel = 'items',
  odds,
}: WeightedShieldTooltipProps) {
  const plugin = usePlugin();

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!allItems || allItems.length === 0) return;

    const kbBreakdown: WeightedShieldBreakdown = computeWeightedShieldBreakdown(
      allItems,
      isDuePredicate
    );
    const docBreakdown: WeightedShieldBreakdown | null =
      docItems && docItems.length > 0
        ? computeWeightedShieldBreakdown(docItems, isDuePredicate)
        : null;

    const oddsSorted = (items: Array<{ priority: number; remId: string }> | null | undefined) =>
      odds && items && items.length > 0
        ? computeWeightedShieldBreakdown(items, odds.isDuePredicate).sortedItems
        : undefined;

    await plugin.widget.openPopup('weighted_shield_popup', {
      kbBreakdown,
      docBreakdown,
      itemLabel,
      odds: odds
        ? { kind: odds.kind, kb: oddsSorted(odds.allItems), doc: oddsSorted(odds.docItems) }
        : undefined,
    });
  };

  return (
    <div
      onClick={handleClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        cursor: 'pointer',
        userSelect: 'none',
        borderRadius: '4px',
        padding: '1px 4px',
        transition: 'opacity 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.7'; }}
      onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
      title="Click for detailed breakdown"
    >
      <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--rn-clr-content-secondary)' }}>
        <span>⚖️</span>
        <span>Weighted:</span>
      </span>
      <div style={{ display: 'flex', gap: '12px', fontSize: '12px', color: 'var(--rn-clr-content-tertiary)' }}>
        <span>KB: <strong style={{ color: 'var(--rn-clr-content-secondary)' }}>{kbValue.toFixed(1)}%</strong></span>
        {docValue !== null && docValue !== undefined && (
          <span>Doc: <strong style={{ color: 'var(--rn-clr-content-secondary)' }}>{docValue.toFixed(1)}%</strong></span>
        )}
      </div>
    </div>
  );
}
