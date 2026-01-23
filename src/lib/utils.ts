import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import * as _ from 'remeda';

// Performance mode constants
export const PERFORMANCE_MODE_FULL = 'full';
export const PERFORMANCE_MODE_LIGHT = 'light';
export const DEFAULT_PERFORMANCE_MODE = PERFORMANCE_MODE_FULL;
export type PerformanceMode = typeof PERFORMANCE_MODE_FULL | typeof PERFORMANCE_MODE_LIGHT;

/**
 * Gets the current performance mode setting with a default fallback.
 * @param plugin Plugin instance to access settings.
 * @returns The current performance mode ('full' or 'light').
 */
export async function getPerformanceMode(plugin: RNPlugin): Promise<PerformanceMode> {
  return (await plugin.settings.getSetting<PerformanceMode>('performanceMode')) || DEFAULT_PERFORMANCE_MODE;
}

/**
 * Checks if the plugin is running in full performance mode.
 * @param plugin Plugin instance to access settings.
 * @returns True if in full mode, false otherwise.
 */
export async function isFullPerformanceMode(plugin: RNPlugin): Promise<boolean> {
  return (await getPerformanceMode(plugin)) === PERFORMANCE_MODE_FULL;
}

/**
 * Checks if the plugin is running in light performance mode.
 * @param plugin Plugin instance to access settings.
 * @returns True if in light mode, false otherwise.
 */
export async function isLightPerformanceMode(plugin: RNPlugin): Promise<boolean> {
  return (await getPerformanceMode(plugin)) === PERFORMANCE_MODE_LIGHT;
}

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

/**
 * Calculates percentiles for all items in a list at once.
 * More efficient than calling calculateRelativePercentile repeatedly.
 * @param items The list of items to calculate percentiles for.
 * @returns A map of remId to percentile (1-100, rounded to whole number).
 */
export function calculateAllPercentiles<T extends { priority: number; remId: string }>(
  items: T[]
): Record<string, number> {
  if (!items || items.length === 0) {
    return {};
  }

  const sortedItems = _.sortBy(items, (x) => x.priority);
  const percentiles: Record<string, number> = {};

  sortedItems.forEach((item, index) => {
    percentiles[item.remId] = Math.round(((index + 1) / sortedItems.length) * 100);
  });

  return percentiles;
}

/**
 * Format milliseconds into a countdown string (MM:SS).
 * @param ms The number of milliseconds remaining.
 * @returns A formatted string like "2:30" or "0:05".
 */
export function formatCountdown(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Format seconds into a human-readable duration string.
 * @param seconds The number of seconds to format.
 * @returns A formatted string like "5s", "2m 30s", "1h 15m", or empty string if 0.
 */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds === 0) return '';

  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0
      ? `${hours}h ${minutes}m`
      : `${hours}h`;
  }
}

export function timeSince(date: Date) {
  var seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);

  var interval = seconds / 31536000;

  if (interval > 1) {
    return Math.floor(interval) + " years ago";
  }
  interval = seconds / 2592000;
  if (interval > 1) {
    return Math.floor(interval) + " months ago";
  }
  interval = seconds / 86400;
  if (interval > 1) {
    return Math.floor(interval) + "d ago";
  }
  interval = seconds / 3600;
  if (interval > 1) {
    return Math.floor(interval) + "h ago";
  }
  interval = seconds / 60;
  if (interval > 1) {
    return Math.floor(interval) + "m ago";
  }
  return Math.floor(seconds) + "s ago";
}
