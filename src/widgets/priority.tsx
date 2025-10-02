import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useState, useRef } from 'react';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { getCardPriority, setCardPriority, PrioritySource, CardPriorityInfo } from '../lib/cardPriority';
import { calculateRelativePriority } from '../lib/priority';
import { allIncrementalRemKey, powerupCode, prioritySlotCode } from '../lib/consts';
import { IncrementalRem } from '../lib/types';
import * as _ from 'remeda';

// Debounce hook to prevent excessive writes to the database while sliding
function useDebouncedEffect(effect: () => void, deps: React.DependencyList, delay: number) {
  useEffect(() => {
    const handler = setTimeout(() => effect(), delay);
    return () => clearTimeout(handler);
  }, [...deps, delay]);
}

function Priority() {
  const plugin = usePlugin();
  
  const widgetContext = useRunAsync(
    async () => await plugin.widget.getWidgetContext<{ remId: string }>(),
    []
  );

  const rem = useTrackerPlugin(
    async (plugin) => {
      const remId = widgetContext?.contextData?.remId;
      if (!remId) return null;
      return await plugin.rem.findOne(remId);
    },
    [widgetContext?.contextData?.remId]
  );

  const incRemInfo = useTrackerPlugin(
    async (plugin) => {
      if (!rem) return null;
      return await getIncrementalRemInfo(plugin, rem);
    },
    [rem?._id]
  );

  const cardInfo = useTrackerPlugin(
    async (plugin) => {
      if (!rem) return null;
      const info = await getCardPriority(plugin, rem);
      return info;
    },
    [rem?._id]
  );

  const hasCards = useTrackerPlugin(
    async (plugin) => {
      if (!rem) return false;
      const cards = await rem.getCards();
      return cards && cards.length > 0;
    },
    [rem?._id]
  );

  const allIncRems = useTrackerPlugin(
    async (plugin) => await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [],
    []
  );

  const allCardRems = useTrackerPlugin(
    async (plugin) => {
      const powerup = await plugin.powerup.getPowerupByCode('cardPriority');
      if (!powerup) return [];
      const taggedRems = await powerup.taggedRem();
      const cardInfos = await Promise.all(
        taggedRems.map(r => getCardPriority(plugin, r))
      );
      return cardInfos.filter(Boolean) as CardPriorityInfo[];
    },
    []
  );

  // --- CORRECTED INITIALIZATION ---
  const [incAbsPriority, setIncAbsPriority] = useState(incRemInfo?.priority || 50);
  const [incRelPriority, setIncRelPriority] = useState(50);
  
  const [cardAbsPriority, setCardAbsPriority] = useState(cardInfo?.priority || 50);
  const [cardRelPriority, setCardRelPriority] = useState(50);
  // --- END CORRECTION ---
  
  const [showConfirmation, setShowConfirmation] = useState(false);

  // This effect ensures the state updates if the underlying data changes after initial load.
  useEffect(() => {
    if (incRemInfo) {
      setIncAbsPriority(incRemInfo.priority);
    }
  }, [incRemInfo]);
  
  useEffect(() => {
    if (cardInfo) {
      setCardAbsPriority(cardInfo.priority);
    }
  }, [cardInfo]);


  useEffect(() => {
    const remId = widgetContext?.contextData?.remId;
    if (!remId || !allIncRems) return;
    const hypotheticalRems = allIncRems.map((r) =>
      r.remId === remId ? { ...r, priority: incAbsPriority } : r
    );
    if (!hypotheticalRems.find(r => r.remId === remId)) {
        hypotheticalRems.push({ remId, priority: incAbsPriority, nextRepDate: 0, history: [] });
    }
    const newRelPriority = calculateRelativePriority(hypotheticalRems, remId);
    if (newRelPriority !== null) setIncRelPriority(newRelPriority);
  }, [incAbsPriority, allIncRems, widgetContext?.contextData?.remId]);
  
  const handleIncRelativeSliderChange = (newRelPriority: number) => {
    setIncRelPriority(newRelPriority);
    const remId = widgetContext?.contextData?.remId;
    if (!remId || !allIncRems || allIncRems.length < 2) return;
    const otherRems = _.sortBy(allIncRems.filter((r) => r.remId !== remId), (x) => x.priority);
    const targetIndex = Math.floor(((newRelPriority - 1) / 100) * otherRems.length);
    const clampedIndex = Math.max(0, Math.min(otherRems.length - 1, targetIndex));
    const targetAbsPriority = otherRems[clampedIndex]?.priority;
    if (targetAbsPriority !== undefined) setIncAbsPriority(targetAbsPriority);
  };

  useEffect(() => {
    const remId = widgetContext?.contextData?.remId;
    if (!remId || !allCardRems) return;
    const hypotheticalRems = allCardRems.map((r) =>
        r.remId === remId ? { ...r, priority: cardAbsPriority } : r
    );
    if (!hypotheticalRems.find(r => r.remId === remId)) {
        hypotheticalRems.push({ remId, priority: cardAbsPriority, source: 'default', lastUpdated: 0, cardCount: 0, dueCards: 0 });
    }
    const sortedItems = _.sortBy(hypotheticalRems, (x) => x.priority);
    const index = sortedItems.findIndex((x) => x.remId === remId);
    if (index !== -1) {
        const percentile = Math.round(((index + 1) / sortedItems.length) * 100);
        setCardRelPriority(percentile);
    }
  }, [cardAbsPriority, allCardRems, widgetContext?.contextData?.remId]);

  const handleCardRelativeSliderChange = (newRelPriority: number) => {
    setCardRelPriority(newRelPriority);
    const remId = widgetContext?.contextData?.remId;
    if (!remId || !allCardRems || allCardRems.length < 2) return;
    const otherRems = _.sortBy(allCardRems.filter((r) => r.remId !== remId), (x) => x.priority);
    const targetIndex = Math.floor(((newRelPriority - 1) / 100) * otherRems.length);
    const clampedIndex = Math.max(0, Math.min(otherRems.length - 1, targetIndex));
    const targetAbsPriority = otherRems[clampedIndex]?.priority;
    if (targetAbsPriority !== undefined) setCardAbsPriority(targetAbsPriority);
  };

  const showIncSection = incRemInfo !== null;
  const showCardSection = hasCards || (cardInfo && cardInfo.cardCount > 0);

  const saveIncPriority = useCallback(async (priority: number) => {
    if (!rem) return;
    if (!incRemInfo) { // If it's a new Inc Rem, we need to initialize it
        await rem.addPowerup(powerupCode);
    }
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [priority.toString()]);
    const newIncRem = await getIncrementalRemInfo(plugin, rem);
    if (newIncRem) {
      const currentRems = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];
      const updatedRems = currentRems.filter(r => r.remId !== rem._id).concat(newIncRem);
      await plugin.storage.setSession(allIncrementalRemKey, updatedRems);
    }
  }, [rem, plugin, incRemInfo]);

  const saveCardPriority = useCallback(async (priority: number) => {
    if (!rem) return;
    await setCardPriority(plugin, rem, priority, 'manual');
  }, [rem, plugin]);

  const saveAndClose = async (incP: number, cardP: number) => {
    if (showIncSection) await saveIncPriority(incP);
    if (showCardSection) await saveCardPriority(cardP);
    plugin.widget.closePopup();
  };

  const handleConfirmAndClose = async () => {
    if (showConfirmation) {
      await saveAndClose(incAbsPriority, cardAbsPriority);
      return;
    }

    if (showIncSection && showCardSection && incAbsPriority !== cardAbsPriority) {
      setShowConfirmation(true);
      return;
    }
    
    // Also check if the card priority needs to be saved on its own
    if (cardInfo && (cardInfo.source === 'inherited' || cardInfo.source === 'default')) {
        await saveCardPriority(cardAbsPriority);
    }
    // And if the inc priority needs to be saved on its own
    else if (incRemInfo && incAbsPriority !== incRemInfo.priority) {
        await saveIncPriority(incAbsPriority);
    }


    await saveAndClose(incAbsPriority, cardAbsPriority);
  };
  
  const incInputRef = useRef<HTMLInputElement>(null);
  const cardInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTimeout(() => {
      if (incInputRef.current) {
        incInputRef.current.focus();
        incInputRef.current.select();
      } else if (cardInputRef.current) {
        cardInputRef.current.focus();
        cardInputRef.current.select();
      }
    }, 50);
  }, [incRemInfo, cardInfo]);

  const removeFromIncremental = useCallback(async () => {
      if (!rem) return;
      const remId = widgetContext?.contextData?.remId;
      if (!remId) return;
      await rem.removePowerup(powerupCode);
      const currentIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
      const updated = currentIncRems.filter(r => r.remId !== remId);
      await plugin.storage.setSession(allIncrementalRemKey, updated);
      await plugin.app.toast('Removed from Incremental Queue');
      plugin.widget.closePopup();
  }, [plugin, rem, widgetContext?.contextData?.remId]);

  if (!widgetContext || !rem) {
    return <div className="p-4">Loading Rem Data...</div>;
  }
  if (!showIncSection && !showCardSection) {
    return <div className="p-4 text-center rn-clr-content-secondary">This rem is neither an Incremental Rem nor has flashcards.</div>;
  }

  return (
    <div className="p-4 flex flex-col gap-6 relative" onKeyDown={async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await handleConfirmAndClose();
      } else if (e.key === 'Escape') {
        plugin.widget.closePopup();
      }
    }}>
      {showConfirmation && (
        <div className="absolute inset-0 bg-white/80 dark:bg-black/80 flex items-center justify-center z-10 p-4 rounded-lg">
          <div className="p-6 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col gap-4 text-center max-w-sm">
            <h3 className="font-semibold text-lg">Priorities are different</h3>
            <p className="text-sm rn-clr-content-secondary">
              Incremental Rem ({incAbsPriority}) and Flashcard ({cardAbsPriority}) priorities do not match.
            </p>
            <div className="flex flex-col gap-2">
              <button
                style={{ backgroundColor: '#3B82F6', color: 'white' }}
                className="px-4 py-2 rounded font-semibold focus:outline-none focus:ring-2 focus:ring-blue-400"
                onClick={() => saveAndClose(incAbsPriority, incAbsPriority)}
              >
                Card inherits IncRem priority ({incAbsPriority})
              </button>
              <button
                style={{ backgroundColor: '#10B981', color: 'white' }}
                className="px-4 py-2 rounded font-semibold focus:outline-none focus:ring-2 focus:ring-green-400"
                onClick={() => saveAndClose(cardAbsPriority, cardAbsPriority)}
              >
                IncRem inherits Card priority ({cardAbsPriority})
              </button>
            </div>
            <p className="text-xs rn-clr-content-secondary">Or press Enter to save both as they are.</p>
            <button
              className="text-sm text-gray-500 hover:underline mt-2"
              onClick={() => setShowConfirmation(false)}
            >
              Go Back
            </button>
          </div>
        </div>
      )}

      <h2 className="text-xl font-bold">Priority Settings</h2>
      
      {showIncSection && (
        <div className="p-4 border border-blue-200 dark:border-blue-800 rounded-lg bg-blue-50 dark:bg-blue-900/20 flex flex-col gap-4">
          <h3 className="text-lg font-semibold flex items-center text-blue-800 dark:text-blue-200">
            <span className="mr-2">📖</span>
            Incremental Rem Priority
          </h3>
          
          <div className="flex flex-col gap-2">
            <div className="flex justify-between items-center">
              <label className="font-medium">Absolute Priority:</label>
              <input
                ref={incInputRef}
                type="number"
                min={0} max={100}
                value={incAbsPriority}
                onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val)) setIncAbsPriority(Math.min(100, Math.max(0, val)));
                    else if (e.target.value === '') setIncAbsPriority(0);
                }}
                className="w-20 text-center p-1 border rounded dark:bg-gray-800 border-gray-300 dark:border-gray-600"
              />
            </div>
            <input
              type="range" min="0" max="100" value={incAbsPriority}
              onChange={(e) => setIncAbsPriority(Number(e.target.value))}
              className="w-full"
            />
            
            <div className="flex justify-between items-center mt-2">
              <label className="font-medium">Relative Priority:</label>
              <span className="text-lg font-bold">{incRelPriority}%</span>
            </div>
            <div className="relative h-8 flex items-center">
               <div
                  className="absolute w-full h-4 rounded-md"
                  style={{ background: `linear-gradient(to right, hsl(0, 80%, 55%), hsl(60, 80%, 55%), hsl(120, 80%, 55%), hsl(240, 80%, 55%))` }}
                ></div>
              <input
                type="range" min="1" max="100" value={incRelPriority}
                onChange={(e) => handleIncRelativeSliderChange(Number(e.target.value))}
                className="absolute w-full custom-transparent-slider"
              />
            </div>
            
            <div className="text-sm rn-clr-content-secondary mt-2">
              Next review: {incRemInfo && new Date(incRemInfo.nextRepDate).toLocaleDateString()}
            </div>
          </div>

          <button onClick={removeFromIncremental} className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 self-center">
            Remove from Incremental Queue
          </button>
        </div>
      )}
      
      {showCardSection && (
         <div className="p-4 border border-green-200 dark:border-green-800 rounded-lg bg-green-50 dark:bg-green-900/20 flex flex-col gap-4">
          <h3 className="text-lg font-semibold flex items-center text-green-800 dark:text-green-200">
            <span className="mr-2">🎴</span>
            Flashcard Priority
          </h3>
          
          {cardInfo && cardInfo.cardCount > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <label className="font-medium">Absolute Priority:</label>
                <input
                    ref={cardInputRef}
                    type="number"
                    min={0} max={100}
                    value={cardAbsPriority}
                    onChange={(e) => {
                        const val = parseInt(e.target.value);
                        if (!isNaN(val)) setCardAbsPriority(Math.min(100, Math.max(0, val)));
                        else if (e.target.value === '') setCardAbsPriority(0);
                    }}
                    className="w-20 text-center p-1 border rounded dark:bg-gray-800 border-gray-300 dark:border-gray-600"
                />
              </div>
              <input
                type="range" min="0" max="100" value={cardAbsPriority}
                onChange={(e) => setCardAbsPriority(Number(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between items-center mt-2">
                <label className="font-medium">Relative Priority:</label>
                <span className="text-lg font-bold">{cardRelPriority}%</span>
              </div>
              <div className="relative h-8 flex items-center">
                <div
                    className="absolute w-full h-4 rounded-md"
                    style={{ background: `linear-gradient(to right, hsl(0, 80%, 55%), hsl(60, 80%, 55%), hsl(120, 80%, 55%), hsl(240, 80%, 55%))` }}
                ></div>
                <input
                    type="range" min="1" max="100" value={cardRelPriority}
                    onChange={(e) => handleCardRelativeSliderChange(Number(e.target.value))}
                    className="absolute w-full custom-transparent-slider"
                />
              </div>
              <div className="flex justify-between items-center text-sm rn-clr-content-secondary mt-2">
                <span><span className="font-medium">Source:</span> {cardInfo.source}</span>
                {cardInfo.source === 'inherited' && (
                  <button onClick={() => saveCardPriority(cardInfo.priority)} className="text-blue-500 hover:underline">
                    Convert to Manual
                  </button>
                )}
              </div>
              <div className="text-sm rn-clr-content-secondary">
                <span className="font-medium">Due Cards:</span> {cardInfo.dueCards} / {cardInfo.cardCount}
              </div>
            </div>
          ) : (
             <p className="rn-clr-content-secondary text-center">This Rem has no flashcards to prioritize.</p>
          )}
        </div>
      )}
      
      <button onClick={handleConfirmAndClose} className="mt-2 px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 self-center">
        Close
      </button>
    </div>
  );
}

renderWidget(Priority);

