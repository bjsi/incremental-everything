import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import { useMemo, useState, useCallback } from 'react';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache, getAllIncrementalRemsFromCache } from '../lib/incremental_rem/cache';
import { getCardPriority, setCardPriority, CardPriorityInfo } from '../lib/card_priority';
import { allIncrementalRemKey, powerupCode, prioritySlotCode, allCardPriorityInfoKey, cardPriorityCacheRefreshKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { percentileToHslColor, calculateRelativePercentile } from '../lib/utils';
import { updateCardPriorityCache } from '../lib/card_priority/cache';

// Move styles outside component to avoid recreation on every render
const buttonStyle: React.CSSProperties = {
  backgroundColor: 'var(--rn-clr-bg-secondary)',
  border: '1px solid var(--rn-clr-border-primary)',
  padding: '4px 8px',
  borderRadius: '4px',
  fontSize: '12px',
  cursor: 'pointer',
  color: 'var(--rn-clr-content-primary)',
};

const priorityPillStyle: React.CSSProperties = {
  color: 'white',
  padding: '2px 6px',
  borderRadius: '4px',
  display: 'inline-block',
  lineHeight: '1.2',
};

export function PriorityEditor() {
  const plugin = usePlugin();
  const widgetContext = useRunAsync(async () => await plugin.widget.getWidgetContext(), []);
  const remId = widgetContext?.remId;

  const [isExpanded, setIsExpanded] = useState(false);

  // Listen for cache refresh signal to force re-evaluation of all data
  const refreshSignal = useTrackerPlugin(
    (rp) => rp.storage.getSession(cardPriorityCacheRefreshKey),
    []
  );

  // SUPER OPTIMIZED: Combine ALL data fetching into a single hook
  // This reduces the render cascade from ~9 renders to ~3 renders
  const remData = useTrackerPlugin(
    async (plugin) => {
      if (!remId) return null;

      const rem = await plugin.rem.findOne(remId);
      if (!rem) return null;

      // Execute ALL queries in parallel for maximum performance
      const [incRemInfo, cardInfo, cards, hasPowerup, allIncRems, allPrioritizedCardInfo, displayMode] = await Promise.all([
        getIncrementalRemFromRem(plugin, rem),
        getCardPriority(plugin, rem),
        rem.getCards(),
        rem.hasPowerup('cardPriority'),
        getAllIncrementalRemsFromCache(plugin),
        plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey),
        plugin.settings.getSetting<string>('priorityEditorDisplayMode')
      ]);

      // Calculate relative priorities inline
      const incRemRelativePriority = (incRemInfo && allIncRems && allIncRems.length > 0)
        ? calculateRelativePercentile(allIncRems, rem._id)
        : 50;

      // Calculate card relative priority inline using pre-calculated kbPercentile
      const cardPriorityInfo = allPrioritizedCardInfo?.find(info => info.remId === rem._id);
      const cardRelativePriority = cardPriorityInfo?.kbPercentile ?? null;

      return {
        rem,
        incRemInfo,
        cardInfo,
        hasCards: cards && cards.length > 0,
        hasPowerup,
        incRemRelativePriority,
        cardRelativePriority,
        allPrioritizedCardInfo: allPrioritizedCardInfo || [],
        displayMode: displayMode || 'all'
      };
    },
    [remId, refreshSignal]
  );

  const rem = remData?.rem ?? null;
  const incRemInfo = remData?.incRemInfo ?? null;
  const cardInfo = remData?.cardInfo ?? null;
  const hasCards = remData?.hasCards ?? false;
  const hasCardPriorityPowerup = remData?.hasPowerup ?? false;
  const incRemRelativePriority = remData?.incRemRelativePriority ?? null;
  const cardRelativePriority = remData?.cardRelativePriority ?? null;
  const allPrioritizedCardInfo = remData?.allPrioritizedCardInfo ?? [];
  const displayMode = remData?.displayMode ?? 'all';

  // IMPORTANT: All hooks must be called unconditionally BEFORE any early returns
  // Optimized: Use useMemo to avoid recalculating these conditions on every render
  const canShowIncRem = useMemo(() => !!incRemInfo, [incRemInfo]);
  const canShowCard = useMemo(() => hasCards || hasCardPriorityPowerup, [hasCards, hasCardPriorityPowerup]);

  // Memoize callback functions to avoid recreation on every render
  const quickUpdateIncPriority = useCallback(async (delta: number) => {
    if (!incRemInfo || !rem) return;
    const newPriority = Math.max(0, Math.min(100, incRemInfo.priority + delta));
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [newPriority.toString()]);

    // Update the incremental rem cache
    const updatedIncRem = await getIncrementalRemFromRem(plugin, rem);
    if (updatedIncRem) {
      await updateIncrementalRemCache(plugin, updatedIncRem);
    }
  }, [incRemInfo, rem, plugin]);

  const quickUpdateCardPriority = useCallback(async (delta: number) => {
    if (!rem) return;
    const currentPriority = cardInfo?.priority ?? 50;
    const newPriority = Math.max(0, Math.min(100, currentPriority + delta));

    await setCardPriority(plugin, rem, newPriority, 'manual');
    await updateCardPriorityCache(plugin, rem._id);
  }, [rem, cardInfo, plugin]);

  // Memoize calculated colors
  const incRemColor = useMemo(
    () => incRemRelativePriority ? percentileToHslColor(incRemRelativePriority) : undefined,
    [incRemRelativePriority]
  );

  const cardColor = useMemo(
    () => cardRelativePriority ? percentileToHslColor(cardRelativePriority) : undefined,
    [cardRelativePriority]
  );

  const cardPriorityFontWeight = useMemo(
    () => cardInfo?.source === 'manual' ? 'bold' : 'normal',
    [cardInfo?.source]
  );

  // Memoize computed values
  const showCardEditor = useMemo(
    () => (displayMode === 'all') && (hasCards || hasCardPriorityPowerup),
    [displayMode, hasCards, hasCardPriorityPowerup]
  );

  // --- RENDER LOGIC (after all hooks) ---

  // Optimized: Check if we're still loading critical data before making visibility decisions
  const isLoadingCriticalData = !rem || remData === undefined;

  if (isLoadingCriticalData) {
    return null; // Still loading, don't render yet
  }

  // Handle disabled state
  if (displayMode === 'disable') {
    return null;
  }

  // Handle logic for 'incRemOnly' and 'all'
  if (displayMode === 'incRemOnly' && !canShowIncRem) {
    return null; // Mode is 'incRemOnly' but this isn't an IncRem
  }

  if (displayMode === 'all' && !canShowIncRem && !canShowCard) {
    return null; // Mode is 'all' but this is neither an IncRem nor a Card
  }

  return (
    <div
      className="priority-editor-widget"
      style={{
        position: 'sticky',
        top: '12px',
        backgroundColor: 'var(--rn-clr-bg-primary)',
        border: '1px solid var(--rn-clr-border-primary)',
        color: 'var(--rn-clr-content-primary)',
        borderRadius: '8px',
        padding: isExpanded ? '12px' : '8px',
        boxShadow: 'var(--rn-box-shadow-modal)',
        transition: 'all 0.3s ease',
        minWidth: isExpanded ? '200px' : '40px',
        zIndex: 1000,
      }}
    >
      {!isExpanded ? (
        <div
          onClick={() => setIsExpanded(true)}
          className="cursor-pointer p-1 text-center"
          title="Click to expand priority controls"
        >
          {incRemInfo && (
            <div className="mb-1" title={`Inc Priority: ${incRemInfo.priority} (${incRemRelativePriority}%)`}>
              <span style={{ ...priorityPillStyle, backgroundColor: incRemColor, fontSize: '11px' }}>
                I:{incRemInfo.priority}
              </span>
            </div>
          )}
          {showCardEditor && ( // This now respects the new setting
            <div title={`Card Priority: ${cardInfo?.priority ?? 'None'} (${cardRelativePriority}%)`}>
              <span style={{ ...priorityPillStyle, backgroundColor: cardColor, fontSize: '11px' }}>
                C:<span style={{ fontWeight: cardPriorityFontWeight }}>{cardInfo?.priority ?? '-'}</span>
              </span>
            </div>
          )}
        </div>
      ) : (
        <div>
          <button
            onClick={() => setIsExpanded(false)}
            className="absolute top-1 right-1"
            style={{ color: 'var(--rn-clr-content-secondary)', fontSize: '12px' }}
          >
            ✕
          </button>

          <div className="mb-3">
            <div className="text-xs font-bold mb-2" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              Priority Control
            </div>

            {incRemInfo && (
              <div className="mb-3">
                <div className="text-xs mb-1" style={{ color: 'var(--rn-clr-blue-600)' }}>
                  Inc Rem ({incRemRelativePriority}%)
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => quickUpdateIncPriority(-10)} style={buttonStyle}>-10</button>
                  <button onClick={() => quickUpdateIncPriority(-1)} style={buttonStyle}>-1</button>
                  <span className="px-2 text-sm font-bold" style={{ ...priorityPillStyle, backgroundColor: incRemColor }}>
                    {incRemInfo.priority}
                  </span>
                  <button onClick={() => quickUpdateIncPriority(1)} style={buttonStyle}>+1</button>
                  <button onClick={() => quickUpdateIncPriority(10)} style={buttonStyle}>+10</button>
                </div>
              </div>
            )}

            {showCardEditor && ( // This now respects the new setting
              <div>
                <div className="text-xs mb-1" style={{ color: 'var(--rn-clr-green-600)' }}>
                  Cards ({cardRelativePriority}%)
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => quickUpdateCardPriority(-10)} style={buttonStyle}>-10</button>
                  <button onClick={() => quickUpdateCardPriority(-1)} style={buttonStyle}>-1</button>
                  <span className="px-2 text-sm" style={{ ...priorityPillStyle, backgroundColor: cardColor, fontWeight: cardPriorityFontWeight }}>
                    {cardInfo?.priority ?? 50}
                  </span>
                  <button onClick={() => quickUpdateCardPriority(1)} style={buttonStyle}>+1</button>
                  <button onClick={() => quickUpdateCardPriority(10)} style={buttonStyle}>+10</button>
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                  {!hasCards && hasCardPriorityPowerup ? "Set for inheritance" : `Source: ${cardInfo?.source}`}
                </div>
              </div>
            )}
          </div>
            <button
            onClick={() => plugin.widget.openPopup('priority', { remId })}
            style={{...buttonStyle, width: '100%'}}
          >
            Open Full Priority Panel
          </button>
        </div>
      )}
    </div>
  );
}

renderWidget(PriorityEditor);