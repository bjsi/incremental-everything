import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  Rem,
} from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { getCardPriority, setCardPriority, PrioritySource, CardPriorityInfo } from '../lib/cardPriority';
import { calculateRelativePriority } from '../lib/priority';
import { allIncrementalRemKey, powerupCode, prioritySlotCode, currentSubQueueIdKey } from '../lib/consts';
import { IncrementalRem } from '../lib/types';
import * as _ from 'remeda';

// Debounce hook to prevent excessive writes to the database while sliding
function useDebouncedEffect(effect: () => void, deps: React.DependencyList, delay: number) {
  useEffect(() => {
    const handler = setTimeout(() => effect(), delay);
    return () => clearTimeout(handler);
  }, [...deps, delay]);
}

type Scope = {
    remId: string | null; // null for "All KB"
    name: string;
}

type ScopeMode = 'all' | 'document';

type CardScopeType = 'prioritized' | 'all';

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

  // --- SCOPE MANAGEMENT ---
  const [scope, setScope] = useState<Scope>({ remId: null, name: 'All KB' });
  const [scopeHierarchy, setScopeHierarchy] = useState<Scope[]>([]);
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all');
  const [cardScopeType, setCardScopeType] = useState<CardScopeType>('prioritized');

  useTrackerPlugin(async (plugin) => {
    if (!rem) return;

    const ancestors: Rem[] = [];
    let current = rem;
    while (current?.parent) {
      const parent = await plugin.rem.findOne(current.parent);
      if (parent) {
        ancestors.push(parent);
        current = parent;
      } else {
        break;
      }
    }

    let initialScope: Scope | null = null;
    let initialMode: ScopeMode = 'all';

    const url = await plugin.window.getURL();
    if (url.includes('/flashcards')) {
      const subQueueId = await plugin.storage.getSession<string>(currentSubQueueIdKey);
      if (subQueueId) {
        const queueRem = await plugin.rem.findOne(subQueueId);
        if (queueRem) {
          initialScope = { remId: queueRem._id, name: await plugin.richText.toString(queueRem.text) };
          initialMode = 'document';
        }
      }
    } else {
      const documentAncestor = ancestors?.find(async (a) => await a.isDocument());
      if (documentAncestor) {
        initialScope = { remId: documentAncestor._id, name: await plugin.richText.toString(documentAncestor.text) };
        initialMode = 'document';
      }
    }

    const hierarchy: Scope[] = [{ remId: null, name: 'All KB' }];
    if (ancestors) {
        for (const ancestor of ancestors.reverse()) { 
            hierarchy.push({ remId: ancestor._id, name: await plugin.richText.toString(ancestor.text) });
        }
    }

    setScopeHierarchy(hierarchy);
    setScopeMode(initialMode);
    if (initialMode === 'document' && initialScope) {
        setScope(initialScope);
    } else {
        setScope({ remId: null, name: 'All KB' });
    }

  }, [rem?._id]);
  
  const documentScopes = useMemo(() => scopeHierarchy.filter(s => s.remId !== null), [scopeHierarchy]);
  const currentDocumentScopeIndex = useMemo(() => documentScopes.findIndex(s => s.remId === scope.remId), [documentScopes, scope]);
  
  // --- DATA FETCHING ---
  const allIncRems = useTrackerPlugin(async (plugin) => await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [], []);
  
  // --- CORRECTED: This hook now handles all 4 scenarios efficiently ---
  const cardDataSource = useTrackerPlugin(async (plugin) => {
    console.log(`[Debug] Fetching card data. Mode: "${cardScopeType}", Scope: "${scope.name}"`);

    // --- CASE 1: All KB Scope ---
    if (!scope.remId) {
        if (cardScopeType === 'prioritized') {
            console.log('[Debug] Getting all prioritized cards from KB...');
            const powerup = await plugin.powerup.getPowerupByCode('cardPriority');
            if (!powerup) return [];
            const taggedRems = await powerup.taggedRem();
            const cardInfos = await Promise.all(taggedRems.map(r => getCardPriority(plugin, r)));
            return cardInfos.filter(Boolean) as CardPriorityInfo[];
        } else { // 'all'
            console.log('[Debug] Getting all cards from KB using card.getAll()...');
            const allCards = await plugin.card.getAll();
            if (!allCards) return [];
            const remIdsWithCards = _.uniq(allCards.map(card => card.remId));
            const rems = await plugin.rem.findMany(remIdsWithCards) || [];
            const cardInfos = await Promise.all(rems.map(r => getCardPriority(plugin, r)));
            return cardInfos.filter(Boolean) as CardPriorityInfo[];
        }
    }
    // --- CASE 2: Document Scope ---
    else {
        console.log(`[Debug] Getting Rems in document scope: "${scope.name}"`);
        const scopeRem = await plugin.rem.findOne(scope.remId);
        if (!scopeRem) return [];
        const remsInScope = [scopeRem, ...(await scopeRem.getDescendants())];
        console.log(`[Debug] Found ${remsInScope.length} Rems to search within scope.`);

        let potentialRems: Rem[] = [];

        if (cardScopeType === 'prioritized') {
            console.log('[Debug] Filtering for prioritized cards WITHIN the document scope...');
            const checkPromises = remsInScope.map(async r => (await r.hasPowerup('cardPriority')) ? r : null);
            potentialRems = (await Promise.all(checkPromises)).filter(Boolean) as Rem[];
        } else { // 'all'
            console.log('[Debug] Using all Rems WITHIN the document scope...');
            potentialRems = remsInScope;
        }

        console.log(`[Debug] Processing ${potentialRems.length} potential Rems to find cards...`);
        const cardInfos = await Promise.all(potentialRems.map(async (r) => {
            if ((await r.getCards()).length > 0) {
                return getCardPriority(plugin, r);
            }
            return null;
        }));
        const results = cardInfos.filter(Boolean) as CardPriorityInfo[];
        console.log(`[Debug] Finished. Found ${results.length} Rems with cards in this scope.`);
        return results;
    }
  }, [cardScopeType, scope.remId]);

  const scopeDescendantIds = useTrackerPlugin(async (plugin) => {
    if (!scope.remId) return null; 
    const scopeRem = await plugin.rem.findOne(scope.remId);
    if (!scopeRem) return [];
    const descendants = await scopeRem.getDescendants();
    return [scope.remId, ...descendants.map(d => d._id)];
  }, [scope.remId]);

  const scopedIncRems = useMemo(() => {
    if (!allIncRems) return [];
    if (!scope.remId) return allIncRems; 
    if (!scopeDescendantIds) return [];
    return allIncRems.filter(r => scopeDescendantIds.includes(r.remId));
  }, [allIncRems, scope.remId, scopeDescendantIds]);

  const scopedCardRems = useMemo(() => {
    // The data source is now fully scope-aware, so we just use its result directly.
    return cardDataSource || [];
  }, [cardDataSource]);

  const prioritySourceCounts = useMemo(() => {
    if (!scopedCardRems) {
      return { manual: 0, inherited: 0, default: 0 };
    }
    return scopedCardRems.reduce((counts, rem) => {
        counts[rem.source] = (counts[rem.source] || 0) + 1;
        return counts;
    }, { manual: 0, inherited: 0, default: 0 });
  }, [scopedCardRems]);


  const incRemInfo = useTrackerPlugin(async (plugin) => rem ? await getIncrementalRemInfo(plugin, rem) : null, [rem?._id]);
  const cardInfo = useTrackerPlugin(async (plugin) => rem ? await getCardPriority(plugin, rem) : null, [rem?._id]);
  const hasCards = useTrackerPlugin(async (plugin) => {
    if (!rem) return false;
    const cards = await rem.getCards();
    return cards && cards.length > 0;
  }, [rem?._id]);
  const [incAbsPriority, setIncAbsPriority] = useState(incRemInfo?.priority || 50);
  const [incRelPriority, setIncRelPriority] = useState(50);
  const [cardAbsPriority, setCardAbsPriority] = useState(cardInfo?.priority || 50);
  const [cardRelPriority, setCardRelPriority] = useState(50);
  const [showConfirmation, setShowConfirmation] = useState(false);
  useEffect(() => { if (incRemInfo) setIncAbsPriority(incRemInfo.priority) }, [incRemInfo]);
  useEffect(() => { if (cardInfo) setCardAbsPriority(cardInfo.priority) }, [cardInfo]);
  useEffect(() => {
    if (!rem || !scopedIncRems) return;
    const newRelPriority = calculateRelativePriority(scopedIncRems, rem._id);
    if (newRelPriority !== null) setIncRelPriority(newRelPriority);
  }, [scopedIncRems, incAbsPriority, rem]);
  useEffect(() => {
    if (!rem || !scopedCardRems) return;
    const hypotheticalRems = scopedCardRems.map((r) => r.remId === rem._id ? { ...r, priority: cardAbsPriority } : r );
    if (!hypotheticalRems.find(r => r.remId === rem._id)) {
        hypotheticalRems.push({ remId: rem._id, priority: cardAbsPriority, source: 'default', lastUpdated: 0, cardCount: 0, dueCards: 0 });
    }
    const sortedItems = _.sortBy(hypotheticalRems, (x) => x.priority);
    const index = sortedItems.findIndex((x) => x.remId === rem._id);
    if (index !== -1 && sortedItems.length > 0) {
        const percentile = Math.round(((index + 1) / sortedItems.length) * 100);
        setCardRelPriority(percentile);
    }
  }, [scopedCardRems, cardAbsPriority, rem]);
  const handleIncRelativeSliderChange = (newRelPriority: number) => { 
    setIncRelPriority(newRelPriority);
    const remId = widgetContext?.contextData?.remId;
    if (!remId || !scopedIncRems || scopedIncRems.length < 2) return;
    const otherRems = _.sortBy(scopedIncRems.filter((r) => r.remId !== remId), (x) => x.priority);
    const targetIndex = Math.floor(((newRelPriority - 1) / 100) * otherRems.length);
    const clampedIndex = Math.max(0, Math.min(otherRems.length - 1, targetIndex));
    const targetAbsPriority = otherRems[clampedIndex]?.priority;
    if (targetAbsPriority !== undefined) setIncAbsPriority(targetAbsPriority);
  };
  const handleCardRelativeSliderChange = (newRelPriority: number) => {
    setCardRelPriority(newRelPriority);
    const remId = widgetContext?.contextData?.remId;
    if (!remId || !scopedCardRems || scopedCardRems.length < 2) return;
    const otherRems = _.sortBy(scopedCardRems.filter((r) => r.remId !== remId), (x) => x.priority);
    const targetIndex = Math.floor(((newRelPriority - 1) / 100) * otherRems.length);
    const clampedIndex = Math.max(0, Math.min(otherRems.length - 1, targetIndex));
    const targetAbsPriority = otherRems[clampedIndex]?.priority;
    if (targetAbsPriority !== undefined) setCardAbsPriority(targetAbsPriority);
  };
  const showIncSection = incRemInfo !== null;
  const showCardSection = hasCards || (cardInfo && cardInfo.cardCount > 0);
  const saveIncPriority = useCallback(async (priority: number) => {
    if (!rem) return;
    if (!incRemInfo) {
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
    if (cardInfo && (cardInfo.source === 'inherited' || cardInfo.source === 'default')) {
        await saveCardPriority(cardAbsPriority);
    }
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

  const handleTabCycle = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showIncSection || !showCardSection || e.key !== 'Tab' || e.shiftKey) {
        return;
    }

    const incInput = incInputRef.current;
    const cardInput = cardInputRef.current;

    e.preventDefault();

    if (document.activeElement === incInput && cardInput) {
        cardInput.focus();
        cardInput.select();
    } 
    else if (document.activeElement === cardInput && incInput) {
        incInput.focus();
        incInput.select();
    }
  };

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
  
  if (!widgetContext || !rem) { return <div className="p-4">Loading Rem Data...</div>; }
  if (!showIncSection && !showCardSection) { return <div className="p-4 text-center rn-clr-content-secondary">This rem is neither an Incremental Rem nor has flashcards.</div>; }

  const secondaryTextStyle = { color: 'rgba(255, 255, 255, 0.8)' };
  
  return (
    <div className="p-4 flex flex-col gap-4 relative" onKeyDown={async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
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
                style={{ backgroundColor: '#6B7280', color: 'white' }}
                className="px-4 py-1 rounded text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-gray-400"
                onClick={() => saveAndClose(incAbsPriority, cardAbsPriority)}
              >
                Save Both As-Is (Enter)
              </button>
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

      <div className="flex justify-center p-1 bg-gray-200 dark:bg-gray-800 rounded-lg">
        <label className={`cursor-pointer w-1/2 text-center text-sm py-1 px-3 rounded-md transition-colors ${
            scopeMode === 'all'
            ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 font-semibold shadow-sm'
            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-300/50 dark:hover:bg-gray-700'
        }`}>
          <input type="radio" name="scopeMode" value="all" checked={scopeMode === 'all'} onChange={() => { setScopeMode('all'); setScope({ remId: null, name: 'All KB' }); }} className="sr-only" />
          All KB
        </label>
        <label className={`cursor-pointer w-1/2 text-center text-sm py-1 px-3 rounded-md transition-colors ${
            scopeMode === 'document'
            ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 font-semibold shadow-sm'
            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-300/50 dark:hover:bg-gray-700'
        }`}>
          <input type="radio" name="scopeMode" value="document" checked={scopeMode === 'document'} onChange={() => { setScopeMode('document'); if (currentDocumentScopeIndex === -1 && documentScopes.length > 0) { setScope(documentScopes[0]); } }} className="sr-only" />
          Document
        </label>
      </div>

      {scopeMode === 'document' && (
        <div className="p-2 border rounded-md dark:border-gray-600 flex items-center justify-between mt-2">
            <button onClick={() => { if (currentDocumentScopeIndex > 0) { setScope(documentScopes[currentDocumentScopeIndex - 1]); } }} disabled={currentDocumentScopeIndex <= 0} className="px-2 py-1 rounded disabled:opacity-20">↑</button>
            <div className="text-sm font-semibold text-center truncate" title={scope.name}>{scope.name}</div>
            <button onClick={() => { if (currentDocumentScopeIndex < documentScopes.length - 1) { setScope(documentScopes[currentDocumentScopeIndex + 1]); } }} disabled={currentDocumentScopeIndex >= documentScopes.length - 1} className="px-2 py-1 rounded disabled:opacity-20">↓</button>
        </div>
      )}
      
      {showIncSection && (
        <div className="p-4 border border-blue-200 dark:border-blue-800 rounded-lg bg-blue-50 dark:bg-blue-900/20 flex flex-col gap-4">
          <h3 className="text-lg font-semibold flex items-center text-blue-800 dark:text-blue-200">
            <span className="mr-2">📖</span>
            Incremental Rem Priority
          </h3>
          <div className="flex flex-col gap-2">
            <div className="flex justify-between items-center">
              <label className="font-medium">Absolute Priority:</label>
              <input ref={incInputRef} type="number" min={0} max={100} value={incAbsPriority} onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val)) setIncAbsPriority(Math.min(100, Math.max(0, val)));
                    else if (e.target.value === '') setIncAbsPriority(0);
                }} 
                onKeyDown={handleTabCycle}
                className="w-20 text-center p-1 border rounded dark:bg-gray-800 border-gray-300 dark:border-gray-600" />
            </div>
            <input type="range" min="0" max="100" value={incAbsPriority} onChange={(e) => setIncAbsPriority(Number(e.target.value))} className="w-full" />
            <div className="flex justify-between items-center mt-2">
              <label className="font-medium">Relative Priority:</label>
              <span className="text-lg font-bold">{incRelPriority}%</span>
            </div>
            <div className="relative h-8 flex items-center">
               <div className="absolute w-full h-4 rounded-md" style={{ background: `linear-gradient(to right, hsl(0, 80%, 55%), hsl(60, 80%, 55%), hsl(120, 80%, 55%), hsl(240, 80%, 55%))` }}></div>
              <input type="range" min="1" max="100" value={incRelPriority} onChange={(e) => handleIncRelativeSliderChange(Number(e.target.value))} className="absolute w-full custom-transparent-slider" />
            </div>
            <div className="text-xs text-center -mt-1" style={secondaryTextStyle}>
              Universe: {scopedIncRems.length.toLocaleString()} Inc Rem
            </div>
            <div className="text-sm mt-2" style={secondaryTextStyle}>
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
                <input ref={cardInputRef} type="number" min={0} max={100} value={cardAbsPriority} onChange={(e) => {
                        const val = parseInt(e.target.value);
                        if (!isNaN(val)) setCardAbsPriority(Math.min(100, Math.max(0, val)));
                        else if (e.target.value === '') setCardAbsPriority(0);
                    }}
                    onKeyDown={handleTabCycle}
                    className="w-20 text-center p-1 border rounded dark:bg-gray-800 border-gray-300 dark:border-gray-600" />
              </div>
              <input type="range" min="0" max="100" value={cardAbsPriority} onChange={(e) => setCardAbsPriority(Number(e.target.value))} className="w-full" />
              <div className="flex justify-between items-center mt-2">
                <label className="font-medium">Relative Priority:</label>
                <span className="text-lg font-bold">{cardRelPriority}%</span>
              </div>
              <div className="relative h-8 flex items-center">
                <div className="absolute w-full h-4 rounded-md" style={{ background: `linear-gradient(to right, hsl(0, 80%, 55%), hsl(60, 80%, 55%), hsl(120, 80%, 55%), hsl(240, 80%, 55%))` }}></div>
                <input type="range" min="1" max="100" value={cardRelPriority} onChange={(e) => handleCardRelativeSliderChange(Number(e.target.value))} className="absolute w-full custom-transparent-slider" />
              </div>
              <div className="text-xs text-center -mt-1" style={secondaryTextStyle}>
                  Universe: {scopedCardRems.length.toLocaleString()} flashcards
              </div>
              <div className="text-xs text-center mt-2 flex justify-around p-1 bg-gray-100 dark:bg-gray-800 rounded-sm" style={secondaryTextStyle}>
                <span>Manual: {prioritySourceCounts.manual.toLocaleString()}</span>
                <span>Inherited: {prioritySourceCounts.inherited.toLocaleString()}</span>
                <span>Default: {prioritySourceCounts.default.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center text-sm mt-2" style={secondaryTextStyle}>
                <span><span className="font-medium">Source:</span> {cardInfo.source}</span>
                {cardInfo.source === 'inherited' && (
                  <button onClick={() => saveCardPriority(cardInfo.priority)} className="text-blue-500 hover:underline">
                    Convert to Manual
                  </button>
                )}
              </div>
              <div className="text-sm" style={secondaryTextStyle}>
                <span className="font-medium">Due Cards:</span> {cardInfo.dueCards} / {cardInfo.cardCount}
              </div>
              <div className="mt-4 pt-2 border-t dark:border-gray-600">
                  <label className="text-sm font-medium">Calculate Relative To:</label>
                  <div className="flex gap-4 mt-1">
                      <label className="flex items-center gap-2 text-sm">
                          <input type="radio" name="cardScope" value="prioritized" checked={cardScopeType === 'prioritized'} onChange={() => setCardScopeType('prioritized')} />
                          Prioritized Cards
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                          <input type="radio" name="cardScope" value="all" checked={cardScopeType === 'all'} onChange={() => setCardScopeType('all')} />
                          All Cards
                      </label>
                  </div>
              </div>
            </div>
          ) : ( <p className="text-center" style={secondaryTextStyle}>This rem has no flashcards to prioritize.</p> )}
        </div>
      )}
      
      <button onClick={handleConfirmAndClose} className="mt-2 px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 self-center">
        Close
      </button>
    </div>
  );
}

renderWidget(Priority);