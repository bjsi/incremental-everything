import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import * as _ from 'remeda';
import { IncrementalRem } from './incremental_rem';

export const tryParseJson = (x: any) => {
  try {
    return JSON.parse(x);
  } catch (e) {
    return undefined;
  }
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getDailyDocReferenceForDate(plugin: RNPlugin, date: Date) {
  const dailyDoc = await plugin.date.getDailyDoc(date);
  if (!dailyDoc) {
    return;
  }
  const dateRef = await plugin.richText.rem(dailyDoc).value();
  return dateRef;
}

/**
 * Converts a percentile (1-100) into an HSL color string.
 * Lower percentiles (higher priority) are mapped to red/orange (hue ~0).
 * Higher percentiles (lower priority) are mapped to green/blue (hue ~240).
 * @param percentile A number from 1 to 100.
 * @returns An HSL color string (e.g., "hsl(120, 80%, 55%)").
 */
export function percentileToHslColor(percentile: number): string {
  const roundedPercentile = Math.round(percentile);
  const clampedPercentile = Math.max(1, Math.min(100, roundedPercentile));
  const hue = (clampedPercentile / 100) * 240;
  const saturation = '80%';
  const lightness = '55%';

  return `hsl(${hue}, ${saturation}, ${lightness})`;
}

/**
 * Calculates the percentile rank of an item's priority within a list.
 * Generic function that works with any type that has priority and remId properties.
 * @param allItems The list of items to rank against.
 * @param currentRemId The ID of the item to find the rank for.
 * @returns A number from 1-100 (rounded to 1 decimal), or null if the item isn't in the list.
 */
export function calculateRelativePercentile<T extends { priority: number; remId: string }>(
  allItems: T[],
  currentRemId: RemId
): number | null {
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
