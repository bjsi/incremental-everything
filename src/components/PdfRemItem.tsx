import React from 'react';
import { formatDuration } from '../lib/utils';
import {
  PriorityBadge,
  ReadingHistoryView,
  InlinePriorityEditor,
  InlinePageRangeEditor,
  InlineHistoryEditor,
  PageHistoryEntry
} from './index';

interface PdfRemItemData {
  remId: string;
  name: string;
  isIncremental: boolean;
  range?: { start: number; end: number | null };
  currentPage?: number | null;
}

interface PdfRemItemProps {
  item: PdfRemItemData;
  isCurrentRem: boolean;
  isExpanded: boolean;
  priorityInfo?: { absolute: number; percentile: number | null };
  statistics?: { totalTimeSeconds: number; sessionsWithTime: number };
  history?: PageHistoryEntry[];
  editingRemId: string | null;
  editingPriorityRemId: string | null;
  editingHistoryRemId: string | null;
  editingRanges: Record<string, { start: number; end: number }>;
  editingPriorities: Record<string, number>;
  editingHistoryPage: number;
  onToggleExpanded: (remId: string) => void;
  onInitIncremental: (remId: string) => void;
  onStartEditingRem: (remId: string) => void;
  onStartEditingPriority: (remId: string) => void;
  onStartEditingHistory: (remId: string, currentPage: number | null) => void;
  onSaveRemRange: (remId: string) => void;
  onSavePriority: (remId: string) => void;
  onSaveHistory: (remId: string) => void;
  onCancelEditingRem: () => void;
  onCancelEditingPriority: () => void;
  onCancelEditingHistory: () => void;
  onEditingRangesChange: (remId: string, field: 'start' | 'end', value: number) => void;
  onEditingPrioritiesChange: (remId: string, value: number) => void;
  onEditingHistoryPageChange: (value: number) => void;
  startInputRef?: React.RefCallback<HTMLInputElement>;
  endInputRef?: React.RefCallback<HTMLInputElement>;
}

