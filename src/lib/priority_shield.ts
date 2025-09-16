import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import {
  allIncrementalRemKey,
  currentScopeRemIdsKey,
  seenRemInSessionKey,
} from './consts';
import { IncrementalRem } from './types';
import { calculateRelativePriority } from './priority';
import * as _ from 'remeda';

// vvv CHANGED: The interface is now structured to hold separate data for KB and Document. vvv
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
// ^^^ CHANGED ^^^

export async function calculatePriorityShield(
  plugin: RNPlugin
): Promise<PriorityShieldStatus> {
  // Initialize with a "perfect" status
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
    (rem) => Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)
  );

  if (unreviewedDueRems.length === 0) {
    return status; // Return the "perfect" status if all due Rems are reviewed.
  }

  // 1. Calculate for the entire Knowledge Base (KB)
  const topMissedInKb = _.minBy(unreviewedDueRems, (rem) => rem.priority);
  if (topMissedInKb) {
    status.kb.absolute = topMissedInKb.priority;
    status.kb.percentile = calculateRelativePriority(allRems, topMissedInKb.remId);
  }

  // 2. Calculate for the current Document scope (if it exists)
  if (docScopeRemIds && docScopeRemIds.length > 0) {
    const scopedRems = allRems.filter((rem) => docScopeRemIds.includes(rem.remId));

    if (scopedRems.length > 0) {
      const unreviewedDueInScope = scopedRems.filter(
        (rem) => Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)
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