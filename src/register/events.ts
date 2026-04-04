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
  dismissedPowerupCode,
  repHistorySlotCode,
  incrementalQueueActiveKey,
} from '../lib/consts';
import {
  CardPriorityInfo,
  QueueSessionCache,
  autoAssignCardPriority,
  getCardPriority,
  PrioritySource,
} from '../lib/card_priority';
import { IncrementalRem, getIncrementalRemFromRem } from '../lib/incremental_rem';
import { flushCacheUpdatesNow, updateCardPriorityCache } from '../lib/card_priority/cache';
import { setCurrentIncrementalRem } from '../lib/incremental_rem';
import { transferToDismissed } from '../lib/dismissed';
import { IncrementalRep } from '../lib/incremental_rem/types';
import { isPriorityReviewDocument, extractOriginalScopeFromPriorityReview } from '../lib/priority_review_document';
import {
  calculateAllPercentiles,
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
import { shouldUseLightMode } from '../lib/mobileUtils';

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
    // Safety net: always clear the incremental queue flag on exit.
    // The QueueComponent's useEffect cleanup may not fire if its iframe is destroyed abruptly.
    await plugin.storage.setSession(incrementalQueueActiveKey, false);

    await flushCacheUpdatesNow(plugin);
    console.log('QueueExit triggered, subQueueId:', subQueueId);

    const originalScopeId = await plugin.storage.getSession<string | null>('originalScopeId');
    const priorityCalcScopeRemIds = await plugin.storage.getSession<RemId[] | null>(priorityCalcScopeRemIdsKey);
    console.log('[QueueExit] Priority calculation scope:', priorityCalcScopeRemIds?.length || 0, 'rems');
    console.log('[QueueExit] Original scope ID for history:', originalScopeId);

    if (!(await shouldUseLightMode(plugin))) {
      console.log('[QueueExit] Full mode. Saving Priority Shield history...');

      const skipCardHistorySave = await plugin.storage.getSession<boolean>('skipCardHistorySave');
      const skipIncRemHistorySave = await plugin.storage.getSession<boolean>('skipIncRemHistorySave');

      const isCardCacheLoaded = await plugin.storage.getSession<boolean>('card_priority_cache_fully_loaded');
      const isIncRemCacheLoaded = await plugin.storage.getSession<boolean>('inc_rem_cache_fully_loaded');

      const shouldSaveCard = isCardCacheLoaded || !skipCardHistorySave;
      const shouldSaveIncRem = isIncRemCacheLoaded || !skipIncRemHistorySave;

      const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
      const allCardInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
      const seenRemIds = (await plugin.storage.getSession<string[]>(seenRemInSessionKey)) || [];
      const seenCardIds = (await plugin.storage.getSession<string[]>(seenCardInSessionKey)) || [];

      // Save KB-level shields
      if (shouldSaveIncRem) {
        await saveKBShield(plugin, allIncRems as any, isIncRemDue, seenRemIds, priorityShieldHistoryKey, 'IncRem');
      } else {
        console.warn('[QueueExit] Skipping KB IncRem shield save because cache was incomplete');
      }

      if (shouldSaveCard) {
        await saveKBShield(plugin, allCardInfos, isCardDue, seenCardIds, cardPriorityShieldHistoryKey, 'Card');
      } else {
        console.warn('[QueueExit] Skipping KB Card shield save because cache was incomplete');
      }

      // Save document-level shields if scope exists
      const historyKey = originalScopeId || subQueueId || await plugin.storage.getSession<string>(currentSubQueueIdKey);

      if (historyKey && priorityCalcScopeRemIds && priorityCalcScopeRemIds.length > 0) {
        if (shouldSaveIncRem) {
          await saveDocumentShield(
            plugin,
            allIncRems as any,
            priorityCalcScopeRemIds,
            isIncRemDue,
            seenRemIds,
            documentPriorityShieldHistoryKey,
            historyKey,
            'IncRem'
          );
        }

        if (shouldSaveCard) {
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
        }
      } else {
        console.log('[QueueExit] No scope ID or priority calc scope - skipping document shield saves');
      }
    } else {
      console.log('[QueueExit] Light mode. Skipping Priority Shield history save.');
    }

    await resetQueueSession(plugin);
    resetSessionItemCounter();

    // console.log('Session state reset complete');
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
      // console.error('Failed to update document ID for counter:', error);
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

    // Safety net: clear stale incremental queue flag from a previous session
    // whose iframe cleanup may not have fired.
    await plugin.storage.setSession(incrementalQueueActiveKey, false);

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
      await plugin.storage.setSession('skipCardHistorySave', true);
    } else {
      await plugin.storage.setSession('skipCardHistorySave', false);
    }

    const dueCardsInKB = !(await shouldUseLightMode(plugin)) ? allCardInfos.filter(info => info.dueCards > 0) : [];

    let docPercentiles: Record<RemId, number> = {};
    let dueCardsInScope: CardPriorityInfo[] = [];

    const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];

    if (allIncRems.length === 0) {
      console.warn('QUEUE ENTER: Incremental Rem cache is empty! IncRem calculations will be skipped.');
      await plugin.storage.setSession('skipIncRemHistorySave', true);
    } else {
      await plugin.storage.setSession('skipIncRemHistorySave', false);
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

        if (!(await shouldUseLightMode(plugin))) {
          console.log('QUEUE ENTER: Full mode. Calculating session cache...');

          const docCardInfos = allCardInfos.filter(info => priorityCalcScope.has(info.remId));
          docPercentiles = calculateAllPercentiles(docCardInfos);
          dueCardsInScope = dueCardsInKB.filter(info => priorityCalcScope.has(info.remId));

          const scopedIncRems = allIncRems.filter(rem => priorityCalcScope.has(rem.remId));
          incRemDocPercentiles = calculateAllPercentiles(scopedIncRems as any);
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
      if (await shouldUseLightMode(plugin)) {
        return;
      }

      // console.log('🎴 CARD COMPLETED (Full Mode):', data);

      if (!data || !data.cardId) {
        // console.error('LISTENER: Event fired but did not contain a cardId. Aborting.');
        return;
      }

      const card = await plugin.card.findOne(data.cardId);
      const remId = card?.remId;
      const rem = remId ? await plugin.rem.findOne(remId) : null;
      const isIncRem = rem ? await rem.hasPowerup(powerupCode) : false;

      // console.log(`🎴 Card from ${isIncRem ? 'INCREMENTAL REM' : 'regular card'}, remId: ${remId}`);

      if (remId) {
        recentlyProcessedCards.add(remId);
        setTimeout(() => recentlyProcessedCards.delete(remId), CARD_PROCESSING_DEBOUNCE_MS);

        // console.log('LISTENER: Calling LIGHT updateCardPriorityCache...');
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
        // console.error(`LISTENER: Could not find a parent Rem for the completed cardId ${data.cardId}`);
      }
    }
  );
}

