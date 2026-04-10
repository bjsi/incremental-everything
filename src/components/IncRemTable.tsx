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
  // createdAt is already part of IncrementalRem base type (from originalIncrementalDateSlotCode)
}

type FilterStatus = 'all' | 'due' | 'scheduled';
type SortBy = 'priority' | 'date' | 'reviews' | 'time' | 'lastReview' | 'createdAt' | 'queueOrder';
type SortOrder = 'asc' | 'desc';
type DateFilterOp = 'is' | 'before' | 'after' | 'on-or-before' | 'on-or-after' | 'between';

interface DateFilter {
  op: DateFilterOp;
  value: string;   // YYYY-MM-DD or N (days ago)
  value2: string;  // only used for 'between'
}

const defaultDateFilter = (): DateFilter => ({ op: 'on-or-after', value: '', value2: '' });

export interface IncRemListState {
  filterStatus: FilterStatus;
  filterType: ActionItemType | 'all';
  priorityMin: number;
  priorityMax: number;
  searchText: string;
  sortBy: SortBy;
  sortOrder: SortOrder;
  dueDateFilter?: DateFilter;
  lastReviewFilter?: DateFilter;
  createdAtFilter?: DateFilter;
}

export interface DocumentInfo {
  id: string;
  name: string;
  count: number;
  dueCount: number;
}

// ─── CalendarPickerButton ─────────────────────────────────────────────────────
// Uses a ref to an always-mounted hidden <input type="date"> and calls
// .showPicker() imperatively — the only reliable cross-browser way to open
// the native calendar from a custom button.
interface CalendarPickerButtonProps {
  value: string;
  onPick: (date: string) => void;
}

function CalendarPickerButton({ value, onPick }: CalendarPickerButtonProps) {
  const pickerRef = useRef<HTMLInputElement>(null);

  const handleButtonClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const input = pickerRef.current;
    if (!input) return;
    // showPicker() is the standard imperative API (Chrome 99+, Firefox 101+, Safari 16+)
    if (typeof input.showPicker === 'function') {
      input.showPicker();
    } else {
      // Fallback: make the input briefly interactive so the user can click it
      input.style.opacity = '1';
      input.style.height = '24px';
      input.focus();
      setTimeout(() => {
        if (pickerRef.current) {
          pickerRef.current.style.opacity = '0';
          pickerRef.current.style.height = '0';
        }
      }, 2000);
    }
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      {/* Always-mounted hidden native date input — positioned over the button */}
      <input
        ref={pickerRef}
        type="date"
        value={value}
        onChange={(e) => onPick(e.target.value)}
        tabIndex={-1}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          width: '22px',
          height: '22px',
          opacity: 0,
          cursor: 'pointer',
          zIndex: 1,
          // Hide the default calendar icon; we provide our own button
          colorScheme: 'light dark',
        }}
      />
      {/* Visual 📅 button sits below the invisible input in stacking order */}
      <button
        onClick={handleButtonClick}
        title="Pick date from calendar"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '0 2px',
          color: 'var(--rn-clr-content-tertiary)',
          fontSize: 11,
          lineHeight: 1,
          position: 'relative',
          zIndex: 0,
        }}
      >
        📅
      </button>
    </div>
  );
}

// ─── DateFilterField ─────────────────────────────────────────────────────────
interface DateFilterFieldProps {
  label: string;
  filter: { op: string; value: string; value2: string };
  onChange: (f: { op: any; value: string; value2: string }) => void;
}

