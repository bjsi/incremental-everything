import { AppEvents, ReactRNPlugin, RemId } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
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
  queueCounterId,
  powerupCode,
  nextRepDateSlotCode,
  scrollToHighlightId,
  collapseTopBarId,
  hideIncEverythingId,
} from '../lib/consts';
import { calculateRelativePriority } from '../lib/priority';
import {
  CardPriorityInfo,
  calculateRelativeCardPriority,
  QueueSessionCache,
  autoAssignCardPriority,
  getCardPriority,
} from '../lib/cardPriority';
import { IncrementalRem } from '../lib/types';
import { flushCacheUpdatesNow, updateCardPriorityInCache } from '../lib/cache';
import { setCurrentIncrementalRem } from '../lib/currentRem';
import { isPriorityReviewDocument, extractOriginalScopeFromPriorityReview } from '../lib/priorityReviewDocument';

type ResetSessionItemCounter = () => void;

type ShieldHistoryEntry = {
  absolute: number | null;
  percentile: number | null;
  universeSize: number;
};

type ShieldHistory = Record<string, ShieldHistoryEntry>;
type ShieldHistoryByScope = Record<string, ShieldHistory>;

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
    `  - Priority calculations for: ${
      extractedScopeId ? `Original scope (${extractedScopeId})` : 'Full KB'
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
    const docScopeRemIds = await plugin.storage.getSession<RemId[] | null>(priorityCalcScopeRemIdsKey);
    console.log('[QueueExit] IncRem shield - Priority calculation scope:', docScopeRemIds?.length || 0, 'rems');
    console.log('Original scope ID for history:', originalScopeId);
    
    const performanceMode = await plugin.settings.getSetting('performanceMode') || 'full';

    if (performanceMode === 'full') {
      console.log('[QueueExit] Full mode. Saving Priority Shield history...');
      
      const allRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];

      if (allRems.length > 0) {
        const today = dayjs().format('YYYY-MM-DD');
        const unreviewedDueRems = allRems.filter(
          (rem) => Date.now() >= rem.nextRepDate
        );

        const kbFinalStatus: ShieldHistoryEntry = {
          absolute: null,
          percentile: 100,
          universeSize: allRems.length,
        };

        if (unreviewedDueRems.length > 0) {
          const topMissedInKb = _.minBy(unreviewedDueRems, (rem) => rem.priority);
          if (topMissedInKb) {
            kbFinalStatus.absolute = topMissedInKb.priority;
            kbFinalStatus.percentile = calculateRelativePriority(allRems, topMissedInKb.remId);
          }
        }
        
        const kbHistory =
          (await plugin.storage.getSynced<ShieldHistory>(priorityShieldHistoryKey)) || {};
        kbHistory[today] = kbFinalStatus;
        await plugin.storage.setSynced(priorityShieldHistoryKey, kbHistory);
        console.log('[QueueExit] Saved KB IncRem history:', kbFinalStatus);
        
        if (docScopeRemIds && docScopeRemIds.length > 0) {
          console.log('[QueueExit] Processing IncRem document shield with PRIORITY CALC scope:', docScopeRemIds.length, 'rems');
          
          const scopedRems = allRems.filter((rem) => docScopeRemIds.includes(rem.remId));
          console.log('[QueueExit] Found', scopedRems.length, 'incremental rems in priority calculation scope');
          
          const unreviewedDueInScope = scopedRems.filter(
            (rem) => Date.now() >= rem.nextRepDate
          );
          console.log('[QueueExit] Found', unreviewedDueInScope.length, 'due IncRems in priority calculation scope');
          
          const docFinalStatus: ShieldHistoryEntry = {
            absolute: null,
            percentile: 100,
            universeSize: scopedRems.length,
          };
          
          if (unreviewedDueInScope.length > 0) {
            const topMissedInDoc = _.minBy(unreviewedDueInScope, (rem) => rem.priority);
            if (topMissedInDoc) {
              docFinalStatus.absolute = topMissedInDoc.priority;
              docFinalStatus.percentile = calculateRelativePriority(scopedRems, topMissedInDoc.remId);
              console.log('[QueueExit] IncRem doc shield - Priority:', docFinalStatus.absolute, 'Percentile:', docFinalStatus.percentile + '%', 'Universe: ', docFinalStatus.universeSize);
            }
          }
          
          const historyKey = originalScopeId || subQueueId || await plugin.storage.getSession<string>(currentSubQueueIdKey);
          
          if (historyKey) {
            const docHistory =
              (await plugin.storage.getSynced<ShieldHistoryByScope>(documentPriorityShieldHistoryKey)) ||
              {};
            if (!docHistory[historyKey]) {
              docHistory[historyKey] = {};
            }
            docHistory[historyKey][today] = docFinalStatus;
            await plugin.storage.setSynced(documentPriorityShieldHistoryKey, docHistory);
            console.log('Saved document history for original scope', historyKey, ':', docFinalStatus);
          } else {
            console.log('Warning: No scope ID available for saving document history');
          }
        } else {
          console.log('No document scope RemIds found or empty - skipping document history save');
        }
      }

      const allCardInfos = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey);

      if (allCardInfos && allCardInfos.length > 0) {
          const today = dayjs().format('YYYY-MM-DD');
          const seenCardIds = (await plugin.storage.getSession<string[]>(seenCardInSessionKey)) || [];

          const unreviewedDueKb = allCardInfos.filter(c => c.dueCards > 0 && !seenCardIds.includes(c.remId));
          const kbCardFinalStatus: ShieldHistoryEntry = { 
            absolute: null, 
            percentile: 100,
            universeSize: allCardInfos.length,
          };
          if (unreviewedDueKb.length > 0) {
              const topMissed = _.minBy(unreviewedDueKb, c => c.priority);
              if (topMissed) {
                  kbCardFinalStatus.absolute = topMissed.priority;
                  kbCardFinalStatus.percentile = calculateRelativeCardPriority(allCardInfos, topMissed.remId);
              }
          }
          const cardKbHistory =
            (await plugin.storage.getSynced<ShieldHistory>(cardPriorityShieldHistoryKey)) || {};
          cardKbHistory[today] = kbCardFinalStatus;
          await plugin.storage.setSynced(cardPriorityShieldHistoryKey, cardKbHistory);
          console.log('Saved KB card history:', kbCardFinalStatus);

          const historyKey = originalScopeId || subQueueId || await plugin.storage.getSession<string>(currentSubQueueIdKey);
          const priorityCalcScopeRemIds = await plugin.storage.getSession<RemId[]>(priorityCalcScopeRemIdsKey);
          
          if (historyKey && priorityCalcScopeRemIds && priorityCalcScopeRemIds.length > 0) {
              console.log('[QueueExit] Calculating card shield using PRIORITY CALC scope:', priorityCalcScopeRemIds.length, 'rems');
              
              const docCardInfos = allCardInfos.filter(ci => priorityCalcScopeRemIds.includes(ci.remId));
              console.log('[QueueExit] Found', docCardInfos.length, 'cards in priority calculation scope');

              const unreviewedDueDoc = docCardInfos.filter(c => c.dueCards > 0 && !seenCardIds.includes(c.remId));
              const docCardFinalStatus: ShieldHistoryEntry = { 
                absolute: null, 
                percentile: 100,
                universeSize: docCardInfos.length,
              };

              if (unreviewedDueDoc.length > 0) {
                  const topMissed = _.minBy(unreviewedDueDoc, c => c.priority);
                  if (topMissed) {
                      docCardFinalStatus.absolute = topMissed.priority;
                      docCardFinalStatus.percentile = calculateRelativeCardPriority(docCardInfos, topMissed.remId);
                      console.log('[QueueExit] Doc card shield - Priority:', docCardFinalStatus.absolute, 'Percentile:', docCardFinalStatus.percentile + '%', 'Universe: ', docCardFinalStatus.universeSize);
                  }
              }
              
              const docCardHistory =
                (await plugin.storage.getSynced<ShieldHistoryByScope>(
                  documentCardPriorityShieldHistoryKey
                )) || {};
              if (!docCardHistory[historyKey]) {
                  docCardHistory[historyKey] = {};
              }
              docCardHistory[historyKey][today] = docCardFinalStatus;
              await plugin.storage.setSynced(documentCardPriorityShieldHistoryKey, docCardHistory);
              console.log('Saved card document history for original scope', historyKey, ':', docCardFinalStatus);
          } else {
              console.log('[QueueExit] Skipping card document shield - no priority calc scope available');
          }
      }
    } else {
      console.log('[QueueExit] Light mode. Skipping Priority Shield history save.');
    }
    
    await plugin.storage.setSession(seenRemInSessionKey, []);
    await plugin.storage.setSession(seenCardInSessionKey, []);
    await plugin.storage.setSession(currentScopeRemIdsKey, null);
    await plugin.storage.setSession(priorityCalcScopeRemIdsKey, null);
    await plugin.storage.setSession(currentSubQueueIdKey, null);
    await plugin.storage.setSession('effectiveScopeId', null);
    await plugin.storage.setSession('originalScopeId', null);
    await plugin.storage.setSession(queueSessionCacheKey, null);
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
      plugin.app.unregisterMenuItem(scrollToHighlightId);
      plugin.app.registerCSS(collapseTopBarId, '');
      plugin.app.registerCSS(queueCounterId, '');
      plugin.app.registerCSS(hideIncEverythingId, '');
      await setCurrentIncrementalRem(plugin, undefined);
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
    await plugin.storage.setSession(seenRemInSessionKey, []);
    await plugin.storage.setSession(seenCardInSessionKey, []);
    await plugin.storage.setSession(currentScopeRemIdsKey, null);
    await plugin.storage.setSession(priorityCalcScopeRemIdsKey, null);
    
    const {
      scopeForPriorityCalc,
      scopeForItemSelection,
      originalScopeId,
      isPriorityReviewDoc,
    } = await resolveQueueScopes(plugin, subQueueId);
    
    await plugin.storage.setSession(currentSubQueueIdKey, subQueueId || null);
    await plugin.storage.setSession('originalScopeId', originalScopeId);
    await plugin.storage.setSession('isPriorityReviewDoc', isPriorityReviewDoc);

    const performanceMode = await plugin.settings.getSetting('performanceMode') || 'full';

    const allCardInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
    
    if (allCardInfos.length === 0) {
      console.warn('QUEUE ENTER: Card priority cache is empty! Flashcard calculations will be skipped.');
    }

    const dueCardsInKB = (performanceMode === 'full') ? allCardInfos.filter(info => info.dueCards > 0) : [];

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
      
      let itemSelectionScope: Set<RemId> = new Set<RemId>();
      
      if (isPriorityReviewDoc) {
        const reviewDocRem = await plugin.rem.findOne(scopeForItemSelection);
        if (reviewDocRem) {
          const startTime = Date.now();
          
          const descendants = await reviewDocRem.getDescendants();
          const allRemsInContext = await reviewDocRem.allRemInDocumentOrPortal();
          const folderQueueRems = await reviewDocRem.allRemInFolderQueue();
          const sources = await reviewDocRem.getSources();
          
          const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
            powerupCode,
            nextRepDateSlotCode
          );
          
          const referencingRems = ((await reviewDocRem.remsReferencingThis()) || []).map((rem) => {
            if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
              return rem.parent;
            } else {
              return rem._id;
            }
          }).filter(id => id !== null && id !== undefined) as RemId[];
          
          itemSelectionScope = new Set<RemId>([
            reviewDocRem._id,
            ...descendants.map(r => r._id),
            ...allRemsInContext.map(r => r._id),
            ...folderQueueRems.map(r => r._id),
            ...sources.map(r => r._id),
            ...referencingRems
          ]);
          
          const elapsed = Date.now() - startTime;
          console.log(`QUEUE ENTER: Priority Review Doc scope: ${itemSelectionScope.size} items for selection (${elapsed}ms)`);
          
          await plugin.storage.setSession(currentScopeRemIdsKey, Array.from(itemSelectionScope));
        }
      } else {
        const scopeRem = await plugin.rem.findOne(scopeForItemSelection);
        if (scopeRem) {
          const startTime = Date.now();
          
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
          
          itemSelectionScope = new Set<RemId>([
            scopeRem._id,
            ...descendants.map(r => r._id),
            ...allRemsInContext.map(r => r._id),
            ...folderQueueRems.map(r => r._id),
            ...sources.map(r => r._id),
            ...referencingRems
          ]);
          
          const elapsed = Date.now() - startTime;
          console.log(`QUEUE ENTER: Regular document comprehensive scope: ${itemSelectionScope.size} items (${elapsed}ms)`);
          
          await plugin.storage.setSession(currentScopeRemIdsKey, Array.from(itemSelectionScope));
        }
      }
      
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
          const originalScopeRem = await plugin.rem.findOne(scopeForPriorityCalc);
          if (originalScopeRem) {
            const descendants = await originalScopeRem.getDescendants();
            const allRemsInContext = await originalScopeRem.allRemInDocumentOrPortal();
            const folderQueueRems = await originalScopeRem.allRemInFolderQueue();
            const sources = await originalScopeRem.getSources();
            
            const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
              powerupCode,
              nextRepDateSlotCode
            );
            
            const referencingRems = ((await originalScopeRem.remsReferencingThis()) || []).map((rem) => {
              if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
                return rem.parent;
              } else {
                return rem._id;
              }
            }).filter(id => id !== null && id !== undefined) as RemId[];
            
            priorityCalcScope = new Set<RemId>([
              originalScopeRem._id,
              ...descendants.map(r => r._id),
              ...allRemsInContext.map(r => r._id),
              ...folderQueueRems.map(r => r._id),
              ...sources.map(r => r._id),
              ...referencingRems
            ]);
          } else {
            priorityCalcScope = new Set<RemId>();
          }
        }
      } else {
        priorityCalcScope = itemSelectionScope || new Set<RemId>();
      }

      if (priorityCalcScope.size > 0) {
        
        await plugin.storage.setSession(priorityCalcScopeRemIdsKey, Array.from(priorityCalcScope));
        
        if (performanceMode === 'full') {
          console.log('QUEUE ENTER: Full mode. Calculating session cache...');
          
          const docCardInfos = allCardInfos.filter(info => priorityCalcScope.has(info.remId));
          const sortedDocCards = _.sortBy(docCardInfos, (info) => info.priority);
          
          sortedDocCards.forEach((info, index) => {
            docPercentiles[info.remId] = Math.round(((index + 1) / sortedDocCards.length) * 100);
          });
          
          dueCardsInScope = dueCardsInKB.filter(info => priorityCalcScope.has(info.remId));
          
          const scopedIncRems = allIncRems.filter(rem => priorityCalcScope.has(rem.remId));
          const sortedIncRems = _.sortBy(scopedIncRems, (rem) => rem.priority);
          
          sortedIncRems.forEach((rem, index) => {
            incRemDocPercentiles[rem.remId] = Math.round(((index + 1) / sortedIncRems.length) * 100);
          });
          
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
    
    let dueIncRemCount: number;
    
    if (isPriorityReviewDoc) {
      const scopeRemIds = await plugin.storage.getSession<RemId[]>(currentScopeRemIdsKey) || [];
      dueIncRemCount = allIncRems.filter(rem => 
        scopeRemIds.includes(rem.remId) && Date.now() >= rem.nextRepDate
      ).length;

    } else if (scopeForItemSelection) {
          
          if (performanceMode === 'full') {
            dueIncRemCount = sessionCache.dueIncRemsInScope.length;
          } else {
            console.log('QUEUE ENTER: Light mode - manually calculating due IncRem count...');
            const scopeRemIds = await plugin.storage.getSession<RemId[]>(currentScopeRemIdsKey) || [];
            if (scopeRemIds) {
              dueIncRemCount = allIncRems.filter(rem => 
                Date.now() >= rem.nextRepDate &&
                scopeRemIds.includes(rem.remId)
              ).length;
            } else {
              dueIncRemCount = 0;
            }
            console.log(`QUEUE ENTER: Light mode - found ${dueIncRemCount} due IncRems`);
          }

        } else {
          dueIncRemCount = sessionCache.dueIncRemsInKB.length;
        }

    plugin.app.registerCSS(
      queueCounterId,
      `
      .rn-queue__card-counter {
        /*visibility: hidden;*/
      }

      .light .rn-queue__card-counter:after {
        content: ' + ${dueIncRemCount}';
      }

      .dark .rn-queue__card-counter:after {
        content: ' + ${dueIncRemCount}';
      }`.trim()
    );

    console.log(`QUEUE ENTER: Queue counter updated to show ${dueIncRemCount} due IncRems`);
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
      const performanceMode = (await plugin.settings.getSetting('performanceMode')) || 'light';
      if (performanceMode !== 'full') {
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
        setTimeout(() => recentlyProcessedCards.delete(remId), 2000);

        console.log('LISTENER: Calling LIGHT updateCardPriorityInCache...');
        await updateCardPriorityInCache(plugin, remId, true);
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
        if (inQueue) {
          console.log('LISTENER: (Debounced) GlobalRemChanged fired, but skipping processing because user is in the queue.');
          return;
        }

        const performanceMode = (await plugin.settings.getSetting('performanceMode')) || 'light';
        if (performanceMode !== 'full') {
          console.log('LISTENER: (Debounced) GlobalRemChanged fired, but skipping (Light Mode).');
          return;
        }

        console.log(`LISTENER: (Debounced) GlobalRemChanged fired for RemId: ${data.remId} (Full Mode)`);

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

        await updateCardPriorityInCache(plugin, data.remId);
        console.log('LISTENER: (Debounced) Finished processing event.');
      }, 1000);
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
