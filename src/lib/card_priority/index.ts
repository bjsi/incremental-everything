import { PluginRem, RNPlugin, RemId } from '@remnote/plugin-sdk';
import { getIncrementalRemFromRem } from '../incremental_rem';
import { findClosestAncestorWithAnyPriority } from '../priority_inheritance';
import {
  allCardPriorityInfoKey,
  powerupCode,
  nextRepDateSlotCode,
} from '../consts';
import {
  CardPriorityInfo,
  PrioritySource,
  CARD_PRIORITY_CODE,
  PRIORITY_SLOT,
  SOURCE_SLOT,
  LAST_UPDATED_SLOT,
} from './types';
import * as _ from 'remeda';

/**
 * Find the closest ancestor with priority (either Incremental or CardPriority)
 * UPDATED: Uses the shared logic from priority_inheritance to ensure
 * Manual Card Priority > Inc Rem Priority > Inherited Card Priority
 */
async function findClosestAncestorWithPriority(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<{ priority: number; source: 'incremental' | 'card' } | null> {
  const result = await findClosestAncestorWithAnyPriority(plugin, rem);

  if (result) {
    return {
      priority: result.priority,
      source: result.sourceType === 'IncRem' ? 'incremental' : 'card'
    };
  }

  return null;
}

/**
 * Get card priority info for a rem.
 * If no priority is set, it checks for inherited priority before returning a default state.
 */
export async function getCardPriority(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<CardPriorityInfo | null> {
  const cards = await rem.getCards();
  const now = Date.now();
  const dueCards = cards.filter((card) => (card.nextRepetitionTime ?? Infinity) <= now).length;

  const priorityValue = await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);

  if (priorityValue) {
    const source = await rem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT);
    const lastUpdated = await rem.getPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT);

    const parsedPriority = parseInt(priorityValue);
    const finalPriority = !isNaN(parsedPriority) ? parsedPriority : 50;

    return {
      remId: rem._id,
      priority: finalPriority,
      source: (source as PrioritySource) || 'default',
      lastUpdated: parseInt(lastUpdated) || now,
      cardCount: cards.length,
      dueCards,
    };
  } else {
    const ancestorPriority = await findClosestAncestorWithPriority(plugin, rem);

    if (ancestorPriority) {
      return {
        remId: rem._id,
        priority: ancestorPriority.priority,
        source: 'inherited' as PrioritySource,
        lastUpdated: 0,
        cardCount: cards.length,
        dueCards,
      };
    }

    const defaultPriority = (await plugin.settings.getSetting<number>('defaultCardPriority')) || 50;
    return {
      remId: rem._id,
      priority: defaultPriority,
      source: 'default' as PrioritySource,
      lastUpdated: 0,
      cardCount: cards.length,
      dueCards,
    };
  }
}

/**
 * Set card priority
 */
export async function setCardPriority(
  plugin: RNPlugin,
  rem: PluginRem,
  priority: number,
  source: PrioritySource,
  knownHasPowerup: boolean = false
): Promise<void> {
  const hasPowerup = knownHasPowerup || (await rem.hasPowerup(CARD_PRIORITY_CODE));
  if (!hasPowerup) {
    await rem.addPowerup(CARD_PRIORITY_CODE);
  }

  // Parallelize the property updates for maximum speed (Fire and Forget style)
  await Promise.all([
    rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT, [priority.toString()]),
    rem.setPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT, [source]),
    rem.setPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT, [Date.now().toString()])
  ]);
}

/**
 * Automatically assign priority to cards based on context
 */
export async function autoAssignCardPriority(plugin: RNPlugin, rem: PluginRem): Promise<number> {
  const existingPriority = await getCardPriority(plugin, rem);

  if (existingPriority && existingPriority.source === 'manual') {
    return existingPriority.priority;
  }

  const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
  if (incRemInfo) {
    await setCardPriority(plugin, rem, incRemInfo.priority, 'inherited');
    return incRemInfo.priority;
  }

  const ancestorPriority = await findClosestAncestorWithPriority(plugin, rem);

  if (ancestorPriority) {
    await setCardPriority(plugin, rem, ancestorPriority.priority, 'inherited');
    return ancestorPriority.priority;
  }

  if (existingPriority && existingPriority.source === 'inherited') {
    return existingPriority.priority;
  }

  const defaultPriority = (await plugin.settings.getSetting<number>('defaultCardPriority')) || 50;
  await setCardPriority(plugin, rem, defaultPriority, 'default');
  return defaultPriority;
}

