import React from 'react';
import { ActionItemType } from '../lib/incremental_rem/types';
import { TypeBadge } from './TypeBadge';
import { PriorityBadge } from './PriorityBadge';
import { TimeBadge } from './TimeBadge';

export interface IncRemRowData {
  remId: string;
  remText?: string;
  priority: number;
  nextRepDate: number;
  incRemType?: ActionItemType;
  percentile?: number;
  historyCount?: number;
}

interface IncRemRowProps {
  incRem: IncRemRowData;
  onClick: () => void;
  compact?: boolean;
  showType?: boolean;
}

export function IncRemRow({ incRem, onClick, compact = true, showType = true }: IncRemRowProps) {
  if (compact) {
    return (
      <div
        onClick={onClick}
        className="flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition-all group"
        style={{ backgroundColor: 'var(--rn-clr-background-secondary)' }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)'; }}
      >
        {showType && <TypeBadge type={incRem.incRemType} compact />}

        <div
          className="flex-1 truncate text-sm"
          style={{ color: 'var(--rn-clr-content-primary)' }}
          title={incRem.remText}
        >
          {incRem.remText || 'Loading...'}
        </div>

        <PriorityBadge priority={incRem.priority} percentile={incRem.percentile} compact />
        <TimeBadge nextRepDate={incRem.nextRepDate} compact />
      </div>
    );
  }

  const isDue = incRem.nextRepDate <= Date.now();

  return (
    <div
      onClick={onClick}
      className="inc-rem-item group relative p-4 rounded cursor-pointer transition-all"
      style={{
        backgroundColor: 'var(--rn-clr-background-secondary)',
        border: '1px solid var(--rn-clr-border-primary)',
        borderLeft: `4px solid ${isDue ? '#f97316' : '#3b82f6'}`,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)'; }}
    >
      <div className="font-medium text-base mb-2 pr-6" style={{ color: 'var(--rn-clr-content-primary)' }}>
        {incRem.remText || 'Loading...'}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {showType && incRem.incRemType && <TypeBadge type={incRem.incRemType} />}
        <PriorityBadge priority={incRem.priority} percentile={incRem.percentile} />
        <TimeBadge nextRepDate={incRem.nextRepDate} />
        {incRem.historyCount !== undefined && incRem.historyCount > 0 && (
          <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            • {incRem.historyCount} review{incRem.historyCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>
    </div>
  );
}
