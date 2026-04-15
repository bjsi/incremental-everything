import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import {
  allIncrementalRemKey,
  seenRemInSessionKey,
  currentSubQueueIdKey,
  powerupCode,
  nextRepDateSlotCode,
} from './consts';
import { IncrementalRem } from './incremental_rem';
import { calculateVolumeBasedPercentile } from './utils';
import * as _ from 'remeda';

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

// --- calculatePriorityShield for Incremental Rems ---

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
