import React from 'react';
import { ActionItemType } from '../lib/incremental_rem/types';
import { TypeBadge } from './TypeBadge';
import { PriorityBadge } from './PriorityBadge';
import { TimeBadge } from './TimeBadge';
import { formatDuration, timeSince } from '../lib/utils';

export interface IncRemRowData {
  remId: string;
  remText?: string;
  priority: number;
  nextRepDate: number;
  incRemType?: ActionItemType;
  percentile?: number;
  historyCount?: number;
  totalTimeSpent?: number;
  lastReviewDate?: number;
  breadcrumb?: string;
}

interface IncRemRowProps {
  incRem: IncRemRowData;
  onClick: () => void;
  showType?: boolean;
}

export function IncRemRow({ incRem, onClick, showType = true }: IncRemRowProps) {
  return (
    <div
      onClick={onClick}
      className="flex items-center gap-4 px-4 py-3 rounded cursor-pointer transition-all"
      style={{ backgroundColor: 'var(--rn-clr-background-secondary)' }}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)'; }}
    >
      {showType && <TypeBadge type={incRem.incRemType} />}

      <div
        className="flex-1 min-w-0 text-sm"
        style={{ color: 'var(--rn-clr-content-primary)' }}
      >
        <div className="truncate" title={incRem.breadcrumb ? `${incRem.breadcrumb} > ${incRem.remText}` : incRem.remText}>
          {incRem.remText || 'Loading...'}
        </div>
        {(incRem.historyCount !== undefined && incRem.historyCount > 0) || (incRem.totalTimeSpent !== undefined && incRem.totalTimeSpent > 0) ? (
          <div className="text-xs mt-0.5 flex items-center gap-2" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            {incRem.historyCount !== undefined && incRem.historyCount > 0 && (
              <span>{incRem.historyCount} review{incRem.historyCount !== 1 ? 's' : ''}</span>
            )}
            {incRem.totalTimeSpent !== undefined && incRem.totalTimeSpent > 0 && (
              <span style={{ color: '#10b981' }} title="Total time spent">
                ⏱️ {formatDuration(incRem.totalTimeSpent)}
              </span>
            )}
            {incRem.lastReviewDate && (
              <span style={{ color: 'var(--rn-clr-content-tertiary)' }} title="Last review date">
                • Last reviewed: {timeSince(new Date(incRem.lastReviewDate))}
              </span>
            )}
          </div>
        ) : null}
      </div>

      <PriorityBadge priority={incRem.priority} percentile={incRem.percentile} />
      <TimeBadge nextRepDate={incRem.nextRepDate} />
    </div>
  );
}
