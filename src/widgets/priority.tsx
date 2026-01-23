import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  PluginRem,
  RemId,
} from '@remnote/plugin-sdk';
import { shouldUseLightMode } from '../lib/mobileUtils';
import React, { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { getIncrementalRemFromRem, initIncrementalRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache, removeIncrementalRemCache } from '../lib/incremental_rem/cache';
import {
  getCardPriority,
  setCardPriority,
  getCardPriorityValue,
  CardPriorityInfo,
  QueueSessionCache,
  CARD_PRIORITY_CODE,
  PRIORITY_SLOT
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
  alwaysUseLightModeOnMobileId,
  defaultPriorityId,
  defaultCardPriorityId
} from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { updateCardPriorityCache, flushLightCacheUpdates } from '../lib/card_priority/cache';
import { findClosestAncestorWithAnyPriority } from '../lib/priority_inheritance';
import { safeRemTextToString } from '../lib/pdfUtils';
import { PriorityBadge, PrioritySlider, PrioritySliderRef } from '../components';
import { useAcceleratedKeyboardHandler } from '../lib/keyboard_utils';
import * as _ from 'remeda';

type Scope = { remId: string | null; name: string; };
type ScopeMode = 'all' | 'document';
type CardScopeType = 'prioritized' | 'all';





function Priority() {
  const plugin = usePlugin();

  // --- ALL HOOKS DECLARED UNCONDITIONALLY AT THE TOP ---

  // ✅ Calculate effective mode
  const performanceMode = useTrackerPlugin(async (rp) => {
    const useLight = await shouldUseLightMode(rp);
    return useLight ? 'light' : 'full';
  }, []) || 'light';

  // State Hooks
  const [scope, setScope] = useState<Scope>({ remId: null, name: 'All KB' });
  const [scopeHierarchy, setScopeHierarchy] = useState<Scope[]>([]);
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all');
  const [cardScopeType, setCardScopeType] = useState<CardScopeType>('prioritized');
  const [incAbsPriority, setIncAbsPriority] = useState<number | null>(null);
  const [cardAbsPriority, setCardAbsPriority] = useState<number | null>(null);
  // RelPriority moved to useMemo below derivedData to ensure synchronous updates (fixing flicker)
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [showInheritanceForIncRem, setShowInheritanceForIncRem] = useState(false);
  const incSliderRef = useRef<PrioritySliderRef>(null);
  const cardSliderRef = useRef<PrioritySliderRef>(null);
  const isSaving = useRef(false);
  // Dirty flags to track if user has interacted with the inputs
  const incIsDirty = useRef(false);
  const cardIsDirty = useRef(false);

  // Data Fetching Hooks
  const widgetContext = useRunAsync(async () => {
    const ctx = await plugin.widget.getWidgetContext<{ remId: string }>();
    return ctx;
  }, []);

  const rem = useTrackerPlugin(async (plugin) => {
    let remId = widgetContext?.contextData?.remId;

    // Fallback: Check if we just came from Highlight Actions (Create Incremental Rem)
    if (!remId) {
      remId = await plugin.storage.getSession<string>('priorityPopupTargetRemId');
      if (remId) {
        // Clear it immediately so it doesn't persist for other uses
        // await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
      }
    }

    if (!remId) {
      return null;
    }
    const foundRem = await plugin.rem.findOne(remId);
    return foundRem;
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

  const defaultIncPriority = useTrackerPlugin(async (plugin) => await plugin.settings.getSetting<number>(defaultPriorityId) || 10, []);
  const defaultCardPriority = useTrackerPlugin(async (plugin) => await plugin.settings.getSetting<number>(defaultCardPriorityId) || 50, []);

  // --- Keyboard Handlers Integration (Must be before early returns) ---
  const incKeyboard = useAcceleratedKeyboardHandler(
    incAbsPriority,
    incAbsPriority ?? defaultIncPriority ?? 50,
    (val) => {

      incIsDirty.current = true;
      setIncAbsPriority(Math.max(0, Math.min(100, val)));
    }
  );

  const cardKeyboard = useAcceleratedKeyboardHandler(
    cardAbsPriority,
    cardAbsPriority ?? defaultCardPriority ?? 50,
    (val) => {

      cardIsDirty.current = true;
      setCardAbsPriority(Math.max(0, Math.min(100, val)));
    }
  );

  const inQueue = !!queueSubQueueId;

  const incRemInfo = useTrackerPlugin(async (plugin) => {
    if (!rem) {
      return null;
    }
    const result = await getIncrementalRemFromRem(plugin, rem);


    return result;
  }, [rem?._id]);

  // --- FAST PRIORITY FETCHER (O(1)) ---
  // To avoid the 50->30 flicker, we fetch *only* the raw priority values directly from the powerup slots.
  // This bypasses the heavy CardInfo (checking cached/global cards) and IncRemInfo (checking dates/history) builders.
  const fastPriorityValues = useTrackerPlugin(async (plugin) => {
    if (!rem) return null;

    // Fast path: Card Priority
    // getPowerupProperty is much faster than constructing full objects
    // UPDATED: Use getCardPriorityValue (LIGHTWEIGHT) to handle inheritance correctly without fetching cards
    const card = await getCardPriorityValue(plugin, rem);

    // Fast path: Inc Rem Priority
    // Note: getPowerupProperty returns the raw string value of the slot
    const incPStr = await rem.getPowerupProperty(powerupCode, prioritySlotCode);
    const inc = incPStr ? parseInt(incPStr) : undefined;

    return {
      card: card, // already a number or undefined/default from getCardPriority
      inc: !isNaN(inc as number) ? inc : undefined
    };
  }, [rem?._id]);

  // Replace the separate hasCards, cardInfo hooks with a combined one:
  // OPTIMIZATION: Check cardPriority powerup first - if it exists, we can skip expensive card checks
  // since having the powerup is sufficient to show the card section.
  // For hasCards, we use a three-tier fallback due to SDK inconsistency where rem.getCards() 
  // sometimes returns [] even when cards exist.
  const cardData = useTrackerPlugin(
    async (plugin) => {
      if (!rem) {
        return undefined;
      }

      // Step 1: Check powerup first (fast) - this determines if we show the card section
      const hasPowerup = await rem.hasPowerup('cardPriority');

      // Step 2: Get card priority info (needed for displaying priority value)
      const cardPriorityInfo = await getCardPriority(plugin, rem);

      // Step 3: If powerup exists, we can skip expensive hasCards check
      // The powerup is sufficient to show the card section
      if (hasPowerup) {
        return {
          hasCards: true, // Treat as true since powerup exists
          cardInfo: cardPriorityInfo,
          hasCardPriorityPowerup: true
        };
      }

      // Step 4: No powerup - need to check for cards using three-tier fallback
      let hasCards = false;

      // Tier 1: Try rem.getCards() first (fastest, works most of the time)
      const directCards = await rem.getCards();
      if (directCards.length > 0) {
        hasCards = true;
      } else {
        // Tier 2: Check if rem exists in the card priority cache
        // 🔌 Skip cache check and global registry in light mode to ensure speed
        if (performanceMode === PERFORMANCE_MODE_LIGHT) {
          hasCards = false;
        } else {
          const cachedCardInfos = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey);
          const cachedInfo = cachedCardInfos?.find(info => info.remId === rem._id);

          if (cachedInfo && cachedInfo.cardCount > 0) {
            hasCards = true;
          } else {
            // Tier 3: Use global registry as final fallback (slowest but most reliable)
            const allCards = await plugin.card.getAll();
            const cardsForRem = allCards.filter(card => card.remId === rem._id);
            hasCards = cardsForRem.length > 0;
          }
        }
      }



      return {
        hasCards,
        cardInfo: cardPriorityInfo,
        hasCardPriorityPowerup: hasPowerup
      };
    },
    [rem?._id, performanceMode]
  );

  // Then use:
  const hasCards = cardData?.hasCards ?? undefined;
  const cardInfo = cardData?.cardInfo ?? undefined;
  const hasCardPriorityPowerup = cardData?.hasCardPriorityPowerup ?? false;

  // This tracker is fast (direct Rem lookup) so it can run in both modes,
  // but we will conditionally *show* the UI in 'full' mode only.
  const ancestorPriorityInfo = useTrackerPlugin(async (plugin) => {
    if (!rem) return null;
    return await findClosestAncestorWithAnyPriority(plugin, rem);
  }, [rem]);

  // Asynchronous Derived Data Hook
  const derivedData = useRunAsync(async () => {
    if (!rem) return undefined;

    // 🔌 Check performance mode
    if (performanceMode === PERFORMANCE_MODE_LIGHT) {
      // In light mode, we skip the expensive descendant card check and assume there might be descendants (always show inheritance option)
      return {
        scopedIncRems: [],
        scopedCardRems: [],
        incRelPriority: 50,
        cardRelPriority: 50,
        descendantCardCount: -1, // -1 indicates "unknown" / skipped check
        prioritySourceCounts: { manual: 0, inherited: 0, default: 0 },
      };
    }

    // --- FULL MODE LOGIC ---

    // Calculate descendant card count (needed for "Set Card Priority for Inheritance" button)
    // We use plugin.card.getAll() instead of rem.getCards() due to SDK inconsistency
    // where rem.getCards() sometimes returns [] even when cards exist.
    // Note: We cannot use the cardPriority cache here because it only contains tagged rems,
    // but for inheritance we need to count ALL cards including untagged descendants.
    const descendants = await rem.getDescendants();
    const descendantIds = new Set(descendants.map(d => d._id));

    // OPTIMIZATION: Use the set of IDs to filter efficiently, as suggested by RemNote support.
    // This is already using the optimized approach of fetching all cards once and validiting IDs,
    // avoiding individual rem fetches for each card.
    const allCards = await plugin.card.getAll();
    const cardsInDescendants = allCards.filter(card => descendantIds.has(card.remId));
    const finalDescendantCardCount = cardsInDescendants.length;

    // ... (rest of the existing derivedData logic) ...
    const effectiveScopeForCache = originalScopeId || queueSubQueueId;
    const useFastCache = inQueue && scope.remId === effectiveScopeForCache;

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
      finalPrioritySourceCounts = allCardsInScope.reduce((counts, rem) => ({ ...counts, [rem.source]: (counts[rem.source] || 0) + 1 }), { manual: 0, inherited: 0, default: 0 });
      finalScopedCardRems = (cardScopeType === 'prioritized' ? allCardsInScope.filter(c => c.source !== 'default') : allCardsInScope);
      finalIncRel = (scopeMode === 'document') ? sessionCache.incRemDocPercentiles[rem._id] : calculateRelativePercentile(allIncRems, rem._id);
      finalCardRel = (scopeMode === 'document') ? sessionCache.docPercentiles[rem._id] : calculateRelativePercentile(allCardInfos, rem._id);

    } else {
      // --- OPTIMIZED ASYNC FALLBACK PATH WITH COMPREHENSIVE SCOPE ---
      const scopeRem = scopeMode === 'document' && scope.remId ? await plugin.rem.findOne(scope.remId) : null;

      let scopeIds: Set<RemId> | null = null;

      if (scopeRem) {
        // --- COMPREHENSIVE SCOPE CALCULATION ---
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
      }

      finalScopedIncRems = scopeIds ? allIncRems.filter(r => scopeIds.has(r.remId)) : allIncRems;
      let tempScopedCardRems = scopeIds ? allCardInfos.filter(ci => scopeIds.has(ci.remId)) : allCardInfos;

      finalPrioritySourceCounts = tempScopedCardRems.reduce((counts, rem) => ({ ...counts, [rem.source]: (counts[rem.source] || 0) + 1 }), { manual: 0, inherited: 0, default: 0 });

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
  }, [rem, inQueue, scope, allIncRems, allCardInfos, cardScopeType, sessionCache, queueSubQueueId, scopeMode, originalScopeId, isPriorityReviewDoc, performanceMode]);

  // --- OPTIMIZED RELATIVE PRIORITY CALCULATION (Synchronous - fixes flicker) ---
  // Using O(N) counting sort logic instead of sorting (O(N log N)) for performance
  const incRelPriority = useMemo(() => {
    if (performanceMode === PERFORMANCE_MODE_LIGHT || !derivedData || !rem) return 50;
    const p = incAbsPriority ?? defaultIncPriority ?? 50;
    // Count items with priority <= p. In a stable sort, our item (if added) would be last among equals.
    // So distinct items < p count + distinct items === p count = items <= p
    const others = derivedData.scopedIncRems.filter(r => r.remId !== rem._id);
    const countLowerOrEqual = others.reduce((acc, curr) => (curr.priority <= p ? acc + 1 : acc), 0);
    const rank = countLowerOrEqual + 1;
    const total = others.length + 1;
    return Math.round((rank / total) * 1000) / 10; // Round to 1 decimal place
  }, [performanceMode, derivedData, rem, incAbsPriority, defaultIncPriority]);

  const cardRelPriority = useMemo(() => {
    if (performanceMode === PERFORMANCE_MODE_LIGHT || !derivedData || !rem) return 50;
    const p = cardAbsPriority ?? defaultCardPriority ?? 50;
    const others = derivedData.scopedCardRems.filter(r => r.remId !== rem._id);
    const countLowerOrEqual = others.reduce((acc, curr) => (curr.priority <= p ? acc + 1 : acc), 0);
    const rank = countLowerOrEqual + 1;
    const total = others.length + 1;
    return Math.round((rank / total) * 1000) / 10;
  }, [performanceMode, derivedData, rem, cardAbsPriority, defaultCardPriority]);

  // Synchronous Derived Data Hooks (Memoization)
  const documentScopes = useMemo(() => scopeHierarchy.filter(s => s.remId !== null), [scopeHierarchy]);
  const currentDocumentScopeIndex = useMemo(() => documentScopes.findIndex(s => s.remId === scope.remId), [documentScopes, scope]);

  // Effect Hooks
  // Reset dirty flags and values when Rem changes
  useEffect(() => {
    incIsDirty.current = false;
    cardIsDirty.current = false;
    // We don't necessarily want to set priorities to null here because other hooks
    // might be about to set them, and setting null might cause a flash.
    // However, for cleanliness on ID swap, we should relying on the data hooks to fire again.
  }, [rem?._id]);

  useEffect(() => {
    if (isSaving.current) return;
    if (incRemInfo) {
      if (!incIsDirty.current) {
        setIncAbsPriority(incRemInfo.priority);
      }
    } else if (defaultIncPriority !== undefined && incAbsPriority === null) {
      // Optimistic default for new/loading IncRems
      // Only set if not dirty (though usually fresh load implies not dirty)
      // GUARD: Ensure we have loaded the incRemInfo status (it shouldn't be undefined if we decided it's null/missing)
      // Actually incRemInfo comes from useTrackerPlugin, so it starts undefined.
      // If it is undefined, we should NOT set default yet.
      if (incRemInfo === undefined) return;

      if (!incIsDirty.current) {
        setIncAbsPriority(defaultIncPriority);
      }
    }
  }, [incRemInfo, defaultIncPriority]);

  useEffect(() => {
    if (isSaving.current) return;
    if (cardInfo) {
      if (!cardIsDirty.current) {
        setCardAbsPriority(cardInfo.priority);
      }
    } else if (defaultCardPriority !== undefined && cardAbsPriority === null) {
      // Optimistic default for new/loading cards

      // GUARD: Ensure cardData has actually loaded.
      // If cardData is undefined, it means we are still loading info.
      // We shouldn't fallback to default yet, otherwise we get a 50 -> 30 flicker.
      if (cardData === undefined) return;

      if (!cardIsDirty.current) {
        setCardAbsPriority(defaultCardPriority);
      }
    }
  }, [cardInfo, defaultCardPriority, cardData]);

  // Snap to Inheritance Effect
  useEffect(() => {
    if (isSaving.current) return;
    // If we have an ancestor priority, and the current card priority is either strictly "default" source 
    // OR we are purely using the default setting (meaning cardInfo might be undefined yet),
    // then snap to the ancestor's priority to show what will be inherited.
    if (ancestorPriorityInfo && (!cardInfo || cardInfo.source === 'default' || cardInfo.source === 'inherited')) {
      // Only update if we haven't already set a manual override? 
      // Actually, if source is default/inherited, we display the effective priority, which IS the ancestor's.
      if (!cardIsDirty.current) {
        setCardAbsPriority(ancestorPriorityInfo.priority);
      } else {
      }
    }
  }, [ancestorPriorityInfo, cardInfo]);

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

  // Effects for calculating hypothetical relative priority REMOVED
  // Replaced by synchronous useMemo above to prevent "Blue Flash" flicker.

  // Event Handlers
  const showIncSection = !!incRemInfo; // Converts to boolean - undefined/null become false
  const showCardSection = hasCards === true || hasCardPriorityPowerup || (cardInfo && cardInfo.cardCount > 0);

  const saveIncPriority = useCallback(async (priority: number) => {
    if (!rem) return;

    // Use initIncrementalRem to ensure proper initialization if not already an IncRem
    if (!incRemInfo) {
      await initIncrementalRem(plugin, rem);
    }

    // Fire-and-forget write
    rem.setPowerupProperty(powerupCode, prioritySlotCode, [priority.toString()]);

    // Construct Optimistic IncRem Object
    const currentNow = Date.now();
    const optimisticIncRem: IncrementalRem = incRemInfo ? {
      ...incRemInfo,
      priority: priority,
      // If we are just updating priority, nextRepDate etc shouldn't change unless it was new
    } : {
      // Fallback for newly initialized inc rem
      remId: rem._id,
      nextRepDate: currentNow, // Approximate
      priority: priority,
      history: [],
      // Other fields might be missing if we construct from scratch, but updateIncrementalRemCache 
      // mainly needs remId and priority for sorting/percentiles if it does a light update.
      // However, for full correctness, initIncrementalRem above handles the DB side.
      // The cache update might need more fields.
      // Let's rely on the fact that if !incRemInfo, the cache probably doesn't have it either, 
      // so a full refresh might be safer or we construct a minimal valid object.
      // For now, let's assume if it exists we use it, if not we rely on background sync or a minimal object.
    } as IncrementalRem;

    // Fire-and-forget cache update
    updateIncrementalRemCache(plugin, optimisticIncRem);

    // 🔌 Conditionally update session cache
    if (performanceMode === PERFORMANCE_MODE_FULL && sessionCache && originalScopeId) {
      const newIncRemDocPercentiles = { ...sessionCache.incRemDocPercentiles };
      delete newIncRemDocPercentiles[rem._id];

      const updatedCache = {
        ...sessionCache,
        incRemDocPercentiles: newIncRemDocPercentiles
      };

      plugin.storage.setSession(queueSessionCacheKey, updatedCache).catch(console.error);
    }
  }, [rem, incRemInfo, plugin, sessionCache, originalScopeId, performanceMode]); // 🔌 Add performanceMode

  const saveCardPriority = useCallback(async (priority: number) => {
    if (!rem) return;

    // 1. Optimistic Updates (FIRST for responsiveness)

    // Construct Optimistic Info to avoid DB reads (fixes Close Lag & Race Condition)
    const optimisticInfo: CardPriorityInfo | null = cardInfo ? {
      ...cardInfo,
      priority: priority,
      source: 'manual',
      lastUpdated: Date.now()
    } : {
      // Fallback if we somehow didn't have cardInfo but are saving (e.g. inheritance only)
      remId: rem._id,
      priority: priority,
      source: 'manual',
      lastUpdated: Date.now(),
      cardCount: cardInfo?.cardCount || 1, // approximate
      dueCards: cardInfo?.dueCards || 0,
      kbPercentile: cardInfo?.kbPercentile || 0
    };

    // 🔌 Only do cache updates in 'full' mode
    if (performanceMode === PERFORMANCE_MODE_FULL) {
      // Fire-and-forget light update
      updateCardPriorityCache(plugin, rem._id, true, optimisticInfo);

      // Ensure the light update is committed to session storage so UI can see it immediately
      // Fire-and-forget flush
      flushLightCacheUpdates(plugin);

      // Fire-and-Forget Heavy Recalculation (Background)
      // We do NOT await this. It will schedule a heavy recalc (sorting/percentiles) in 200ms.
      updateCardPriorityCache(plugin, rem._id, false, optimisticInfo).catch(console.error);

      if (sessionCache && originalScopeId) {
        // Minimal lag: rely on global refresh or previous logic without blocking
      }
    }

    // 🔔 Signal refresh for listeners (e.g. display widget) in ALL modes
    // This ensures that even in Light Mode, the display widget updates its color immediately.
    plugin.storage.setSession(cardPriorityCacheRefreshKey, Date.now()).catch(console.error);


    // 2. Critical Writes (Fire and Forget)
    // Signal events.ts to allow this update even if in queue (Global Context Survivor)
    plugin.storage.setSession('manual_priority_update_pending', true).catch(console.error);

    // Perform the actual DB write
    if (!hasCardPriorityPowerup) {
      // CRITICAL: We MUST await the powerup addition here.
      // If we don't, the 'await rem.hasPowerup' check inside setCardPriority will yield control,
      // and saveAndClose will immediately close the popup, destroying the widget context
      // before the powerup is added.
      await rem.addPowerup(CARD_PRIORITY_CODE);
    }

    // Now we can fire-and-forget the property updates safely, passing true for knownHasPowerup
    setCardPriority(plugin, rem, priority, 'manual', true).catch(console.error);

  }, [rem, plugin, sessionCache, originalScopeId, performanceMode, cardInfo, hasCardPriorityPowerup]); // 🔌 Add performanceMode

  const showInheritanceSection =
    (!showIncSection && !showCardSection) ||
    (showIncSection && !hasCards && cardInfo?.source === 'manual') ||
    showInheritanceForIncRem;

  const saveAndClose = useCallback(async (incP: number, cardP: number) => {
    isSaving.current = true;

    // Fire both save operations
    const promises: Promise<any>[] = [];

    if (showIncSection) {
      // Fire-and-forget inc priority (assuming it already exists if showIncSection is true)
      saveIncPriority(incP).catch(console.error);
    }
    if (showCardSection || showInheritanceSection) {
      // CRITICAL: We must await saveCardPriority because it might need to add a powerup (async).
      // If hasCardPriorityPowerup is true (normal case), the await returns immediately (fast).
      // If false (inheritance case), it waits for addPowerup (necessary delay).
      promises.push(saveCardPriority(cardP));
    }

    // Wait for critical operations (like adding powerup) before closing
    await Promise.all(promises);

    // Close immediately
    plugin.widget.closePopup();
  }, [plugin, showIncSection, showCardSection, showInheritanceSection, saveIncPriority, saveCardPriority]);

  const handleConfirmAndClose = useCallback(async () => {
    const bothSectionsVisible = showIncSection && (showCardSection || showInheritanceSection);
    const safeInc = incAbsPriority ?? defaultIncPriority ?? 50;
    const safeCard = cardAbsPriority ?? defaultCardPriority ?? 50;

    if (bothSectionsVisible && incRemInfo && cardInfo) {
      const wasIncPriorityChanged = incAbsPriority !== null && incAbsPriority !== incRemInfo.priority;
      const wasCardPriorityChanged = cardAbsPriority !== null && cardAbsPriority !== cardInfo.priority;
      const isCardPriorityManual = cardInfo.source === 'manual';
      const prioritiesAreDifferent = safeInc !== safeCard;

      if (prioritiesAreDifferent && (isCardPriorityManual || (wasIncPriorityChanged && wasCardPriorityChanged))) {
        setShowConfirmation(true);
        return;
      }
      if (wasIncPriorityChanged && !wasCardPriorityChanged && !isCardPriorityManual) {
        await saveAndClose(safeInc, safeInc);
        return;
      }
    }
    await saveAndClose(safeInc, safeCard);
  }, [showIncSection, showCardSection, showInheritanceSection, incRemInfo, cardInfo, incAbsPriority, cardAbsPriority, saveAndClose, defaultIncPriority, defaultCardPriority]);

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

  const handleInputBlur = () => {
    if (showConfirmation) return;
    // Additional blur logic if needed
  };



  const handleTabCycle = (e: React.KeyboardEvent) => {
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
    isSaving.current = true;
    await rem.removePowerup(powerupCode);
    await removeIncrementalRemCache(plugin, rem._id);
    await plugin.app.toast('Removed from Incremental Queue');
    plugin.widget.closePopup();
  }, [plugin, rem]);

  const removeCardPriority = useCallback(async () => {
    if (!rem) return;
    isSaving.current = true;
    await rem.removePowerup('cardPriority');
    // 🔌 Conditionally update cache
    if (performanceMode === PERFORMANCE_MODE_FULL) {
      // For removal, we don't have overrides, we assume the next read will see the powerup gone.
      // Or we can force it? Ideally removal propagates fast enough or we accept a small delay on reset.
      // But let's rely on standard read for removal for now.
      await updateCardPriorityCache(plugin, rem._id);
    }
    await plugin.app.toast('Card Priority for inheritance removed.');
    plugin.widget.closePopup();
  }, [plugin, rem, performanceMode]); // 🔌 Add performanceMode

  // --- EARLY RETURNS & FINAL DATA DE-STRUCTURING ---
  if (!widgetContext || !rem) {
    return <div className="p-4">Loading Rem Data...</div>;
  }

  // Check if critical card/incRem data is still loading
  // derivedData can be null! We no longer block on it.

  if (!rem) {
    return (
      <div className="p-4 flex flex-col gap-4 relative items-center justify-center">
        <h2 className="text-xl font-bold">Priority Settings</h2>
        <div className="text-lg">Loading...</div>
      </div>
    );
  }

  const {
    scopedIncRems = [],
    scopedCardRems = [],
    descendantCardCount,
    prioritySourceCounts,
    // We do NOT use the derived priorities directly for rendering,
    // because they don't update optimistically while dragging.
    // Instead, we use the state variables `incRelPriority` and `cardRelPriority`
    // which are kept in sync via the useEffects above.
  } = derivedData || {};

  const isLoadingDerivedData = !derivedData;
  // In Light Mode, we don't calculate relative percentiles, so we should always use absolute coloring
  // to give meaningful visual feedback (red->green->blue) instead of a static "50%" color.
  // Also, if we have fewer than 2 items in scope (e.g. initial load or single item), relative priority
  // will be 100% (Blue), which is misleading for high priority items. Force absolute coloring in that case.
  const baseUseAbsolute = isLoadingDerivedData || performanceMode === PERFORMANCE_MODE_LIGHT;
  const incUseAbsoluteColoring = baseUseAbsolute || scopedIncRems.length < 2;
  const cardUseAbsoluteColoring = baseUseAbsolute || scopedCardRems.length < 2;

  // FIX: Should prefer fastPriorityValues over default to avoid 50->30 flicker
  // This uses the O(1) fetch result which is available almost instantly
  const safeIncAbsPriority = incAbsPriority ?? fastPriorityValues?.inc ?? incRemInfo?.priority ?? defaultIncPriority ?? 50;
  const safeCardAbsPriority = cardAbsPriority ?? fastPriorityValues?.card ?? cardInfo?.priority ?? defaultCardPriority ?? 50;

  const showAddCardPriorityButton = showIncSection && !showCardSection && !showInheritanceSection;

  /* Deprecated: We now always show the inheritance section even if no cards exist, to allow setting future priority.
  if (!showIncSection && !showCardSection && !showInheritanceSection) {
    return (
      <div className="p-4 text-center text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
        This rem is neither an Incremental Rem nor has flashcards.
      </div>
    );
  }
  */

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
            await saveAndClose(safeIncAbsPriority, safeCardAbsPriority);
          } else {
            await handleConfirmAndClose();
          }
        } else if (e.key === 'Escape') {
          plugin.widget.closePopup();
        }
      }}
      onKeyUp={() => {
        incKeyboard.handleKeyUp();
        cardKeyboard.handleKeyUp();
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
              Incremental Rem (<strong>{safeIncAbsPriority}</strong>) and Flashcard (<strong>{safeCardAbsPriority}</strong>) priorities do not match.
            </p>
            <div className="flex flex-col gap-2 mt-2">
              <button
                className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#6B7280', color: 'white' }}
                onClick={() => saveAndClose(safeIncAbsPriority, safeCardAbsPriority)}
              >
                Save Both As-Is (Enter)
              </button>
              <button
                className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#3B82F6', color: 'white' }}
                onClick={() => saveAndClose(safeIncAbsPriority, safeIncAbsPriority)}
              >
                Use IncRem Priority for Both ({safeIncAbsPriority})
              </button>
              <button
                className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#10B981', color: 'white' }}
                onClick={() => saveAndClose(safeCardAbsPriority, safeCardAbsPriority)}
              >
                Use Card Priority for Both ({safeCardAbsPriority})
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
            <PriorityBadge priority={safeIncAbsPriority} percentile={incRelPriority} useAbsoluteColoring={incUseAbsoluteColoring} />
          </div>

          <div className="flex flex-col gap-3">
            <PrioritySlider
              ref={incSliderRef}
              value={safeIncAbsPriority}
              onChange={(val) => {
                incIsDirty.current = true;
                setIncAbsPriority(val);
              }}
              relativePriority={incRelPriority}
              useAbsoluteColoring={incUseAbsoluteColoring}
              onKeyDown={(e) => {
                if (e.key === 'Tab') handleTabCycle(e);
                else incKeyboard.handleKeyDown(e);
              }}
            />

            {performanceMode === PERFORMANCE_MODE_FULL && (
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                {isLoadingDerivedData ? (
                  <span>Loading relative priority...</span>
                ) : (
                  <>
                    <span>Relative: <strong>{incRelPriority}%</strong></span>
                    <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>•</span>
                    <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>{scopedIncRems.length.toLocaleString()} items</span>
                  </>
                )}
              </div>
            )}

            <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              Next: {incRemInfo && new Date(incRemInfo.nextRepDate).toLocaleDateString()}
            </div>
          </div>

          {showAddCardPriorityButton && (
            <div className="pt-2 border-t" style={{ borderColor: 'var(--rn-clr-border-primary)' }}>
              <p className="text-xs text-center mb-2" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                {isLoadingDerivedData ? (
                  'Loading descendant cards...'
                ) : (
                  descendantCardCount === -1 || descendantCardCount === undefined ? 'Descendant flashcards' : (descendantCardCount === 0 ? 'No current descendant flashcards' : `${descendantCardCount} descendant flashcards`)
                )}
              </p>
              <button
                onClick={() => { setCardAbsPriority(safeIncAbsPriority); setShowInheritanceForIncRem(true); }}
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
            <PriorityBadge priority={safeCardAbsPriority} percentile={cardRelPriority} useAbsoluteColoring={cardUseAbsoluteColoring} />
          </div>

          <div className="flex flex-col gap-3">
            <PrioritySlider
              ref={cardSliderRef}
              value={safeCardAbsPriority}
              onChange={(val) => {

                cardIsDirty.current = true;
                setCardAbsPriority(val);
              }}
              relativePriority={cardRelPriority}
              useAbsoluteColoring={cardUseAbsoluteColoring}
              onKeyDown={(e) => {
                if (e.key === 'Tab') handleTabCycle(e);
                else cardKeyboard.handleKeyDown(e);
              }}
            />

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
                    {isLoadingDerivedData ? (
                      <span>Loading relative priority...</span>
                    ) : (
                      <>
                        <span>Relative: <strong>{cardRelPriority}%</strong></span>
                        <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>•</span>
                        <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>{scopedCardRems.length.toLocaleString()} cards</span>
                      </>
                    )}
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
            <PriorityBadge priority={safeCardAbsPriority} percentile={cardRelPriority} useAbsoluteColoring={cardUseAbsoluteColoring} />
          </div>

          <p className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            {isLoadingDerivedData ? 'Loading inheritance details...' : (
              descendantCardCount === 0
                ? 'No descendant flashcards found. Set priority for future cards to inherit.'
                : showIncSection
                  ? `Set priority for ${descendantCardCount === -1 || descendantCardCount === undefined ? '' : descendantCardCount} descendant flashcards to inherit.`
                  : `${descendantCardCount === -1 || descendantCardCount === undefined ? 'Descendant flashcards' : descendantCardCount + ' descendant ' + (descendantCardCount === 1 ? 'flashcard' : 'flashcards')} will inherit this priority.`
            )}
          </p>

          <div className="flex flex-col gap-3">
            <PrioritySlider
              ref={!showCardSection ? cardSliderRef : undefined}
              value={safeCardAbsPriority}
              onChange={(val) => {

                cardIsDirty.current = true;
                setCardAbsPriority(val);
              }}
              relativePriority={cardRelPriority}
              useAbsoluteColoring={cardUseAbsoluteColoring}
              onKeyDown={(e) => {
                if (e.key === 'Tab') handleTabCycle(e);
                else cardKeyboard.handleKeyDown(e);
              }}
            />

            {performanceMode === PERFORMANCE_MODE_FULL && (
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                {isLoadingDerivedData ? (
                  <span>Loading relative priority...</span>
                ) : (
                  <>
                    <span>Relative: <strong>{cardRelPriority}%</strong></span>
                    <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>•</span>
                    <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>{scopedCardRems.length.toLocaleString()} cards</span>
                  </>
                )}
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