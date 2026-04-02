import React, { useState, useMemo, useRef, useEffect } from 'react';
import { IncrementalRem } from '../lib/incremental_rem';
import { ActionItemType } from '../lib/incremental_rem/types';
import { IncRemRow, IncRemRowData } from './IncRemRow';

export interface IncRemWithDetails extends IncrementalRem {
  remText?: string;
  incRemType?: ActionItemType;
  percentile?: number;
  totalTimeSpent?: number;
  documentId?: string;
  documentName?: string;
  lastReviewDate?: number;
  breadcrumb?: string;
}

type FilterStatus = 'all' | 'due' | 'scheduled';
type SortBy = 'priority' | 'date' | 'reviews' | 'time' | 'lastReview' | 'queueOrder';
type SortOrder = 'asc' | 'desc';

export interface IncRemListState {
  filterStatus: FilterStatus;
  filterType: ActionItemType | 'all';
  priorityMin: number;
  priorityMax: number;
  searchText: string;
  sortBy: SortBy;
  sortOrder: SortOrder;
}

export interface DocumentInfo {
  id: string;
  name: string;
  count: number;
  dueCount: number;
}

interface IncRemTableProps {
  title: string;
  icon: string;
  incRems: IncRemWithDetails[];
  loading: boolean;
  dueCount: number;
  totalCount: number;
  onRemClick: (remId: string) => void;
  onClose?: () => void;
  documents?: DocumentInfo[];
  selectedDocumentId?: string | null;
  onDocumentFilterChange?: (documentId: string | null) => void;
  onPriorityChange?: (remId: string, newPriority: number) => Promise<void>;
  onReviewAndOpen?: (remId: string, subsequentRemIds?: string[]) => void;
  initialState?: IncRemListState;
  onStateChange?: (state: IncRemListState) => void;
  subtitle?: string;
  sortingRandomness?: number;
}

