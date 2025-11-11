import { PluginRem, RNPlugin, RemId } from '@remnote/plugin-sdk';
import { getIncrementalRemInfo } from '../incremental_rem';
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
 */
async function findClosestAncestorWithPriority(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<{ priority: number; source: 'incremental' | 'card' } | null> {
  let current = rem;

  while (current.parent) {
    const parent = await plugin.rem.findOne(current.parent);
    if (!parent) break;

    const parentIncInfo = await getIncrementalRemInfo(plugin, parent);
    if (parentIncInfo) {
      return { priority: parentIncInfo.priority, source: 'incremental' };
    }

    const parentCardPriorityValue = await parent.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);
    if (parentCardPriorityValue) {
      const priority = parseInt(parentCardPriorityValue);
      if (!isNaN(priority)) {
        return { priority: priority, source: 'card' };
      }
    }

    current = parent;
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
  source: PrioritySource
): Promise<void> {
  const hasPowerup = await rem.hasPowerup(CARD_PRIORITY_CODE);
  if (!hasPowerup) {
    await rem.addPowerup(CARD_PRIORITY_CODE);
  }

  await rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT, [priority.toString()]);
  await rem.setPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT, [source]);
  await rem.setPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT, [Date.now().toString()]);
}

/**
 * Automatically assign priority to cards based on context
 */
export async function autoAssignCardPriority(plugin: RNPlugin, rem: PluginRem): Promise<number> {
  const existingPriority = await getCardPriority(plugin, rem);

  if (existingPriority && existingPriority.source === 'manual') {
    return existingPriority.priority;
  }

  const incRemInfo = await getIncrementalRemInfo(plugin, rem);
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

  const incRemInfo = await getIncrementalRemInfo(plugin, rem);
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
    const descendantIncInfo = await getIncrementalRemInfo(plugin, descendant);
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
 */
export async function getDueCardsWithPriorities(
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
  console.log(`[getDueCardsWithPriorities] Starting OPTIMIZED cache-based gathering...`);
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
    const afterDescendants = scopeRemIds.size;
    allRemsInContext.forEach((rem) => scopeRemIds.add(rem._id));
    const afterContext = scopeRemIds.size;
    folderQueueRems.forEach((rem) => scopeRemIds.add(rem._id));
    const afterFolderQueue = scopeRemIds.size;
    sources.forEach((rem) => scopeRemIds.add(rem._id));
    const afterSources = scopeRemIds.size;
    referencingRems.forEach((id) => scopeRemIds.add(id));
    const afterReferences = scopeRemIds.size;

    console.log(`[getDueCardsWithPriorities] Comprehensive scope contains ${scopeRemIds.size} unique rems`);
    console.log(`[getDueCardsWithPriorities] Deduplication breakdown:`);
    console.log(
      `[getDueCardsWithPriorities]  - After scope rem + descendants: ${afterDescendants} unique rems`
    );
    console.log(
      `[getDueCardsWithPriorities]  - After adding document/portal context: ${afterContext} (+${
        afterContext - afterDescendants
      })`
    );
    console.log(
      `[getDueCardsWithPriorities]  - After adding folder queue: ${afterFolderQueue} (+${
        afterFolderQueue - afterContext
      })`
    );
    console.log(
      `[getDueCardsWithPriorities]  - After adding sources: ${afterSources} (+${afterSources - afterFolderQueue})`
    );
    console.log(
      `[getDueCardsWithPriorities]  - After adding references: ${afterReferences} (+${
        afterReferences - afterSources
      })`
    );
    console.log(
      `[getDueCardsWithPriorities]  - Final comprehensive scope size: ${scopeRemIds.size} unique Rem`
    );
  } else {
    scopeRemIds = new Set(allCardInfos.map((info) => info.remId));
    console.log(`[getDueCardsWithPriorities] Using full KB scope: ${scopeRemIds.size} rems`);
  }

  const now = Date.now();
  let processedCount = 0;
  let dueCardsCount = 0;

  for (const remId of scopeRemIds) {
    const cardInfo = priorityMap.get(remId);

    if (!cardInfo) {
      if (includeNonPrioritized) {
        const rem = await plugin.rem.findOne(remId);
        if (rem) {
          const cards = await rem.getCards();
          if (cards.length > 0) {
            await autoAssignCardPriority(plugin, rem);
            const newCardInfo = await getCardPriority(plugin, rem);
            if (newCardInfo) {
              results.push({
                rem,
                cards: cards.filter((card) => (card.nextRepetitionTime ?? Infinity) <= now),
                priority: newCardInfo.priority,
                source: newCardInfo.source,
              });
            }
          }
        }
      }
      continue;
    }

    if (cardInfo.dueCards > 0) {
      dueCardsCount++;

      const rem = await plugin.rem.findOne(remId);
      if (!rem) continue;

      const cards = await rem.getCards();
      const dueCards = cards.filter((card) => (card.nextRepetitionTime ?? Infinity) <= now);

      if (dueCards.length > 0) {
        results.push({
          rem,
          cards: dueCards,
          priority: cardInfo.priority,
          source: cardInfo.source,
        });
      }

      processedCount++;
    }
  }

  const elapsedTime = Date.now() - startTime;
  console.log(`[getDueCardsWithPriorities] OPTIMIZED completion:`);
  console.log(`[getDueCardsWithPriorities]  - Processed ${processedCount} rems with due cards`);
  console.log(`[getDueCardsWithPriorities]  - Found ${results.length} rems with due cards to include`);
  console.log(`[getDueCardsWithPriorities]  - Time elapsed: ${elapsedTime}ms`);
  console.log(`[getDueCardsWithPriorities]  - Average time per rem: ${(elapsedTime / processedCount).toFixed(2)}ms`);

  return results;
}

