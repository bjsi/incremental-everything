import { AppEvents, ReactRNPlugin, RemId, BuiltInPowerupCodes, RichTextElementRemInterface } from '@remnote/plugin-sdk';
import * as _ from 'remeda';
import {
  allIncrementalRemKey,
  priorityCalcScopeRemIdsKey,
  currentSubQueueIdKey,
  priorityShieldHistoryKey,
  cardPriorityShieldHistoryKey,
  documentPriorityShieldHistoryKey,
  seenRemInSessionKey,
  seenCardInSessionKey,
  allCardPriorityInfoKey,
  documentCardPriorityShieldHistoryKey,
  queueSessionCacheKey,
  currentScopeRemIdsKey,
  powerupCode,
} from '../lib/consts';
import {
  CardPriorityInfo,
  QueueSessionCache,
  autoAssignCardPriority,
  getCardPriority,
} from '../lib/card_priority';
import { IncrementalRem } from '../lib/incremental_rem';
import { flushCacheUpdatesNow, updateCardPriorityCache } from '../lib/card_priority/cache';
import { setCurrentIncrementalRem } from '../lib/incremental_rem';
import { isPriorityReviewDocument, extractOriginalScopeFromPriorityReview } from '../lib/priority_review_document';
import {
  calculateAllPercentiles,
  isFullPerformanceMode,
  isLightPerformanceMode,
  getPerformanceMode,
} from '../lib/utils';
import {
  saveKBShield,
  saveDocumentShield,
  isIncRemDue,
  isCardDue,
} from '../lib/shield_history';
import { resetQueueSession, clearSeenItems, calculateDueIncRemCount } from '../lib/session_helpers';
import { registerQueueCounter, clearQueueUI } from '../lib/ui_helpers';
import { buildComprehensiveScope } from '../lib/scope_helpers';

// Debounce/timeout constants
const CARD_PROCESSING_DEBOUNCE_MS = 2000;
const REM_CHANGE_DEBOUNCE_MS = 1000;

type ResetSessionItemCounter = () => void;

type QueueScopeResolution = {
  scopeForPriorityCalc: RemId | null | undefined;
  scopeForItemSelection: RemId | null;
  originalScopeId: RemId | null | undefined;
  isPriorityReviewDoc: boolean;
};


/**
 * Determines which scope IDs should be used for item selection and priority
 * calculations when entering the queue.
 *
 * - For regular queues both scopes stay on the incoming `subQueueId`.
 * - For Priority Review Docs, item selection stays on that generated document
 *   while priority calculations use the original scope (or `null` for full KB).
 * - If the title cannot be parsed we only mark `isPriorityReviewDoc` so callers
 *   can react without inheriting a stale scope.
 *
 * @param plugin Plugin instance to access the RemNote API.
 * @param subQueueId RemId of the active queue or `null`.
 * @returns Resolved scopes plus the Priority Review flag.
 */
async function resolveQueueScopes(
  plugin: ReactRNPlugin,
  subQueueId: RemId | null | undefined
): Promise<QueueScopeResolution> {
  const baseScopes: QueueScopeResolution = {
    scopeForPriorityCalc: subQueueId || null,
    scopeForItemSelection: subQueueId || null,
    originalScopeId: subQueueId || null,
    isPriorityReviewDoc: false,
  };

  if (!subQueueId) {
    return baseScopes;
  }

  const queueRem = await plugin.rem.findOne(subQueueId);
  if (!queueRem) {
    return baseScopes;
  }

  const isPriorityReviewDoc = await isPriorityReviewDocument(queueRem);
  if (!isPriorityReviewDoc) {
    return baseScopes;
  }

  console.log('QUEUE ENTER: Priority Review Document detected!');

  const extractedScopeId = await extractOriginalScopeFromPriorityReview(queueRem);

  if (extractedScopeId === undefined) {
    console.warn('QUEUE ENTER: Could not extract scope from Priority Review Document');
    return { ...baseScopes, isPriorityReviewDoc: true };
  }

  console.log('QUEUE ENTER: Priority Review Document setup:');
  console.log(`  - Item selection from: Priority Review Doc (${subQueueId})`);
  console.log(
    `  - Priority calculations for: ${extractedScopeId ? `Original scope (${extractedScopeId})` : 'Full KB'
    }`
  );

  return {
    scopeForPriorityCalc: extractedScopeId,
    scopeForItemSelection: subQueueId,
    originalScopeId: extractedScopeId,
    isPriorityReviewDoc: true,
  };
}

/**
 * Registers a listener that runs after the user exits the queue to flush caches and persist shield history.
 *
 * @param plugin Plugin instance to interact with RemNote APIs.
 * @param resetSessionItemCounter Callback to reset the session counter UI.
 */
