import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import React, { useState } from 'react';
import { allIncrementalRemKey, popupDocumentIdKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { ActionItemType } from '../lib/incremental_rem/types';
import { remToActionItemType } from '../lib/incremental_rem/action_items';
import { buildDocumentScope } from '../lib/scope_helpers';
import { percentileToHslColor } from '../lib/utils';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import '../style.css';
import '../App.css';

dayjs.extend(relativeTime);

interface IncRemWithDetails extends IncrementalRem {
  remText?: string;
  incRemType?: ActionItemType;
  percentile?: number;
}

// Type badge configuration
const TYPE_BADGES: Record<ActionItemType, { emoji: string; label: string; bgColor: string; textColor: string; description: string }> = {
  'pdf': { emoji: '📄', label: 'PDF', bgColor: '#fef3c7', textColor: '#92400e', description: 'A PDF file added as incremental rem' },
  'pdf-highlight': { emoji: '🖍️', label: 'PDF Extract', bgColor: '#fce7f3', textColor: '#9d174d', description: 'Text or area highlighted in a PDF' },
  'pdf-note': { emoji: '📑', label: 'PDF Note', bgColor: '#e0e7ff', textColor: '#3730a3', description: 'A rem created inside a PDF (open PDF → Notes)' },
  'html': { emoji: '🌐', label: 'Web', bgColor: '#dbeafe', textColor: '#1e40af', description: 'A web page added as incremental rem' },
  'html-highlight': { emoji: '🔖', label: 'Web Extract', bgColor: '#d1fae5', textColor: '#065f46', description: 'Text highlighted from a web page' },
  'youtube': { emoji: '▶️', label: 'YouTube', bgColor: '#fee2e2', textColor: '#991b1b', description: 'A YouTube video added as incremental rem' },
  'video': { emoji: '🎬', label: 'Video', bgColor: '#fae8ff', textColor: '#86198f', description: 'A video file added as incremental rem' },
  'rem': { emoji: '📝', label: 'Rem', bgColor: '#f3f4f6', textColor: '#374151', description: 'A regular rem added as incremental rem' },
  'unknown': { emoji: '❓', label: 'Unknown', bgColor: '#f3f4f6', textColor: '#6b7280', description: 'Unknown type' },
};

// Compact colored badge with emoji + short label, fixed width for alignment
function TypeBadge({ type }: { type?: ActionItemType }) {
  if (!type) return null;
  const badge = TYPE_BADGES[type] || TYPE_BADGES['unknown'];
  return (
    <span
      className="inline-flex items-center justify-center gap-1 px-1.5 py-0.5 rounded text-xs shrink-0"
      style={{ backgroundColor: badge.bgColor, color: badge.textColor, width: '90px' }}
      title={badge.description}
    >
      <span>{badge.emoji}</span>
      <span className="font-medium truncate">{badge.label}</span>
    </span>
  );
}

// Compact single-row card
function IncRemRow({ incRem, onClick }: { incRem: IncRemWithDetails; onClick: () => void }) {
  const isDue = incRem.nextRepDate <= Date.now();

  return (
    <div
      onClick={onClick}
      className="flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition-all group"
      style={{ backgroundColor: 'var(--rn-clr-background-secondary)' }}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)'; }}
    >
      {/* Type badge */}
      <TypeBadge type={incRem.incRemType} />

      {/* Title - truncated */}
      <div
        className="flex-1 truncate text-sm"
        style={{ color: 'var(--rn-clr-content-primary)' }}
        title={incRem.remText}
      >
        {incRem.remText || 'Loading...'}
      </div>

      {/* Priority pill - using percentile color, fixed width for alignment */}
      <span
        className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0 text-center tabular-nums"
        style={{
          backgroundColor: incRem.percentile ? percentileToHslColor(incRem.percentile) : '#6b7280',
          color: 'white',
          minWidth: '42px',
        }}
        title={`Priority: ${incRem.priority}${incRem.percentile ? ` (top ${incRem.percentile}%)` : ''}`}
      >
        ★{incRem.priority}
      </span>

      {/* Time - with context, fixed width for alignment */}
      <span
        className="text-xs shrink-0 text-right"
        style={{ color: isDue ? '#ea580c' : 'var(--rn-clr-content-tertiary)', width: '75px' }}
        title={dayjs(incRem.nextRepDate).format('DD MMM YYYY HH:mm')}
      >
        {isDue ? `${dayjs(incRem.nextRepDate).fromNow(true)} ago` : `in ${dayjs(incRem.nextRepDate).fromNow(true)}`}
      </span>
    </div>
  );
}

// Collapsible section with compact header
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
            <IncRemRow key={incRem.remId} incRem={incRem} onClick={() => onRemClick(incRem.remId)} />
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

    // Calculate percentiles for all items
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

  // Sort function based on current selection
  const sortRems = (rems: IncRemWithDetails[]) => {
    if (sortBy === 'priority') {
      return [...rems].sort((a, b) => a.priority - b.priority);
    }
    // Default: sort by date (earliest first for due, soonest first for scheduled)
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
      {/* Compact Header */}
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
          {/* Sort toggle */}
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

      {/* Content - fills remaining space */}
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

// Helper functions
function extractText(text: unknown): string {
  if (typeof text === 'string') return text;
  if (!Array.isArray(text)) return '[Complex content]';

  const result = text
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

  return result || '[Complex content]';
}

async function determineIncRemType(plugin: any, rem: any): Promise<ActionItemType> {
  try {
    const actionItem = await remToActionItemType(plugin, rem);
    if (!actionItem) return 'unknown';

    let type: ActionItemType = actionItem.type;

    // Check if it's a 'rem' type but actually inside a PDF (pdf-note)
    if (type === 'rem') {
      let currentRem = rem;
      for (let i = 0; i < 20; i++) {
        const parent = await currentRem.getParentRem();
        if (!parent) break;
        if (await parent.hasPowerup(BuiltInPowerupCodes.UploadedFile)) {
          return 'pdf-note';
        }
        currentRem = parent;
      }
    }

    return type;
  } catch {
    return 'unknown';
  }
}

renderWidget(IncRemList);
