import React from 'react';
import { ActionItemType } from '../lib/incremental_rem/types';
import { TypeBadge } from './TypeBadge';
import { PriorityBadge } from './PriorityBadge';
import { TimeBadge } from './TimeBadge';
import { InlinePriorityEditor } from './InlineEditors';
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
  // Priority inline editing
  editingPriority?: { value: number };
  onPriorityClick?: (remId: string) => void;
  onPriorityChange?: (value: number) => void;
  onPrioritySave?: (remId: string) => void;
  onPriorityCancel?: () => void;
  // Review in Editor action
  onReviewInEditor?: (remId: string) => void;
}

export function IncRemRow({
  incRem,
  onClick,
  showType = true,
  editingPriority,
  onPriorityClick,
  onPriorityChange,
  onPrioritySave,
  onPriorityCancel,
  onReviewInEditor,
}: IncRemRowProps) {
  return (
    <div>
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

        <span
          onClick={(e) => {
            if (onPriorityClick) {
              e.stopPropagation();
              onPriorityClick(incRem.remId);
            }
          }}
          style={{ cursor: onPriorityClick ? 'pointer' : undefined }}
          title={onPriorityClick ? 'Click to edit priority' : undefined}
        >
          <PriorityBadge priority={incRem.priority} percentile={incRem.percentile} />
        </span>
        <TimeBadge nextRepDate={incRem.nextRepDate} />

        {/* Review in Editor icon */}
        {onReviewInEditor && (
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onReviewInEditor(incRem.remId);
            }}
            style={{
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '4px',
              borderRadius: '6px',
              transition: 'background-color 0.2s, opacity 0.2s',
              opacity: 0.6,
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '1';
              e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '0.6';
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            title="Review in Editor — open in editor, start timer, and reschedule"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </span>
        )}
      </div>

      {/* Inline priority editor — shown below the row when editing */}
      {editingPriority && onPriorityChange && onPrioritySave && onPriorityCancel && (
        <div
          className="px-4 pb-2 pt-1"
          style={{ backgroundColor: 'var(--rn-clr-background-secondary)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <InlinePriorityEditor
            value={editingPriority.value}
            onChange={onPriorityChange}
            onSave={() => onPrioritySave(incRem.remId)}
            onCancel={onPriorityCancel}
          />
        </div>
      )}
    </div>
  );
}
