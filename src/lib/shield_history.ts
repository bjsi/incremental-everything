import { ReactRNPlugin, RNPlugin, RemId } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import * as _ from 'remeda';
import { calculateVolumeBasedPercentile, calculateWeightedShield } from './utils';
import { IncrementalRem } from './incremental_rem';
import { CardPriorityInfo } from './card_priority';
import { dismissedPowerupCode } from './consts';

export type ShieldHistoryEntry = {
  absolute: number | null;
  percentile: number | null;
  universeSize: number;
  dismissedCount?: number;
  weightedShield?: number | null;
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

/** Options for live verification of the top-missed rem at QueueExit. */
export type VerifyOptions<T extends PriorityItem> = {
  /** Called once per candidate rem; should return its current cards. */
  getCards: (item: T) => Promise<{ nextRepetitionTime?: number }[]>;
  /** Timestamp threshold — cards due at or before this count as overdue (e.g. startOfToday). */
  dueThreshold: number;
};

/**
 * Verify the top-priority missed rem from the candidate list using live API calls.
 *
 * Groups candidates by priority level and checks every rem in the top group.
 * If all are stale, escalates to the next priority level.
 * Caps total getCards() calls at MAX_SHIELD_VERIFY_CALLS (20).
 *
 * @param plugin Plugin instance (used only for rem.findOne ghost checks)
 * @param candidates Pre-filtered, unreviewed due items sorted by ascending priority
 * @param verifyOptions getCards callback and dueThreshold timestamp
 * @param label Label for logging (e.g. 'KB' or 'Doc')
 */
async function verifyTopMissedByPriorityLevel<T extends PriorityItem>(
  plugin: RNPlugin,
  candidates: T[],
  verifyOptions: VerifyOptions<T>,
  label: string
): Promise<T | undefined> {
  const MAX_VERIFY_CALLS = 20;
  const { getCards, dueThreshold } = verifyOptions;
  const sorted = _.sortBy(candidates, (item) => item.priority);
  let totalChecks = 0;
  let idx = 0;

  while (idx < sorted.length && totalChecks < MAX_VERIFY_CALLS) {
    const currentPriority = sorted[idx].priority;

    // Collect all candidates at this priority level
    const group: T[] = [];
    while (idx < sorted.length && sorted[idx].priority === currentPriority) {
      group.push(sorted[idx]);
      idx++;
    }

    let staleCount = 0;
    for (const candidate of group) {
      if (totalChecks >= MAX_VERIFY_CALLS) {
        console.warn(`[ShieldVerify] ${label}: Hit verification cap (${MAX_VERIFY_CALLS}) at priority ${currentPriority}. Trusting remaining cache.`);
        return candidate;
      }

      let cards: { nextRepetitionTime?: number }[];
      try {
        cards = await getCards(candidate);
      } catch {
        totalChecks++;
        staleCount++;
        continue;
      }
      totalChecks++;

      const actualDue = cards.filter(c => (c.nextRepetitionTime ?? Infinity) <= dueThreshold).length;
      if (actualDue > 0) {
        if (staleCount > 0) {
          console.log(`[ShieldVerify] ✅ ${label} verified at priority ${currentPriority} after skipping ${staleCount} stale entries.`);
        }
        return candidate;
      } else {
        console.warn(`[ShieldVerify] ⚠️ ${label} Stale: rem ${candidate.remId} (priority ${currentPriority}) has no overdue cards.`);
        staleCount++;
      }
    }

    console.log(`[ShieldVerify] ${label}: All ${group.length} entries at priority ${currentPriority} are stale. Escalating...`);
  }

  return undefined;
}

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
 * @param plugin Plugin instance (required when verifyOptions is provided, else null)
 * @param allItems All items in the universe
 * @param unreviewedDue Items that are due but unreviewed
 * @param isDue Predicate to determine if an item is still due
 * @param seenIds IDs reviewed in this session
 * @param dismissedCount Global dismissed count
 * @param computeWeighted Whether to compute weighted shield
 * @param verifyOptions When provided, the top-missed rem is confirmed via live API calls
 */
async function calculateShieldStatus<T extends PriorityItem>(
  plugin: RNPlugin | null,
  allItems: T[],
  unreviewedDue: T[],
  isDue: (item: T) => boolean,
  seenIds: string[],
  dismissedCount: number = 0,
  computeWeighted: boolean = false,
  verifyOptions?: VerifyOptions<T>
): Promise<ShieldHistoryEntry> {
  const status: ShieldHistoryEntry = {
    absolute: null,
    percentile: 100,
    universeSize: allItems.length,
    dismissedCount,
  };

  if (unreviewedDue.length > 0) {
    let topMissed = _.minBy(unreviewedDue, item => item.priority);

    // Optional live verification: confirm the cache-derived top candidate is truly overdue.
    if (topMissed && verifyOptions && plugin) {
      topMissed = await verifyTopMissedByPriorityLevel(plugin, unreviewedDue, verifyOptions, 'Shield') ?? topMissed;
    }

    if (topMissed) {
      status.absolute = topMissed.priority;
      status.percentile = calculateVolumeBasedPercentile(
        allItems,
        topMissed.priority,
        (item) => isDue(item) && !seenIds.includes(item.remId)
      );
    }
  }

  if (computeWeighted) {
    status.weightedShield = calculateWeightedShield(
      allItems as any,
      (item: any) => isDue(item) && !seenIds.includes(item.remId)
    );
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
  label: string,
  computeWeighted: boolean = false,
  verifyOptions?: VerifyOptions<T>
): Promise<void> {
  if (allItems.length === 0) {
    console.log(`[QueueExit] No ${label} items found, skipping KB shield save`);
    return;
  }

  const dismissedPowerup = await plugin.powerup.getPowerupByCode(dismissedPowerupCode);
  const dismissedRems = (await dismissedPowerup?.taggedRem()) || [];
  const dismissedCount = dismissedRems.length;

  const today = dayjs().format('YYYY-MM-DD');
  const unreviewedDue = filterUnreviewedDue(allItems, isDue, seenIds);
  const status = await calculateShieldStatus(plugin, allItems, unreviewedDue, isDue, seenIds, dismissedCount, computeWeighted, verifyOptions);

  await saveKBShieldHistory(plugin, storageKey, status, today);
  const kbTriggerItem = unreviewedDue.find(item => item.priority === status.absolute);
  console.log(`[QueueExit] Saved KB ${label} shield:`, status, `Triggered by remId: ${kbTriggerItem?.remId ?? 'none'}`);
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
  label: string,
  computeWeighted: boolean = false,
  verifyOptions?: VerifyOptions<T>
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

  const dismissedPowerup = await plugin.powerup.getPowerupByCode(dismissedPowerupCode);
  const globalDismissedRems = (await dismissedPowerup?.taggedRem()) || [];
  const scopedDismissedCount = globalDismissedRems.filter(rem => scopeSet.has(rem._id)).length;

  const today = dayjs().format('YYYY-MM-DD');
  const status = await calculateShieldStatus(plugin, scopedItems, unreviewedDueInScope, isDue, seenIds, scopedDismissedCount, computeWeighted, verifyOptions);

  await saveScopedShieldHistory(plugin, storageKey, historyKey, status, today);
  const docTriggerItem = unreviewedDueInScope.find(item => item.priority === status.absolute);
  console.log(
    `[QueueExit] ${label} doc shield - Priority: ${status.absolute}, ` +
    `Percentile: ${status.percentile}%, Universe: ${status.universeSize}, Dismissed: ${scopedDismissedCount}, ` +
    `Triggered by remId: ${docTriggerItem?.remId ?? 'none'}`
  );
  console.log(`Saved ${label} document history for original scope ${historyKey}:`, status);
}

/**
 * Helper type guards and isDue functions for IncrementalRem and CardPriorityInfo
 */
export const isIncRemDue = (rem: IncrementalRem): boolean => Date.now() >= rem.nextRepDate;
export const isCardDue = (card: CardPriorityInfo): boolean => card.dueCards > 0;
/** Shield-specific: card was due before start of today (filters intraday re-scheduling noise). */
export const isCardDueOverdue = (card: CardPriorityInfo): boolean => (card.dueCardsOverdue ?? 0) > 0;
