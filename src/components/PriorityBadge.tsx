import React from 'react';
import { percentileToHslColor } from '../lib/utils';

interface PriorityBadgeProps {
  priority: number;
  percentile?: number;
  compact?: boolean;
}

export function PriorityBadge({ priority, percentile, compact = false }: PriorityBadgeProps) {
  const bgColor = percentile ? percentileToHslColor(percentile) : '#6b7280';

  if (compact) {
    return (
      <span
        className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0 text-center tabular-nums"
        style={{
          backgroundColor: bgColor,
          color: 'white',
          minWidth: '42px',
        }}
        title={`Priority: ${priority}${percentile ? ` (top ${percentile}%)` : ''}`}
      >
        ★{priority}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center justify-center gap-1 px-2 py-1 rounded text-sm font-medium shrink-0 tabular-nums"
      style={{
        backgroundColor: bgColor,
        color: 'white',
        minWidth: '52px',
      }}
      title={`Priority: ${priority}${percentile ? ` (top ${percentile}%)` : ''}`}
    >
      ★{priority}
    </span>
  );
}
