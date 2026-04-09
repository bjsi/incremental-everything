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
}: WeightedShieldTooltipProps) {
  const plugin = usePlugin();

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!allItems || allItems.length === 0) return;

    const kbBreakdown: WeightedShieldBreakdown = computeWeightedShieldBreakdown(allItems, isDuePredicate);
    const docBreakdown: WeightedShieldBreakdown | null =
      docItems && docItems.length > 0
        ? computeWeightedShieldBreakdown(docItems, isDuePredicate)
        : null;

    await plugin.widget.openPopup('weighted_shield_popup', {
      kbBreakdown,
      docBreakdown,
      itemLabel,
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
      <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
        <span>⚖️</span>
        <span>Weighted:</span>
      </span>
      <div style={{ display: 'flex', gap: '12px', fontSize: '12px' }}>
        <span>KB: <strong>{kbValue.toFixed(1)}%</strong></span>
        {docValue !== null && docValue !== undefined && (
          <span>Doc: <strong>{docValue.toFixed(1)}%</strong></span>
        )}
      </div>
    </div>
  );
}
