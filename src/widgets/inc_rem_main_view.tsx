import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useState, useMemo } from 'react';
import { allIncrementalRemKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { ActionItemType } from '../lib/incremental_rem/types';
import { extractText, determineIncRemType } from '../lib/incRemHelpers';
import { IncRemRow, IncRemRowData } from '../components';

interface IncRemWithDetails extends IncrementalRem {
  remText?: string;
  incRemType?: ActionItemType;
  percentile?: number;
}

type FilterStatus = 'all' | 'due' | 'scheduled';
type SortBy = 'priority' | 'date' | 'reviews';
type SortOrder = 'asc' | 'desc';

export function IncRemMainView() {
  const plugin = usePlugin();
  const [loadingRems, setLoadingRems] = useState<boolean>(false);
  const [incRemsWithDetails, setIncRemsWithDetails] = useState<IncRemWithDetails[]>([]);

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

    const sortedByPriority = [...incRems].sort((a, b) => a.priority - b.priority);
    const percentiles: Record<string, number> = {};
    sortedByPriority.forEach((item, index) => {
      percentiles[item.remId] = Math.round(((index + 1) / sortedByPriority.length) * 100);
    });

    const remsWithDetails = await Promise.all(
      incRems.map(async (incRem) => {
        try {
          const rem = await plugin.rem.findOne(incRem.remId);
          if (!rem) return null;

          const text = await rem.text;
          let textStr = extractText(text);
          if (textStr.length > 300) textStr = textStr.substring(0, 300) + '...';

          const incRemType = await determineIncRemType(plugin, rem);

          return {
            ...incRem,
            remText: textStr || '[Empty rem]',
            incRemType,
            percentile: percentiles[incRem.remId],
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
      if (filterStatus === 'due' && rem.nextRepDate > now) return false;
      if (filterStatus === 'scheduled' && rem.nextRepDate <= now) return false;
      if (rem.priority < priorityMin || rem.priority > priorityMax) return false;
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

  const hasActiveFilters = filterStatus !== 'all' || priorityMin !== 0 || priorityMax !== 100 || searchText !== '';

  return (
    <div className="flex flex-col h-full" style={{
      backgroundColor: 'var(--rn-clr-background-primary)',
      minHeight: '500px'
    }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">📊</span>
          <span className="font-semibold text-sm" style={{ color: 'var(--rn-clr-content-primary)' }}>All Inc Rems</span>
          <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            <span style={{ color: '#f97316' }}>{dueCount}</span>
            {' / '}
            <span style={{ color: '#3b82f6' }}>{totalCount}</span>
            {filteredAndSortedRems.length !== totalCount && (
              <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> ({filteredAndSortedRems.length})</span>
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
            <option value="date">Date</option>
            <option value="reviews">Reviews</option>
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
        </div>
      </div>

      {/* Filter Bar - compact */}
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
              setPriorityMin(0);
              setPriorityMax(100);
              setSearchText('');
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
        {loadingRems ? (
          <div className="text-center py-6 text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>Loading...</div>
        ) : filteredAndSortedRems.length === 0 ? (
          <div className="text-center py-6 text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            {incRemsWithDetails.length === 0 ? 'No incremental rems' : 'No matches'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filteredAndSortedRems.map((incRem) => (
              <IncRemRow
                key={incRem.remId}
                incRem={{
                  ...incRem,
                  historyCount: incRem.history?.length,
                } as IncRemRowData}
                onClick={() => handleRemClick(incRem.remId)}
                compact={false}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

renderWidget(IncRemMainView);