export function registerQueueExitListener(
  plugin: ReactRNPlugin,
  resetSessionItemCounter: ResetSessionItemCounter
) {
  plugin.event.addListener(AppEvents.QueueExit, undefined, async ({ subQueueId }) => {
    await flushCacheUpdatesNow(plugin);
    console.log('QueueExit triggered, subQueueId:', subQueueId);

    const originalScopeId = await plugin.storage.getSession<string | null>('originalScopeId');
    const priorityCalcScopeRemIds = await plugin.storage.getSession<RemId[] | null>(priorityCalcScopeRemIdsKey);
    console.log('[QueueExit] Priority calculation scope:', priorityCalcScopeRemIds?.length || 0, 'rems');
    console.log('[QueueExit] Original scope ID for history:', originalScopeId);

    if (await isFullPerformanceMode(plugin)) {
      console.log('[QueueExit] Full mode. Saving Priority Shield history...');

      const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
      const allCardInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
      const seenRemIds = (await plugin.storage.getSession<string[]>(seenRemInSessionKey)) || [];
      const seenCardIds = (await plugin.storage.getSession<string[]>(seenCardInSessionKey)) || [];

      // Save KB-level shields
      await saveKBShield(plugin, allIncRems, isIncRemDue, seenRemIds, priorityShieldHistoryKey, 'IncRem');
      await saveKBShield(plugin, allCardInfos, isCardDue, seenCardIds, cardPriorityShieldHistoryKey, 'Card');

      // Save document-level shields if scope exists
      const historyKey = originalScopeId || subQueueId || await plugin.storage.getSession<string>(currentSubQueueIdKey);

      if (historyKey && priorityCalcScopeRemIds && priorityCalcScopeRemIds.length > 0) {
        await saveDocumentShield(
          plugin,
          allIncRems,
          priorityCalcScopeRemIds,
          isIncRemDue,
          seenRemIds,
          documentPriorityShieldHistoryKey,
          historyKey,
          'IncRem'
        );

        await saveDocumentShield(
          plugin,
          allCardInfos,
          priorityCalcScopeRemIds,
          isCardDue,
          seenCardIds,
          documentCardPriorityShieldHistoryKey,
          historyKey,
          'Card'
        );
      } else {
        console.log('[QueueExit] No scope ID or priority calc scope - skipping document shield saves');
      }
    } else {
      console.log('[QueueExit] Light mode. Skipping Priority Shield history save.');
    }

    await resetQueueSession(plugin);
    resetSessionItemCounter();

    console.log('Session state reset complete');
  });
}

/**
 * Registers the global `AppEvents.URLChange` listener (triggered on any internal navigation)
 * to tear down queue-specific UI whenever the user leaves the /flashcards view.
 *
 * @param plugin Plugin instance for accessing window and UI helpers.
 */
export function registerURLChangeListener(plugin: ReactRNPlugin) {
  plugin.event.addListener(AppEvents.URLChange, undefined, async () => {
    const url = await plugin.window.getURL();
    if (!url.includes('/flashcards')) {
      clearQueueUI(plugin);
      await setCurrentIncrementalRem(plugin, undefined);
    }

    // Trigger inc rem counter widget reactivity by updating current document ID
    try {
      const { currentDocumentIdKey } = await import('../lib/consts');
      const focusedRem = await plugin.focus.getFocusedRem();
      const documentId = focusedRem?._id || null;
      await plugin.storage.setSession(currentDocumentIdKey, documentId);
    } catch (error) {
      console.error('Failed to update document ID for counter:', error);
    }
  });
}

/**
 * Registers logic that runs when entering the queue to precompute scopes, caches, and UI state.
 *
 * @param plugin Plugin instance for storage/settings access.
 * @param resetSessionItemCounter Callback to clear per-session card counters.
 */
