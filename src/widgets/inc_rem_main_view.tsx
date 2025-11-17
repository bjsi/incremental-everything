import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useState, useMemo } from 'react';
import { allIncrementalRemKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

// Inject CSS for hover effects
const style = document.createElement('style');
style.textContent = `
  .inc-rem-item:hover {
    background-color: var(--rn-clr-background-tertiary) !important;
  }
`;
document.head.appendChild(style);

// Main view for all incremental rems with advanced filtering and sorting

interface IncRemWithDetails extends IncrementalRem {
  remText?: string;
}

type FilterStatus = 'all' | 'due' | 'scheduled';
type SortBy = 'priority' | 'date' | 'reviews';
type SortOrder = 'asc' | 'desc';

export function IncRemMainView() {
  const plugin = usePlugin();
  const [loadingRems, setLoadingRems] = useState<boolean>(false);
  const [incRemsWithDetails, setIncRemsWithDetails] = useState<IncRemWithDetails[]>([]);

  // Filter states
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [priorityMin, setPriorityMin] = useState<number>(0);
  const [priorityMax, setPriorityMax] = useState<number>(100);
  const [searchText, setSearchText] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortBy>('priority');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  const allIncRems = useTrackerPlugin(
    async (rp) => {
      try {
        const incRems = (await rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
        loadIncRemDetails(incRems);
        return incRems;
      } catch (error) {
        console.error('INC REM MAIN VIEW: Error loading incRems', error);
        return [];
      }
    },
    []
  );

  const loadIncRemDetails = async (incRems: IncrementalRem[]) => {
    if (loadingRems) return;

    setLoadingRems(true);

    const remsWithDetails = await Promise.all(
      incRems.map(async (incRem) => {
        try {
          const rem = await plugin.rem.findOne(incRem.remId);
          if (!rem) return null;

          const text = await rem.text;
          let textStr: string;

          if (typeof text === 'string') {
            textStr = text;
          } else if (Array.isArray(text)) {
            textStr = text
              .map((item: any) => {
                if (typeof item === 'string') return item;
                if (item?.text) return item.text;
                if (item?.i === 'q') return '[Quote]';
                if (item?.i === 'i') return '[Image]';
                if (item?.url) return '[Link]';
                return '';
              })
              .filter(Boolean)
              .join(' ');

            if (!textStr) textStr = '[Complex content]';
          } else {
            textStr = '[Complex content]';
          }

          if (textStr.length > 300) {
            textStr = textStr.substring(0, 300) + '...';
          }

          return {
            ...incRem,
            remText: textStr || '[Empty rem]',
          };
        } catch (error) {
          console.error('Error loading rem details:', error);
          return null;
        }
      })
    );

    setIncRemsWithDetails(remsWithDetails.filter((rem): rem is IncRemWithDetails => rem !== null));
    setLoadingRems(false);
  };

  const filteredAndSortedRems = useMemo(() => {
    const now = Date.now();

    let filtered = incRemsWithDetails.filter((rem) => {
      // Status filter
      if (filterStatus === 'due' && rem.nextRepDate > now) return false;
      if (filterStatus === 'scheduled' && rem.nextRepDate <= now) return false;

      // Priority filter
      if (rem.priority < priorityMin || rem.priority > priorityMax) return false;

      // Search filter
      if (searchText && rem.remText && !rem.remText.toLowerCase().includes(searchText.toLowerCase())) {
        return false;
      }

      return true;
    });

    // Sorting
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
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [incRemsWithDetails, filterStatus, priorityMin, priorityMax, searchText, sortBy, sortOrder]);

  const handleRemClick = async (remId: string) => {
    try {
      const rem = await plugin.rem.findOne(remId);
      if (rem) {
        await plugin.window.openRem(rem);
        await plugin.widget.closePopup();
      }
    } catch (error) {
      console.error('Error opening rem:', error);
    }
  };

  const now = Date.now();
  const dueCount = incRemsWithDetails.filter((r) => r.nextRepDate <= now).length;
  const totalCount = incRemsWithDetails.length;

  return (
    <div className="flex flex-col h-full" style={{
      backgroundColor: 'var(--rn-clr-background-primary)',
      minHeight: '600px'
    }}>
      {/* Header */}
      <div className="px-6 py-5" style={{
        borderBottom: '1px solid var(--rn-clr-border-primary)',
        backgroundColor: 'var(--rn-clr-background-secondary)'
      }}>
        <div className="flex items-center gap-3">
          <div className="text-3xl">📊</div>
          <div>
            <h2 className="text-2xl font-bold" style={{ color: 'var(--rn-clr-content-primary)' }}>
              All Incremental Rems
            </h2>
            <div className="text-sm mt-1" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              <span className="font-semibold" style={{ color: '#f97316' }}>{dueCount}</span> due
              {' • '}
              <span className="font-semibold" style={{ color: '#3b82f6' }}>{totalCount}</span> total
              {filteredAndSortedRems.length !== totalCount && (
                <>
                  {' • '}
                  <span className="font-semibold">{filteredAndSortedRems.length}</span> filtered
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="px-6 py-4" style={{
        borderBottom: '1px solid var(--rn-clr-border-primary)',
        backgroundColor: 'var(--rn-clr-background-secondary)'
      }}>
        <div className="flex flex-col gap-4">
          {/* Row 1: Status and Sort */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                Status:
              </label>
              <div className="flex gap-1">
                {(['all', 'due', 'scheduled'] as FilterStatus[]).map((status) => (
                  <button
                    key={status}
                    onClick={() => setFilterStatus(status)}
                    className="px-3 py-1 text-sm rounded transition-all"
                    style={{
                      backgroundColor: filterStatus === status ? 'var(--rn-clr-background-tertiary)' : 'transparent',
                      color: filterStatus === status ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-secondary)',
                      border: filterStatus === status ? '1px solid var(--rn-clr-border-primary)' : '1px solid transparent',
                      fontWeight: filterStatus === status ? 600 : 400
                    }}
                  >
                    {status.charAt(0).toUpperCase() + status.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm font-medium" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                Sort by:
              </label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="px-3 py-1 text-sm rounded"
                style={{
                  backgroundColor: 'var(--rn-clr-background-tertiary)',
                  color: 'var(--rn-clr-content-primary)',
                  border: '1px solid var(--rn-clr-border-primary)'
                }}
              >
                <option value="priority">Priority</option>
                <option value="date">Due Date</option>
                <option value="reviews">Review Count</option>
              </select>
              <button
                onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                className="px-3 py-1 text-sm rounded transition-all flex items-center gap-1"
                style={{
                  backgroundColor: 'var(--rn-clr-background-tertiary)',
                  color: 'var(--rn-clr-content-primary)',
                  border: '1px solid var(--rn-clr-border-primary)',
                  cursor: 'pointer',
                  fontWeight: 500
                }}
                title={`Click to sort ${sortOrder === 'asc' ? 'descending' : 'ascending'}`}
              >
                {sortOrder === 'asc' ? '↑ Asc' : '↓ Desc'}
              </button>
            </div>
          </div>

          {/* Row 2: Priority Range */}
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              Priority:
            </label>
            <div className="flex items-center gap-3 flex-1">
              <input
                type="number"
                min="0"
                max="100"
                value={priorityMin}
                onChange={(e) => setPriorityMin(Number(e.target.value))}
                className="w-16 px-2 py-1 text-sm rounded"
                style={{
                  backgroundColor: 'var(--rn-clr-background-tertiary)',
                  color: 'var(--rn-clr-content-primary)',
                  border: '1px solid var(--rn-clr-border-primary)'
                }}
              />
              <span style={{ color: 'var(--rn-clr-content-secondary)' }}>to</span>
              <input
                type="number"
                min="0"
                max="100"
                value={priorityMax}
                onChange={(e) => setPriorityMax(Number(e.target.value))}
                className="w-16 px-2 py-1 text-sm rounded"
                style={{
                  backgroundColor: 'var(--rn-clr-background-tertiary)',
                  color: 'var(--rn-clr-content-primary)',
                  border: '1px solid var(--rn-clr-border-primary)'
                }}
              />
            </div>

            {/* Search */}
            <div className="flex items-center gap-2 flex-1">
              <label className="text-sm font-medium" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                Search:
              </label>
              <input
                type="text"
                placeholder="Filter by text..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="flex-1 px-3 py-1 text-sm rounded"
                style={{
                  backgroundColor: 'var(--rn-clr-background-tertiary)',
                  color: 'var(--rn-clr-content-primary)',
                  border: '1px solid var(--rn-clr-border-primary)'
                }}
              />
            </div>
          </div>

          {/* Reset filters button */}
          {(filterStatus !== 'all' || priorityMin !== 0 || priorityMax !== 100 || searchText !== '' || sortOrder !== 'asc') && (
            <button
              onClick={() => {
                setFilterStatus('all');
                setPriorityMin(0);
                setPriorityMax(100);
                setSearchText('');
                setSortOrder('asc');
              }}
              className="self-start px-3 py-1 text-sm rounded transition-colors"
              style={{
                backgroundColor: 'var(--rn-clr-background-tertiary)',
                color: 'var(--rn-clr-content-secondary)',
                border: '1px solid var(--rn-clr-border-primary)'
              }}
            >
              Reset Filters
            </button>
          )}
        </div>
      </div>

      {/* Rem List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loadingRems ? (
          <div className="text-center py-8" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            Loading rems...
          </div>
        ) : filteredAndSortedRems.length === 0 ? (
          <div className="text-center py-8" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            {incRemsWithDetails.length === 0 ? 'No incremental rems found' : 'No rems match the current filters'}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filteredAndSortedRems.map((incRem) => {
              const isDue = incRem.nextRepDate <= now;
              return (
                <div
                  key={incRem.remId}
                  onClick={() => handleRemClick(incRem.remId)}
                  className="inc-rem-item group relative p-4 rounded cursor-pointer transition-all"
                  style={{
                    backgroundColor: 'var(--rn-clr-background-secondary)',
                    border: '1px solid var(--rn-clr-border-primary)',
                    borderLeft: `4px solid ${isDue ? '#f97316' : '#3b82f6'}`,
                  }}
                >
                  <div className="font-medium text-base mb-2 pr-6" style={{ color: 'var(--rn-clr-content-primary)' }}>
                    {incRem.remText || 'Loading...'}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded" style={{
                      backgroundColor: isDue ? '#fed7aa' : '#bfdbfe',
                      color: isDue ? '#9a3412' : '#1e3a8a'
                    }}>
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                      {incRem.priority}
                    </span>
                    <span style={{ color: 'var(--rn-clr-content-secondary)' }}>
                      {isDue ? '⚠️ ' : '📅 '}
                      Due {dayjs(incRem.nextRepDate).fromNow()}
                    </span>
                    {incRem.history && incRem.history.length > 0 && (
                      <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                        • {incRem.history.length} review{incRem.history.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  {incRem.history && incRem.history.length > 0 && (
                    <div className="mt-2 pt-2 text-xs" style={{
                      borderTop: '1px solid var(--rn-clr-border-primary)',
                      color: 'var(--rn-clr-content-tertiary)'
                    }}>
                      Last reviewed {dayjs(incRem.history[incRem.history.length - 1].date).fromNow()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

renderWidget(IncRemMainView);
