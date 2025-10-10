import { Rem, RNPlugin } from '@remnote/plugin-sdk';
import { IncrementalRem } from './types';
import { getIncrementalRemInfo } from './incremental_rem';
import * as _ from 'remeda';

const CARD_PRIORITY_CODE = 'cardPriority';
const PRIORITY_SLOT = 'priority';
const SOURCE_SLOT = 'prioritySource';
const LAST_UPDATED_SLOT = 'lastUpdated';

export type PrioritySource = 'manual' | 'inherited' | 'default';

export interface CardPriorityInfo {
  remId: string;
  priority: number;
  source: PrioritySource;
  lastUpdated: number;
  cardCount: number;
  dueCards: number;
}


/**
 * Find the closest ancestor with priority (either Incremental or CardPriority)
 */
async function findClosestAncestorWithPriority(
  plugin: RNPlugin,
  rem: Rem
): Promise<{ priority: number; source: 'incremental' | 'card' } | null> {
  let current = rem;
  
  while (current.parent) {
    const parent = await plugin.rem.findOne(current.parent);
    if (!parent) break;
    
    // Check for Incremental Rem priority first
    const parentIncInfo = await getIncrementalRemInfo(plugin, parent);
    if (parentIncInfo) {
      return { priority: parentIncInfo.priority, source: 'incremental' };
    }
    
    // Check for CardPriority powerup
    const parentCardInfo = await getCardPriority(plugin, parent);
    if (parentCardInfo) {
      return { priority: parentCardInfo.priority, source: 'card' };
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
  rem: Rem
): Promise<CardPriorityInfo | null> {
  const cards = await rem.getCards();
  const now = Date.now();
  const dueCards = cards.filter(card => card.nextRepetitionTime <= now).length;

  const hasPowerup = await rem.hasPowerup(CARD_PRIORITY_CODE);
  
  if (!hasPowerup) {
    // Before returning a generic default, check for an inheritable priority.
    const ancestorPriority = await findClosestAncestorWithPriority(plugin, rem);
    if (ancestorPriority) {
      return {
        remId: rem._id,
        priority: ancestorPriority.priority,
        source: 'inherited',
        lastUpdated: 0, // 0 indicates it's not saved yet
        cardCount: cards.length,
        dueCards
      };
    }

    // If no ancestor is found, then use the default.
    return {
      remId: rem._id,
      priority: (await plugin.settings.getSetting<number>('defaultCardPriority')) || 50,
      source: 'default',
      lastUpdated: 0, // 0 indicates it's not saved
      cardCount: cards.length,
      dueCards
    };
  }

  const priority = await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);
  const source = await rem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT);
  const lastUpdated = await rem.getPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT);

  return {
    remId: rem._id,
    priority: parseInt(priority) || 50,
    source: (source as PrioritySource) || 'default',
    lastUpdated: parseInt(lastUpdated) || now,
    cardCount: cards.length,
    dueCards
  };
}

export function calculateRelativeCardPriority(allItems: CardPriorityInfo[], currentRemId: RemId): number | null {
  if (!allItems || !currentRemId || allItems.length === 0) {
    return null;
  }
  // Use spread operator to avoid mutating the original cache array during sort
  const sortedItems = [...allItems].sort((a, b) => a.priority - b.priority);
  const index = sortedItems.findIndex((x) => x.remId === currentRemId);
  if (index === -1) {
    return null;
  }
  const percentile = ((index + 1) / sortedItems.length) * 100;
  return Math.round(percentile * 10) / 10;
}

/**
 * Set card priority
 */
