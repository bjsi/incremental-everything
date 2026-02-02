import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import {
  allIncrementalRemKey,
  seenRemInSessionKey,
  currentSubQueueIdKey,
  seenCardInSessionKey,
  powerupCode,
  nextRepDateSlotCode,
} from './consts';
import { IncrementalRem } from './incremental_rem';
import { calculateRelativePercentile, calculateVolumeBasedPercentile } from './utils';
import * as _ from 'remeda';
import { CardPriorityInfo } from './card_priority';

export interface PriorityShieldStatus {
  kb: {
    absolute: number | null;
    percentile: number | null;
    universeSize?: number; // NEW: Track total KB IncRems
  };
  doc: {
    absolute: number | null;
    percentile: number | null;
    universeSize?: number; // NEW: Track total doc IncRems
  };
}

export interface CardPriorityShieldStatus {
  kb: {
    absolute: number | null;
    percentile: number | null;
    universeSize?: number;
  } | null;
  doc: {
    absolute: number | null;
    percentile: number | null;
    universeSize?: number;
  } | null;
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
      const percentile = calculateVolumeBasedPercentile(
        allPrioritizedCardInfo,
        topMissedInKb.priority,
        (info) => info.dueCards > 0 && (!seenRemIds.includes(info.remId) || info.remId === currentRemId)
      );

      status.kb = {
        absolute: topMissedInKb.priority,
        percentile: percentile,
        universeSize: allPrioritizedCardInfo.length, // NEW: Track KB universe size
      };
      console.log(`[CardPriorityShield] KB Shield: Priority ${topMissedInKb.priority}, Percentile ${percentile}%, Universe ${allPrioritizedCardInfo.length}`);
    }
  } else if (allPrioritizedCardInfo.length > 0) {
    // Even if no unreviewed due cards, still track universe size
    status.kb = {
      absolute: null,
      percentile: 100,
      universeSize: allPrioritizedCardInfo.length,
    };
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
          const percentile = calculateVolumeBasedPercentile(
            docPrioritizedCardInfo,
            topMissedInDoc.priority,
            (info) => info.dueCards > 0 && (!seenRemIds.includes(info.remId) || info.remId === currentRemId)
          );

          status.doc = {
            absolute: topMissedInDoc.priority,
            percentile: percentile,
            universeSize: docPrioritizedCardInfo.length, // NEW: Track doc universe size
          };
          console.log(`[CardPriorityShield] Doc Shield: Priority ${topMissedInDoc.priority}, Percentile ${percentile}%, Universe ${docPrioritizedCardInfo.length}`);
        }
      } else if (docPrioritizedCardInfo.length > 0) {
        // Even if no unreviewed due cards, still track universe size
        status.doc = {
          absolute: null,
          percentile: 100,
          universeSize: docPrioritizedCardInfo.length,
        };
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
    kb: { absolute: null, percentile: null, universeSize: 0 },
    doc: { absolute: null, percentile: null, universeSize: 0 },
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

  // Track KB universe size
  status.kb.universeSize = allRems.length;

  const unreviewedDueRems = allRems.filter(
    (rem) =>
      (Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)) ||
      rem.remId === currentRemId
  );

  if (unreviewedDueRems.length === 0) {
    // Still return universe size even if no unreviewed due rems
    return status;
  }

  const topMissedInKb = _.minBy(unreviewedDueRems, (rem) => rem.priority);
  if (topMissedInKb) {
    status.kb.absolute = topMissedInKb.priority;
    status.kb.percentile = calculateVolumeBasedPercentile(
      allRems,
      topMissedInKb.priority,
      (rem) => (Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)) || rem.remId === currentRemId
    );
    console.log(`[PriorityShield] KB Shield: Priority ${topMissedInKb.priority}, Percentile ${status.kb.percentile}%, Universe ${allRems.length}`);
  }

  const scopeIds = docScopeRemIds;
  if (scopeIds && scopeIds.length > 0) {
    const scopedRems = allRems.filter((rem) => scopeIds.includes(rem.remId));

    // Track doc universe size
    status.doc.universeSize = scopedRems.length;

    if (scopedRems.length > 0) {
      const unreviewedDueInScope = scopedRems.filter(
        (rem) =>
          (Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)) ||
          rem.remId === currentRemId
      );

      const topMissedInDoc = _.minBy(unreviewedDueInScope, (rem) => rem.priority);
      if (topMissedInDoc) {
        status.doc.absolute = topMissedInDoc.priority;
        status.doc.percentile = calculateVolumeBasedPercentile(
          scopedRems,
          topMissedInDoc.priority,
          (rem) => (Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)) || rem.remId === currentRemId
        );
        console.log(`[PriorityShield] Doc Shield: Priority ${topMissedInDoc.priority}, Percentile ${status.doc.percentile}%, Universe ${scopedRems.length}`);
      }
    }
  }

  return status;
}
