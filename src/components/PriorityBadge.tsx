import React from 'react';
import { percentileToHslColor } from '../lib/utils';
import { priorityColor, priorityScalePercentile, usePriorityColorScale } from './priorityColor';

interface PriorityBadgeProps {
  priority: number;
  percentile?: number;
  compact?: boolean;
  useAbsoluteColoring?: boolean;
  source?: string;
  isCardPriority?: boolean;
}

export function PriorityBadge({ priority, percentile, compact = false, useAbsoluteColoring = false, source, isCardPriority = false }: PriorityBadgeProps) {
  // The colour is the priority's place on the unified IncRems + cards scale, the
  // same for every badge in the plugin (lib/priority_color_scale). Until a map
  // exists: the caller's percentile, the absolute value, or gray.
  const scale = usePriorityColorScale();
  const bgColor = scale
    ? priorityColor(scale, priority)
    : useAbsoluteColoring
      ? percentileToHslColor(priority)
      : (percentile !== undefined ? percentileToHslColor(percentile) : '#6b7280');
  // The hover text names the same scale the colour comes from.
  const shown = scale ? priorityScalePercentile(scale, priority) : percentile;
  const title = `Priority: ${priority}${shown !== undefined ? ` (top ${shown}%${scale ? ' of IncRems and cards' : ''})` : ''}`;

  const isBoldNumber = isCardPriority && (source === 'manual' || source === 'incremental');
  const numberNode = isBoldNumber ? <strong className="font-extrabold">{priority}</strong> : priority;

  if (compact) {
    return (
      <span
        className="text-xs px-1.5 py-0.5 rounded font-semibold shrink-0 text-center tabular-nums"
        style={{
          backgroundColor: bgColor,
          color: 'white',
          minWidth: '36px',
        }}
        title={title}
      >
        P{numberNode}
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
      title={title}
    >
      P{numberNode}
    </span>
  );
}