function DateFilterField({ label, filter, onChange }: DateFilterFieldProps) {
  // Validate: empty = ok, plain integer (N days ago) = ok, MM/DD/YYYY or MM/DD = ok, else invalid
  const isValueInvalid = (v: string): boolean => {
    const trimmed = v.trim();
    if (!trimmed) return false;
    // Pure integer → N days ago → always valid
    if (/^\d+$/.test(trimmed)) return false;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
      const [m, d, y] = trimmed.split('/').map(Number);
      return isNaN(new Date(y, m - 1, d).getTime());
    }
    if (/^\d{1,2}\/\d{1,2}$/.test(trimmed)) {
      const [m, d] = trimmed.split('/').map(Number);
      return isNaN(new Date(new Date().getFullYear(), m - 1, d).getTime());
    }
    return true; // anything else is invalid
  };

  const makeInputStyle = (value: string): React.CSSProperties => {
    const invalid = isValueInvalid(value);
    return {
      backgroundColor: invalid ? 'rgba(239,68,68,0.08)' : 'var(--rn-clr-background-primary)',
      color: 'var(--rn-clr-content-primary)',
      border: `1px solid ${invalid ? '#ef4444' : 'var(--rn-clr-border-primary)'}`,
      borderRadius: 4,
      padding: '1px 4px',
      fontSize: 11,
      width: 100,
      outline: 'none',
      transition: 'border-color 0.15s, background-color 0.15s',
    };
  };

  const selectStyle: React.CSSProperties = {
    backgroundColor: 'var(--rn-clr-background-primary)',
    color: 'var(--rn-clr-content-secondary)',
    border: '1px solid var(--rn-clr-border-primary)',
    borderRadius: 4,
    padding: '1px 2px',
    fontSize: 11,
    outline: 'none',
    cursor: 'pointer',
  };

  const isBetween = filter.op === 'between';
  const hasValue = filter.value.trim() !== '';
  const PLACEHOLDER = 'MM/DD/YYYY or N days';

  // Normalize MM/DD/YYYY or MM/DD to YYYY-MM-DD for the native date picker value
  const toPickerValue = (v: string): string => {
    const full = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (full) {
      const [, m, d, y] = full;
      return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
    const short = v.trim().match(/^(\d{1,2})\/(\d{1,2})$/);
    if (short) {
      const [, m, d] = short;
      const y = new Date().getFullYear();
      return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
    return '';
  };

  // Convert YYYY-MM-DD from the picker back to MM/DD/YYYY
  const fromPickerValue = (iso: string): string => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return iso;
    return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
      <span style={{ color: 'var(--rn-clr-content-tertiary)', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <select
        value={filter.op}
        onChange={(e) => onChange({ ...filter, op: e.target.value as any })}
        style={selectStyle}
        title="Filter comparison"
      >
        <option value="is">is</option>
        <option value="before">is before</option>
        <option value="after">is after</option>
        <option value="on-or-before">is on/before</option>
        <option value="on-or-after">is on/after</option>
        <option value="between">is between</option>
      </select>
      <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <input
          type="text"
          placeholder={PLACEHOLDER}
          value={filter.value}
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
          style={makeInputStyle(filter.value)}
        />
        <CalendarPickerButton
          value={toPickerValue(filter.value)}
          onPick={(iso) => onChange({ ...filter, value: fromPickerValue(iso) })}
        />
      </div>
      {isBetween && (
        <>
          <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>–</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <input
              type="text"
              placeholder={PLACEHOLDER}
              value={filter.value2}
              onChange={(e) => onChange({ ...filter, value2: e.target.value })}
              style={makeInputStyle(filter.value2)}
            />
            <CalendarPickerButton
              value={toPickerValue(filter.value2)}
              onPick={(iso) => onChange({ ...filter, value2: fromPickerValue(iso) })}
            />
          </div>
        </>
      )}
      {hasValue && (
        <button
          onClick={() => onChange({ ...filter, value: '', value2: '' })}
          title="Clear this date filter"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0 2px',
            color: 'var(--rn-clr-content-tertiary)',
            fontSize: 11,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

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
  onReviewInEditor?: (remId: string, subsequentRemIds?: string[]) => void;
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
  onReviewInEditor,
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

  // Date filters
  const [dueDateFilter, setDueDateFilter] = useState<DateFilter>(initialState?.dueDateFilter ?? defaultDateFilter());
  const [lastReviewFilter, setLastReviewFilter] = useState<DateFilter>(initialState?.lastReviewFilter ?? defaultDateFilter());
  const [createdAtFilter, setCreatedAtFilter] = useState<DateFilter>(initialState?.createdAtFilter ?? defaultDateFilter());

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
      onStateChange({ filterStatus, filterType, priorityMin, priorityMax, searchText, sortBy, sortOrder, dueDateFilter, lastReviewFilter, createdAtFilter });
    }
  }, [filterStatus, filterType, priorityMin, priorityMax, searchText, sortBy, sortOrder, dueDateFilter, lastReviewFilter, createdAtFilter, onStateChange]);

  /**
   * Parse a filter field value string → millisecond timestamp.
   * Accepts:
   *   - MM/DD/YYYY → that specific date
   *   - MM/DD      → that month/day in the current year
   * Returns null for empty or unrecognised input.
   */
  function parseDateValue(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Plain integer N → N days ago from now
    if (/^\d+$/.test(trimmed)) {
      return Date.now() - Number(trimmed) * 86_400_000;
    }

    // MM/DD/YYYY
    const fullMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (fullMatch) {
      const d = new Date(Number(fullMatch[3]), Number(fullMatch[1]) - 1, Number(fullMatch[2]));
      return isNaN(d.getTime()) ? null : d.getTime();
    }

    // MM/DD → current year
    const shortMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (shortMatch) {
      const year = new Date().getFullYear();
      const d = new Date(year, Number(shortMatch[1]) - 1, Number(shortMatch[2]));
      return isNaN(d.getTime()) ? null : d.getTime();
    }

    return null;
  }

  /**
   * Given a timestamp `ts` and a DateFilter, returns true if `ts` passes the filter.
   * A missing / empty filter always passes.
   */
  function passesDateFilter(ts: number | undefined, filter: DateFilter): boolean {
    const { op, value, value2 } = filter;
    if (!value.trim()) return true; // no filter set
    const cutoff = parseDateValue(value);
    if (cutoff === null) return true; // unparseable value — don't filter
    const t = ts ?? 0;
    switch (op) {
      case 'is':          return t >= cutoff && t < cutoff + 86_400_000; // same day
      case 'before':      return t < cutoff;
      case 'after':       return t > cutoff + 86_399_999; // strictly after that day ends
      case 'on-or-before': return t < cutoff + 86_400_000;
      case 'on-or-after':  return t >= cutoff;
      case 'between': {
        const cutoff2 = parseDateValue(value2);
        if (cutoff2 === null) return t >= cutoff;
        const lo = Math.min(cutoff, cutoff2);
        const hi = Math.max(cutoff, cutoff2) + 86_399_999;
        return t >= lo && t <= hi;
      }
      default: return true;
    }
  }

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
      // Date filters
      if (!passesDateFilter(rem.nextRepDate, dueDateFilter)) return false;
      if (!passesDateFilter(rem.lastReviewDate, lastReviewFilter)) return false;
      if (!passesDateFilter(rem.createdAt, createdAtFilter)) return false;
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
        } else if (sortBy === 'createdAt') {
          const aDate = a.createdAt || 0;
          const bDate = b.createdAt || 0;
          comparison = aDate - bDate;
        }
        return effectiveSortOrder === 'asc' ? comparison : -comparison;
      });
    }

    return filtered;
  }, [incRems, effectiveFilterStatus, filterType, priorityMin, priorityMax, searchText, sortBy, effectiveSortOrder, sortingRandomness, dueDateFilter, lastReviewFilter, createdAtFilter]);

  const hasDateFilter = (f: DateFilter) => f.value.trim() !== '';
  const hasActiveFilters = filterStatus !== 'all' || filterType !== 'all' || priorityMin !== 0 || priorityMax !== 100 || searchText !== '' || selectedDocumentId ||
    hasDateFilter(dueDateFilter) || hasDateFilter(lastReviewFilter) || hasDateFilter(createdAtFilter);

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
            <option value="createdAt">Created At</option>
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
          {onReviewInEditor && filteredAndSortedRems.length > 0 && (
            <button
              onClick={() => {
                const doReview = () =>
                  onReviewInEditor(filteredAndSortedRems[0].remId, filteredAndSortedRems.slice(1).map(r => r.remId));

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
              setDueDateFilter(defaultDateFilter());
              setLastReviewFilter(defaultDateFilter());
              setCreatedAtFilter(defaultDateFilter());
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

      {/* Date filter bar */}
      <div
        className="flex flex-col px-4 py-1.5 shrink-0"
        style={{ borderBottom: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1" style={{ fontSize: '11px' }}>
          {/* Due Date filter */}
          <DateFilterField
            label="Due"
            filter={dueDateFilter}
            onChange={setDueDateFilter}
          />
          {/* Last Review filter */}
          <DateFilterField
            label="Last Review"
            filter={lastReviewFilter}
            onChange={setLastReviewFilter}
          />
          {/* Created At filter */}
          <DateFilterField
            label="Created"
            filter={createdAtFilter}
            onChange={setCreatedAtFilter}
          />
        </div>
        <div style={{ fontSize: 9, color: 'var(--rn-clr-content-tertiary)', marginTop: 2, letterSpacing: '0.01em' }}>
          Date formats: MM/DD/YYYY · MM/DD (current year) · N (days ago). Use the 📅 button to pick from a calendar.
        </div>
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
                    createdAt: incRem.createdAt,
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
                  // Review in Editor
                  onReviewInEditor={(remId) => {
                    if (onReviewInEditor) {
                      const idx = filteredAndSortedRems.findIndex(r => r.remId === remId);
                      // Queue = clicked item + everything after it
                      const queueSlice = idx >= 0 ? filteredAndSortedRems.slice(idx) : [];
                      const subsequentIds = queueSlice.slice(1).map(r => r.remId);
                      const doReview = () => onReviewInEditor(remId, subsequentIds);
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
