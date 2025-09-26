import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import {
  allIncrementalRemKey,
  currentScopeRemIdsKey,
  seenRemInSessionKey,
} from './consts';
import { IncrementalRem } from './types';
import { calculateRelativePriority } from './priority';
import * as _ from 'remeda';

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

// vvv CHANGED: The function now accepts an optional currentRemId vvv
export async function calculatePriorityShield(
  plugin: RNPlugin,
  currentRemId?: RemId
): Promise<PriorityShieldStatus> {
// ^^^ CHANGED ^^^
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

  // vvv CHANGED: The filter now includes the currentRemId, even if it's marked as "seen" vvv
  const unreviewedDueRems = allRems.filter(
    (rem) =>
      (Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)) ||
      rem.remId === currentRemId
  );
  // ^^^ CHANGED ^^^

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
      // vvv CHANGED: The filter for the document scope is also updated vvv
      const unreviewedDueInScope = scopedRems.filter(
        (rem) =>
          (Date.now() >= rem.nextRepDate && !seenRemIds.includes(rem.remId)) ||
          rem.remId === currentRemId
      );
      // ^^^ CHANGED ^^^

      const topMissedInDoc = _.minBy(unreviewedDueInScope, (rem) => rem.priority);
      if (topMissedInDoc) {
        status.doc.absolute = topMissedInDoc.priority;
        status.doc.percentile = calculateRelativePriority(scopedRems, topMissedInDoc.remId);
      }
    }
  }

  return status;
}