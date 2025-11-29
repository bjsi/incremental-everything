import React from 'react';
import { percentileToHslColor } from '../lib/utils';

interface PriorityBadgeProps {
  priority: number;
  percentile?: number;
  compact?: boolean;
}

export function PriorityBadge({ priority, percentile, compact = false }: PriorityBadgeProps) {
  // Use percentile for color if available (including 0), otherwise fallback to gray
  const bgColor = percentile !== undefined ? percentileToHslColor(percentile) : '#6b7280';

  if (compact) {
    return (
      <span
        className="text-xs px-1.5 py-0.5 rounded font-semibold shrink-0 text-center tabular-nums"
        style={{
          backgroundColor: bgColor,
          color: 'white',
          minWidth: '36px',
        }}
        title={`Priority: ${priority}${percentile ? ` (top ${percentile}%)` : ''}`}
      >
        P{priority}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center justify-center px-2 py-1 rounded text-sm font-semibold shrink-0 tabular-nums"
      style={{
        backgroundColor: bgColor,
        color: 'white',
        minWidth: '44px',
      }}
      title={`Priority: ${priority}${percentile ? ` (top ${percentile}%)` : ''}`}
    >
      P{priority}
    </span>
  );
}
