import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import {
  allIncrementalRemKey,
  currentScopeRemIdsKey,
  seenRemInSessionKey,
} from './consts';
import { IncrementalRem } from './types';
import { calculateRelativePriority } from './priority';
import * as _ from 'remeda';

/**
 * Defines the structure for our Priority Shield data.
 * Using 'null' allows us to handle cases where a value isn't applicable
 * (e.g., no document scope, or all due items have been reviewed).
 */
export interface PriorityShieldStatus {
  absolute: number | null;
  kbPercentile: number | null;
  docPercentile: number | null;
}

/**
 * Calculates the current Priority Shield status based on the user's progress.
 * It finds the highest-priority (lowest number) due Rem that hasn't been
 * reviewed in the current session.
 * @param plugin The RNPlugin instance.
 * @returns An object with the absolute, KB percentile, and document percentile priority.
 */
export async function calculatePriorityShield(
  plugin: RNPlugin
): Promise<PriorityShieldStatus> {
  // 1. Fetch all the data we need from session storage.
  const allRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
  const seenRemIds = (await plugin.storage.getSession<RemId[]>(seenRemInSessionKey)) || [];
  const docScopeRemIds = (await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey)) || null;

  if (allRems.length === 0) {
    return { absolute: null, kbPercentile: null, docPercentile: null };
  }

  // 2. Find all Rems that are due and haven't been seen yet in this session.
  const unreviewedDueRems = allRems.filter(
    (rem) => Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)
  );

  // If there are no unreviewed due Rems, the user is caught up! Protection is perfect.
  if (unreviewedDueRems.length === 0) {
    return { absolute: null, kbPercentile: null, docPercentile: null };
  }

  // 3. Find the highest-priority (lowest number) missed Rem for the entire KB.
  const topMissedInKb = _.minBy(unreviewedDueRems, (rem) => rem.priority);
  if (!topMissedInKb) {
    // This case should not happen if unreviewedDueRems.length > 0, but it's good for type safety.
    return { absolute: null, kbPercentile: null, docPercentile: null };
  }

  const absolute = topMissedInKb.priority;
  const kbPercentile = calculateRelativePriority(allRems, topMissedInKb.remId);
  let docPercentile: number | null = null;

  // 4. If we are in a document queue, perform the same calculation for the document scope.
  if (docScopeRemIds && docScopeRemIds.length > 0) {
    const scopedRems = allRems.filter((rem) => docScopeRemIds.includes(rem.remId));

    if (scopedRems.length > 0) {
      // Find unreviewed due Rems within this specific scope.
      const unreviewedDueInScope = scopedRems.filter(
        (rem) => Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)
      );

      const topMissedInDoc = _.minBy(unreviewedDueInScope, (rem) => rem.priority);

      if (topMissedInDoc) {
        // Calculate the percentile relative ONLY to the other Rems in the document.
        docPercentile = calculateRelativePriority(scopedRems, topMissedInDoc.remId);
      }
    }
  }

  return {
    absolute,
    kbPercentile,
    docPercentile,
  };
}