export function registerQueueEnterListener(
  plugin: ReactRNPlugin,
  resetSessionItemCounter: ResetSessionItemCounter
) {

  plugin.event.addListener(AppEvents.QueueEnter, undefined, async ({ subQueueId }) => {
    console.log('QUEUE ENTER: Starting session pre-calculation for subQueueId:', subQueueId);

    resetSessionItemCounter();
    await clearSeenItems(plugin);

    const {
      scopeForPriorityCalc,
      scopeForItemSelection,
      originalScopeId,
      isPriorityReviewDoc,
    } = await resolveQueueScopes(plugin, subQueueId);

    await plugin.storage.setSession(currentSubQueueIdKey, subQueueId || null);
    await plugin.storage.setSession('originalScopeId', originalScopeId);
    await plugin.storage.setSession('isPriorityReviewDoc', isPriorityReviewDoc);

    const allCardInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];

    if (allCardInfos.length === 0) {
      console.warn('QUEUE ENTER: Card priority cache is empty! Flashcard calculations will be skipped.');
    }

    const dueCardsInKB = (await isFullPerformanceMode(plugin)) ? allCardInfos.filter(info => info.dueCards > 0) : [];

    let docPercentiles: Record<RemId, number> = {};
    let dueCardsInScope: CardPriorityInfo[] = [];

    const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];

    if (allIncRems.length === 0) {
      console.warn('QUEUE ENTER: Incremental Rem cache is empty! IncRem calculations will be skipped.');
    }

    const dueIncRemsInKB = allIncRems?.filter(rem => Date.now() >= rem.nextRepDate) || [];
    let dueIncRemsInScope: IncrementalRem[] = [];
    let incRemDocPercentiles: Record<RemId, number> = {};

    if (scopeForItemSelection) {
      console.log('QUEUE ENTER: Setting up scopes...');

      const startTime = Date.now();
      const itemSelectionScope = await buildComprehensiveScope(plugin, scopeForItemSelection);
      const elapsed = Date.now() - startTime;

      const scopeType = isPriorityReviewDoc ? 'Priority Review Doc' : 'Regular document comprehensive';
      console.log(`QUEUE ENTER: ${scopeType} scope: ${itemSelectionScope.size} items (${elapsed}ms)`);

      await plugin.storage.setSession(currentScopeRemIdsKey, Array.from(itemSelectionScope));

      let priorityCalcScope: Set<RemId> = new Set<RemId>();

      if (isPriorityReviewDoc && scopeForPriorityCalc !== undefined) {
        if (scopeForPriorityCalc === null) {
          const fullKbIds = [
            ...allCardInfos.map(info => info.remId).filter((id): id is RemId => !!id),
            ...allIncRems.map(rem => rem.remId),
          ];
          priorityCalcScope = new Set<RemId>(fullKbIds);
          console.log(`QUEUE ENTER: Priority Review Doc using FULL KB for priority calculations (${priorityCalcScope.size} rems).`);
        } else {
          priorityCalcScope = await buildComprehensiveScope(plugin, scopeForPriorityCalc);
        }
      } else {
        priorityCalcScope = itemSelectionScope || new Set<RemId>();
      }

      if (priorityCalcScope.size > 0) {

        await plugin.storage.setSession(priorityCalcScopeRemIdsKey, Array.from(priorityCalcScope));

        if (await isFullPerformanceMode(plugin)) {
          console.log('QUEUE ENTER: Full mode. Calculating session cache...');

          const docCardInfos = allCardInfos.filter(info => priorityCalcScope.has(info.remId));
          docPercentiles = calculateAllPercentiles(docCardInfos);
          dueCardsInScope = dueCardsInKB.filter(info => priorityCalcScope.has(info.remId));

          const scopedIncRems = allIncRems.filter(rem => priorityCalcScope.has(rem.remId));
          incRemDocPercentiles = calculateAllPercentiles(scopedIncRems);
          dueIncRemsInScope = dueIncRemsInKB.filter(rem => priorityCalcScope.has(rem.remId));

          console.log(`QUEUE ENTER: Priority calculations complete:`);
          console.log(`  - Cards in priority scope: ${docCardInfos.length}`);
          console.log(`  - Due cards in priority scope: ${dueCardsInScope.length}`);
          console.log(`  - IncRems in priority scope: ${scopedIncRems.length}`);
          console.log(`  - Due IncRems in priority scope: ${dueIncRemsInScope.length}`);

        } else {
          console.log('QUEUE ENTER: Light mode. Skipping session cache calculation.');
        }
      }

    }

    const sessionCache: QueueSessionCache = {
      docPercentiles,
      dueCardsInScope,
      dueCardsInKB,
      dueIncRemsInScope,
      dueIncRemsInKB,
      incRemDocPercentiles,
    };

    await plugin.storage.setSession(queueSessionCacheKey, sessionCache);
    console.log('QUEUE ENTER: Pre-calculation complete. Session cache has been saved.');

    const performanceMode = await getPerformanceMode(plugin);
    const dueIncRemCount = await calculateDueIncRemCount(
      plugin,
      allIncRems,
      sessionCache,
      isPriorityReviewDoc,
      scopeForItemSelection,
      performanceMode
    );

    registerQueueCounter(plugin, dueIncRemCount);
  });
}

// Shared Set for coordinating between QueueCompleteCard and GlobalRemChanged listeners
// to avoid duplicate processing
const recentlyProcessedCards = new Set<string>();

/**
 * Hooks into card completion events to keep the card priority cache fresh in full-performance mode.
 *
 * @param plugin Plugin instance for card/rem lookups and settings access.
 */
