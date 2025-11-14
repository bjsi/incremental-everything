import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import { useMemo, useState } from 'react';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { getCardPriority, setCardPriority, CardPriorityInfo } from '../lib/card_priority';
import { allIncrementalRemKey, powerupCode, prioritySlotCode, allCardPriorityInfoKey, cardPriorityCacheRefreshKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { percentileToHslColor, calculateRelativePercentile } from '../lib/utils';
import { updateCardPriorityCache } from '../lib/card_priority/cache';


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

  const rem = useTrackerPlugin(
    async (plugin) => {
      if (!remId) return null;
      return await plugin.rem.findOne(remId);
    },
    [remId]
  );

  const incRemInfo = useTrackerPlugin(
    async (plugin) => {
      if (!rem) return null;
      return await getIncrementalRemFromRem(plugin, rem);
    },
    [rem]
  );

  const cardInfo = useTrackerPlugin(
    async (plugin) => {
      if (!rem) return null;
      return await getCardPriority(plugin, rem);
    },
    [rem, refreshSignal]
  );

  // Optimized: Combine both card-related queries into a single useTrackerPlugin
  const cardMetadata = useTrackerPlugin(
    async (plugin) => {
      if (!rem) return null;

      // Execute both queries in parallel for better performance
      const [cards, hasPowerup] = await Promise.all([
        rem.getCards(),
        rem.hasPowerup('cardPriority')
      ]);

      return {
        hasCards: cards && cards.length > 0,
        hasPowerup
      };
    },
    [rem, refreshSignal]
  );

  const hasCards = cardMetadata?.hasCards ?? false;
  const hasCardPriorityPowerup = cardMetadata?.hasPowerup ?? false;

  const incRemRelativePriority = useTrackerPlugin(
    async (plugin) => {
      if (!rem || !incRemInfo) return null;
      const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
      if (allIncRems.length === 0) return 50;
      return calculateRelativePercentile(allIncRems, rem._id);
    },
    [rem, incRemInfo]
  );

  const allPrioritizedCardInfo = useTrackerPlugin(
    (rp) => rp.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey),
    [refreshSignal]
  );

  // --- 1. GET THE NEW SETTING ---
  const displayMode = useTrackerPlugin(
    async (plugin) =>
      (await plugin.settings.getSetting<string>('priorityEditorDisplayMode')) || 'all',
    []
  );

  const cardRelativePriority = useMemo(() => {
    if (!rem || !allPrioritizedCardInfo) return null;

    // Use pre-calculated kbPercentile from cache for consistency
    const cardInfo = allPrioritizedCardInfo.find(info => info.remId === rem._id);
    return cardInfo?.kbPercentile ?? null;
  }, [rem, allPrioritizedCardInfo]);


  // --- 2. UPDATED RENDER LOGIC ---

  // Optimized: Use useMemo to avoid recalculating these conditions on every render
  const canShowIncRem = useMemo(() => !!incRemInfo, [incRemInfo]);
  const canShowCard = useMemo(() => hasCards || hasCardPriorityPowerup, [hasCards, hasCardPriorityPowerup]);

  // Optimized: Check if we're still loading critical data before making visibility decisions
  // We need ALL of these to make correct visibility decisions:
  // 1. rem - the target rem object
  // 2. displayMode - the user's display preference setting
  // 3. cardMetadata - information about cards and powerups
  const isLoadingCriticalData = !rem || displayMode === undefined || cardMetadata === undefined;

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
  
  // --- END OF UPDATED RENDER LOGIC ---


  const quickUpdateIncPriority = async (delta: number) => {
    if (!incRemInfo || !rem) return;
    const newPriority = Math.max(0, Math.min(100, incRemInfo.priority + delta));
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [newPriority.toString()]);

    // Update the incremental rem cache
    const updatedIncRem = await getIncrementalRemFromRem(plugin, rem);
    if (updatedIncRem) {
      await updateIncrementalRemCache(plugin, updatedIncRem);
    }
  };

  const quickUpdateCardPriority = async (delta: number) => {
    if (!rem) return;
    const currentPriority = cardInfo?.priority ?? 50; // Use ?? instead of || to handle 0 correctly
    const newPriority = Math.max(0, Math.min(100, currentPriority + delta));
    
    await setCardPriority(plugin, rem, newPriority, 'manual');
    await updateCardPriorityCache(plugin, rem._id);
  };

  const buttonStyle: React.CSSProperties = {
    backgroundColor: 'var(--rn-clr-bg-secondary)',
    border: '1px solid var(--rn-clr-border-primary)',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    cursor: 'pointer',
    color: 'var(--rn-clr-content-primary)',
  };
  
  const incRemColor = incRemRelativePriority ? percentileToHslColor(incRemRelativePriority) : undefined;
  
  const cardColor = cardRelativePriority ? percentileToHslColor(cardRelativePriority) : undefined;

  const cardPriorityFontWeight = cardInfo?.source === 'manual' ? 'bold' : 'normal';


  const priorityPillStyle: React.CSSProperties = {
    color: 'white',
    padding: '2px 6px',
    borderRadius: '4px',
    display: 'inline-block',
    lineHeight: '1.2',
  };

  // --- 3. CONDITIONALLY SHOW CARD EDITOR ---
  const showCardEditor = (displayMode === 'all') && (hasCards || hasCardPriorityPowerup);

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