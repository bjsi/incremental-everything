import { ReactRNPlugin, RemId } from '@remnote/plugin-sdk';
import {
  seenRemInSessionKey,
  seenCardInSessionKey,
  currentScopeRemIdsKey,
  priorityCalcScopeRemIdsKey,
  currentSubQueueIdKey,
  queueSessionCacheKey,
} from './consts';
import { IncrementalRem } from './incremental_rem';
import { QueueSessionCache } from './card_priority';

/**
 * Resets all queue-related session storage keys.
 * Called when exiting the queue or entering a new queue session.
 */
export async function resetQueueSession(plugin: ReactRNPlugin): Promise<void> {
  await plugin.storage.setSession(seenRemInSessionKey, []);
  await plugin.storage.setSession(seenCardInSessionKey, []);
  await plugin.storage.setSession(currentScopeRemIdsKey, null);
  await plugin.storage.setSession(priorityCalcScopeRemIdsKey, null);
  await plugin.storage.setSession(currentSubQueueIdKey, null);
  await plugin.storage.setSession('effectiveScopeId', null);
  await plugin.storage.setSession('originalScopeId', null);
  await plugin.storage.setSession('isPriorityReviewDoc', null);
  await plugin.storage.setSession(queueSessionCacheKey, null);
  await plugin.storage.setSession('skipCardHistorySave', null);
  await plugin.storage.setSession('skipIncRemHistorySave', null);
}

/**
 * Clears only the seen items tracking for a new queue session.
 * Called when entering the queue to start with a clean slate.
 */
export async function clearSeenItems(plugin: ReactRNPlugin): Promise<void> {
  await plugin.storage.setSession(seenRemInSessionKey, []);
  await plugin.storage.setSession(seenCardInSessionKey, []);
  await plugin.storage.setSession(currentScopeRemIdsKey, null);
  await plugin.storage.setSession(priorityCalcScopeRemIdsKey, null);
}

/**
 * Calculates the count of due Incremental Rems based on the current queue context.
 *
 * @param plugin Plugin instance
 * @param allIncRems All incremental rems in the knowledge base
 * @param sessionCache The pre-calculated session cache
 * @param isPriorityReviewDoc Whether this is a Priority Review Document
 * @param scopeForItemSelection The scope being used for item selection
 * @param performanceMode Current performance mode setting
 * @returns Count of due incremental rems to display
 */
export async function calculateDueIncRemCount(
  plugin: ReactRNPlugin,
  allIncRems: IncrementalRem[],
  sessionCache: QueueSessionCache,
  isPriorityReviewDoc: boolean,
  scopeForItemSelection: RemId | null,
  performanceMode: string
): Promise<number> {
  // Priority Review Docs always calculate from scope
  if (isPriorityReviewDoc) {
    const scopeRemIds = (await plugin.storage.getSession<RemId[]>(currentScopeRemIdsKey)) || [];
    return allIncRems.filter(
      (rem) => scopeRemIds.includes(rem.remId) && Date.now() >= rem.nextRepDate
    ).length;
  }

  // No scope means full KB
  if (!scopeForItemSelection) {
    return sessionCache.dueIncRemsInKB.length;
  }

  // Scoped queue - use cache in full mode, calculate in light mode
  if (performanceMode === 'full') {
    return sessionCache.dueIncRemsInScope.length;
  }

  // Light mode with scope - calculate manually
  console.log('QUEUE ENTER: Light mode - manually calculating due IncRem count...');
  const scopeRemIds = (await plugin.storage.getSession<RemId[]>(currentScopeRemIdsKey)) || [];
  const count = scopeRemIds.length
    ? allIncRems.filter(
      (rem) => Date.now() >= rem.nextRepDate && scopeRemIds.includes(rem.remId)
    ).length
    : 0;
  console.log(`QUEUE ENTER: Light mode - found ${count} due IncRems`);
  return count;
}
