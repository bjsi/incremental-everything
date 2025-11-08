import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  PluginRem,
  RemId,
} from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { 
  getCardPriority, 
  setCardPriority, 
  PrioritySource, 
  CardPriorityInfo, 
  calculateRelativeCardPriority, 
  QueueSessionCache 
} from '../lib/cardPriority';
import { calculateRelativePriority as calculateIncRemRelativePriority } from '../lib/priority';
import { 
  allIncrementalRemKey, 
  powerupCode, 
  nextRepDateSlotCode, 
  prioritySlotCode, 
  currentSubQueueIdKey, 
  allCardPriorityInfoKey, 
  cardPriorityCacheRefreshKey, 
  queueSessionCacheKey,
  isMobileDeviceKey,          
  alwaysUseLightModeOnMobileId 
} from '../lib/consts';
import { IncrementalRem } from '../lib/types';
import { updateCardPriorityInCache, flushLightCacheUpdates } from '../lib/cache';
import { findClosestAncestorWithAnyPriority } from '../lib/priority_inheritance';
import { safeRemTextToString } from '../lib/pdfUtils';
import * as _ from 'remeda';

type Scope = { remId: string | null; name: string; };
type ScopeMode = 'all' | 'document';
type CardScopeType = 'prioritized' | 'all';