export function registerQueueCompleteCardListener(plugin: ReactRNPlugin) {
  plugin.event.addListener(
    AppEvents.QueueCompleteCard,
    undefined,
    async (data: { cardId: RemId }) => {
      if (await isLightPerformanceMode(plugin)) {
        return;
      }

      console.log('🎴 CARD COMPLETED (Full Mode):', data);

      if (!data || !data.cardId) {
        console.error('LISTENER: Event fired but did not contain a cardId. Aborting.');
        return;
      }

      const card = await plugin.card.findOne(data.cardId);
      const remId = card?.remId;
      const rem = remId ? await plugin.rem.findOne(remId) : null;
      const isIncRem = rem ? await rem.hasPowerup(powerupCode) : false;

      console.log(`🎴 Card from ${isIncRem ? 'INCREMENTAL REM' : 'regular card'}, remId: ${remId}`);

      if (remId) {
        recentlyProcessedCards.add(remId);
        setTimeout(() => recentlyProcessedCards.delete(remId), CARD_PROCESSING_DEBOUNCE_MS);

        console.log('LISTENER: Calling LIGHT updateCardPriorityCache...');
        await updateCardPriorityCache(plugin, remId, true);

        // Mark card as seen for this session (used by Shield)
        const seenCards = (await plugin.storage.getSession<string[]>(seenCardInSessionKey)) || [];
        if (!seenCards.includes(remId)) {
          await plugin.storage.setSession(seenCardInSessionKey, [...seenCards, remId]);
        }

        // Keep session cache in sync so Shield updates immediately
        const sessionCache = await plugin.storage.getSession<QueueSessionCache>(queueSessionCacheKey);
        if (sessionCache) {
          const updatedCache: QueueSessionCache = {
            ...sessionCache,
            dueCardsInKB: sessionCache.dueCardsInKB.filter((c) => c.remId !== remId),
            dueCardsInScope: sessionCache.dueCardsInScope.filter((c) => c.remId !== remId),
          };
          await plugin.storage.setSession(queueSessionCacheKey, updatedCache);
        }
      } else {
        console.error(`LISTENER: Could not find a parent Rem for the completed cardId ${data.cardId}`);
      }
    }
  );
}

/**
 * Registers a debounced handler for the global Rem change stream: ignores updates fired while
 * the user is in the queue or running in Light mode, then auto-assigns priorities (if missing)
 * and refreshes the priority cache for the changed Rem.
 *
 * @param plugin Plugin instance for storage, settings, and Rem lookups.
 */
export function registerGlobalRemChangedListener(plugin: ReactRNPlugin) {
  let remChangeDebounceTimer: NodeJS.Timeout;

  plugin.event.addListener(
    AppEvents.GlobalRemChanged,
    undefined,
    (data) => {
      clearTimeout(remChangeDebounceTimer);

      remChangeDebounceTimer = setTimeout(async () => {
        const inQueue = !!(await plugin.storage.getSession(currentSubQueueIdKey));
        const isManualUpdate = await plugin.storage.getSession<boolean>('manual_priority_update_pending');

        if (inQueue && !isManualUpdate) {
          console.log('LISTENER: (Debounced) GlobalRemChanged fired, but skipping processing because user is in the queue.');
          return;
        }

        if (isManualUpdate) {
          console.log('LISTENER: Processing manual priority update (Queue Override).');
          // Reset flag
          await plugin.storage.setSession('manual_priority_update_pending', false);
        }

        if (await isLightPerformanceMode(plugin)) {
          console.log('LISTENER: (Debounced) GlobalRemChanged fired, but skipping (Light Mode).');
          return;
        }



        if (recentlyProcessedCards.has(data.remId)) {
          console.log('LISTENER: Skipping - recently processed by QueueCompleteCard');
          return;
        }

        const rem = await plugin.rem.findOne(data.remId);
        if (!rem) {
          return;
        }

        const cards = await rem.getCards();
        if (cards && cards.length > 0) {
          const existingPriority = await getCardPriority(plugin, rem);
          if (!existingPriority) {
            await autoAssignCardPriority(plugin, rem);
          }
        }

        await updateCardPriorityCache(plugin, data.remId);

      }, REM_CHANGE_DEBOUNCE_MS);
    }
  );
}

export function registerEventListeners(
  plugin: ReactRNPlugin,
  resetSessionItemCounter: ResetSessionItemCounter
) {
  registerQueueExitListener(plugin, resetSessionItemCounter);
  registerQueueEnterListener(plugin, resetSessionItemCounter);
  registerURLChangeListener(plugin);
  registerQueueCompleteCardListener(plugin);
  registerGlobalRemChangedListener(plugin);
}
