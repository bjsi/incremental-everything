import { ReactRNPlugin, RemId } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import * as _ from 'remeda';
import { calculateVolumeBasedPercentile } from './utils';
import { IncrementalRem } from './incremental_rem';
import { CardPriorityInfo } from './card_priority';

export type ShieldHistoryEntry = {
  absolute: number | null;
  percentile: number | null;
  universeSize: number;
};

export type ShieldHistory = Record<string, ShieldHistoryEntry>;
export type ShieldHistoryByScope = Record<string, ShieldHistory>;

/**
 * Generic item that can be used for shield history calculations.
 * Can represent either an IncrementalRem or CardPriorityInfo.
 */
type PriorityItem = {
  remId: RemId;
  priority: number;
};

/**
 * Filters items to find those that are due and unreviewed.
 *
 * @param items All items to filter
 * @param isDue Function to determine if an item is due
 * @param seenIds Set of IDs that have been seen/reviewed
 * @returns Array of unreviewed due items
 */
function filterUnreviewedDue<T extends PriorityItem>(
  items: T[],
  isDue: (item: T) => boolean,
  seenIds: string[]
): T[] {
  return items.filter(item => isDue(item) && !seenIds.includes(item.remId));
}

/**
 * Calculates the final shield status for a set of items.
 *
 * @param allItems All items in the universe
 * @param unreviewedDue Items that are due but unreviewed
 * @returns Shield history entry with absolute priority, percentile, and universe size
 */
function calculateShieldStatus<T extends PriorityItem>(
  allItems: T[],
  unreviewedDue: T[],
  isDue: (item: T) => boolean,
  seenIds: string[]
): ShieldHistoryEntry {
  const status: ShieldHistoryEntry = {
    absolute: null,
    percentile: 100,
    universeSize: allItems.length,
  };

  if (unreviewedDue.length > 0) {
    const topMissed = _.minBy(unreviewedDue, item => item.priority);
    if (topMissed) {
      status.absolute = topMissed.priority;
      status.percentile = calculateVolumeBasedPercentile(
        allItems,
        topMissed.priority,
        (item) => isDue(item) && !seenIds.includes(item.remId)
      );
    }
  }

  return status;
}

/**
 * Helper to get the current KB ID.
 */
async function getCurrentKbId(plugin: ReactRNPlugin): Promise<string> {
  const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
  return kbData?._id || 'global';
}

/**
 * Migrates legacy history (date -> entry) to KB-aware history (kbId -> date -> entry).
 * Only migrates if the current KB is the Primary Knowledge Base.
 */
async function migrateToKbAware<T>(
  plugin: ReactRNPlugin,
  history: any,
  currentKbId: string
): Promise<Record<string, Record<string, T>>> {
  if (!history) return {};

  // Check if it's already KB-aware (keys are NOT dates/likely KB IDs, or empty)
  const keys = Object.keys(history);
  if (keys.length === 0) return {};

  const isLegacy = keys.some(k => /^\d{4}-\d{2}-\d{2}$/.test(k));

  if (isLegacy) {
    const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
    if (isPrimary) {
      console.log('[ShieldHistory] Primary KB detected. Migrating legacy history to:', currentKbId);
      return {
        [currentKbId]: history
      };
    } else {
      console.log('[ShieldHistory] Non-primary KB. Skipping legacy migration to preserve for Main KB.');
      return history;
    }
  }

  return history;
}

/**
 * Saves shield history to storage (KB-aware).
 *
 * @param plugin Plugin instance
 * @param storageKey Key to store the history under
 * @param historyEntry Entry to save
 * @param date Date string (YYYY-MM-DD format)
 */
async function saveKBShieldHistory(
  plugin: ReactRNPlugin,
  storageKey: string,
  historyEntry: ShieldHistoryEntry,
  date: string
): Promise<void> {
  let rawHistory = (await plugin.storage.getSynced<any>(storageKey)) || {};
  const kbId = await getCurrentKbId(plugin);

  const keys = Object.keys(rawHistory);
  const isLegacy = keys.some(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
  let history = rawHistory;

  if (isLegacy) {
    const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
    if (isPrimary) {
      console.log('[ShieldHistory] Primary KB detected. Migrating legacy keys to:', kbId);
      const newHistory: Record<string, any> = {};
      const legacyEntries: Record<string, any> = {};

      for (const key of keys) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
          legacyEntries[key] = rawHistory[key];
        } else {
          newHistory[key] = rawHistory[key];
        }
      }

      newHistory[kbId] = { ...(newHistory[kbId] || {}), ...legacyEntries };
      history = newHistory;
    } else {
      console.log('[ShieldHistory] Non-primary KB. Keeping legacy keys at root.');
    }
  }

  if (!history[kbId]) {
    history[kbId] = {};
  }
  history[kbId][date] = historyEntry;

  await plugin.storage.setSynced(storageKey, history);
}

/**
 * Saves scoped shield history to storage (KB-aware).
 *
 * @param plugin Plugin instance
 * @param storageKey Key to store the history under
 * @param scopeKey Scope identifier (remId)
 * @param historyEntry Entry to save
 * @param date Date string (YYYY-MM-DD format)
 */
