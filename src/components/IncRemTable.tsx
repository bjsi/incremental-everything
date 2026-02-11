import React, { useState, useMemo } from 'react';
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
type SortBy = 'priority' | 'date' | 'reviews' | 'time' | 'lastReview';
type SortOrder = 'asc' | 'desc';

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
}: IncRemTableProps) {
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [filterType, setFilterType] = useState<ActionItemType | 'all'>('all');
  const [priorityMin, setPriorityMin] = useState<number>(0);
  const [priorityMax, setPriorityMax] = useState<number>(100);
  const [searchText, setSearchText] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortBy>('priority');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  const filteredAndSortedRems = useMemo(() => {
    const now = Date.now();

    let filtered = incRems.filter((rem) => {
      if (filterStatus === 'due' && rem.nextRepDate > now) return false;
      if (filterStatus === 'scheduled' && rem.nextRepDate <= now) return false;
      if (rem.priority < priorityMin || rem.priority > priorityMax) return false;
      if (filterType !== 'all' && rem.incRemType !== filterType) return false;
      if (searchText && rem.remText && !rem.remText.toLowerCase().includes(searchText.toLowerCase())) {
        return false;
      }
      return true;
    });

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
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [incRems, filterStatus, filterType, priorityMin, priorityMax, searchText, sortBy, sortOrder]);

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
          <span className="font-semibold text-sm" style={{ color: 'var(--rn-clr-content-primary)' }}>{title}</span>
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
          <div className="flex text-xs" style={{ backgroundColor: 'var(--rn-clr-background-primary)', borderRadius: '4px' }}>
            {(['all', 'due', 'scheduled'] as FilterStatus[]).map((status) => (
              <button
                key={status}
                onClick={() => setFilterStatus(status)}
                className={`px-2 py-1 transition-colors ${status === 'all' ? 'rounded-l' : status === 'scheduled' ? 'rounded-r' : ''}`}
                style={{
                  backgroundColor: filterStatus === status ? 'var(--rn-clr-background-tertiary)' : 'transparent',
                  color: filterStatus === status ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-tertiary)',
                }}
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
          </select>
          <button
            onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
            className="px-2 py-1 text-xs rounded transition-colors"
            style={{
              backgroundColor: 'var(--rn-clr-background-primary)',
              color: 'var(--rn-clr-content-primary)',
            }}
            title={sortOrder === 'asc' ? 'Ascending' : 'Descending'}
          >
            {sortOrder === 'asc' ? '↑' : '↓'}
          </button>

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
              <IncRemRow
                key={incRem.remId}
                incRem={{
                  ...incRem,
                  historyCount: incRem.history?.length,
                  totalTimeSpent: incRem.totalTimeSpent,
                  lastReviewDate: incRem.lastReviewDate,
                  breadcrumb: incRem.breadcrumb,
                } as IncRemRowData}
                onClick={() => onRemClick(incRem.remId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
