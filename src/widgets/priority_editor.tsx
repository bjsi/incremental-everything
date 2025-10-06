import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  Rem,
} from '@remnote/plugin-sdk';
import { useMemo, useState } from 'react';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { getCardPriority, setCardPriority, CardPriorityInfo, calculateRelativeCardPriority } from '../lib/cardPriority';
import { allIncrementalRemKey, powerupCode, prioritySlotCode, allCardPriorityInfoKey } from '../lib/consts';
import { IncrementalRem } from '../lib/types';
import { percentileToHslColor } from '../lib/color';
import { calculateRelativePriority as calculateIncRemRelativePriority } from '../lib/priority'; // Aliased to avoid name clash
import { updateCardPriorityInCache } from '../lib/cache';


export function PriorityEditor() {
  const plugin = usePlugin();
  const widgetContext = useRunAsync(async () => await plugin.widget.getWidgetContext(), []);
  const remId = widgetContext?.remId;

  const [isExpanded, setIsExpanded] = useState(false);

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
      return await getIncrementalRemInfo(plugin, rem);
    },
    [rem]
  );

  const cardInfo = useTrackerPlugin(
    async (plugin) => {
      if (!rem) return null;
      return await getCardPriority(plugin, rem);
    },
    [rem]
  );

  const hasCards = useTrackerPlugin(
    async (plugin) => {
      if (!rem) return false;
      const cards = await rem.getCards();
      return cards && cards.length > 0;
    },
    [rem]
  );

  const incRemRelativePriority = useTrackerPlugin(
    async (plugin) => {
      if (!rem || !incRemInfo) return null;
      const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
      if (allIncRems.length === 0) return 50;
      return calculateIncRemRelativePriority(allIncRems, rem._id);
    },
    [rem, incRemInfo]
  );

  const allPrioritizedCardInfo = useTrackerPlugin(
    (rp) => rp.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey),
    []
  );

  const cardRelativePriority = useMemo(() => {
    if (!rem || !allPrioritizedCardInfo) return null;
    return calculateRelativeCardPriority(allPrioritizedCardInfo, rem._id);
  }, [rem, allPrioritizedCardInfo]);


  if (!rem || (!incRemInfo && !hasCards)) {
    return null;
  }

  const quickUpdateIncPriority = async (delta: number) => {
    if (!incRemInfo || !rem) return;
    const newPriority = Math.max(0, Math.min(100, incRemInfo.priority + delta));
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [newPriority.toString()]);
  };

  const quickUpdateCardPriority = async (delta: number) => {
    if (!rem) return;
    const currentPriority = cardInfo?.priority || 50;
    const newPriority = Math.max(0, Math.min(100, currentPriority + delta));
    
    await setCardPriority(plugin, rem, newPriority, 'manual');
    await updateCardPriorityInCache(plugin, rem._id);
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
  
  // CHANGED: Removed the `100 - ...` inversion. Now low percentile (high priority) maps to red.
  const incRemColor = incRemRelativePriority ? percentileToHslColor(incRemRelativePriority) : undefined;
  
  // CHANGED: Removed the `100 - ...` inversion here as well for consistency.
  const cardColor = cardRelativePriority ? percentileToHslColor(cardRelativePriority) : undefined;


  const priorityPillStyle: React.CSSProperties = {
    color: 'white',
    padding: '2px 6px',
    borderRadius: '4px',
    display: 'inline-block',
    lineHeight: '1.2',
  };

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
          {hasCards && (
            <div title={`Card Priority: ${cardInfo?.priority || 'None'} (${cardRelativePriority}%)`}>
              <span style={{ ...priorityPillStyle, backgroundColor: cardColor, fontSize: '11px' }}>
                C:{cardInfo?.priority || '-'}
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

            {hasCards && (
              <div>
                <div className="text-xs mb-1" style={{ color: 'var(--rn-clr-green-600)' }}>
                  Cards ({cardRelativePriority}%)
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => quickUpdateCardPriority(-10)} style={buttonStyle}>-10</button>
                  <button onClick={() => quickUpdateCardPriority(-1)} style={buttonStyle}>-1</button>
                  <span className="px-2 text-sm font-bold" style={{ ...priorityPillStyle, backgroundColor: cardColor }}>
                    {cardInfo?.priority || 50}
                  </span>
                  <button onClick={() => quickUpdateCardPriority(1)} style={buttonStyle}>+1</button>
                  <button onClick={() => quickUpdateCardPriority(10)} style={buttonStyle}>+10</button>
                </div>
                {cardInfo?.source && (
                  <div className="text-xs mt-1" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                    Source: {cardInfo.source}
                  </div>
                )}
              </div>
            )}
          </div>
            <button
            onClick={() => plugin.widget.openPopup('priority', { remId })}
            style={buttonStyle}
          >
            Open Full Priority Panel
          </button>
        </div>
      )}
    </div>
  );
}

renderWidget(PriorityEditor);