export async function setCardPriority(
  plugin: RNPlugin,
  rem: Rem,
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
export async function autoAssignCardPriority(
  plugin: RNPlugin,
  rem: Rem
): Promise<number> {
  // Check existing priority
  const existingPriority = await getCardPriority(plugin, rem);
  
  // ONLY preserve manual priorities - recalculate inherited and default
  if (existingPriority && existingPriority.source === 'manual') {
    return existingPriority.priority;
  }

  // Check if rem itself is an incremental rem (highest precedence)
  const incRemInfo = await getIncrementalRemInfo(plugin, rem);
  if (incRemInfo) {
    await setCardPriority(plugin, rem, incRemInfo.priority, 'inherited');
    return incRemInfo.priority;
  }

  // Search for closest ancestor with priority
  const ancestorPriority = await findClosestAncestorWithPriority(plugin, rem);
  
  if (ancestorPriority) {
    // Found an ancestor - update with its priority
    await setCardPriority(plugin, rem, ancestorPriority.priority, 'inherited');
    return ancestorPriority.priority;
  }
  
  // No ancestor found - decide what to do based on existing priority
  if (existingPriority && existingPriority.source === 'inherited') {
    // PRESERVE existing inherited priority when no ancestors are found
    // The ancestor that gave this priority may have been deleted/changed,
    // but we keep the inherited value stable
    return existingPriority.priority;
  }
  
  // Only use default if there's no existing priority or it was already default
  const defaultPriority = (await plugin.settings.getSetting<number>('defaultCardPriority')) || 50;
  await setCardPriority(plugin, rem, defaultPriority, 'default');
  return defaultPriority;
}

/**
 * Update inherited priorities when parent changes
 * This recursively updates all descendants that have inherited or default priority
 */
export async function updateInheritedPriorities(
  plugin: RNPlugin,
  parentRem: Rem,
  newPriority: number
): Promise<void> {
  const descendants = await parentRem.getDescendants();
  
  for (const descendant of descendants) {
    // Skip if descendant has its own Incremental priority (takes precedence)
    const descendantIncInfo = await getIncrementalRemInfo(plugin, descendant);
    if (descendantIncInfo) {
      continue; // Don't override Incremental Rem priorities
    }
    
    const cardInfo = await getCardPriority(plugin, descendant);
    
    // Only update if it's inherited or default (not manual)
    if (!cardInfo || cardInfo.source !== 'manual') {
      // Check if this descendant should inherit from a closer ancestor
      const closerAncestor = await findClosestAncestorWithPriority(plugin, descendant);
      
      // Only update if the current parent is actually the closest ancestor with priority
      // or if no closer ancestor exists
      if (!closerAncestor || closerAncestor.priority === newPriority) {
        await setCardPriority(plugin, descendant, newPriority, 'inherited');
      }
    }
  }
}

/**
 * Get all due cards with priorities from a scope
 */
export async function getDueCardsWithPriorities(
  plugin: RNPlugin,
  scopeRem: Rem | null,
  includeNonPrioritized: boolean = true
): Promise<Array<{
  rem: Rem;
  cards: any[];
  priority: number;
  source: PrioritySource;
}>> {
  const results: Array<{
    rem: Rem;
    cards: any[];
    priority: number;
    source: PrioritySource;
  }> = [];

  let remsToCheck: Rem[];

  if (scopeRem) {
    remsToCheck = [scopeRem, ...(await scopeRem.getDescendants())];
  } else {
    // CORRECTED LOGIC: Get all cards, then find their unique parent Rems.
    const allCards = await plugin.card.getAll();
    const remIdsWithCards = _.uniq(allCards.map(c => c.remId));
    remsToCheck = await plugin.rem.findMany(remIdsWithCards) || [];
  }

  const now = Date.now();

  for (const rem of remsToCheck) {
    const cards = await rem.getCards();
    const dueCards = cards.filter(card => card.nextRepetitionTime <= now);
    
    if (dueCards.length > 0) {
      // Try to get existing priority
      let priorityInfo = await getCardPriority(plugin, rem);
      
      // If no priority exists and includeNonPrioritized is true, auto-assign
      if (!priorityInfo && includeNonPrioritized) {
        await autoAssignCardPriority(plugin, rem);
        priorityInfo = await getCardPriority(plugin, rem);
      }
      
      if (priorityInfo || includeNonPrioritized) {
        results.push({
          rem,
          cards: dueCards,
          priority: priorityInfo?.priority ?? 100, // Default to lowest priority
          source: priorityInfo?.source ?? 'default'
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
  parentRem: Rem,
  newPriority: number
): Promise<number> {
  let updatedCount = 0;
  const descendants = await parentRem.getDescendants();
  
  // Process in batches to avoid overwhelming the system
  const batchSize = 50;
  for (let i = 0; i < descendants.length; i += batchSize) {
    const batch = descendants.slice(i, i + batchSize);
    
    await Promise.all(batch.map(async (descendant) => {
      // Skip if has Incremental Rem priority
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
    }));
  }
  
  return updatedCount;
}