export function PdfRemItem({
  item,
  isCurrentRem,
  isExpanded,
  priorityInfo,
  statistics,
  history,
  editingRemId,
  editingPriorityRemId,
  editingHistoryRemId,
  editingRanges,
  editingPriorities,
  editingHistoryPage,
  onToggleExpanded,
  onInitIncremental,
  onStartEditingRem,
  onStartEditingPriority,
  onStartEditingHistory,
  onSaveRemRange,
  onSavePriority,
  onSaveHistory,
  onCancelEditingRem,
  onCancelEditingPriority,
  onCancelEditingHistory,
  onEditingRangesChange,
  onEditingPrioritiesChange,
  onEditingHistoryPageChange,
  startInputRef,
  endInputRef,
}: PdfRemItemProps) {
  const isEditingRange = editingRemId === item.remId;
  const isEditingPriority = editingPriorityRemId === item.remId;
  const isEditingHistory = editingHistoryRemId === item.remId;

  return (
    <div
      className="rounded p-2 cursor-pointer transition-colors"
      style={{
        backgroundColor: isCurrentRem ? 'var(--rn-clr-background-tertiary)' : 'var(--rn-clr-background-secondary)',
        border: isCurrentRem ? '2px solid #10b981' : '1px solid var(--rn-clr-border-primary)',
      }}
      onClick={() => onToggleExpanded(item.remId)}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = isCurrentRem ? 'var(--rn-clr-background-tertiary)' : 'var(--rn-clr-background-secondary)'; }}
    >
      {/* Main Rem Info */}
      <div className="flex items-center gap-2">
        <span className="text-xs transition-transform" style={{
          color: 'var(--rn-clr-content-secondary)',
          transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)'
        }}>▼</span>
        {item.isIncremental && <span className="text-xs" title="Incremental Rem">⚡</span>}
        <span className="text-sm flex-1 truncate" style={{ color: 'var(--rn-clr-content-primary)' }}>
          {item.name}
        </span>
        {isCurrentRem && (
          <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: '#d1fae5', color: '#065f46' }}>Current</span>
        )}
        {item.isIncremental && priorityInfo && (
          <PriorityBadge priority={priorityInfo.absolute} percentile={priorityInfo.percentile ?? undefined} compact />
        )}
        {item.range && (
          <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-secondary)' }} title="Page range">
            p.{item.range.start}-{item.range.end || '∞'}
          </span>
        )}
        {item.currentPage && (
          <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }} title="Current reading position">
            📖{item.currentPage}
          </span>
        )}
        {statistics && statistics.totalTimeSeconds > 0 && (
          <span className="text-xs" style={{ color: '#10b981' }} title="Total reading time">
            ⏱️{formatDuration(statistics.totalTimeSeconds)}
          </span>
        )}
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--rn-clr-border-primary)' }} onClick={(e) => e.stopPropagation()}>
          {/* Action Buttons */}
          <div className="flex gap-1 mb-2 flex-wrap">
            {!item.isIncremental ? (
              <button
                onClick={() => onInitIncremental(item.remId)}
                className="px-2 py-1 text-xs rounded transition-colors"
                style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: '#10b981' }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#10b981'; e.currentTarget.style.color = 'white'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; e.currentTarget.style.color = '#10b981'; }}
              >
                Make Incremental
              </button>
            ) : (
              <>
                {isEditingRange ? (
                  <>
                    <button onClick={() => onSaveRemRange(item.remId)} className="px-2 py-1 text-xs rounded" style={{ backgroundColor: '#3b82f6', color: 'white' }}>Save</button>
                    <button onClick={onCancelEditingRem} className="px-2 py-1 text-xs rounded" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-secondary)' }}>Cancel</button>
                  </>
                ) : isEditingPriority ? (
                  <button onClick={onCancelEditingPriority} className="px-2 py-1 text-xs rounded" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-secondary)' }}>Cancel</button>
                ) : isEditingHistory ? (
                  <button onClick={onCancelEditingHistory} className="px-2 py-1 text-xs rounded" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-secondary)' }}>Cancel</button>
                ) : (
                  <>
                    <button
                      onClick={() => onStartEditingRem(item.remId)}
                      className="px-2 py-1 text-xs rounded transition-colors"
                      style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: '#3b82f6' }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#3b82f6'; e.currentTarget.style.color = 'white'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; e.currentTarget.style.color = '#3b82f6'; }}
                    >
                      📄 Range
                    </button>
                    <button
                      onClick={() => onStartEditingPriority(item.remId)}
                      className="px-2 py-1 text-xs rounded transition-colors"
                      style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: '#8b5cf6' }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#8b5cf6'; e.currentTarget.style.color = 'white'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; e.currentTarget.style.color = '#8b5cf6'; }}
                    >
                      ★ Priority
                    </button>
                    <button
                      onClick={() => onStartEditingHistory(item.remId, item.currentPage || null)}
                      className="px-2 py-1 text-xs rounded transition-colors"
                      style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: '#10b981' }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#10b981'; e.currentTarget.style.color = 'white'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; e.currentTarget.style.color = '#10b981'; }}
                    >
                      📖 History
                    </button>
                  </>
                )}
              </>
            )}
          </div>

          {/* Inline Priority Editor */}
          {isEditingPriority && (
            <InlinePriorityEditor
              value={editingPriorities[item.remId]}
              onChange={(value) => onEditingPrioritiesChange(item.remId, value)}
              onSave={() => onSavePriority(item.remId)}
              onCancel={onCancelEditingPriority}
            />
          )}

          {/* Page Range Editor */}
          {isEditingRange && editingRanges[item.remId] && (
            <InlinePageRangeEditor
              startValue={editingRanges[item.remId].start}
              endValue={editingRanges[item.remId].end}
              onStartChange={(value) => onEditingRangesChange(item.remId, 'start', value)}
              onEndChange={(value) => onEditingRangesChange(item.remId, 'end', value)}
              onSave={() => onSaveRemRange(item.remId)}
              onCancel={onCancelEditingRem}
              startInputRef={startInputRef}
              endInputRef={endInputRef}
            />
          )}

          {/* Inline History Editor */}
          {isEditingHistory && (
            <InlineHistoryEditor
              value={editingHistoryPage}
              onChange={onEditingHistoryPageChange}
              onSave={() => onSaveHistory(item.remId)}
              onCancel={onCancelEditingHistory}
            />
          )}

          {/* Reading History */}
          {history && history.length > 0 && (
            <ReadingHistoryView
              history={history}
              statistics={statistics}
              formatDuration={formatDuration}
            />
          )}
        </div>
      )}
    </div>
  );
}
