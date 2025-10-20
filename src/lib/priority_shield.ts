import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import {
  allIncrementalRemKey,
  currentScopeRemIdsKey,
  seenRemInSessionKey,
  currentSubQueueIdKey,
  seenCardInSessionKey,
  powerupCode,
  nextRepDateSlotCode,
} from './consts';
import { IncrementalRem } from './types';
import { calculateRelativePriority } from './priority';
import * as _ from 'remeda';
import { CardPriorityInfo } from './cardPriority';

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
  const unreviewedDueKb = allPrioritizedCardInfo.filter(
    (info) => info.dueCards > 0 && (!seenRemIds.includes(info.remId) || info.remId === currentRemId)
  );

  if (unreviewedDueKb.length > 0) {
    const topMissedInKb = _.minBy(unreviewedDueKb, (info) => info.priority);
    if (topMissedInKb) {
      const percentile = calculateRelativeCardPriority(allPrioritizedCardInfo, topMissedInKb.remId);
      
      status.kb = {
        absolute: topMissedInKb.priority,
        percentile: percentile === null ? 100 : percentile,
      };
    }
  }

  // 2. Calculate the Document Shield with COMPREHENSIVE SCOPE
  // --- NEW: Use originalScopeId if available (for Priority Review Documents) ---
  const subQueueId = await plugin.storage.getSession<string | null>(currentSubQueueIdKey);
  const originalScopeId = await plugin.storage.getSession<string | null>('originalScopeId');
  
  // Use originalScopeId if it exists (Priority Review Document case), otherwise use subQueueId
  const effectiveScopeId = originalScopeId || subQueueId;
  
  if (effectiveScopeId) {
    const scopeRem = await plugin.rem.findOne(effectiveScopeId);
    if (scopeRem) {
      console.log('[CardPriorityShield] Building comprehensive document scope...');
      
      if (originalScopeId) {
        console.log('[CardPriorityShield] Using original scope from Priority Review Document:', originalScopeId);
      }
      
      // --- COMPREHENSIVE SCOPE CALCULATION (same as before) ---
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
      
      const scopeRemIds = new Set<RemId>([
        scopeRem._id,
        ...descendants.map(r => r._id),
        ...allRemsInContext.map(r => r._id),
        ...folderQueueRems.map(r => r._id),
        ...sources.map(r => r._id),
        ...referencingRems
      ]);
      
      console.log(`[CardPriorityShield] Comprehensive scope: ${scopeRemIds.size} rems`);
      console.log(`[CardPriorityShield]  - Descendants: ${descendants.length}`);
      console.log(`[CardPriorityShield]  - Document/portal: ${allRemsInContext.length}`);
      console.log(`[CardPriorityShield]  - Folder queue: ${folderQueueRems.length}`);
      console.log(`[CardPriorityShield]  - Sources: ${sources.length}`);
      console.log(`[CardPriorityShield]  - References: ${referencingRems.length}`);
      
      // Filter the main cache to get only the cards in the current document scope.
      const docPrioritizedCardInfo = allPrioritizedCardInfo.filter(info => scopeRemIds.has(info.remId));
      
      // Now find unreviewed due cards within this smaller, document-scoped list.
      const unreviewedDueDoc = docPrioritizedCardInfo.filter(
        (info) => info.dueCards > 0 && (!seenRemIds.includes(info.remId) || info.remId === currentRemId)
      );

      if (unreviewedDueDoc.length > 0) {
        const topMissedInDoc = _.minBy(unreviewedDueDoc, (info) => info.priority);
        if (topMissedInDoc) {
          const percentile = calculateRelativeCardPriority(docPrioritizedCardInfo, topMissedInDoc.remId);

          status.doc = {
            absolute: topMissedInDoc.priority,
            percentile: percentile === null ? 100 : percentile,
          };
        }
      }
    }
  }

  return status;
}

// --- SIMILARLY UPDATE calculatePriorityShield for Incremental Rems ---

export async function calculatePriorityShield(
  plugin: RNPlugin,
  currentRemId?: RemId
): Promise<PriorityShieldStatus> {
  const status: PriorityShieldStatus = {
    kb: { absolute: null, percentile: null },
    doc: { absolute: null, percentile: null },
  };

  const allRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
  const seenRemIds = (await plugin.storage.getSession<RemId[]>(seenRemInSessionKey)) || [];
  
  // --- NEW: Use originalScopeId if available (for Priority Review Documents) ---
  const subQueueId = await plugin.storage.getSession<string | null>(currentSubQueueIdKey);
  const originalScopeId = await plugin.storage.getSession<string | null>('originalScopeId');
  const effectiveScopeId = originalScopeId || subQueueId;
  
  // --- MODIFIED: Get docScopeRemIds based on effective scope ---
  // Note: The currentScopeRemIdsKey might contain the item selection scope for Priority Review Documents
  // For priority shield calculations, we need to use the original document scope
  let docScopeRemIds: RemId[] | null = null;
  
  if (effectiveScopeId) {
    // If we have an effectiveScopeId, we should recalculate the comprehensive scope
    // to ensure it matches the original document, not the Priority Review Document
    const scopeRem = await plugin.rem.findOne(effectiveScopeId);
    if (scopeRem) {
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
      
      const scopeRemIds = new Set<RemId>([
        scopeRem._id,
        ...descendants.map(r => r._id),
        ...allRemsInContext.map(r => r._id),
        ...folderQueueRems.map(r => r._id),
        ...sources.map(r => r._id),
        ...referencingRems
      ]);
      
      docScopeRemIds = Array.from(scopeRemIds);
      
      if (originalScopeId) {
        console.log('[PriorityShield] Using original scope from Priority Review Document:', originalScopeId);
      }
    }
  }

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