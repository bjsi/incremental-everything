import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  PluginRem,
  RemId,
} from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { getIncrementalRemFromRem, initIncrementalRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache, removeIncrementalRemCache } from '../lib/incremental_rem/cache';
import {
  getCardPriority,
  setCardPriority,
  CardPriorityInfo,
  QueueSessionCache
} from '../lib/card_priority';
import { calculateRelativePercentile, DEFAULT_PERFORMANCE_MODE, PERFORMANCE_MODE_FULL, PERFORMANCE_MODE_LIGHT } from '../lib/utils';
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
import { IncrementalRem } from '../lib/incremental_rem';
import { updateCardPriorityCache, flushLightCacheUpdates } from '../lib/card_priority/cache';
import { findClosestAncestorWithAnyPriority } from '../lib/priority_inheritance';
import { safeRemTextToString } from '../lib/pdfUtils';
import { PriorityBadge, PrioritySlider, PrioritySliderRef } from '../components';
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
  ) || DEFAULT_PERFORMANCE_MODE;

  const isMobile = useTrackerPlugin(
    async (rp) => await rp.storage.getSynced<boolean>(isMobileDeviceKey),
    []
  );

  const alwaysUseLightOnMobile = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(alwaysUseLightModeOnMobileId),
    []
  );

  // ✅ Calculate effective mode
  const performanceMode = performanceModeSetting === PERFORMANCE_MODE_LIGHT || 
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
  const incSliderRef = useRef<PrioritySliderRef>(null);
  const cardSliderRef = useRef<PrioritySliderRef>(null);

  // Data Fetching Hooks
  const widgetContext = useRunAsync(async () => await plugin.widget.getWidgetContext<{ remId: string }>(), []);
  const rem = useTrackerPlugin(async (plugin) => {
    const remId = widgetContext?.contextData?.remId;
    if (!remId) return null;
    return await plugin.rem.findOne(remId);
  }, [widgetContext?.contextData?.remId]);

  // 🔌 Conditionally fetch cache based on performance mode
  const sessionCache = useTrackerPlugin(
    (rp) => (performanceMode === PERFORMANCE_MODE_FULL) 
      ? rp.storage.getSession<QueueSessionCache>(queueSessionCacheKey) 
      : Promise.resolve(null), 
  [performanceMode]);
  
  const allIncRems = useTrackerPlugin(async (plugin) => await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [], []);
  
  const allCardInfos = useTrackerPlugin(async (plugin) => 
    (performanceMode === PERFORMANCE_MODE_FULL)
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

  const incRemInfo = useTrackerPlugin(async (plugin) => rem ? await getIncrementalRemFromRem(plugin, rem) : null, [rem?._id]);
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
    // We always use direct card fetching now for accuracy, since the cache
    // may not include all cards (especially during deferred loading).
    const descendants = await rem.getDescendants();
    const cardsInDescendants = await Promise.all(descendants.map(d => d.getCards()));
    const finalDescendantCardCount = cardsInDescendants.flat().length;

    // 🔌 Check performance mode
    if (performanceMode === PERFORMANCE_MODE_LIGHT) {
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
      finalIncRel = (scopeMode === 'document') ? sessionCache.incRemDocPercentiles[rem._id] : calculateRelativePercentile(allIncRems, rem._id);
      finalCardRel = (scopeMode === 'document') ? sessionCache.docPercentiles[rem._id] : calculateRelativePercentile(allCardInfos, rem._id);
      
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
      finalIncRel = calculateRelativePercentile(finalScopedIncRems, rem._id);
      finalCardRel = calculateRelativePercentile(finalScopedCardRems, rem._id);
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
    if (!rem || performanceMode === PERFORMANCE_MODE_LIGHT) return; // 🔌 Skip in light mode
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
      if (inQueue && queueSubQueueId && performanceMode === PERFORMANCE_MODE_FULL) { // 🔌 Skip in light mode
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
      if (incSliderRef.current) {
        incSliderRef.current.focus();
        incSliderRef.current.select();
      } else if (cardSliderRef.current) {
        cardSliderRef.current.focus();
        cardSliderRef.current.select();
      }
    }, 50);
  }, [incRemInfo, cardInfo]);

  // This effect calculates hypothetical relative priority, skip in 'light' mode
  useEffect(() => {
    if (performanceMode === PERFORMANCE_MODE_FULL && derivedData && rem) {
      const hypotheticalRems = [
        ...derivedData.scopedIncRems.filter(r => r.remId !== rem._id),
        { remId: rem._id, priority: incAbsPriority } as IncrementalRem
      ];
      const newRelPriority = calculateRelativePercentile(hypotheticalRems, rem._id);
      if (newRelPriority !== null) setIncRelPriority(newRelPriority);
    }
  }, [incAbsPriority, derivedData, rem, performanceMode]); // 🔌 Add performanceMode

  useEffect(() => {
    if (performanceMode === PERFORMANCE_MODE_FULL && derivedData && rem) {
      const hypotheticalRems = [
        ...derivedData.scopedCardRems.filter(r => r.remId !== rem._id),
        { remId: rem._id, priority: cardAbsPriority, source: 'manual' } as CardPriorityInfo
      ];
      const newRelPriority = calculateRelativePercentile(hypotheticalRems, rem._id);
      if (newRelPriority !== null) setCardRelPriority(newRelPriority);
    }
  }, [cardAbsPriority, derivedData, rem, performanceMode]); // 🔌 Add performanceMode

  // Event Handlers
  const showIncSection = incRemInfo !== null;
  const showCardSection = hasCards || (cardInfo && cardInfo.cardCount > 0);
  
  const saveIncPriority = useCallback(async (priority: number) => {
    if (!rem) return;

    // Use initIncrementalRem to ensure proper initialization if not already an IncRem
    if (!incRemInfo) {
      await initIncrementalRem(plugin, rem);
    }

    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [priority.toString()]);

    // Get the updated IncRem info and update allIncrementalRemKey
    const updatedIncRem = await getIncrementalRemFromRem(plugin, rem);
    if (updatedIncRem) {
      await updateIncrementalRemCache(plugin, updatedIncRem);
    }

    // 🔌 Conditionally update session cache
    if (performanceMode === PERFORMANCE_MODE_FULL && sessionCache && originalScopeId) {
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
    if (performanceMode === PERFORMANCE_MODE_FULL) {
        const numCardsRemaining = await plugin.queue.getNumRemainingCards();
        const isInQueueNow = numCardsRemaining !== undefined;
        await updateCardPriorityCache(plugin, rem._id, isInQueueNow);
        
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
    e.preventDefault();
    // Tab cycling between inc and card sliders
    if (incSliderRef.current && cardSliderRef.current) {
      // Simple toggle - if we're in the inc section, go to card, otherwise go to inc
      const activeElement = document.activeElement;
      const incSection = activeElement?.closest('[data-section="inc"]');
      if (incSection) {
        cardSliderRef.current.focus();
        cardSliderRef.current.select();
      } else {
        incSliderRef.current.focus();
        incSliderRef.current.select();
      }
    }
  };

  const removeFromIncremental = useCallback(async () => {
    if (!rem) return;
    await rem.removePowerup(powerupCode);
    await removeIncrementalRemCache(plugin, rem._id);
    await plugin.app.toast('Removed from Incremental Queue');
    plugin.widget.closePopup();
  }, [plugin, rem]);
    
  const removeCardPriority = useCallback(async () => {
    if (!rem) return;
    await rem.removePowerup('cardPriority');
    // 🔌 Conditionally update cache
    if (performanceMode === PERFORMANCE_MODE_FULL) {
        await updateCardPriorityCache(plugin, rem._id);
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
    return (
      <div
        className="p-4 text-center text-sm"
        style={{ color: 'var(--rn-clr-content-secondary)' }}
      >
        This rem is neither an Incremental Rem nor has flashcards.
      </div>
    );
  }
  
  // --- FINAL JSX RENDER ---
  return (
    <div
      className="flex flex-col gap-3 relative"
      style={{
        padding: '16px',
        backgroundColor: 'var(--rn-clr-background-primary)',
        color: 'var(--rn-clr-content-primary)',
      }}
      onKeyDown={async (e) => {
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
      }}
    >
      {showConfirmation && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10 p-4"
          style={{ backgroundColor: 'var(--rn-clr-background-primary)', opacity: 0.98 }}
        >
          <div
            className="p-5 rounded-lg flex flex-col gap-3 text-center max-w-sm"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
              boxShadow: 'var(--rn-box-shadow-modal)',
            }}
          >
            <h3 className="font-semibold text-base" style={{ color: 'var(--rn-clr-content-primary)' }}>
              Priorities are different
            </h3>
            <p className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              Incremental Rem (<strong>{incAbsPriority}</strong>) and Flashcard (<strong>{cardAbsPriority}</strong>) priorities do not match.
            </p>
            <div className="flex flex-col gap-2 mt-2">
              <button
                className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#6B7280', color: 'white' }}
                onClick={() => saveAndClose(incAbsPriority, cardAbsPriority)}
              >
                Save Both As-Is (Enter)
              </button>
              <button
                className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#3B82F6', color: 'white' }}
                onClick={() => saveAndClose(incAbsPriority, incAbsPriority)}
              >
                Use IncRem Priority for Both ({incAbsPriority})
              </button>
              <button
                className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#10B981', color: 'white' }}
                onClick={() => saveAndClose(cardAbsPriority, cardAbsPriority)}
              >
                Use Card Priority for Both ({cardAbsPriority})
              </button>
            </div>
            <button
              className="text-xs mt-1 transition-opacity hover:opacity-70"
              style={{ color: 'var(--rn-clr-content-tertiary)' }}
              onClick={() => setShowConfirmation(false)}
            >
              Go Back
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold" style={{ color: 'var(--rn-clr-content-primary)' }}>
          Priority Settings
        </h2>
        <button
          onClick={() => plugin.widget.closePopup()}
          className="p-1 rounded transition-colors text-sm"
          style={{ color: 'var(--rn-clr-content-tertiary)' }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          ✕
        </button>
      </div>

      {/* Scope UI */}
      {performanceMode === PERFORMANCE_MODE_FULL && (
        <div className="flex flex-col gap-2">
          {isPriorityReviewDoc && originalScopeId && scopeMode === 'document' && (
            <div
              className="px-2 py-1.5 rounded text-xs text-center"
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
                color: 'var(--rn-clr-content-secondary)',
              }}
            >
              📊 Scope: <span className="font-semibold">{scope.name}</span>
            </div>
          )}

          <div
            className="flex p-0.5 rounded-md"
            style={{ backgroundColor: 'var(--rn-clr-background-secondary)' }}
          >
            <label
              className="cursor-pointer w-1/2 text-center text-xs py-1.5 px-2 rounded transition-all"
              style={{
                backgroundColor: scopeMode === 'all' ? 'var(--rn-clr-background-primary)' : 'transparent',
                color: scopeMode === 'all' ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-tertiary)',
                fontWeight: scopeMode === 'all' ? 600 : 400,
              }}
            >
              <input type="radio" name="scopeMode" value="all" checked={scopeMode === 'all'} onChange={() => { setScopeMode('all'); setScope({ remId: null, name: 'All KB' }); }} className="sr-only" />
              All KB
            </label>
            <label
              className="cursor-pointer w-1/2 text-center text-xs py-1.5 px-2 rounded transition-all"
              style={{
                backgroundColor: scopeMode === 'document' ? 'var(--rn-clr-background-primary)' : 'transparent',
                color: scopeMode === 'document' ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-tertiary)',
                fontWeight: scopeMode === 'document' ? 600 : 400,
              }}
            >
              <input type="radio" name="scopeMode" value="document" checked={scopeMode === 'document'} onChange={() => { setScopeMode('document'); if (currentDocumentScopeIndex === -1 && documentScopes.length > 0) { setScope(documentScopes[0]); } }} className="sr-only" />
              Document
            </label>
          </div>

          {scopeMode === 'document' && (
            <div
              className="px-2 py-1.5 rounded flex items-center justify-between gap-2"
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
            >
              <button
                onClick={() => { if (currentDocumentScopeIndex > 0) { setScope(documentScopes[currentDocumentScopeIndex - 1]); } }}
                disabled={currentDocumentScopeIndex <= 0}
                className="px-1.5 py-0.5 rounded text-xs disabled:opacity-20"
                style={{ color: 'var(--rn-clr-content-secondary)' }}
              >
                ↑
              </button>
              <div
                className="text-xs font-medium text-center truncate flex-1"
                style={{ color: 'var(--rn-clr-content-primary)' }}
                title={scope.name}
              >
                {scope.name}
              </div>
              <button
                onClick={() => { if (currentDocumentScopeIndex < documentScopes.length - 1) { setScope(documentScopes[currentDocumentScopeIndex + 1]); } }}
                disabled={currentDocumentScopeIndex >= documentScopes.length - 1}
                className="px-1.5 py-0.5 rounded text-xs disabled:opacity-20"
                style={{ color: 'var(--rn-clr-content-secondary)' }}
              >
                ↓
              </button>
            </div>
          )}
        </div>
      )}
      
      {showIncSection && (
        <div
          className="p-3 rounded-lg flex flex-col gap-3"
          data-section="inc"
          style={{
            backgroundColor: 'var(--rn-clr-background-secondary)',
            border: '1px solid var(--rn-clr-border-primary)',
          }}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--rn-clr-content-primary)' }}>
              <span>📖</span>
              Incremental Rem
            </h3>
            <PriorityBadge priority={incAbsPriority} percentile={incRelPriority} />
          </div>

          <div className="flex flex-col gap-3">
            <PrioritySlider ref={incSliderRef} value={incAbsPriority} onChange={setIncAbsPriority} relativePriority={incRelPriority} />

            {performanceMode === PERFORMANCE_MODE_FULL && (
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                <span>Relative: <strong>{incRelPriority}%</strong></span>
                <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>•</span>
                <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>{scopedIncRems.length.toLocaleString()} items</span>
              </div>
            )}

            <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              Next: {incRemInfo && new Date(incRemInfo.nextRepDate).toLocaleDateString()}
            </div>
          </div>

          {showAddCardPriorityButton && (
            <div className="pt-2 border-t" style={{ borderColor: 'var(--rn-clr-border-primary)' }}>
              <p className="text-xs text-center mb-2" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                {descendantCardCount} descendant flashcards
              </p>
              <button
                onClick={() => { setCardAbsPriority(incAbsPriority); setShowInheritanceForIncRem(true); }}
                className="w-full px-3 py-1.5 text-xs font-semibold rounded transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#eab308', color: 'white' }}
              >
                Set Card Priority for Inheritance
              </button>
            </div>
          )}

          {performanceMode === PERFORMANCE_MODE_FULL && ancestorPriorityInfo && (
            <div
              className="p-2 rounded flex items-center gap-3"
              style={{
                backgroundColor: 'var(--rn-clr-background-primary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
            >
              <PriorityBadge priority={ancestorPriorityInfo.priority} compact />
              <div className="flex-1 min-w-0">
                <div className="text-xs truncate" style={{ color: 'var(--rn-clr-content-primary)' }}>
                  {ancestorPriorityInfo.ancestorName}
                </div>
                <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                  {ancestorPriorityInfo.levelDescription} • {ancestorPriorityInfo.sourceType}
                </div>
              </div>
            </div>
          )}

          <button
            onClick={removeFromIncremental}
            className="px-3 py-1.5 text-xs rounded transition-opacity hover:opacity-80 self-center"
            style={{ backgroundColor: '#ef4444', color: 'white' }}
          >
            Remove from Queue
          </button>
        </div>
      )}
      
      {showCardSection && (
        <div
          className="p-3 rounded-lg flex flex-col gap-3"
          data-section="card"
          style={{
            backgroundColor: 'var(--rn-clr-background-secondary)',
            border: '1px solid var(--rn-clr-border-primary)',
          }}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--rn-clr-content-primary)' }}>
              <span>🎴</span>
              Flashcard Priority
            </h3>
            <PriorityBadge priority={cardAbsPriority} percentile={cardRelPriority} />
          </div>

          <div className="flex flex-col gap-3">
            <PrioritySlider ref={cardSliderRef} value={cardAbsPriority} onChange={setCardAbsPriority} relativePriority={cardRelPriority} />

            {hasCards && cardInfo && (
              <>
                <div className="flex items-center justify-between text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                  <span>Source: <strong>{cardInfo?.source}</strong> • Due: {cardInfo?.dueCards}/{cardInfo?.cardCount}</span>
                  {cardInfo?.source === 'inherited' && (
                    <button
                      onClick={() => saveCardPriority(cardInfo.priority)}
                      className="text-xs hover:underline"
                      style={{ color: '#3b82f6' }}
                    >
                      Convert to Manual
                    </button>
                  )}
                </div>

                {performanceMode === PERFORMANCE_MODE_FULL && (
                  <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                    <span>Relative: <strong>{cardRelPriority}%</strong></span>
                    <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>•</span>
                    <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>{scopedCardRems.length.toLocaleString()} cards</span>
                  </div>
                )}

                {performanceMode === PERFORMANCE_MODE_FULL && ancestorPriorityInfo && (
                  <div
                    className="p-2 rounded flex items-center gap-3"
                    style={{
                      backgroundColor: 'var(--rn-clr-background-primary)',
                      border: '1px solid var(--rn-clr-border-primary)',
                    }}
                  >
                    <PriorityBadge priority={ancestorPriorityInfo.priority} compact />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs truncate" style={{ color: 'var(--rn-clr-content-primary)' }}>
                        {ancestorPriorityInfo.ancestorName}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                        {cardInfo?.source === 'inherited' ? 'Inherits from' : 'Ancestor'} • {ancestorPriorityInfo.levelDescription}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {showInheritanceSection && (
        <div
          className="p-3 rounded-lg flex flex-col gap-3"
          data-section="card"
          style={{
            backgroundColor: 'var(--rn-clr-background-secondary)',
            border: '1px solid var(--rn-clr-border-primary)',
          }}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--rn-clr-content-primary)' }}>
              <span>🌿</span>
              Inheritance Priority
            </h3>
            <PriorityBadge priority={cardAbsPriority} percentile={cardRelPriority} />
          </div>

          <p className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            {showIncSection
              ? `Set priority for ${descendantCardCount} descendant flashcards to inherit.`
              : `${descendantCardCount} descendant ${descendantCardCount === 1 ? 'flashcard' : 'flashcards'} will inherit this priority.`
            }
          </p>

          <div className="flex flex-col gap-3">
            <PrioritySlider ref={!showCardSection ? cardSliderRef : undefined} value={cardAbsPriority} onChange={setCardAbsPriority} relativePriority={cardRelPriority} />

            {performanceMode === PERFORMANCE_MODE_FULL && (
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                <span>Relative: <strong>{cardRelPriority}%</strong></span>
                <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>•</span>
                <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>{scopedCardRems.length.toLocaleString()} cards</span>
              </div>
            )}
          </div>

          {cardInfo?.source === 'manual' && (
            <button
              onClick={removeCardPriority}
              className="px-3 py-1.5 text-xs rounded transition-opacity hover:opacity-80 self-center"
              style={{ backgroundColor: '#ef4444', color: 'white' }}
            >
              Remove Card Priority
            </button>
          )}
        </div>
      )}

      <button
        onClick={handleConfirmAndClose}
        className="px-4 py-2 text-sm font-semibold rounded transition-opacity hover:opacity-90 self-center"
        style={{ backgroundColor: '#3B82F6', color: 'white' }}
      >
        Save & Close
      </button>
    </div>
  );
}

renderWidget(Priority);