function Priority() {
  const plugin = usePlugin();

  // --- ALL HOOKS DECLARED UNCONDITIONALLY AT THE TOP ---

  // ✅ Track the values that determine effective mode
  const performanceModeSetting = useTrackerPlugin(
    (rp) => rp.settings.getSetting<string>('performanceMode'), 
    []
  ) || 'full';

  const isMobile = useTrackerPlugin(
    async (rp) => await rp.storage.getSynced<boolean>(isMobileDeviceKey),
    []
  );

  const alwaysUseLightOnMobile = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(alwaysUseLightModeOnMobileId),
    []
  );

  // ✅ Calculate effective mode
  const performanceMode = performanceModeSetting === 'light' || 
                          (isMobile && alwaysUseLightOnMobile !== false) 
                          ? 'light' : 'full';

  // State Hooks
  const [scope, setScope] = useState<Scope>({ remId: null, name: 'All KB' });
  const [scopeHierarchy, setScopeHierarchy] = useState<Scope[]>([]);
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all');
  const [cardScopeType, setCardScopeType] = useState<CardScopeType>('prioritized');
  const [incAbsPriority, setIncAbsPriority] = useState(50);
  const [cardAbsPriority, setCardAbsPriority] = useState(50);
  const [incRelPriority, setIncRelPriority] = useState(50);
  const [cardRelPriority, setCardRelPriority] = useState(50);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [showInheritanceForIncRem, setShowInheritanceForIncRem] = useState(false);
  const incInputRef = useRef<HTMLInputElement>(null);
  const cardInputRef = useRef<HTMLInputElement>(null);

  // Data Fetching Hooks
  const widgetContext = useRunAsync(async () => await plugin.widget.getWidgetContext<{ remId: string }>(), []);
  const rem = useTrackerPlugin(async (plugin) => {
    const remId = widgetContext?.contextData?.remId;
    if (!remId) return null;
    return await plugin.rem.findOne(remId);
  }, [widgetContext?.contextData?.remId]);

  // 🔌 Conditionally fetch cache based on performance mode
  const sessionCache = useTrackerPlugin(
    (rp) => (performanceMode === 'full') 
      ? rp.storage.getSession<QueueSessionCache>(queueSessionCacheKey) 
      : Promise.resolve(null), 
  [performanceMode]);
  
  const allIncRems = useTrackerPlugin(async (plugin) => await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [], []);
  
  const allCardInfos = useTrackerPlugin(async (plugin) => 
    (performanceMode === 'full')
      ? await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey) || [] 
      : Promise.resolve([]), 
  [performanceMode]);

  const queueSubQueueId = useTrackerPlugin((rp) => rp.storage.getSession<string | null>(currentSubQueueIdKey), []);
  
  // --- NEW: Priority Review Document awareness ---
  const originalScopeId = useTrackerPlugin(
    (rp) => rp.storage.getSession<string | null>('originalScopeId'),
    []
  );
  
  const isPriorityReviewDoc = useTrackerPlugin(
    (rp) => rp.storage.getSession<boolean>('isPriorityReviewDoc'),
    []
  );
  
  const inQueue = !!queueSubQueueId;

  const incRemInfo = useTrackerPlugin(async (plugin) => rem ? await getIncrementalRemInfo(plugin, rem) : null, [rem?._id]);
  const cardInfo = useTrackerPlugin(async (plugin) => rem ? await getCardPriority(plugin, rem) : null, [rem?._id]);
  const hasCards = useTrackerPlugin(async (plugin) => rem ? (await rem.getCards()).length > 0 : false, [rem?._id]);

  // This tracker is fast (direct Rem lookup) so it can run in both modes,
  // but we will conditionally *show* the UI in 'full' mode only.
  const ancestorPriorityInfo = useTrackerPlugin(async (plugin) => {
    if (!rem) return null;
    return await findClosestAncestorWithAnyPriority(plugin, rem);
  }, [rem]);

  // Asynchronous Derived Data Hook
  const derivedData = useRunAsync(async () => {
    if (!rem) return undefined;

    // Calculate descendant card count (needed for "Set Card Priority" button)
    // We fetch this in both modes, but it's much faster in 'light' mode.
    let finalDescendantCardCount = 0;
    if (performanceMode === 'full') {
        const remDescendants = await rem.getDescendants();
        const remDescendantIds = new Set(remDescendants.map(d => d._id));
        finalDescendantCardCount = _.sumBy(
          allCardInfos.filter(info => remDescendantIds.has(info.remId)), 
          c => c.cardCount
        );
    } else {
        // Light mode: a faster, less accurate (but still useful) check
        const descendants = await rem.getDescendants();
        // This is a rough proxy but avoids loading the allCardInfos cache
        const cardsInDescendants = await Promise.all(descendants.map(d => d.getCards()));
        finalDescendantCardCount = cardsInDescendants.flat().length;
    }

    // 🔌 Check performance mode
    if (performanceMode === 'light') {
      // In light mode, we only return the descendant count and empty arrays
      return { 
        scopedIncRems: [], 
        scopedCardRems: [],
        incRelPriority: 50,
        cardRelPriority: 50,
        descendantCardCount: finalDescendantCardCount, 
        prioritySourceCounts: { manual: 0, inherited: 0, default: 0 },
      };
    }

    // --- FULL MODE LOGIC ---
    // ... (rest of the existing derivedData logic) ...
    const effectiveScopeForCache = originalScopeId || queueSubQueueId;
    const useFastCache = inQueue && scope.remId === effectiveScopeForCache;
    
    if (useFastCache && isPriorityReviewDoc) {
      console.log('[Priority Widget] Using fast cache with original scope:', originalScopeId);
    }
    
    let finalScopedIncRems: IncrementalRem[];
    let finalScopedCardRems: CardPriorityInfo[];
    let finalIncRel: number | null = null;
    let finalCardRel: number | null = null;
    let finalPrioritySourceCounts = { manual: 0, inherited: 0, default: 0 };

    if (useFastCache && sessionCache) {
      // --- ULTRA-FAST PATH (uses pre-calculated cache from QueueEnter) ---
      const incRemsInScope = allIncRems.filter(r => sessionCache.incRemDocPercentiles.hasOwnProperty(r.remId));
      const cardRemsInScope = allCardInfos.filter(ci => sessionCache.docPercentiles.hasOwnProperty(ci.remId));
      finalScopedIncRems = (scopeMode === 'all') ? allIncRems : incRemsInScope;
      const allCardsInScope = (scopeMode === 'all') ? allCardInfos : cardRemsInScope;
      finalPrioritySourceCounts = allCardsInScope.reduce((counts, rem) => ({...counts, [rem.source]: (counts[rem.source] || 0) + 1 }), { manual: 0, inherited: 0, default: 0 });
      finalScopedCardRems = (cardScopeType === 'prioritized' ? allCardsInScope.filter(c => c.source !== 'default') : allCardsInScope);
      finalIncRel = (scopeMode === 'document') ? sessionCache.incRemDocPercentiles[rem._id] : calculateIncRemRelativePriority(allIncRems, rem._id);
      finalCardRel = (scopeMode === 'document') ? sessionCache.docPercentiles[rem._id] : calculateRelativeCardPriority(allCardInfos, rem._id);
      
    } else {
      // --- OPTIMIZED ASYNC FALLBACK PATH WITH COMPREHENSIVE SCOPE ---
      const scopeRem = scopeMode === 'document' && scope.remId ? await plugin.rem.findOne(scope.remId) : null;
      
      let scopeIds: Set<RemId> | null = null;
      
      if (scopeRem) {
        // --- COMPREHENSIVE SCOPE CALCULATION ---
        console.log('[Priority Widget] Building comprehensive document scope...');
        
        const descendants = await scopeRem.getDescendants();
        const allRemsInContext = await scopeRem.allRemInDocumentOrPortal();
        const folderQueueRems = await scopeRem.allRemInFolderQueue();
        const sources = await scopeRem.getSources();
        
        const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
          powerupCode,
          nextRepDateSlotCode
        );
        
        const referencingRems = ((await scopeRem.remsReferencingThis()) || []).map((rem) => {
          if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
            return rem.parent;
          } else {
            return rem._id;
          }
        }).filter(id => id !== null && id !== undefined) as RemId[];
        
        scopeIds = new Set<RemId>([
          scopeRem._id,
          ...descendants.map(d => d._id),
          ...allRemsInContext.map(r => r._id),
          ...folderQueueRems.map(r => r._id),
          ...sources.map(r => r._id),
          ...referencingRems
        ]);
        
        console.log(`[Priority Widget] Comprehensive scope: ${scopeIds.size} rems`);
        console.log(`[Priority Widget]  - Descendants: ${descendants.length}`);
        console.log(`[Priority Widget]  - Document/portal: ${allRemsInContext.length}`);
        console.log(`[Priority Widget]  - Folder queue: ${folderQueueRems.length}`);
        console.log(`[Priority Widget]  - Sources: ${sources.length}`);
        console.log(`[Priority Widget]  - References: ${referencingRems.length}`);
      }
      
      finalScopedIncRems = scopeIds ? allIncRems.filter(r => scopeIds.has(r.remId)) : allIncRems;
      let tempScopedCardRems = scopeIds ? allCardInfos.filter(ci => scopeIds.has(ci.remId)) : allCardInfos;
      
      finalPrioritySourceCounts = tempScopedCardRems.reduce((counts, rem) => ({...counts, [rem.source]: (counts[rem.source] || 0) + 1 }), { manual: 0, inherited: 0, default: 0 });

      if (cardScopeType === 'prioritized') {
        tempScopedCardRems = tempScopedCardRems.filter(c => c.source !== 'default');
      }
      finalScopedCardRems = tempScopedCardRems;
      finalIncRel = calculateIncRemRelativePriority(finalScopedIncRems, rem._id);
      finalCardRel = calculateRelativeCardPriority(finalScopedCardRems, rem._id);
    }    
    return { 
      scopedIncRems: finalScopedIncRems, 
      scopedCardRems: finalScopedCardRems,
      incRelPriority: finalIncRel || 50,
      cardRelPriority: finalCardRel || 50,
      descendantCardCount: finalDescendantCardCount, 
      prioritySourceCounts: finalPrioritySourceCounts,
    };
  }, [rem, inQueue, scope, allIncRems, allCardInfos, cardScopeType, sessionCache, queueSubQueueId, scopeMode, originalScopeId, isPriorityReviewDoc, performanceMode]); // 🔌 Add performanceMode

  // Synchronous Derived Data Hooks (Memoization)
  const documentScopes = useMemo(() => scopeHierarchy.filter(s => s.remId !== null), [scopeHierarchy]);
  const currentDocumentScopeIndex = useMemo(() => documentScopes.findIndex(s => s.remId === scope.remId), [documentScopes, scope]);

  // Effect Hooks
  useEffect(() => { if (incRemInfo) setIncAbsPriority(incRemInfo.priority) }, [incRemInfo]);
  useEffect(() => { if (cardInfo) setCardAbsPriority(cardInfo.priority) }, [cardInfo]);
  
  // This tracker is fast and only runs in 'full' mode, so it's fine.
  useTrackerPlugin(async (plugin) => {
    if (!rem || performanceMode === 'light') return; // 🔌 Skip in light mode
    const ancestors: PluginRem[] = [];
    let current: PluginRem | undefined = rem;
    while (current?.parent) {
      const parent = await plugin.rem.findOne(current.parent);
      if (parent) { ancestors.push(parent); current = parent; } else { break; }
    }
    const hierarchy: Scope[] = [{ remId: null, name: 'All KB' }];
    for (const ancestor of ancestors.reverse()) { 
      hierarchy.push({ remId: ancestor._id, name: await safeRemTextToString(plugin, ancestor.text) });
    }
    setScopeHierarchy(hierarchy);
  }, [rem?._id, performanceMode]); // 🔌 Add performanceMode
  
  // --- MODIFIED: Initialize scope with original scope for Priority Review Documents ---
  useEffect(() => {
    const initializeScope = async () => {
      if (inQueue && queueSubQueueId && performanceMode === 'full') { // 🔌 Skip in light mode
        // Use originalScopeId if available (Priority Review Document case)
        const effectiveScopeId = originalScopeId || queueSubQueueId;
        const scopeRem = await plugin.rem.findOne(effectiveScopeId);
        
        if (scopeRem) {
          setScope({ 
            remId: scopeRem._id, 
            name: await safeRemTextToString(plugin, scopeRem.text) 
          });
          setScopeMode('document');
          
          if (isPriorityReviewDoc && originalScopeId) {
            console.log('[Priority Widget] Using original scope from Priority Review Document:', originalScopeId);
          }
        }
      }
    };
    initializeScope();
  }, [inQueue, queueSubQueueId, originalScopeId, isPriorityReviewDoc, performanceMode]); // 🔌 Add performanceMode

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

  // This effect calculates hypothetical relative priority, skip in 'light' mode
  useEffect(() => {
    if (performanceMode === 'full' && derivedData && rem) {
      const hypotheticalRems = [
        ...derivedData.scopedIncRems.filter(r => r.remId !== rem._id),
        { remId: rem._id, priority: incAbsPriority } as IncrementalRem
      ];
      const newRelPriority = calculateIncRemRelativePriority(hypotheticalRems, rem._id);
      if (newRelPriority !== null) setIncRelPriority(newRelPriority);
    }
  }, [incAbsPriority, derivedData, rem, performanceMode]); // 🔌 Add performanceMode

  useEffect(() => {
    if (performanceMode === 'full' && derivedData && rem) {
      const hypotheticalRems = [
        ...derivedData.scopedCardRems.filter(r => r.remId !== rem._id),
        { remId: rem._id, priority: cardAbsPriority, source: 'manual' } as CardPriorityInfo
      ];
      const newRelPriority = calculateRelativeCardPriority(hypotheticalRems, rem._id);
      if (newRelPriority !== null) setCardRelPriority(newRelPriority);
    }
  }, [cardAbsPriority, derivedData, rem, performanceMode]); // 🔌 Add performanceMode

  // Event Handlers
  const showIncSection = incRemInfo !== null;
  const showCardSection = hasCards || (cardInfo && cardInfo.cardCount > 0);
  
  const saveIncPriority = useCallback(async (priority: number) => {
    if (!rem) return;
    if (!incRemInfo) await rem.addPowerup(powerupCode);
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [priority.toString()]);
    
    // Get the updated IncRem info and update allIncrementalRemKey
    const updatedIncRem = await getIncrementalRemInfo(plugin, rem);
    if (updatedIncRem) {
      const allIncRems = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];
      const updatedAllIncRems = allIncRems
        .filter((r) => r.remId !== updatedIncRem.remId)
        .concat(updatedIncRem);
      await plugin.storage.setSession(allIncrementalRemKey, updatedAllIncRems);
    }
    
    // 🔌 Conditionally update session cache
    if (performanceMode === 'full' && sessionCache && originalScopeId) {
      const newIncRemDocPercentiles = { ...sessionCache.incRemDocPercentiles };
      delete newIncRemDocPercentiles[rem._id];
      
      const updatedCache = {
        ...sessionCache,
        incRemDocPercentiles: newIncRemDocPercentiles
      };
      
      await plugin.storage.setSession(queueSessionCacheKey, updatedCache);
    }
  }, [rem, incRemInfo, plugin, sessionCache, originalScopeId, performanceMode]); // 🔌 Add performanceMode

  const saveCardPriority = useCallback(async (priority: number) => {
    if (!rem) return;
    await setCardPriority(plugin, rem, priority, 'manual');

    // 🔌 Only do cache updates in 'full' mode
    if (performanceMode === 'full') {
        const numCardsRemaining = await plugin.queue.getNumRemainingCards();
        const isInQueueNow = numCardsRemaining !== undefined;
        await updateCardPriorityInCache(plugin, rem._id, isInQueueNow);
        
        await flushLightCacheUpdates(plugin);
        
        const allCardInfos = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey) || [];
        const sortedInfos = [...allCardInfos].sort((a, b) => a.priority - b.priority);
        const totalItems = sortedInfos.length;
        const recalculatedInfos = sortedInfos.map((info, index) => {
          const percentile = totalItems > 0 ? Math.round(((index + 1) / totalItems) * 100) : 0;
          return { ...info, kbPercentile: percentile };
        });
        await plugin.storage.setSession(allCardPriorityInfoKey, recalculatedInfos);
        
        await plugin.storage.setSession(cardPriorityCacheRefreshKey, Date.now());
        
        if (sessionCache && originalScopeId) {
          const newDocPercentiles = { ...sessionCache.docPercentiles };
          delete newDocPercentiles[rem._id];
          
          const updatedCache = {
            ...sessionCache,
            docPercentiles: newDocPercentiles
          };
          
          await plugin.storage.setSession(queueSessionCacheKey, updatedCache);
        }
    }
  }, [rem, plugin, sessionCache, originalScopeId, performanceMode]); // 🔌 Add performanceMode

  const showInheritanceSection = 
    (!showIncSection && !showCardSection && derivedData?.descendantCardCount > 0) ||
    (showIncSection && !hasCards && cardInfo?.source === 'manual') ||
    showInheritanceForIncRem;

  const saveAndClose = useCallback(async (incP: number, cardP: number) => {
    if (showIncSection) await saveIncPriority(incP);
    if (showCardSection || showInheritanceSection) {
      await saveCardPriority(cardP);
      // Cache flush and refresh signal are now handled inside saveCardPriority
    }
    plugin.widget.closePopup();
  }, [plugin, showIncSection, showCardSection, showInheritanceSection, saveIncPriority, saveCardPriority]);

  const handleConfirmAndClose = useCallback(async () => {
    const bothSectionsVisible = showIncSection && (showCardSection || showInheritanceSection);
    if (bothSectionsVisible && incRemInfo && cardInfo) {
      const wasIncPriorityChanged = incAbsPriority !== incRemInfo.priority;
      const wasCardPriorityChanged = cardAbsPriority !== cardInfo.priority;
      const isCardPriorityManual = cardInfo.source === 'manual';
      const prioritiesAreDifferent = incAbsPriority !== cardAbsPriority;

      if (prioritiesAreDifferent && (isCardPriorityManual || (wasIncPriorityChanged && wasCardPriorityChanged))) {
        setShowConfirmation(true);
        return;
      }
      if (wasIncPriorityChanged && !wasCardPriorityChanged && !isCardPriorityManual) {
        await saveAndClose(incAbsPriority, incAbsPriority);
        return;
      }
    }
    await saveAndClose(incAbsPriority, cardAbsPriority);
  }, [showIncSection, showCardSection, showInheritanceSection, incRemInfo, cardInfo, incAbsPriority, cardAbsPriority, saveAndClose]);

  const handleIncRelativeSliderChange = (newRelPriority: number) => { 
    if (!rem || !derivedData?.scopedIncRems || derivedData.scopedIncRems.length < 2) return;
    const otherRems = _.sortBy(derivedData.scopedIncRems.filter((r) => r.remId !== rem._id), (x) => x.priority);
    const targetIndex = Math.floor(((newRelPriority - 1) / 100) * otherRems.length);
    const clampedIndex = Math.max(0, Math.min(otherRems.length - 1, targetIndex));
    const targetAbsPriority = otherRems[clampedIndex]?.priority;
    if (targetAbsPriority !== undefined) setIncAbsPriority(targetAbsPriority);
  };

    const handleCardRelativeSliderChange = (newRelPriority: number) => {
    if (!rem || !derivedData?.scopedCardRems || derivedData.scopedCardRems.length < 2) return;
    const otherRems = _.sortBy(derivedData.scopedCardRems.filter((r) => r.remId !== rem._id), (x) => x.priority);
    const targetIndex = Math.floor(((newRelPriority - 1) / 100) * otherRems.length);
    const clampedIndex = Math.max(0, Math.min(otherRems.length - 1, targetIndex));
    const targetAbsPriority = otherRems[clampedIndex]?.priority;
    if (targetAbsPriority !== undefined) setCardAbsPriority(targetAbsPriority);
  };

  const handleTabCycle = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showIncSection || (!showCardSection && !showInheritanceSection) || e.key !== 'Tab' || e.shiftKey) return;
    const incInput = incInputRef.current;
    const cardInput = cardInputRef.current;
    e.preventDefault();
    if (document.activeElement === incInput && cardInput) {
        cardInput.focus(); cardInput.select();
    } else if (document.activeElement === cardInput && incInput) {
        incInput.focus(); incInput.select();
    }
  };

  const removeFromIncremental = useCallback(async () => {
    if (!rem) return;
    await rem.removePowerup(powerupCode);
    const currentIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
    const updated = currentIncRems.filter(r => r.remId !== rem._id);
    await plugin.storage.setSession(allIncrementalRemKey, updated);
    await plugin.app.toast('Removed from Incremental Queue');
    plugin.widget.closePopup();
  }, [plugin, rem]);
    
  const removeCardPriority = useCallback(async () => {
    if (!rem) return;
    await rem.removePowerup('cardPriority');
    // 🔌 Conditionally update cache
    if (performanceMode === 'full') {
        await updateCardPriorityInCache(plugin, rem._id);
    }
    await plugin.app.toast('Card Priority for inheritance removed.');
    plugin.widget.closePopup();
  }, [plugin, rem, performanceMode]); // 🔌 Add performanceMode
  
  // --- EARLY RETURNS & FINAL DATA DE-STRUCTURING ---
  if (!widgetContext || !rem) { return <div className="p-4">Loading Rem Data...</div>; }
  
  if (!derivedData) {
    return (
      <div className="p-4 flex flex-col gap-4 relative items-center justify-center">
        <h2 className="text-xl font-bold">Priority Settings</h2>
        <div className="text-lg">Calculating...</div>
      </div>
    );
  }

  const { scopedIncRems, scopedCardRems, descendantCardCount, prioritySourceCounts } = derivedData;
  
  const showAddCardPriorityButton = showIncSection && !showCardSection && descendantCardCount > 0 && !showInheritanceSection;

  if (!showIncSection && !showCardSection && !showInheritanceSection) { 
    return <div className="p-4 text-center rn-clr-content-secondary">This rem is neither an Incremental Rem nor has flashcards.</div>; 
  }
  
  const secondaryTextStyle = { color: 'rgba(255, 255, 255, 0.8)' };
  
  // --- FINAL JSX RENDER ---
  return (
    <div className="p-4 flex flex-col gap-4 relative" onKeyDown={async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (showConfirmation) {
          await saveAndClose(incAbsPriority, cardAbsPriority);
        } else {
          await handleConfirmAndClose();
        }
      } else if (e.key === 'Escape') {
        plugin.widget.closePopup();
      }
    }}>
      {showConfirmation && (
        <div className="absolute inset-0 bg-white/80 dark:bg-black/80 flex items-center justify-center z-10 p-4 rounded-lg">
          <div className="p-6 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col gap-4 text-center max-w-sm">
            <h3 className="font-semibold text-lg">Priorities are different</h3>
            <p className="text-sm rn-clr-content-secondary">
              Incremental Rem ({incAbsPriority}) and Flashcard ({cardAbsPriority}) priorities do not match.  Please choose an option below.
            </p>
            <div className="flex flex-col gap-2">
              <button
                style={{ backgroundColor: '#6B7280', color: 'white' }}
                className="px-4 py-2 rounded text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-gray-400"
                onClick={() => saveAndClose(incAbsPriority, cardAbsPriority)}
              >
                Save Both As-Is (Enter)
              </button>
              <button
                style={{ backgroundColor: '#3B82F6', color: 'white' }}
                className="px-4 py-2 rounded font-semibold focus:outline-none focus:ring-2 focus:ring-blue-400"
                onClick={() => saveAndClose(incAbsPriority, incAbsPriority)}
              >
                Use IncRem Priority for Both ({incAbsPriority})
              </button>
              <button
                style={{ backgroundColor: '#10B981', color: 'white' }}
                className="px-4 py-2 rounded font-semibold focus:outline-none focus:ring-2 focus:ring-green-400"
                onClick={() => saveAndClose(cardAbsPriority, cardAbsPriority)}
              >
                Use Card Priority for Both ({cardAbsPriority})
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

      {/* 🔌 Conditionally render scope UI */}
      {performanceMode === 'full' && (
        <>
          {isPriorityReviewDoc && originalScopeId && scopeMode === 'document' && (
            <div className="px-3 py-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded text-xs text-center">
              📊 Scope: <span className="font-semibold">{scope.name}</span> (Original Document)
            </div>
          )}

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
        </>
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
            
            {/* 🔌 Conditionally render relative priority */}
            {performanceMode === 'full' && (
              <>
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
              </>
            )}

            <div className="text-sm mt-2" style={secondaryTextStyle}>
              Next review: {incRemInfo && new Date(incRemInfo.nextRepDate).toLocaleDateString()}
            </div>
          </div>

          {showAddCardPriorityButton && (
            <div className="pt-2 mt-2 border-t border-blue-200/50 dark:border-blue-800/50">
              <p className="text-xs text-center text-blue-700 dark:text-blue-300 mb-2">
                This Rem has {descendantCardCount} descendant flashcards.
              </p>
              <button 
                onClick={() => {
                  setCardAbsPriority(incAbsPriority);
                  setShowInheritanceForIncRem(true);
                }}
                className="w-full px-4 py-2 bg-yellow-500 text-white rounded hover:bg-yellow-600 self-center font-semibold"
                >
                Set Card Priority for Inheritance
              </button>
            </div>
          )}

          {/* 🔌 Conditionally render ancestor info */}
          {performanceMode === 'full' && ancestorPriorityInfo && ancestorPriorityInfo.sourceType === 'IncRem' && (
            <div className="mt-2 p-3 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
              <div className="text-sm font-semibold text-blue-700 dark:text-blue-300">
                Closest Ancestor Priority: {ancestorPriorityInfo.priority}
              </div>
              <div className="text-xs text-blue-600 dark:text-blue-400 mt-1 truncate">
                {ancestorPriorityInfo.ancestorName}
              </div>
            </div>
          )}

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
              
              {/* 🔌 Conditionally render relative priority */}
              {performanceMode === 'full' && (
                <>
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
                </>
              )}
              
              {/* 🔌 Conditionally render ancestor info */}
              {performanceMode === 'full' && ancestorPriorityInfo && (
                <div className="mt-4 p-3 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                  <div className="text-sm font-semibold text-blue-700 dark:text-blue-300">
                    {cardInfo?.source === 'inherited' 
                      ? `Inherits from Ancestor (${ancestorPriorityInfo.sourceType}): ${ancestorPriorityInfo.priority}`
                      : `Ancestor Priority (${ancestorPriorityInfo.sourceType}): ${ancestorPriorityInfo.priority}`
                    }
                  </div>
                  <div className="text-xs text-blue-600 dark:text-blue-400 mt-1 truncate">
                    {ancestorPriorityInfo.ancestorName}
                  </div>
                </div>
              )}


              {hasCards && cardInfo && (
                <>
                  {/* 🔌 Conditionally render statistics */}
                  {performanceMode === 'full' && (
                    <div className="text-xs text-center mt-2 flex justify-around p-1 bg-gray-100 dark:bg-gray-800 rounded-sm" style={secondaryTextStyle}>
                      <span>Manual: {prioritySourceCounts.manual.toLocaleString()}</span>
                      <span>Inherited: {prioritySourceCounts.inherited.toLocaleString()}</span>
                      <span>Default: {prioritySourceCounts.default.toLocaleString()}</span>
                    </div>
                  )}
                  <div className="flex justify-between items-center text-sm mt-2" style={secondaryTextStyle}>
                    <span><span className="font-medium">Source:</span> {cardInfo?.source}</span>
                    {cardInfo?.source === 'inherited' && (
                      <button onClick={() => saveCardPriority(cardInfo.priority)} className="text-blue-500 hover:underline">
                        Convert to Manual
                      </button>
                    )}
                  </div>
                  <div className="text-sm" style={secondaryTextStyle}>
                    <span className="font-medium">Due Cards:</span> {cardInfo?.dueCards} / {cardInfo?.cardCount}
                  </div>
                  
                  {/* 🔌 Conditionally render scope type radio buttons */}
                  {performanceMode === 'full' && (
                    <div className="mt-4 pt-2 border-t dark:border-gray-600">
                        <label className="text-sm font-medium">Calculate Relative To:</label>
                        <div className="flex gap-4 mt-1">
                            <label className="flex items-center gap-2 text-sm">
                                <input type="radio" name="cardScope" value="prioritized" checked={cardScopeType === 'prioritized'} onChange={() => setCardScopeType('prioritized')} />
                                Prioritized Cards (Manual + Inherited)
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                                <input type="radio" name="cardScope" value="all" checked={cardScopeType === 'all'} onChange={() => setCardScopeType('all')} />
                                All Cards
                            </label>
                        </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
      )}

      {showInheritanceSection && (
         <div className="p-4 border border-yellow-200 dark:border-yellow-800 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 flex flex-col gap-4">
          <h3 className="text-lg font-semibold flex items-center text-yellow-800 dark:text-yellow-200">
            <span className="mr-2">🌿</span>
            Set Card Priority for Inheritance
          </h3>
          <p className="text-xs text-yellow-700 dark:text-yellow-300 -mt-2">
            {showIncSection 
              ? `This Incremental Rem has no cards, but you can set a card priority for its ${descendantCardCount} descendant flashcards to inherit.`
              : `This Rem has no cards, but its descendants have ${descendantCardCount} ${descendantCardCount === 1 ? 'flashcard' : 'flashcards'}. You can set a priority here for them to inherit.`
            }
          </p> 
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
              
              {/* 🔌 Conditionally render relative priority */}
              {performanceMode === 'full' && (
                <>
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
                </>
              )}
            </div>
            
            {cardInfo?.source === 'manual' && (
              <button 
                onClick={removeCardPriority} 
                className="mt-2 px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 self-center"
              >
                Remove Card Priority
              </button>
            )}
        </div>
      )}
      
      <button 
        onClick={handleConfirmAndClose} 
        className="mt-2 px-4 py-2 font-semibold rounded self-center"
        style={{
          backgroundColor: '#3B82F6',
          color: 'white',
          border: 'none',
        }}
      >
        Close
      </button>
    </div>
  );
}

renderWidget(Priority);