/**
 * Calculate what the priority should be without actually saving it
 * Used for optimization to avoid unnecessary updates
 */
export async function calculateNewPriority(
  plugin: RNPlugin,
  rem: PluginRem,
  existingPriority: CardPriorityInfo | null = null
): Promise<{ priority: number; source: PrioritySource }> {
  if (existingPriority && existingPriority.source === 'manual') {
    return { priority: existingPriority.priority, source: 'manual' };
  }

  const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
  if (incRemInfo) {
    return { priority: incRemInfo.priority, source: 'inherited' };
  }

  const ancestorPriority = await findClosestAncestorWithPriority(plugin, rem);

  if (ancestorPriority) {
    return { priority: ancestorPriority.priority, source: 'inherited' };
  }

  if (existingPriority && existingPriority.source === 'inherited') {
    return { priority: existingPriority.priority, source: 'inherited' };
  }

  const defaultPriority = (await plugin.settings.getSetting<number>('defaultCardPriority')) || 50;
  return { priority: defaultPriority, source: 'default' };
}

/**
 * Update inherited priorities when parent changes
 * This recursively updates all descendants that have inherited or default priority
 */
export async function updateInheritedPriorities(
  plugin: RNPlugin,
  parentRem: PluginRem,
  newPriority: number
): Promise<void> {
  const descendants = await parentRem.getDescendants();

  for (const descendant of descendants) {
    const descendantIncInfo = await getIncrementalRemFromRem(plugin, descendant);
    if (descendantIncInfo) {
      continue;
    }

    const cardInfo = await getCardPriority(plugin, descendant);

    if (!cardInfo || cardInfo.source !== 'manual') {
      const closerAncestor = await findClosestAncestorWithPriority(plugin, descendant);

      if (!closerAncestor || closerAncestor.priority === newPriority) {
        await setCardPriority(plugin, descendant, newPriority, 'inherited');
      }
    }
  }
}

/**
 * Get all due cards with priorities from a scope (used in priorityReviewDocument.ts)
 * OPTIMIZED VERSION - Uses the pre-built cache for maximum speed
 * 
 * NOTE: This function no longer fetches actual card objects via rem.getCards()
 * because the `cards` array in the return value is NOT used by any caller.
 * The callers only use `rem`, `priority`, and `source` from the results.
 * This optimization:
 * 1. Eliminates the SDK inconsistency where rem.getCards() sometimes returns []
 * 2. Significantly improves performance by avoiding N API calls
 */
export async function getDueCardsWithPriorities(
  plugin: RNPlugin,
  scopeRem: PluginRem | null,
  includeNonPrioritized: boolean = true
): Promise<
  Array<{
    rem: PluginRem;
    cards: any[];  // Always empty - kept for type compatibility
    priority: number;
    source: PrioritySource;
  }>