/**
 * Registers a debounced handler for the global Rem change stream: ignores updates fired while
 * the user is in the queue or running in Light mode, then auto-assigns priorities (if missing)
 * and refreshes the priority cache for the changed Rem.
 * 
 * Also detects when an Incremental powerup is manually removed and transfers history to dismissed.
 *
 * @param plugin Plugin instance for storage, settings, and Rem lookups.
 */
export function registerGlobalRemChangedListener(plugin: ReactRNPlugin) {
  // Per-remId debounce timers: prevents cross-rem timer stomping during
  // search/navigation bursts where many different remIds fire in rapid succession.
  const remChangeDebounceTimers = new Map<string, NodeJS.Timeout>();

  // Store captured history per remId (captured before debounce to avoid race condition)
  // Key: remId, Value: cloned history array
  const pendingHistoryMap = new Map<string, IncrementalRep[]>();

  // Store captured nextRepDate per remId (for manual date reset detection)
  const pendingNextRepDateMap = new Map<string, number>();

  plugin.event.addListener(
    AppEvents.GlobalRemChanged,
    undefined,
    async (data) => {
      const isBatchActive = await plugin.storage.getSession<boolean>('plugin_operation_active');
      if (isBatchActive) return;

      const existingTimer = remChangeDebounceTimers.get(data.remId);
      if (existingTimer) clearTimeout(existingTimer);

      const rem = await plugin.rem.findOne(data.remId);
      if (!rem) return;

      // IMPORTANT: Capture history NOW, before debounce
      //
      // History capture strategy: We prioritize the session cache (allIncrementalRemKey)
      // because when removePowerup() is called, the GlobalRemChanged event fires AFTER
      // the powerup and all its slots are already deleted. Reading from the rem's powerup
      // slots would fail in that case. The session cache still holds the old data.
      //
      // We fall back to direct rem read for cases where the session cache hasn't been
      // populated yet (e.g., Light Mode or before first queue entry).
      let capturedHistory: IncrementalRep[] | null = null;

      // Primary: read from session cache (immune to powerup removal timing)
      const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
      const cachedIncRem = allIncRems.find(r => r.remId === data.remId);

      if (cachedIncRem && cachedIncRem.history && cachedIncRem.history.length > 0) {
        capturedHistory = [...cachedIncRem.history];
      }

      // Fallback: read directly from rem (works when powerup is still present)
      const currentIncRem = !capturedHistory ? await getIncrementalRemFromRem(plugin, rem) : null;

      if (!capturedHistory && currentIncRem && currentIncRem.history && currentIncRem.history.length > 0) {
        capturedHistory = [...currentIncRem.history];
      }

      if (capturedHistory && capturedHistory.length > 0) {
        pendingHistoryMap.set(data.remId, capturedHistory);
      }

      // Also capture nextRepDate for manual date reset detection
      // (only relevant when powerup is still present, so direct rem read is fine)
      if (!currentIncRem && !capturedHistory) {
        // Skip nextRepDate capture — powerup is gone, this was a removal event
      } else {
        const incRemForDate = currentIncRem || (cachedIncRem as any);
        if (incRemForDate && incRemForDate.nextRepDate) {
          if (!pendingNextRepDateMap.has(data.remId)) {
            pendingNextRepDateMap.set(data.remId, incRemForDate.nextRepDate);
          }
        }
      }

      const debounceTimer = setTimeout(async () => {
        remChangeDebounceTimers.delete(data.remId);
        // Re-check suppression flag — the event may have been enqueued
        // before the flag was set, but fires inside a batch operation.
        const isBatchActiveNow = await plugin.storage.getSession<boolean>('plugin_operation_active');
        if (isBatchActiveNow) {
          pendingHistoryMap.delete(data.remId);
          pendingNextRepDateMap.delete(data.remId);
          return;
        }

        const rem = await plugin.rem.findOne(data.remId);
        if (!rem) {
          pendingHistoryMap.delete(data.remId);
          pendingNextRepDateMap.delete(data.remId);
          return;
        }

        // Check for powerup removal detection
        const hasIncremental = await rem.hasPowerup(powerupCode);
        const hasDismissed = await rem.hasPowerup(dismissedPowerupCode);

        // Use the pre-captured history for THIS remId
        const pendingHistory = pendingHistoryMap.get(data.remId);
        const hadHistoryPreCaptured = pendingHistory && pendingHistory.length > 0;

        if (!hasIncremental && !hasDismissed && hadHistoryPreCaptured) {
          // Powerup was manually removed! Transfer to dismissed
          await transferToDismissed(plugin, rem, pendingHistory!);
        }

        // === MANUAL DATE RESET DETECTION ===
        // Only check if still an incremental rem (powerup not removed)
        if (hasIncremental && !hasDismissed) {
          const oldNextRepDate = pendingNextRepDateMap.get(data.remId);

          if (oldNextRepDate !== undefined) {
            // Get the CURRENT nextRepDate from the rem itself
            const currentIncRem = await getIncrementalRemFromRem(plugin, rem);

            if (currentIncRem && currentIncRem.nextRepDate !== oldNextRepDate) {
              // Check if this change was made by the plugin using a session flag
              const pluginIsUpdating = await plugin.storage.getSession<boolean>('plugin_updating_srs_data');

              if (!pluginIsUpdating) {
                // Date was changed manually! Add manualDateReset event
                console.log('[GlobalRemChanged] Manual date reset detected:', {
                  remId: data.remId,
                  oldDate: new Date(oldNextRepDate).toLocaleDateString(),
                  newDate: new Date(currentIncRem.nextRepDate).toLocaleDateString()
                });

                // Calculate the new interval in days
                const intervalDays = Math.round((currentIncRem.nextRepDate - Date.now()) / (1000 * 60 * 60 * 24));

                // Add manualDateReset event to history
                const newHistoryEntry: IncrementalRep = {
                  date: Date.now(),
                  scheduled: oldNextRepDate,
                  interval: Math.max(0, intervalDays),
                  eventType: 'manualDateReset' as const,
                };

                const updatedHistory: IncrementalRep[] = [
                  ...(currentIncRem.history || []),
                  newHistoryEntry,
                ];

                // IMPORTANT: Set the suppression flag BEFORE writing the history property.
                // Writing repHistorySlotCode fires a new GlobalRemChanged for this same rem.
                // Without this flag, that new event passes all guards and triggers another
                // "manual date reset" detection → infinite loop.
                // We use the same flag + delayed-clear pattern as updateSRSDataForRem so that
                // the existing guard at line ~571 suppresses the follow-up event.
                await plugin.storage.setSession('plugin_updating_srs_data', true);

                // Update just the history slot (date already changed by user)
                await rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(updatedHistory)]);
                console.log('[GlobalRemChanged] Added manualDateReset event to history');

                // Update the in-memory IncRem cache so any subsequent event pre-captures
                // the correct (new) history/date and doesn't see stale baseline values.
                const { updateIncrementalRemCache } = await import('../lib/incremental_rem/cache');
                await updateIncrementalRemCache(plugin, { ...currentIncRem, history: updatedHistory });

                // Clear suppression flag after a delay longer than the debounce window (1000ms)
                // so it stays active for any follow-up GlobalRemChanged from the property write.
                setTimeout(async () => {
                  await plugin.storage.setSession('plugin_updating_srs_data', false);
                }, 3000);
              }
            }
          }
        }

        // Clear pending state for this rem
        pendingHistoryMap.delete(data.remId);
        pendingNextRepDateMap.delete(data.remId);

        // Original logic continues below
        const inQueue = !!(await plugin.storage.getSession(currentSubQueueIdKey));

        const manualPendingRems = await plugin.storage.getSession<string[]>('manual_priority_pending_rems') || [];
        const isManualUpdate = manualPendingRems.includes(data.remId);

        if (inQueue && !isManualUpdate) {
          // console.log('LISTENER: (Debounced) GlobalRemChanged fired, but skipping processing because user is in the queue.');
          return;
        }

        if (isManualUpdate) {
          // console.log('LISTENER: Processing manual priority update (Queue Override).');
          // Consume the flag for this specific RemId only!
          await plugin.storage.setSession(
            'manual_priority_pending_rems',
            manualPendingRems.filter(id => id !== data.remId)
          );
        }

        if (await shouldUseLightMode(plugin)) {
          // console.log('LISTENER: (Debounced) GlobalRemChanged fired, but skipping (Light Mode).');
          return;
        }

        if (recentlyProcessedCards.has(data.remId)) {
          // console.log('LISTENER: Skipping - recently processed by QueueCompleteCard');
          return;
        }

        const cards = await rem.getCards();
        let targetPriority: number | null = null;
        let targetSource: PrioritySource | null = null;

        if (cards && cards.length > 0) {
          const existingPriority = await getCardPriority(plugin, rem);
          if (!existingPriority || existingPriority.source === 'default' || existingPriority.source === 'inherited') {
            await autoAssignCardPriority(plugin, rem);
          }
          const finalPriority = await getCardPriority(plugin, rem);
          if (finalPriority) {
            targetPriority = finalPriority.priority;
            targetSource = finalPriority.source;
          }
        }

        // Compare against existing cache to prevent useless UI rebuilds and overwrites.
        //
        // Skip entirely if this rem has no cards and no existing cache entry:
        // these are non-card rems (opened documents, search results, etc.) that fire
        // GlobalRemChanged constantly but have nothing to update in the priority cache.
        // Without this guard, `!cachedEntry` was unconditionally true for them, causing
        // thousands of false "property drift" logs and updateCardPriorityCache calls.
        if (targetPriority === null && targetSource === null) {
          // No cards on this rem — nothing to track in the card priority cache.
          return;
        }

        const allInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
        const cachedEntry = allInfos.find((info) => info.remId === data.remId);

        if (
          !cachedEntry ||
          cachedEntry.priority !== targetPriority ||
          cachedEntry.source !== targetSource
        ) {
          console.log(`[GlobalRemChanged] Detected true property drift for ${data.remId}. Triggering update.`);
          await updateCardPriorityCache(plugin, data.remId);
        }

      }, REM_CHANGE_DEBOUNCE_MS);
      remChangeDebounceTimers.set(data.remId, debounceTimer);
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