/**
 * FALLBACK: Slow version for when cache doesn't exist
 * This is your original implementation
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
  const results: Array<{
    rem: PluginRem;
    cards: any[];
    priority: number;
    source: PrioritySource;
  }> = [];

  let remsToCheck: PluginRem[];

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

    const referencingRemObjs = ((await scopeRem.remsReferencingThis()) || []).map((rem) => {
      if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
        return { rem: null, parentId: rem.parent };
      } else {
        return { rem: rem, parentId: null };
      }
    });

    console.log(`[getDueCardsWithPrioritiesSlow] ✓ Found ${referencingRemObjs.length} referencing rems`);

    const combinedRems = new Map<RemId, PluginRem>();

    combinedRems.set(scopeRem._id, scopeRem);

    descendants.forEach((rem) => combinedRems.set(rem._id, rem));
    const afterDescendants = combinedRems.size;

    allRemsInContext.forEach((rem) => combinedRems.set(rem._id, rem));
    const afterContext = combinedRems.size;

    folderQueueRems.forEach((rem) => combinedRems.set(rem._id, rem));
    const afterFolderQueue = combinedRems.size;

    sources.forEach((rem) => combinedRems.set(rem._id, rem));
    const afterSources = combinedRems.size;

    for (const refObj of referencingRemObjs) {
      if (refObj.rem) {
        combinedRems.set(refObj.rem._id, refObj.rem);
      } else if (refObj.parentId) {
        const parentRem = await plugin.rem.findOne(refObj.parentId);
        if (parentRem) {
          combinedRems.set(parentRem._id, parentRem);
        }
      }
    }
    const afterReferences = combinedRems.size;

    remsToCheck = Array.from(combinedRems.values());

    console.log(`[getDueCardsWithPrioritiesSlow] Deduplication results:`);
    console.log(
      `[getDueCardsWithPrioritiesSlow]  - After scope rem + descendants: ${afterDescendants} unique rems`
    );
    console.log(
      `[getDueCardsWithPrioritiesSlow]  - After adding document/portal context: ${afterContext} (+${
        afterContext - afterDescendants
      })`
    );
    console.log(
      `[getDueCardsWithPrioritiesSlow]  - After adding folder queue: ${afterFolderQueue} (+${
        afterFolderQueue - afterContext
      })`
    );
    console.log(
      `[getDueCardsWithPrioritiesSlow]  - After adding sources: ${afterSources} (+${
        afterSources - afterFolderQueue
      })`
    );
    console.log(
      `[getDueCardsWithPrioritiesSlow]  - After adding references: ${afterReferences} (+${
        afterReferences - afterSources
      })`
    );
    console.log(
      `[getDueCardsWithPrioritiesSlow]  - Final comprehensive scope size: ${remsToCheck.length} unique Rem`
    );
  } else {
    console.log(`[getDueCardsWithPrioritiesSlow] Using full KB scope...`);
    const allCards = await plugin.card.getAll();
    const remIdsWithCards = _.uniq(allCards.map((c) => c.remId));
    remsToCheck = (await plugin.rem.findMany(remIdsWithCards)) || [];
    console.log(`[getDueCardsWithPrioritiesSlow] Found ${remsToCheck.length} rems with cards in full KB`);
  }

  const now = Date.now();

  for (const rem of remsToCheck) {
    const cards = await rem.getCards();
    const dueCards = cards.filter((card) => (card.nextRepetitionTime ?? Infinity) <= now);

    if (dueCards.length > 0) {
      let priorityInfo = await getCardPriority(plugin, rem);

      if (!priorityInfo && includeNonPrioritized) {
        await autoAssignCardPriority(plugin, rem);
        priorityInfo = await getCardPriority(plugin, rem);
      }

      if (priorityInfo || includeNonPrioritized) {
        results.push({
          rem,
          cards: dueCards,
          priority: priorityInfo?.priority ?? 100,
          source: priorityInfo?.source ?? 'default',
        });
      }
    }
  }

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
        const incInfo = await getIncrementalRemInfo(plugin, descendant);
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