> {
  console.log(`[getDueCardsWithPriorities] Starting OPTIMIZED cache-based gathering (no rem.getCards)...`);
  const startTime = Date.now();

  const results: Array<{
    rem: PluginRem;
    cards: any[];
    priority: number;
    source: PrioritySource;
  }> = [];

  const allCardInfos = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey);

  if (!allCardInfos || allCardInfos.length === 0) {
    console.warn(`[getDueCardsWithPriorities] Cache is empty! Consider running cache build first.`);
    return getDueCardsWithPrioritiesSlow(plugin, scopeRem, includeNonPrioritized);
  }

  console.log(`[getDueCardsWithPriorities] Cache loaded: ${allCardInfos.length} card priority entries`);

  const priorityMap = new Map<RemId, CardPriorityInfo>();
  allCardInfos.forEach((info) => priorityMap.set(info.remId, info));

  let scopeRemIds: Set<RemId>;

  if (scopeRem) {
    console.log(`[getDueCardsWithPriorities] Gathering comprehensive scope...`);

    const descendants = await scopeRem.getDescendants();
    console.log(`[getDueCardsWithPriorities] ✓ Found ${descendants.length} descendants`);

    const allRemsInContext = await scopeRem.allRemInDocumentOrPortal();
    console.log(
      `[getDueCardsWithPriorities] ✓ Found ${allRemsInContext.length} rems in document/portal context`
    );

    const folderQueueRems = await scopeRem.allRemInFolderQueue();
    console.log(`[getDueCardsWithPriorities] ✓ Found ${folderQueueRems.length} rems via allRemInFolderQueue`);

    const sources = await scopeRem.getSources();
    console.log(`[getDueCardsWithPriorities] ✓ Found ${sources.length} sources`);

    const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(powerupCode, nextRepDateSlotCode);

    const referencingRems = ((await scopeRem.remsReferencingThis()) || [])
      .map((rem) => {
        if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
          return rem.parent;
        } else {
          return rem._id;
        }
      })
      .filter((id) => id !== null && id !== undefined) as RemId[];

    console.log(`[getDueCardsWithPriorities] ✓ Found ${referencingRems.length} referencing rems`);

    scopeRemIds = new Set<RemId>();
    scopeRemIds.add(scopeRem._id);
    descendants.forEach((rem) => scopeRemIds.add(rem._id));
    allRemsInContext.forEach((rem) => scopeRemIds.add(rem._id));
    folderQueueRems.forEach((rem) => scopeRemIds.add(rem._id));
    sources.forEach((rem) => scopeRemIds.add(rem._id));
    referencingRems.forEach((id) => scopeRemIds.add(id));

    console.log(`[getDueCardsWithPriorities] Comprehensive scope contains ${scopeRemIds.size} unique rems`);
  } else {
    scopeRemIds = new Set(allCardInfos.map((info) => info.remId));
    console.log(`[getDueCardsWithPriorities] Using full KB scope: ${scopeRemIds.size} rems`);
  }

  let processedCount = 0;
  let dueCardsCount = 0;

  for (const remId of scopeRemIds) {
    const cardInfo = priorityMap.get(remId);

    if (!cardInfo) {
      // Rem not in cache - skip if not including non-prioritized
      // NOTE: We no longer call rem.getCards() here to check for cards
      // Instead, we trust the cache which is built from plugin.card.getAll()
      if (includeNonPrioritized) {
        // For non-prioritized rems, we'd need to check if they have cards
        // But since the cache is built from plugin.card.getAll(), any rem with cards
        // should already be in the cache. If it's not, it likely doesn't have cards.
        // We skip the expensive rem.getCards() call here.
      }
      continue;
    }

    // Use dueCards count from cache instead of fetching and filtering cards
    if (cardInfo.dueCards > 0) {
      dueCardsCount++;

      const rem = await plugin.rem.findOne(remId);
      if (!rem) continue;

      // Push result with empty cards array - callers don't use it
      results.push({
        rem,
        cards: [],  // Empty - not used by callers
        priority: cardInfo.priority,
        source: cardInfo.source,
      });

      processedCount++;
    }
  }

  const elapsedTime = Date.now() - startTime;
  console.log(`[getDueCardsWithPriorities] OPTIMIZED completion:`);
  console.log(`[getDueCardsWithPriorities]  - Processed ${processedCount} rems with due cards`);
  console.log(`[getDueCardsWithPriorities]  - Found ${results.length} rems with due cards to include`);
  console.log(`[getDueCardsWithPriorities]  - Time elapsed: ${elapsedTime}ms`);
  if (processedCount > 0) {
    console.log(`[getDueCardsWithPriorities]  - Average time per rem: ${(elapsedTime / processedCount).toFixed(2)}ms`);
  }

  return results;
}

/**
 * FALLBACK: Slow version for when cache doesn't exist
 * Also optimized to avoid rem.getCards() - uses plugin.card.getAll() instead
 */
async function getDueCardsWithPrioritiesSlow(
  plugin: RNPlugin,
  scopeRem: PluginRem | null,
  includeNonPrioritized: boolean = true
): Promise<
  Array<{
    rem: PluginRem;
    cards: any[];
    priority: number;
    source: PrioritySource;
  }>
