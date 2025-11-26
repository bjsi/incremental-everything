import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useState } from 'react';
import { allIncrementalRemKey, popupDocumentIdKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { ActionItemType } from '../lib/incremental_rem/types';
import { buildDocumentScope } from '../lib/scope_helpers';
import { extractText, determineIncRemType } from '../lib/incRemHelpers';
import { IncRemRow, IncRemRowData } from '../components';
import '../style.css';
import '../App.css';

interface IncRemWithDetails extends IncrementalRem {
  remText?: string;
  incRemType?: ActionItemType;
  percentile?: number;
}

function IncRemSection({ title, count, color, rems, onRemClick }: {
  title: string;
  count: number;
  color: string;
  rems: IncRemWithDetails[];
  onRemClick: (remId: string) => void;
}) {
  const [collapsed, setCollapsed] = React.useState(false);

  if (rems.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 w-full text-left py-1 px-1 rounded transition-colors"
        style={{ color }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
      >
        <span className="text-xs transition-transform" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
        <span className="font-semibold text-xs uppercase tracking-wide">{title}</span>
        <span className="text-xs font-normal opacity-70">({count})</span>
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-1 mt-1">
          {rems.map((incRem) => (
            <IncRemRow
              key={incRem.remId}
              incRem={incRem as IncRemRowData}
              onClick={() => onRemClick(incRem.remId)}
              compact
            />
          ))}
        </div>
      )}
    </div>
  );
}

type SortOption = 'date' | 'priority';

export function IncRemList() {
  const plugin = usePlugin();
  const [loadingRems, setLoadingRems] = useState(false);
  const [incRemsWithDetails, setIncRemsWithDetails] = useState<IncRemWithDetails[]>([]);
  const [sortBy, setSortBy] = useState<SortOption>('date');

  const counterData = useTrackerPlugin(
    async (rp) => {
      try {
        const documentId = await rp.storage.getSession(popupDocumentIdKey);
        const allIncRems = (await rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
        const now = Date.now();

        if (!documentId) {
          const dueIncRems = allIncRems.filter((incRem) => incRem.nextRepDate <= now);
          loadIncRemDetails(allIncRems);
          return { due: dueIncRems.length, total: allIncRems.length, incRems: allIncRems };
        }

        const documentScope = await buildDocumentScope(rp, documentId);
        if (documentScope.size === 0) {
          return { due: 0, total: 0, incRems: [] };
        }

        const docIncRems = allIncRems.filter((incRem) => documentScope.has(incRem.remId));
        const dueIncRems = docIncRems.filter((incRem) => incRem.nextRepDate <= now);
        loadIncRemDetails(docIncRems);

        return { due: dueIncRems.length, total: docIncRems.length, incRems: docIncRems };
      } catch (error) {
        console.error('INC REM LIST: Error', error);
        return { due: 0, total: 0, incRems: [] };
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

    const remsWithDetails: IncRemWithDetails[] = [];

    for (const incRem of incRems) {
      try {
        const rem = await plugin.rem.findOne(incRem.remId);
        if (!rem) continue;

        const text = await rem.text;
        let textStr = extractText(text);
        if (textStr.length > 200) textStr = textStr.substring(0, 200) + '...';

        const incRemType = await determineIncRemType(plugin, rem);

        remsWithDetails.push({
          ...incRem,
          remText: textStr || '[Empty rem]',
          incRemType,
          percentile: percentiles[incRem.remId],
        });
      } catch (error) {
        console.error('Error loading rem details:', error);
      }
    }

    setIncRemsWithDetails(remsWithDetails);
    setLoadingRems(false);
  };

  const handleClose = () => plugin.widget.closePopup();

  const handleRemClick = async (remId: string) => {
    const rem = await plugin.rem.findOne(remId);
    if (rem) {
      await plugin.window.openRem(rem);
      await plugin.widget.closePopup();
    }
  };

  const now = Date.now();

  const sortRems = (rems: IncRemWithDetails[]) => {
    if (sortBy === 'priority') {
      return [...rems].sort((a, b) => a.priority - b.priority);
    }
    return [...rems].sort((a, b) => a.nextRepDate - b.nextRepDate);
  };

  const dueRems = sortRems(incRemsWithDetails.filter((r) => r.nextRepDate <= now));
  const scheduledRems = sortRems(incRemsWithDetails.filter((r) => r.nextRepDate > now));

  return (
    <div
      className="flex flex-col"
      style={{
        height: '100%',
        width: '100%',
        minHeight: '400px',
        backgroundColor: 'var(--rn-clr-background-primary)',
      }}
    >
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">📚</span>
          <span className="font-semibold text-sm" style={{ color: 'var(--rn-clr-content-primary)' }}>Inc Rems</span>
          {counterData && (
            <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              <span style={{ color: '#f97316' }}>{counterData.due}</span>
              {' / '}
              <span style={{ color: '#3b82f6' }}>{counterData.total}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex text-xs" style={{ backgroundColor: 'var(--rn-clr-background-primary)', borderRadius: '4px' }}>
            <button
              onClick={() => setSortBy('date')}
              className="px-2 py-1 rounded-l transition-colors"
              style={{
                backgroundColor: sortBy === 'date' ? 'var(--rn-clr-background-tertiary)' : 'transparent',
                color: sortBy === 'date' ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-tertiary)',
              }}
              title="Sort by date"
            >
              📅
            </button>
            <button
              onClick={() => setSortBy('priority')}
              className="px-2 py-1 rounded-r transition-colors"
              style={{
                backgroundColor: sortBy === 'priority' ? 'var(--rn-clr-background-tertiary)' : 'transparent',
                color: sortBy === 'priority' ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-tertiary)',
              }}
              title="Sort by priority"
            >
              ★
            </button>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded transition-colors text-xs"
            style={{ color: 'var(--rn-clr-content-tertiary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2" style={{ minHeight: 0 }}>
        {loadingRems ? (
          <div className="text-center py-6 text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>Loading...</div>
        ) : incRemsWithDetails.length === 0 ? (
          <div className="text-center py-6 text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>No incremental rems</div>
        ) : (
          <div className="flex flex-col gap-3">
            <IncRemSection title="Due" count={dueRems.length} color="#f97316" rems={dueRems} onRemClick={handleRemClick} />
            <IncRemSection title="Scheduled" count={scheduledRems.length} color="#3b82f6" rems={scheduledRems} onRemClick={handleRemClick} />
          </div>
        )}
      </div>
    </div>
  );
}

renderWidget(IncRemList);
