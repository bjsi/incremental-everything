import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import { useMemo, useState, useCallback } from 'react';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { getCardPriority, setCardPriority, CardPriorityInfo } from '../lib/card_priority';
import { allIncrementalRemKey, powerupCode, prioritySlotCode, allCardPriorityInfoKey, cardPriorityCacheRefreshKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { calculateRelativePercentile } from '../lib/utils';
import { updateCardPriorityCache } from '../lib/card_priority/cache';
import { PriorityBadge } from '../components';

// Move styles outside component to avoid recreation on every render
const adjustButtonStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: '6px',
  fontSize: '11px',
  fontWeight: 600,
  cursor: 'pointer',
  border: 'none',
  transition: 'all 0.15s ease',
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
        plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
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

  // Memoize whether card priority is manual (for visual indicator)
  const isCardPriorityManual = useMemo(
    () => cardInfo?.source === 'manual',
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
        backgroundColor: isExpanded ? 'var(--rn-clr-background-primary)' : 'transparent',
        border: isExpanded ? '1px solid var(--rn-clr-border-primary)' : 'none',
        color: 'var(--rn-clr-content-primary)',
        borderRadius: '12px',
        padding: isExpanded ? '16px' : '4px',
        boxShadow: isExpanded ? '0 4px 20px rgba(0,0,0,0.15)' : 'none',
        transition: 'all 0.2s ease',
        minWidth: isExpanded ? '240px' : 'auto',
        zIndex: 1000,
      }}
    >
      {!isExpanded ? (
        <div
          onClick={() => setIsExpanded(true)}
          className="cursor-pointer flex flex-col items-center gap-1.5"
          title="Click to expand priority controls"
        >
          {incRemInfo && (
            <PriorityBadge priority={incRemInfo.priority} percentile={incRemRelativePriority ?? undefined} compact />
          )}
          {showCardEditor && (
            <PriorityBadge priority={cardInfo?.priority ?? 50} percentile={cardRelativePriority ?? undefined} compact />
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm">⚡</span>
              <span className="text-xs font-bold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                Quick Priority
              </span>
            </div>
            <button
              onClick={() => setIsExpanded(false)}
              className="w-5 h-5 flex items-center justify-center rounded-full transition-colors"
              style={{
                color: 'var(--rn-clr-content-tertiary)',
                backgroundColor: 'var(--rn-clr-background-secondary)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)'; }}
            >
              <span className="text-xs">✕</span>
            </button>
          </div>

          {/* Inc Rem Section */}
          {incRemInfo && (
            <div
              className="p-3 rounded-lg"
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">📖</span>
                  <span className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                    Inc Rem
                  </span>
                </div>
                <PriorityBadge priority={incRemInfo.priority} percentile={incRemRelativePriority ?? undefined} compact />
              </div>
              <div className="flex items-center justify-center gap-1">
                <button
                  onClick={() => quickUpdateIncPriority(-10)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#ef4444', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  −10
                </button>
                <button
                  onClick={() => quickUpdateIncPriority(-1)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#f97316', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  −1
                </button>
                <button
                  onClick={() => quickUpdateIncPriority(1)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#22c55e', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  +1
                </button>
                <button
                  onClick={() => quickUpdateIncPriority(10)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#3b82f6', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  +10
                </button>
              </div>
            </div>
          )}

          {/* Cards Section */}
          {showCardEditor && (
            <div
              className="p-3 rounded-lg"
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">🎴</span>
                  <span className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                    Cards
                  </span>
                  {isCardPriorityManual && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                      style={{ backgroundColor: '#8b5cf6', color: 'white' }}
                    >
                      manual
                    </span>
                  )}
                </div>
                <PriorityBadge priority={cardInfo?.priority ?? 50} percentile={cardRelativePriority ?? undefined} compact />
              </div>
              <div className="flex items-center justify-center gap-1">
                <button
                  onClick={() => quickUpdateCardPriority(-10)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#ef4444', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  −10
                </button>
                <button
                  onClick={() => quickUpdateCardPriority(-1)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#f97316', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  −1
                </button>
                <button
                  onClick={() => quickUpdateCardPriority(1)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#22c55e', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  +1
                </button>
                <button
                  onClick={() => quickUpdateCardPriority(10)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#3b82f6', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  +10
                </button>
              </div>
              <div className="text-[10px] text-center mt-2" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                {!hasCards && hasCardPriorityPowerup ? "Set for inheritance" : `Source: ${cardInfo?.source}`}
              </div>
            </div>
          )}

          {/* Open Full Panel Button */}
          <button
            onClick={() => plugin.widget.openPopup('priority', { remId })}
            className="w-full py-2 rounded-lg text-xs font-semibold transition-all"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
              color: 'var(--rn-clr-content-secondary)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
              e.currentTarget.style.color = 'var(--rn-clr-content-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)';
              e.currentTarget.style.color = 'var(--rn-clr-content-secondary)';
            }}
          >
            Open Full Panel →
          </button>
        </div>
      )}
    </div>
  );
}

renderWidget(PriorityEditor);