> {
  console.log(`[getDueCardsWithPrioritiesSlow] Starting fallback gathering...`);

  const results: Array<{
    rem: PluginRem;
    cards: any[];
    priority: number;
    source: PrioritySource;
  }> = [];

  // Get all cards once using the reliable plugin.card.getAll()
  const allCards = await plugin.card.getAll();
  const now = Date.now();

  // Build a map of remId -> due card count
  const remDueCardCount = new Map<RemId, number>();
  for (const card of allCards) {
    if ((card.nextRepetitionTime ?? Infinity) <= now) {
      remDueCardCount.set(card.remId, (remDueCardCount.get(card.remId) || 0) + 1);
    }
  }

  console.log(`[getDueCardsWithPrioritiesSlow] Found ${remDueCardCount.size} rems with due cards`);

  let remsToCheckIds: Set<RemId>;

  if (scopeRem) {
    console.log(`[getDueCardsWithPrioritiesSlow] Starting comprehensive scope gathering...`);

    const descendants = await scopeRem.getDescendants();
    console.log(`[getDueCardsWithPrioritiesSlow] ✓ Found ${descendants.length} descendants`);

    const allRemsInContext = await scopeRem.allRemInDocumentOrPortal();
    console.log(
      `[getDueCardsWithPrioritiesSlow] ✓ Found ${allRemsInContext.length} rems in document/portal context`
    );

    const folderQueueRems = await scopeRem.allRemInFolderQueue();
    console.log(`[getDueCardsWithPrioritiesSlow] ✓ Found ${folderQueueRems.length} rems via allRemInFolderQueue`);

    const sources = await scopeRem.getSources();
    console.log(`[getDueCardsWithPrioritiesSlow] ✓ Found ${sources.length} sources`);

    const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(powerupCode, nextRepDateSlotCode);

    const referencingRems = ((await scopeRem.remsReferencingThis()) || [])
      .map((rem) => {
        if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
          return rem.parent;
        } else {
          return rem._id;
        }
      })
      .filter((id) => id !== null && id !== undefined) as RemId[];

    console.log(`[getDueCardsWithPrioritiesSlow] ✓ Found ${referencingRems.length} referencing rems`);

    remsToCheckIds = new Set<RemId>([
      scopeRem._id,
      ...descendants.map(d => d._id),
      ...allRemsInContext.map(r => r._id),
      ...folderQueueRems.map(r => r._id),
      ...sources.map(r => r._id),
      ...referencingRems
    ]);

    console.log(`[getDueCardsWithPrioritiesSlow] Comprehensive scope: ${remsToCheckIds.size} unique rems`);
  } else {
    // Full KB scope - use all rems that have due cards
    remsToCheckIds = new Set(remDueCardCount.keys());
    console.log(`[getDueCardsWithPrioritiesSlow] Using full KB scope: ${remsToCheckIds.size} rems with due cards`);
  }

  // Filter to only rems that have due cards
  const remsWithDueCards = Array.from(remsToCheckIds).filter(remId => remDueCardCount.has(remId));
  console.log(`[getDueCardsWithPrioritiesSlow] ${remsWithDueCards.length} rems in scope have due cards`);

  for (const remId of remsWithDueCards) {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) continue;

    let priorityInfo = await getCardPriority(plugin, rem);

    if (!priorityInfo && includeNonPrioritized) {
      await autoAssignCardPriority(plugin, rem);
      priorityInfo = await getCardPriority(plugin, rem);
    }

    if (priorityInfo || includeNonPrioritized) {
      results.push({
        rem,
        cards: [],  // Empty - not used by callers
        priority: priorityInfo?.priority ?? 100,
        source: priorityInfo?.source ?? 'default',
      });
    }
  }

  console.log(`[getDueCardsWithPrioritiesSlow] Complete. Found ${results.length} rems with due cards.`);
  return results;
}

/**
 * Batch update priorities for multiple rems
 * Useful when changing priority of a parent with many descendants
 */
export async function batchUpdateInheritedPriorities(
  plugin: RNPlugin,
  parentRem: PluginRem,
  newPriority: number
): Promise<number> {
  let updatedCount = 0;
  const descendants = await parentRem.getDescendants();

  const batchSize = 50;
  for (let i = 0; i < descendants.length; i += batchSize) {
    const batch = descendants.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (descendant) => {
        const incInfo = await getIncrementalRemFromRem(plugin, descendant);
        if (incInfo) return;

        const cardInfo = await getCardPriority(plugin, descendant);
        if (!cardInfo || cardInfo.source !== 'manual') {
          const closerAncestor = await findClosestAncestorWithPriority(plugin, descendant);
          if (!closerAncestor || closerAncestor.priority === newPriority) {
            await setCardPriority(plugin, descendant, newPriority, 'inherited');
            updatedCount++;
          }
        }
      })
    );
  }

  return updatedCount;
}

export * from './types';
export * from './cache';
export * from './batch';