export function IncRemTable({
  title,
  icon,
  incRems,
  loading,
  dueCount,
  totalCount,
  onRemClick,
  onClose,
  documents,
  selectedDocumentId,
  onDocumentFilterChange,
  onPriorityChange,
  onReviewAndOpen,
  initialState,
  onStateChange,
  subtitle,
  sortingRandomness = 0,
}: IncRemTableProps) {
  const [filterStatus, setFilterStatus] = useState<FilterStatus>(initialState?.filterStatus ?? 'all');
  const [filterType, setFilterType] = useState<ActionItemType | 'all'>(initialState?.filterType ?? 'all');
  const [priorityMin, setPriorityMin] = useState<number>(initialState?.priorityMin ?? 0);
  const [priorityMax, setPriorityMax] = useState<number>(initialState?.priorityMax ?? 100);
  const [searchText, setSearchText] = useState<string>(initialState?.searchText ?? '');
  const [sortBy, setSortBy] = useState<SortBy>(initialState?.sortBy ?? 'priority');
  const [sortOrder, setSortOrder] = useState<SortOrder>(initialState?.sortOrder ?? 'asc');

  // Inline priority editing state
  const [editingPriorityRemId, setEditingPriorityRemId] = useState<string | null>(null);
  const [editingPriorityValue, setEditingPriorityValue] = useState<number>(0);
  const editingPriorityValueRef = useRef<number>(0);

  // Warning state: holds pending review info when user clicks without Due filter
  type PendingReview =
    | { type: 'header'; callback: () => void }
    | { type: 'row'; triggerRemId: string; queueCount: number; dueCountInQueue: number; callback: () => void };
  const [pendingReview, setPendingReview] = useState<PendingReview | null>(null);

  // Force filters when 'queueOrder' is selected
  const effectiveFilterStatus = sortBy === 'queueOrder' ? 'due' : filterStatus;
  const effectiveSortOrder = sortBy === 'queueOrder' ? 'asc' : sortOrder;

  // Report state changes to parent so it can store them for the "Back to IncRem List" flow
  // Use the actual state values, not the effective ones, so if they change sort they get their old filters back
  useEffect(() => {
    if (onStateChange) {
      onStateChange({ filterStatus, filterType, priorityMin, priorityMax, searchText, sortBy, sortOrder });
    }
  }, [filterStatus, filterType, priorityMin, priorityMax, searchText, sortBy, sortOrder, onStateChange]);

  // Apply sorting criteria, preserving a stable random order for 'queueOrder'
  const randomOrderCache = useRef<Record<string, number>>({});

  // Clear random cache if we change sort type away from queueOrder
  useEffect(() => {
    if (sortBy !== 'queueOrder') {
      randomOrderCache.current = {};
    }
  }, [sortBy]);

  const filteredAndSortedRems = useMemo(() => {
    const now = Date.now();

    let filtered = incRems.filter((rem) => {
      if (effectiveFilterStatus === 'due' && rem.nextRepDate > now) return false;
      if (effectiveFilterStatus === 'scheduled' && rem.nextRepDate <= now) return false;
      if (rem.priority < priorityMin || rem.priority > priorityMax) return false;
      if (filterType !== 'all' && rem.incRemType !== filterType) return false;
      if (searchText && rem.remText && !rem.remText.toLowerCase().includes(searchText.toLowerCase())) {
        return false;
      }
      return true;
    });

    if (sortBy === 'queueOrder') {
      // 1. Sort by priority first
      filtered.sort((a, b) => a.priority - b.priority);

      // 2. Apply randomness swaps once, caching the resulting order via a mapped index
      const cacheNeedsInit = Object.keys(randomOrderCache.current).length === 0 ||
        filtered.some(r => randomOrderCache.current[r.remId] === undefined);

      if (cacheNeedsInit) {
        // Build new random order
        const orderArr = [...filtered];
        const numSwaps = Math.floor(sortingRandomness * orderArr.length);

        for (let i = 0; i < numSwaps; i++) {
          const idx1 = Math.floor(Math.random() * orderArr.length);
          const idx2 = Math.floor(Math.random() * orderArr.length);
          [orderArr[idx1], orderArr[idx2]] = [orderArr[idx2], orderArr[idx1]];
        }

        // Save the resulting indices to the cache
        randomOrderCache.current = {};
        orderArr.forEach((rem, idx) => {
          randomOrderCache.current[rem.remId] = idx;
        });
      }

      // Sort using the cached random order
      filtered.sort((a, b) => randomOrderCache.current[a.remId] - randomOrderCache.current[b.remId]);
    } else {
      filtered.sort((a, b) => {
        let comparison = 0;
        if (sortBy === 'priority') {
          comparison = a.priority - b.priority;
        } else if (sortBy === 'date') {
          comparison = a.nextRepDate - b.nextRepDate;
        } else if (sortBy === 'reviews') {
          const aReviews = a.history?.length || 0;
          const bReviews = b.history?.length || 0;
          comparison = aReviews - bReviews;
        } else if (sortBy === 'time') {
          const aTime = a.totalTimeSpent || 0;
          const bTime = b.totalTimeSpent || 0;
          comparison = aTime - bTime;
        } else if (sortBy === 'lastReview') {
          const aDate = a.lastReviewDate || 0;
          const bDate = b.lastReviewDate || 0;
          comparison = aDate - bDate;
        }
        return effectiveSortOrder === 'asc' ? comparison : -comparison;
      });
    }

    return filtered;
  }, [incRems, effectiveFilterStatus, filterType, priorityMin, priorityMax, searchText, sortBy, effectiveSortOrder, sortingRandomness]);

  const hasActiveFilters = filterStatus !== 'all' || filterType !== 'all' || priorityMin !== 0 || priorityMax !== 100 || searchText !== '' || selectedDocumentId;

  return (
    <div className="flex flex-col h-full" style={{
      backgroundColor: 'var(--rn-clr-background-primary)',
      minHeight: '400px'
    }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">{icon}</span>
          <span className="font-semibold text-sm" style={{ color: 'var(--rn-clr-content-primary)' }} title={subtitle}>{title}</span>
          <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            <span style={{ color: '#f97316' }}>{dueCount}</span>
            <span> due</span>
            {' / '}
            <span style={{ color: '#3b82f6' }}>{totalCount}</span>
            <span> total</span>
            {filteredAndSortedRems.length !== totalCount && (
              <span> ({filteredAndSortedRems.length} filtered)</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Status toggle */}
          <div className="flex text-xs" style={{ backgroundColor: 'var(--rn-clr-background-primary)', borderRadius: '4px', opacity: sortBy === 'queueOrder' ? 0.5 : 1 }}>
            {(['all', 'due', 'scheduled'] as FilterStatus[]).map((status) => (
              <button
                key={status}
                onClick={() => setFilterStatus(status)}
                disabled={sortBy === 'queueOrder'}
                className={`px-2 py-1 transition-colors ${status === 'all' ? 'rounded-l' : status === 'scheduled' ? 'rounded-r' : ''} ${sortBy === 'queueOrder' && status !== 'due' ? 'cursor-not-allowed' : ''}`}
                style={{
                  backgroundColor: effectiveFilterStatus === status ? 'var(--rn-clr-background-tertiary)' : 'transparent',
                  color: effectiveFilterStatus === status ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-tertiary)',
                }}
                title={sortBy === 'queueOrder' ? "Locked when sorting by Queue Order" : undefined}
              >
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </button>
            ))}
          </div>

          {/* Sort controls */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="px-2 py-1 text-xs rounded"
            style={{
              backgroundColor: 'var(--rn-clr-background-primary)',
              color: 'var(--rn-clr-content-primary)',
              border: 'none',
            }}
          >
            <option value="priority">Priority</option>
            <option value="date">Due Date</option>
            <option value="reviews">Reviews</option>
            <option value="time">Time Spent</option>
            <option value="lastReview">Last Review Date</option>
            <option value="queueOrder">Sort for Review</option>
          </select>
          <button
            onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
            disabled={sortBy === 'queueOrder'}
            className={`px-2 py-1 text-xs rounded transition-colors ${sortBy === 'queueOrder' ? 'cursor-not-allowed' : ''}`}
            style={{
              backgroundColor: 'var(--rn-clr-background-primary)',
              color: 'var(--rn-clr-content-primary)',
              opacity: sortBy === 'queueOrder' ? 0.5 : 1
            }}
            title={sortBy === 'queueOrder' ? 'Locked to Ascending when sorting by Queue Order' : sortOrder === 'asc' ? 'Ascending' : 'Descending'}
          >
            {effectiveSortOrder === 'asc' ? '↑' : '↓'}
          </button>

          {/* Top-Level Review Button */}
          {onReviewAndOpen && filteredAndSortedRems.length > 0 && (
            <button
              onClick={() => {
                const doReview = () =>
                  onReviewAndOpen(filteredAndSortedRems[0].remId, filteredAndSortedRems.slice(1).map(r => r.remId));

                // Warn if not filtered to Due items
                if (effectiveFilterStatus !== 'due') {
                  setPendingReview({ type: 'header', callback: doReview });
                } else {
                  doReview();
                }
              }}
              className="px-3 py-1 text-xs rounded transition-colors font-semibold ml-1"
              style={{
                backgroundColor: '#3b82f6',
                color: 'white',
                border: 'none',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2563eb'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#3b82f6'; }}
              title="Start reviewing this list sequentially in the Editor"
            >
              Review in Editor
            </button>
          )}

          {/* Close button */}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded transition-colors text-xs"
              style={{ color: 'var(--rn-clr-content-tertiary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              title="Close (Esc)"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Due-filter warning banner — header level only */}
      {pendingReview?.type === 'header' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '8px 16px',
            backgroundColor: '#fef3c7',
            borderBottom: '1px solid #f59e0b',
            flexWrap: 'wrap',
            rowGap: '6px',
          }}
        >
          <span style={{ fontSize: '16px', flexShrink: 0 }}>⚠️</span>
          <span style={{ flex: 1, fontSize: '12px', color: '#92400e', fontWeight: 500, minWidth: '180px' }}>
            You are about to review <strong>{filteredAndSortedRems.length}</strong> items — but the list is not
            filtered to <strong>Due</strong> items only. Usually you only want to review what's due
            {dueCount > 0 ? ` (${dueCount} due right now)` : ''}.
          </span>
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            <button
              onClick={() => {
                setFilterStatus('due');
                setPendingReview(null);
              }}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                backgroundColor: '#f59e0b',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 600,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#d97706'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#f59e0b'; }}
              title={`Switch to Due filter (${dueCount} due)`}
            >
              Filter to Due Only
            </button>
            <button
              onClick={() => {
                const cb = pendingReview.callback;
                setPendingReview(null);
                cb();
              }}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                backgroundColor: '#6b7280',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 600,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#4b5563'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#6b7280'; }}
              title="Proceed with the current list as-is"
            >
              Proceed As-Is
            </button>
            <button
              onClick={() => setPendingReview(null)}
              style={{
                padding: '4px 8px',
                fontSize: '12px',
                backgroundColor: 'transparent',
                color: '#92400e',
                border: '1px solid #f59e0b',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
              title="Dismiss warning"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div
        className="flex items-center gap-3 px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}
      >
        {/* Search */}
        <input
          type="text"
          placeholder="Search..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="flex-1 px-2 py-1 text-xs rounded"
          style={{
            backgroundColor: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
            border: 'none',
          }}
        />

        {/* Document filter */}
        {documents && documents.length > 0 && onDocumentFilterChange && (
          <select
            value={selectedDocumentId || ''}
            onChange={(e) => onDocumentFilterChange(e.target.value || null)}
            className="px-2 py-1 text-xs rounded"
            style={{
              backgroundColor: 'var(--rn-clr-background-primary)',
              color: 'var(--rn-clr-content-primary)',
              border: 'none',
              maxWidth: '200px',
            }}
            title="Filter by document"
          >
            <option value="">All documents</option>
            {documents.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.name} ({doc.dueCount}/{doc.count})
              </option>
            ))}
          </select>
        )}

        {/* Rem Type filter */}
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as ActionItemType | 'all')}
          className="px-2 py-1 text-xs rounded"
          style={{
            backgroundColor: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
            border: 'none',
            maxWidth: '120px',
          }}
          title="Filter by Rem Type"
        >
          <option value="all">All Types</option>
          <option value="pdf">PDF</option>
          <option value="pdf-highlight">PDF Highlight</option>
          <option value="pdf-note">PDF Note</option>
          <option value="html">HTML</option>
          <option value="html-highlight">HTML Highlight</option>
          <option value="youtube">YouTube</option>
          <option value="youtube-highlight">Video Extract</option>
          <option value="video">Video</option>
          <option value="rem">Rem</option>
        </select>

        {/* Priority range */}
        <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
          <span>★</span>
          <input
            type="number"
            min="0"
            max="100"
            value={priorityMin}
            onChange={(e) => setPriorityMin(Number(e.target.value))}
            className="w-12 px-1 py-1 text-xs rounded text-center"
            style={{
              backgroundColor: 'var(--rn-clr-background-primary)',
              color: 'var(--rn-clr-content-primary)',
              border: 'none',
            }}
          />
          <span>-</span>
          <input
            type="number"
            min="0"
            max="100"
            value={priorityMax}
            onChange={(e) => setPriorityMax(Number(e.target.value))}
            className="w-12 px-1 py-1 text-xs rounded text-center"
            style={{
              backgroundColor: 'var(--rn-clr-background-primary)',
              color: 'var(--rn-clr-content-primary)',
              border: 'none',
            }}
          />
        </div>

        {/* Reset button */}
        {hasActiveFilters && (
          <button
            onClick={() => {
              setFilterStatus('all');
              setFilterType('all');
              setPriorityMin(0);
              setPriorityMax(100);
              setSearchText('');
              onDocumentFilterChange?.(null);
            }}
            className="px-2 py-1 text-xs rounded transition-colors"
            style={{ color: 'var(--rn-clr-content-tertiary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            title="Reset filters"
          >
            ✕
          </button>
        )}
      </div>

      {/* Rem List */}
      <div className="flex-1 overflow-y-auto px-3 py-2" style={{ minHeight: 0 }}>
        {loading ? (
          <div className="text-center py-6 text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>Loading...</div>
        ) : filteredAndSortedRems.length === 0 ? (
          <div className="text-center py-6 text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            {incRems.length === 0 ? 'No incremental rems' : 'No matches'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filteredAndSortedRems.map((incRem) => (
              <React.Fragment key={incRem.remId}>
                <IncRemRow
                  incRem={{
                    ...incRem,
                    historyCount: incRem.history?.length,
                    totalTimeSpent: incRem.totalTimeSpent,
                    lastReviewDate: incRem.lastReviewDate,
                    breadcrumb: incRem.breadcrumb,
                  } as IncRemRowData}
                  onClick={() => onRemClick(incRem.remId)}
                  // Priority editing
                  onPriorityClick={onPriorityChange ? (remId) => {
                    if (editingPriorityRemId === remId) {
                      setEditingPriorityRemId(null);
                    } else {
                      setEditingPriorityRemId(remId);
                      setEditingPriorityValue(incRem.priority);
                      editingPriorityValueRef.current = incRem.priority;
                    }
                  } : undefined}
                  editingPriority={editingPriorityRemId === incRem.remId ? { value: editingPriorityValue } : undefined}
                  onPriorityChange={(value) => {
                    setEditingPriorityValue(value);
                    editingPriorityValueRef.current = value;
                  }}
                  onPrioritySave={async (remId) => {
                    if (onPriorityChange) {
                      await onPriorityChange(remId, editingPriorityValueRef.current);
                    }
                    setEditingPriorityRemId(null);
                  }}
                  onPriorityCancel={() => setEditingPriorityRemId(null)}
                  // Review & Open
                  onReviewAndOpen={(remId) => {
                    if (onReviewAndOpen) {
                      const idx = filteredAndSortedRems.findIndex(r => r.remId === remId);
                      // Queue = clicked item + everything after it
                      const queueSlice = idx >= 0 ? filteredAndSortedRems.slice(idx) : [];
                      const subsequentIds = queueSlice.slice(1).map(r => r.remId);
                      const doReview = () => onReviewAndOpen(remId, subsequentIds);
                      if (effectiveFilterStatus !== 'due') {
                        const now = Date.now();
                        const dueCountInQueue = queueSlice.filter(r => r.nextRepDate <= now).length;
                        setPendingReview({
                          type: 'row',
                          triggerRemId: remId,
                          queueCount: queueSlice.length,
                          dueCountInQueue,
                          callback: doReview,
                        });
                      } else {
                        doReview();
                      }
                    }
                  }}
                />

                {/* Inline row-level due-filter warning */}
                {pendingReview?.type === 'row' && pendingReview.triggerRemId === incRem.remId && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '8px 12px',
                      backgroundColor: '#fef3c7',
                      border: '1px solid #f59e0b',
                      borderRadius: '6px',
                      flexWrap: 'wrap',
                      rowGap: '6px',
                      marginTop: '-4px',
                    }}
                  >
                    <span style={{ fontSize: '14px', flexShrink: 0 }}>⚠️</span>
                    <span style={{ flex: 1, fontSize: '11px', color: '#92400e', fontWeight: 500, minWidth: '160px' }}>
                      Reviewing <strong>{pendingReview.queueCount}</strong> items from here onwards —
                      only <strong>{pendingReview.dueCountInQueue}</strong> of them {pendingReview.dueCountInQueue === 1 ? 'is' : 'are'} due.
                      Consider filtering to <strong>Due</strong> only first.
                    </span>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      <button
                        onClick={() => {
                          setFilterStatus('due');
                          setPendingReview(null);
                        }}
                        style={{
                          padding: '3px 8px',
                          fontSize: '11px',
                          backgroundColor: '#f59e0b',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#d97706'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#f59e0b'; }}
                        title="Switch to Due filter"
                      >
                        Filter to Due Only
                      </button>
                      <button
                        onClick={() => {
                          const cb = pendingReview.callback;
                          setPendingReview(null);
                          cb();
                        }}
                        style={{
                          padding: '3px 8px',
                          fontSize: '11px',
                          backgroundColor: '#6b7280',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#4b5563'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#6b7280'; }}
                        title="Proceed with current list"
                      >
                        Proceed As-Is
                      </button>
                      <button
                        onClick={() => setPendingReview(null)}
                        style={{
                          padding: '3px 6px',
                          fontSize: '11px',
                          backgroundColor: 'transparent',
                          color: '#92400e',
                          border: '1px solid #f59e0b',
                          borderRadius: '4px',
                          cursor: 'pointer',
                        }}
                        title="Dismiss"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
