import { RemId } from '@remnote/plugin-sdk';
import * as _ from 'remeda';
import { IncrementalRem } from './incremental_rem';

/**
 * Calculates the percentile rank of a Rem's priority within a list.
 * @param allItems The list of Rems to rank against.
 * @param currentRemId The ID of the Rem to find the rank for.
 * @returns A number from 1-100, or null if the Rem isn't in the list.
 */
export function calculateRelativePriority(
  allItems: IncrementalRem[],
  currentRemId: RemId
): number | null {
  if (!allItems || allItems.length === 0) {
    return null;
  }

  // 1. Sort the entire list by priority number, ascending.
  const sortedItems = _.sortBy(allItems, (x) => x.priority);

  // 2. Find the 0-based index of the current Rem in the sorted list.
  const index = sortedItems.findIndex((x) => x.remId === currentRemId);

  if (index === -1) {
    return null;
  }

  // 3. Calculate the percentile.
  const percentile = Math.round(((index + 1) / sortedItems.length) * 100);
  
  return percentile;
}