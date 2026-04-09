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
 * Calculates a "volume-aware" percentile rank for a priority shield.
 * Unlike standard percentile which depends on the exact position of a specific item,
 * this calculation treats all items with the same priority as a block.
 *
 * The rank is calculated as:
 * Rank = (Count of Higher Priority Items) + (Count of Non-Due Items with Same Priority)
 *
 * This ensures that as you complete items with the *same* priority, the shield naturally moves up.
 *
 * @param allItems The full list of items in the universe (KB or Doc scope).
 * @param topMissedPriority The priority value of the "top missed" item (the shield's current level).
 * @param isDuePredicate A function to determine if an item is currently "due" (unreviewed).
 * @returns A number from 1-100 representing the completion progress.
 */
export function calculateVolumeBasedPercentile<T extends { priority: number }>(
  allItems: T[],
  topMissedPriority: number,
  isDuePredicate: (item: T) => boolean
): number {
  if (!allItems || allItems.length === 0) {
    return 100; // Empty universe is considered complete/100%
  }

  // Pre-filter: Ignore rems that explicitly have 0 cards (e.g. Disabled Cards)
  // so they don't artificially inflate the completion metric.
  const validItems = allItems.filter((item: any) => item.cardCount === undefined || item.cardCount > 0);

  if (validItems.length === 0) {
    return 100;
  }

  // 1. Count items with strictly higher priority (lower priority value number)
  const higherPriorityCount = validItems.filter((x) => x.priority < topMissedPriority).length;

  // 2. Count items with the SAME priority that are ALREADY PROCESSED (not due)
  const samePriorityProcessedCount = validItems.filter(
    (x) => x.priority === topMissedPriority && !isDuePredicate(x)
  ).length;

  const currentRank = higherPriorityCount + samePriorityProcessedCount;
  const percentile = (currentRank / validItems.length) * 100;

  // Round to 1 decimal place
  return Math.round(percentile * 10) / 10;
}

/**
 * Calculates a weighted priority completion metric across all items.
 *
 * The metric represents "what fraction of the total priority weight has been processed",
 * using exponential decay W(p) = e^(-k * p/100) with k ≈ 2.3026 so that
 * a 0-percentile item weighs ~10× a 100-percentile item.
 *
 * Shield = (processedWeight / totalWeight) × 100
 *
 * This ALWAYS increases as items are processed, with bigger jumps for
 * high-priority items. 100 = fully processed, 0 = nothing processed.
 *
 * @param allItems Full universe of items (KB or doc scope).
 * @param isDuePredicate Returns true if the item is due and unreviewed.
 * @returns Weighted completion percentage (0–100), or 100 if no items / no due items.
 */
export function calculateWeightedShield<T extends { priority: number; remId: string }>(
  allItems: T[],
  isDuePredicate: (item: T) => boolean
): number {
  if (!allItems || allItems.length === 0) return 100;

  // Pre-filter: Ignore rems that explicitly have 0 cards
  const validItems = allItems.filter((item: any) => item.cardCount === undefined || item.cardCount > 0);
  if (validItems.length === 0) return 100;

  // 1. Sort by priority to compute each item's percentile rank
  const sorted = [...validItems].sort((a, b) => a.priority - b.priority);
  const percentileMap = new Map<string, number>();
  sorted.forEach((item, idx) => {
    percentileMap.set(item.remId, ((idx + 1) / sorted.length) * 100);
  });

  // 2. Compute total weight and due (unprocessed) weight
  // k = ln(10) ≈ 2.3026 → a 0% item weighs 10× more than a 100% item
  const k = 2.3026;
  let totalWeight = 0;
  let dueWeight = 0;

  for (const item of validItems) {
    const p = percentileMap.get(item.remId) ?? 50;
    const weight = Math.exp(-k * p / 100);
    totalWeight += weight;

    if (isDuePredicate(item)) {
      dueWeight += weight;
    }
  }

  if (totalWeight === 0) return 100;

  // Shield = fraction of total weight that's been processed
  const processedFraction = (totalWeight - dueWeight) / totalWeight;
  const result = processedFraction * 100;
  return Math.round(result * 10) / 10; // 1 decimal
}

/**
 * A single bucket in the weighted shield breakdown (e.g. 0-10%, 10-20%, ...).
 */
export interface WeightedShieldBucket {
  /** e.g. "0-10%" */
  label: string;
  /** e.g. "0-5" */
  priorityRange: string;
  /** Total items in this bucket */
  total: number;
  /** Items processed (not due) in this bucket */
  processed: number;
  /** Items due (unprocessed) in this bucket */
  due: number;
  /** Percentage of items processed (0-100) */
  processedPct: number;
  /** Mean exponential weight of items in this bucket */
  meanWeight: number;
  /** This bucket's share of total weight (0-100%) */
  weightShare: number;
}

/**
 * Full breakdown data for the weighted shield tooltip/popup.
 */
export interface WeightedShieldBreakdown {
  /** Total items in the universe */
  totalItems: number;
  /** Total due (unprocessed) items */
  dueItems: number;
  /** Percentage of items that are due */
  duePct: number;
  /** The weighted shield value (0-100) */
  shieldValue: number;
  /** Total exponential weight of all items */
  totalWeight: number;
  /** Total exponential weight of due items */
  dueWeight: number;
  /** Weighted processing fraction (same as shieldValue, for display) */
  processedWeightPct: number;
  /** 10 buckets of percentile ranges */
  buckets: WeightedShieldBucket[];
}

/**
 * Computes a detailed breakdown of the weighted shield for display in a tooltip.
 * Divides items into 10 percentile buckets and computes per-bucket processing stats.
 *
 * @param allItems Full universe of items (KB or doc scope).
 * @param isDuePredicate Returns true if the item is due and unreviewed.
 * @returns Detailed breakdown including buckets, totals, and weights.
 */
export function computeWeightedShieldBreakdown<T extends { priority: number; remId: string }>(
  allItems: T[],
  isDuePredicate: (item: T) => boolean
): WeightedShieldBreakdown {
  const k = 2.3026;

  // Pre-filter: Ignore rems that explicitly have 0 cards
  const validItems = allItems.filter((item: any) => item.cardCount === undefined || item.cardCount > 0);

  // Sort and compute percentiles
  const sorted = [...validItems].sort((a, b) => a.priority - b.priority);
  const percentileMap = new Map<string, number>();
  sorted.forEach((item, idx) => {
    percentileMap.set(item.remId, ((idx + 1) / sorted.length) * 100);
  });

  // Initialize 10 buckets
  const bucketData: { total: number; processed: number; due: number; weightSum: number; minPriority: number; maxPriority: number }[] =
    Array.from({ length: 10 }, () => ({ total: 0, processed: 0, due: 0, weightSum: 0, minPriority: Infinity, maxPriority: -Infinity }));

  let totalWeight = 0;
  let dueWeight = 0;
  let dueCount = 0;

  for (const item of validItems) {
    const p = percentileMap.get(item.remId) ?? 50;
    const weight = Math.exp(-k * p / 100);
    const bucketIdx = Math.min(Math.floor(p / 10), 9); // 0-9
    const isDue = isDuePredicate(item);

    totalWeight += weight;
    bucketData[bucketIdx].total++;
    bucketData[bucketIdx].weightSum += weight;
    bucketData[bucketIdx].minPriority = Math.min(bucketData[bucketIdx].minPriority, item.priority);
    bucketData[bucketIdx].maxPriority = Math.max(bucketData[bucketIdx].maxPriority, item.priority);

    if (isDue) {
      dueWeight += weight;
      dueCount++;
      bucketData[bucketIdx].due++;
    } else {
      bucketData[bucketIdx].processed++;
    }
  }

  const shieldValue = totalWeight > 0
    ? Math.round(((totalWeight - dueWeight) / totalWeight) * 1000) / 10
    : 100;

  const buckets: WeightedShieldBucket[] = bucketData.map((b, i) => ({
    label: `${i * 10}-${(i + 1) * 10}%`,
    priorityRange: b.total > 0 ? `${b.minPriority}-${b.maxPriority}` : '—',
    total: b.total,
    processed: b.processed,
    due: b.due,
    processedPct: b.total > 0 ? Math.round((b.processed / b.total) * 1000) / 10 : 100,
    meanWeight: b.total > 0 ? Math.round((b.weightSum / b.total) * 1000) / 1000 : 0,
    weightShare: totalWeight > 0 ? Math.round((b.weightSum / totalWeight) * 1000) / 10 : 0,
  }));

  return {
    totalItems: validItems.length,
    dueItems: dueCount,
    duePct: validItems.length > 0 ? Math.round((dueCount / validItems.length) * 1000) / 10 : 0,
    shieldValue,
    totalWeight: Math.round(totalWeight * 100) / 100,
    dueWeight: Math.round(dueWeight * 100) / 100,
    processedWeightPct: shieldValue,
    buckets,
  };
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

/**
 * Format a relative time based on date passing.
 */
export function formatTimeAgo(timestampMs: number, nowMs: number = Date.now()): string {
  const isFuture = timestampMs > nowMs;
  const diffMs = Math.abs(timestampMs - nowMs);
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffMonths = Math.floor(diffDays / 30.436875); /* Average days per month */
  const diffYears = Math.floor(diffDays / 365.25);

  let formatted = '';

  if (diffYears > 0) {
    formatted = `${diffYears} year${diffYears > 1 ? 's' : ''}`;
  } else if (diffMonths > 0) {
    formatted = `${diffMonths} month${diffMonths > 1 ? 's' : ''}`;
  } else if (diffDays > 0) {
    formatted = `${diffDays} day${diffDays > 1 ? 's' : ''}`;
  } else if (diffHours > 0) {
    formatted = `${diffHours} hour${diffHours > 1 ? 's' : ''}`;
  } else if (diffMinutes > 0) {
    formatted = `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''}`;
  } else {
    formatted = `${diffSeconds} second${diffSeconds !== 1 ? 's' : ''}`;
  }

  return isFuture ? `in ${formatted}` : `${formatted} ago`;
}

/**
 * Format FSRS stability (in days) as a friendly human-readable string.
 * Examples: 0.3d, 5d, 3.5m, 2y, 1.2y
 */
export function formatStabilityDays(days: number): string {
  if (days < 30) return `${days.toFixed(1)}d`;
  if (days < 365) return `${(days / 30.44).toFixed(1)}m`;
  return `${(days / 365.25).toFixed(1)}y`;
}

/**
 * Converts a retrievability score (0-1) into an HSL color string gradient.
 * 100% maps to green (~120 deg).
 * 70% maps to red (0 deg).
 * Below 70% remains red.
 */
export function getRetrievabilityColor(r: number): string {
  if (r <= 0.70) return 'var(--rn-clr-red, #ef4444)';
  const clampedR = Math.min(1.0, r);
  const hue = Math.round(((clampedR - 0.70) / 0.30) * 120);
  return `hsl(${hue}, 80%, 45%)`;
}