async function saveScopedShieldHistory(
  plugin: ReactRNPlugin,
  storageKey: string,
  scopeKey: string,
  historyEntry: ShieldHistoryEntry,
  date: string
): Promise<void> {
  let rawHistory = (await plugin.storage.getSynced<any>(storageKey)) || {};
  const kbId = await getCurrentKbId(plugin);

  const keys = Object.keys(rawHistory);
  let isLegacy = false;

  if (keys.length > 0) {
    const firstValue = rawHistory[keys[0]];
    const dateKeys = Object.keys(firstValue || {});
    if (dateKeys.some(k => /^\d{4}-\d{2}-\d{2}$/.test(k))) {
      isLegacy = true;
    }
  }

  if (isLegacy) {
    const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
    if (isPrimary) {
      console.log('[ShieldHistory] Primary KB detected. Migrating legacy scoped history to:', kbId);

      const newHistory: Record<string, any> = {};
      const legacyEntries: Record<string, any> = {};

      for (const key of keys) {
        const val = rawHistory[key];
        const subKeys = Object.keys(val || {});
        if (subKeys.some(k => /^\d{4}-\d{2}-\d{2}$/.test(k))) {
          legacyEntries[key] = val;
        } else {
          newHistory[key] = val;
        }
      }

      newHistory[kbId] = { ...(newHistory[kbId] || {}), ...legacyEntries };
      rawHistory = newHistory;

    } else {
      console.log('[ShieldHistory] Non-primary KB. Keeping legacy scoped history at root.');
    }
  }

  if (!rawHistory[kbId]) {
    rawHistory[kbId] = {};
  }
  if (!rawHistory[kbId][scopeKey]) {
    rawHistory[kbId][scopeKey] = {};
  }

  rawHistory[kbId][scopeKey][date] = historyEntry;
  await plugin.storage.setSynced(storageKey, rawHistory);
}

/**
 * Calculates and saves KB-level shield history for any item type.
 *
 * @param plugin Plugin instance
 * @param allItems All items in the knowledge base
 * @param isDue Function to determine if an item is due
 * @param seenIds IDs that have been seen in this session
 * @param storageKey Storage key for this type's history
 * @param label Label for logging (e.g., "IncRem" or "Card")
 */
export async function saveKBShield<T extends PriorityItem>(
  plugin: ReactRNPlugin,
  allItems: T[],
  isDue: (item: T) => boolean,
  seenIds: string[],
  storageKey: string,
  label: string
): Promise<void> {
  if (allItems.length === 0) {
    console.log(`[QueueExit] No ${label} items found, skipping KB shield save`);
    return;
  }

  const today = dayjs().format('YYYY-MM-DD');
  const unreviewedDue = filterUnreviewedDue(allItems, isDue, seenIds);
  const status = calculateShieldStatus(allItems, unreviewedDue, isDue, seenIds);

  await saveKBShieldHistory(plugin, storageKey, status, today);
  console.log(`[QueueExit] Saved KB ${label} shield:`, status);
}

/**
 * Calculates and saves document-level shield history for any item type.
 *
 * @param plugin Plugin instance
 * @param allItems All items in the knowledge base
 * @param scopeRemIds RemIds that define the document scope
 * @param isDue Function to determine if an item is due
 * @param seenIds IDs that have been seen in this session
 * @param storageKey Storage key for this type's scoped history
 * @param historyKey Key to identify this specific scope in history
 * @param label Label for logging (e.g., "IncRem" or "Card")
 */
export async function saveDocumentShield<T extends PriorityItem>(
  plugin: ReactRNPlugin,
  allItems: T[],
  scopeRemIds: RemId[],
  isDue: (item: T) => boolean,
  seenIds: string[],
  storageKey: string,
  historyKey: string,
  label: string
): Promise<void> {
  if (!scopeRemIds || scopeRemIds.length === 0) {
    console.log(`[QueueExit] No scope RemIds found, skipping ${label} document shield save`);
    return;
  }

  console.log(`[QueueExit] Processing ${label} document shield with PRIORITY CALC scope:`, scopeRemIds.length, 'rems');

  const scopeSet = new Set(scopeRemIds);
  const scopedItems = allItems.filter(item => scopeSet.has(item.remId));
  console.log(`[QueueExit] Found ${scopedItems.length} ${label} items in priority calculation scope`);

  const unreviewedDueInScope = filterUnreviewedDue(scopedItems, isDue, seenIds);
  console.log(`[QueueExit] Found ${unreviewedDueInScope.length} due ${label} items in priority calculation scope`);

  const today = dayjs().format('YYYY-MM-DD');
  const status = calculateShieldStatus(scopedItems, unreviewedDueInScope, isDue, seenIds);

  await saveScopedShieldHistory(plugin, storageKey, historyKey, status, today);
  console.log(
    `[QueueExit] ${label} doc shield - Priority: ${status.absolute}, ` +
    `Percentile: ${status.percentile}%, Universe: ${status.universeSize}`
  );
  console.log(`Saved ${label} document history for original scope ${historyKey}:`, status);
}

/**
 * Helper type guards and isDue functions for IncrementalRem and CardPriorityInfo
 */
export const isIncRemDue = (rem: IncrementalRem): boolean => Date.now() >= rem.nextRepDate;
export const isCardDue = (card: CardPriorityInfo): boolean => card.dueCards > 0;
