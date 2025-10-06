import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import {
  allIncrementalRemKey,
  currentScopeRemIdsKey,
  seenRemInSessionKey,
  currentSubQueueIdKey,
  seenCardInSessionKey,
} from './consts';
import { IncrementalRem } from './types';
import { calculateRelativePriority } from './priority';
import * as _ from 'remeda';
import { CardPriorityInfo } from './cardPriority';

// ... (Existing PriorityShieldStatus and calculatePriorityShield for Incremental Rem)
// ... (Make sure to keep the top part of the file for Incremental Rem if it's there)

export interface PriorityShieldStatus {
  kb: {
    absolute: number | null;
    percentile: number | null;
  };
  doc: {
    absolute: number | null;
    percentile: number | null;
  };
}

export async function calculatePriorityShield(
  plugin: RNPlugin,
  currentRemId?: RemId
): Promise<PriorityShieldStatus> {
  // ... existing implementation for Incremental Rem ...
  const status: PriorityShieldStatus = {
    kb: { absolute: null, percentile: null },
    doc: { absolute: null, percentile: null },
  };

  const allRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
  const seenRemIds = (await plugin.storage.getSession<RemId[]>(seenRemInSessionKey)) || [];
  const docScopeRemIds = (await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey)) || null;

  if (allRems.length === 0) {
    return status;
  }

  const unreviewedDueRems = allRems.filter(
    (rem) =>
      (Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)) ||
      rem.remId === currentRemId
  );

  if (unreviewedDueRems.length === 0) {
    return status;
  }

  const topMissedInKb = _.minBy(unreviewedDueRems, (rem) => rem.priority);
  if (topMissedInKb) {
    status.kb.absolute = topMissedInKb.priority;
    status.kb.percentile = calculateRelativePriority(allRems, topMissedInKb.remId);
  }

  if (docScopeRemIds && docScopeRemIds.length > 0) {
    const scopedRems = allRems.filter((rem) => docScopeRemIds.includes(rem.remId));

    if (scopedRems.length > 0) {
      const unreviewedDueInScope = scopedRems.filter(
        (rem) =>
          (Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)) ||
          rem.remId === currentRemId
      );

      const topMissedInDoc = _.minBy(unreviewedDueInScope, (rem) => rem.priority);
      if (topMissedInDoc) {
        status.doc.absolute = topMissedInDoc.priority;
        status.doc.percentile = calculateRelativePriority(scopedRems, topMissedInDoc.remId);
      }
    }
  }

  return status;
}

// --- REWRITTEN AND OPTIMIZED SECTION FOR CARD PRIORITY ---

export interface CardPriorityShieldStatus {
  kb: { absolute: number; percentile: number } | null;
  doc: { absolute: number; percentile: number } | null;
}

function calculateRelativeCardPriority(allItems: { priority: number; remId: string }[], currentRemId: RemId): number | null {
  if (!allItems || allItems.length === 0) {
    return null;
  }
  const sortedItems = _.sortBy(allItems, (x) => x.priority);
  const index = sortedItems.findIndex((x) => x.remId === currentRemId);
  if (index === -1) {
    return null;
  }
  const percentile = ((index + 1) / sortedItems.length) * 100;
  return Math.round(percentile * 10) / 10;
}

export async function calculateCardPriorityShield(
  plugin: RNPlugin,
  allPrioritizedCardInfo: CardPriorityInfo[],
  currentRemId?: RemId
): Promise<CardPriorityShieldStatus> {
  const status: CardPriorityShieldStatus = { kb: null, doc: null };
  const seenRemIds = (await plugin.storage.getSession<RemId[]>(seenCardInSessionKey)) || [];

  // 1. Find all unreviewed due cards in the KB from the FAST cache.
  // The cache already knows which Rems have due cards (`info.dueCards > 0`).
  const unreviewedDueKb = allPrioritizedCardInfo.filter(
    (info) => info.dueCards > 0 && (!seenRemIds.includes(info.remId) || info.remId === currentRemId)
  );

  if (unreviewedDueKb.length > 0) {
    // Find the highest priority (lowest number) among them.
    const topMissedInKb = _.minBy(unreviewedDueKb, (info) => info.priority);
    if (topMissedInKb) {
      // Step 1: Call the function and store the result.
      const percentile = calculateRelativeCardPriority(allPrioritizedCardInfo, topMissedInKb.remId);
      
      status.kb = {
        absolute: topMissedInKb.priority,
        // Step 2: Use the result with the correct fallback logic.
        percentile: percentile === null ? 100 : percentile,
      };
    }
  }

  // 2. Calculate the Document Shield
  const subQueueId = await plugin.storage.getSession<string | null>(currentSubQueueIdKey);
  if (subQueueId) {
    const scopeRem = await plugin.rem.findOne(subQueueId);
    if (scopeRem) {
      const docDescendants = await scopeRem.getDescendants();
      const scopeRemIds = new Set([scopeRem._id, ...docDescendants.map(r => r._id)]);
      
      // Filter the main cache to get only the cards in the current document scope.
      const docPrioritizedCardInfo = allPrioritizedCardInfo.filter(info => scopeRemIds.has(info.remId));
      
      // Now find unreviewed due cards within this smaller, document-scoped list.
      const unreviewedDueDoc = docPrioritizedCardInfo.filter(
        (info) => info.dueCards > 0 && (!seenRemIds.includes(info.remId) || info.remId === currentRemId)
      );

      if (unreviewedDueDoc.length > 0) {
        const topMissedInDoc = _.minBy(unreviewedDueDoc, (info) => info.priority);
        if (topMissedInDoc) {
          // Step 1: Call the function and store the result.
          const percentile = calculateRelativeCardPriority(docPrioritizedCardInfo, topMissedInDoc.remId);

          status.doc = {
            absolute: topMissedInDoc.priority,
            // Step 2: Use the result with the correct fallback logic.
            percentile: percentile === null ? 100 : percentile,
          };
        }
      }
    }
  }

  return status;
}