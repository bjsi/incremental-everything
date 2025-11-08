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
} from '../lib/consts';
import { calculateRelativePriority } from '../lib/priority';
import {
  CardPriorityInfo,
  calculateRelativeCardPriority,
} from '../lib/cardPriority';
import { IncrementalRem } from '../lib/types';
import { flushCacheUpdatesNow } from '../lib/cache';

type ResetSessionItemCounter = () => void;

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

        let kbFinalStatus = {
          absolute: null as number | null,
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
        
        const kbHistory = (await plugin.storage.getSynced(priorityShieldHistoryKey)) || {};
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
          
          let docFinalStatus = {
            absolute: null as number | null,
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
            const docHistory = (await plugin.storage.getSynced(documentPriorityShieldHistoryKey)) || {};
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
          let kbCardFinalStatus = { 
            absolute: null as number | null, 
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
          const cardKbHistory = (await plugin.storage.getSynced(cardPriorityShieldHistoryKey)) || {};
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
              let docCardFinalStatus = { 
                absolute: null as number | null, 
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
              
              const docCardHistory = (await plugin.storage.getSynced(documentCardPriorityShieldHistoryKey)) || {};
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
