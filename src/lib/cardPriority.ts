import { Rem, RNPlugin, RemId, Query_DUPE_2 as Query, BuiltInPowerupCodes, SearchPortalQuery } from '@remnote/plugin-sdk';
import { IncrementalRem } from './types';
import { getIncrementalRemInfo } from './incremental_rem';
import { safeRemTextToString } from './pdfUtils';
import { allCardPriorityInfoKey, powerupCode, nextRepDateSlotCode } from './consts';
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
  kbPercentile?: number; // Add this new optional property
}

export interface QueueSessionCache {
  /**
   * A map of RemID -> document-level percentile.
   * Pre-calculated for every card in the current document scope.
   * Allows for an instant lookup of the "X% of Doc" value.
   */
  docPercentiles: Record<RemId, number>;

  /**
   * A pre-filtered list of all due cards that are part of the current document/folder.
   * Used for the fast Document Shield calculation.
   */
  dueCardsInScope: CardPriorityInfo[];

  /**
   * A pre-filtered list of all due cards from the entire Knowledge Base.
   * Used for the fast KB Shield calculation.
   */
  dueCardsInKB: CardPriorityInfo[];


  // --- NEW: Incremental Rem Data ---
  /**
   * A pre-filtered list of all due Incremental Rems in the document scope.
   * Used for the fast Incremental Rem Document Shield.
   */
  dueIncRemsInScope: IncrementalRem[];

  /**
   * A pre-filtered list of all due Incremental Rems in the entire KB.
   * Used for the fast Incremental Rem KB Shield.
   */
  dueIncRemsInKB: IncrementalRem[];

  // --- NEW: Pre-calculated IncRem Percentiles ---
  /**
   * A map of RemID -> document-level percentile for Incremental Rems.
   * Pre-calculated for every IncRem in the current document scope.
   */
  incRemDocPercentiles: Record<RemId, number>;
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
    
    // Then, DIRECTLY check for a CardPriority powerup property on the parent
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
// --- NEW DEBUG-INSTRUMENTED VERSION ---
export async function getCardPriority(
  plugin: RNPlugin,
  rem: Rem
): Promise<CardPriorityInfo | null> {
  const remText = await safeRemTextToString(plugin, rem.text);
  //console.log(`[DEBUG getCardPriority] -----------------------------------------`);
  //console.log(`[DEBUG getCardPriority] 1. START processing Rem: "${remText.slice(0, 30)}..." (${rem._id})`);

  const cards = await rem.getCards();
  const now = Date.now();
  const dueCards = cards.filter(card => card.nextRepetitionTime <= now).length;

  //console.log(`[DEBUG getCardPriority] 2. Attempting to read priority slot directly...`);
  const priorityValue = await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);
  //console.log(`[DEBUG getCardPriority] 3. Result of getPowerupProperty:`, { priorityValue });
  
  if (priorityValue) {
    //console.log(`[DEBUG getCardPriority] 4a. SUCCESS: Priority slot has a value. Reading from powerup.`);
    const source = await rem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT);
    const lastUpdated = await rem.getPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT);
    
    // Parse priority - use ?? instead of || to handle 0 correctly
    const parsedPriority = parseInt(priorityValue);
    const finalPriority = !isNaN(parsedPriority) ? parsedPriority : 50;
    
    const result = {
      remId: rem._id,
      priority: finalPriority,
      source: (source as PrioritySource) || 'default',
      lastUpdated: parseInt(lastUpdated) || now,
      cardCount: cards.length,
      dueCards
    };
    //console.log(`[DEBUG getCardPriority] 5a. FINAL RESULT from direct read:`, result);
    //console.log(`[DEBUG getCardPriority] -----------------------------------------`);
    return result;

  } else {
    //console.log(`[DEBUG getCardPriority] 4b. FAILED: Priority slot is empty. Checking for inheritance.`);
    const ancestorPriority = await findClosestAncestorWithPriority(plugin, rem);
    //console.log(`[DEBUG getCardPriority] 5b. Result of findClosestAncestorWithPriority:`, ancestorPriority);

    if (ancestorPriority) {
      const result = {
        remId: rem._id,
        priority: ancestorPriority.priority,
        source: 'inherited' as PrioritySource,
        lastUpdated: 0,
        cardCount: cards.length,
        dueCards
      };
      //console.log(`[DEBUG getCardPriority] 6b. FINAL RESULT from inheritance:`, result);
      //console.log(`[DEBUG getCardPriority] -----------------------------------------`);
      return result;
    }

    const defaultPriority = (await plugin.settings.getSetting<number>('defaultCardPriority')) || 50;
    const result = {
      remId: rem._id,
      priority: defaultPriority,
      source: 'default' as PrioritySource,
      lastUpdated: 0,
      cardCount: cards.length,
      dueCards
    };
    //console.log(`[DEBUG getCardPriority] 7b. FINAL RESULT from default:`, result);
    //console.log(`[DEBUG getCardPriority] -----------------------------------------`);
    return result;
  }
}


export function calculateRelativeCardPriority(allItems: CardPriority.tsInfo[], currentRemId: RemId): number | null {
  if (!allItems || !currentRemId) {
    return null;
  }

  // A more robust filter to ensure every item is a valid object with a remId.
  // This is the definitive fix for the "cannot read properties of undefined" error.
  const validItems = allItems.filter(item => item && typeof item === 'object' && item.remId);

  if (validItems.length === 0) {
    return null;
  }

  const sortedItems = [...validItems].sort((a, b) => a.priority - b.priority);
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
 * Calculate what the priority should be without actually saving it
 * Used for optimization to avoid unnecessary updates
 */
export async function calculateNewPriority(
  plugin: RNPlugin,
  rem: Rem,
  existingPriority: CardPriorityInfo | null = null
): Promise<{ priority: number; source: PrioritySource }> {
  // ONLY preserve manual priorities
  if (existingPriority && existingPriority.source === 'manual') {
    return { priority: existingPriority.priority, source: 'manual' };
  }

  // Check if rem itself is an incremental rem (highest precedence)
  const incRemInfo = await getIncrementalRemInfo(plugin, rem);
  if (incRemInfo) {
    return { priority: incRemInfo.priority, source: 'inherited' };
  }

  // Search for closest ancestor with priority
  const ancestorPriority = await findClosestAncestorWithPriority(plugin, rem);
  
  if (ancestorPriority) {
    return { priority: ancestorPriority.priority, source: 'inherited' };
  }
  
  // No ancestor found - check existing inherited priority
  if (existingPriority && existingPriority.source === 'inherited') {
    // Preserve existing inherited priority
    return { priority: existingPriority.priority, source: 'inherited' };
  }
  
  // Use default priority
  const defaultPriority = (await plugin.settings.getSetting<number>('defaultCardPriority')) || 50;
  return { priority: defaultPriority, source: 'default' };
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
 * Get all due cards with priorities from a scope (used in priorityReviewDocument.ts)
 * OPTIMIZED VERSION - Uses the pre-built cache for maximum speed
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
  console.log(`[getDueCardsWithPriorities] Starting OPTIMIZED cache-based gathering...`);
  const startTime = Date.now();

  const results: Array<{
    rem: Rem;
    cards: any[];
    priority: number;
    source: PrioritySource;
  }> = [];

  // Get the pre-built cache - this is the key optimization!
  const allCardInfos = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey);
  
  if (!allCardInfos || allCardInfos.length === 0) {
    console.warn(`[getDueCardsWithPriorities] Cache is empty! Consider running cache build first.`);
    // Fallback to slow method if cache doesn't exist
    return getDueCardsWithPrioritiesSlow(plugin, scopeRem, includeNonPrioritized);
  }

  console.log(`[getDueCardsWithPriorities] Cache loaded: ${allCardInfos.length} card priority entries`);

  // Build a lookup map for O(1) access
  const priorityMap = new Map<RemId, CardPriorityInfo>();
  allCardInfos.forEach(info => priorityMap.set(info.remId, info));

  let scopeRemIds: Set<RemId>;

  if (scopeRem) {
      // --- COMPREHENSIVE SCOPE GATHERING LOGIC ---
      console.log(`[getDueCardsWithPriorities] Gathering comprehensive scope...`);

      // 1. Get structural descendants (hierarchical children)
      const descendants = await scopeRem.getDescendants();
      console.log(`[getDueCardsWithPriorities] ✓ Found ${descendants.length} descendants`);

      // 2. Get all Rem that appear in this document/portal context
      const allRemsInContext = await scopeRem.allRemInDocumentOrPortal();
      console.log(`[getDueCardsWithPriorities] ✓ Found ${allRemsInContext.length} rems in document/portal context`);
      
      // 3. Get folder queue rems (RemNote's native scope)
      const folderQueueRems = await scopeRem.allRemInFolderQueue();
      console.log(`[getDueCardsWithPriorities] ✓ Found ${folderQueueRems.length} rems via allRemInFolderQueue`);
      
      // 4. Get sources (bibliography, references FROM this document)
      const sources = await scopeRem.getSources();
      console.log(`[getDueCardsWithPriorities] ✓ Found ${sources.length} sources`);
      
      // 5. Get rems that reference this document (backlinks)
      // Use the same logic as QueueEnter to filter out property value rems
      const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
        powerupCode,
        nextRepDateSlotCode
      );
      
      const referencingRems = ((await scopeRem.remsReferencingThis()) || []).map((rem) => {
        if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
          // This is a property value rem - return its parent (the actual rem)
          return rem.parent;
        } else {
          // Normal rem that references the document
          return rem._id;
        }
      }).filter(id => id !== null && id !== undefined) as RemId[];
      
      console.log(`[getDueCardsWithPriorities] ✓ Found ${referencingRems.length} referencing rems`);

      // 6. Combine and deduplicate - but we only need the IDs!
      scopeRemIds = new Set<RemId>();
      // Add the scope rem itself
      scopeRemIds.add(scopeRem._id);
      // Add all descendants
      descendants.forEach(rem => scopeRemIds.add(rem._id));
      const afterDescendants = scopeRemIds.size;
      // Add all rems from document/portal context
      allRemsInContext.forEach(rem => scopeRemIds.add(rem._id));
      const afterContext = scopeRemIds.size;
      // Add folder queue rems
      folderQueueRems.forEach(rem => scopeRemIds.add(rem._id));
      const afterFolderQueue = scopeRemIds.size;
      // Add sources
      sources.forEach(rem => scopeRemIds.add(rem._id));
      const afterSources = scopeRemIds.size;
      // Add referencing rems
      referencingRems.forEach(id => scopeRemIds.add(id));
      const afterReferences = scopeRemIds.size;

      console.log(`[getDueCardsWithPriorities] Comprehensive scope contains ${scopeRemIds.size} unique rems`);
      console.log(`[getDueCardsWithPriorities] Deduplication breakdown:`);
      console.log(`[getDueCardsWithPriorities]  - After scope rem + descendants: ${afterDescendants} unique rems`);
      console.log(`[getDueCardsWithPriorities]  - After adding document/portal context: ${afterContext} (+${afterContext - afterDescendants})`);
      console.log(`[getDueCardsWithPriorities]  - After adding folder queue: ${afterFolderQueue} (+${afterFolderQueue - afterContext})`);
      console.log(`[getDueCardsWithPriorities]  - After adding sources: ${afterSources} (+${afterSources - afterFolderQueue})`);
      console.log(`[getDueCardsWithPriorities]  - After adding references: ${afterReferences} (+${afterReferences - afterSources})`);
      console.log(`[getDueCardsWithPriorities]  - Final comprehensive scope size: ${scopeRemIds.size} unique Rem`);
    } else {
    // Full KB - all rems in cache are in scope
    scopeRemIds = new Set(allCardInfos.map(info => info.remId));
    console.log(`[getDueCardsWithPriorities] Using full KB scope: ${scopeRemIds.size} rems`);
  }

  const now = Date.now();
  let processedCount = 0;
  let dueCardsCount = 0;

  // Process only rems that are in scope AND have due cards
  for (const remId of scopeRemIds) {
    const cardInfo = priorityMap.get(remId);
    
    if (!cardInfo) {
      // Rem not in cache - might not have cards, or cache needs refresh
      if (includeNonPrioritized) {
        // Fallback: fetch the rem and process it the slow way
        const rem = await plugin.rem.findOne(remId);
        if (rem) {
          const cards = await rem.getCards();
          if (cards.length > 0) {
            await autoAssignCardPriority(plugin, rem);
            const newCardInfo = await getCardPriority(plugin, rem);
            if (newCardInfo) {
              results.push({
                rem,
                cards: cards.filter(card => card.nextRepetitionTime <= now),
                priority: newCardInfo.priority,
                source: newCardInfo.source
              });
            }
          }
        }
      }
      continue;
    }

    // Check if this rem has due cards
    if (cardInfo.dueCards > 0) {
      dueCardsCount++;
      
      // Get the actual Rem object (lightweight operation)
      const rem = await plugin.rem.findOne(remId);
      if (!rem) continue;

      // Get the actual card objects (we need these for the return value)
      const cards = await rem.getCards();
      const dueCards = cards.filter(card => card.nextRepetitionTime <= now);

      if (dueCards.length > 0) {
        results.push({
          rem,
          cards: dueCards,
          priority: cardInfo.priority,
          source: cardInfo.source
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
      // --- COMPREHENSIVE SCOPE GATHERING LOGIC ---
      console.log(`[getDueCardsWithPrioritiesSlow] Starting comprehensive scope gathering...`);

      // 1. Get structural descendants (hierarchical children)
      const descendants = await scopeRem.getDescendants();
      console.log(`[getDueCardsWithPrioritiesSlow] ✓ Found ${descendants.length} descendants`);

      // 2. Get all Rem that appear in this document/portal context
      const allRemsInContext = await scopeRem.allRemInDocumentOrPortal();
      console.log(`[getDueCardsWithPrioritiesSlow] ✓ Found ${allRemsInContext.length} rems in document/portal context`);
      
      // 3. Get folder queue rems
      const folderQueueRems = await scopeRem.allRemInFolderQueue();
      console.log(`[getDueCardsWithPrioritiesSlow] ✓ Found ${folderQueueRems.length} rems via allRemInFolderQueue`);
      
      // 4. Get sources
      const sources = await scopeRem.getSources();
      console.log(`[getDueCardsWithPrioritiesSlow] ✓ Found ${sources.length} sources`);
      
      // 5. Get referencing rems (with property value filtering)
      const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
        powerupCode,
        nextRepDateSlotCode
      );
      
      const referencingRemObjs = ((await scopeRem.remsReferencingThis()) || []).map((rem) => {
        if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
          // This is a property value rem - we need the parent
          return { rem: null, parentId: rem.parent };
        } else {
          // Normal rem that references the document
          return { rem: rem, parentId: null };
        }
      });
      
      console.log(`[getDueCardsWithPrioritiesSlow] ✓ Found ${referencingRemObjs.length} referencing rems`);

      // 3. Combine and deduplicate all sources
      const combinedRems = new Map<RemId, Rem>();
    
      // Add the scope rem itself
      combinedRems.set(scopeRem._id, scopeRem);
      
      // Add all descendants
      descendants.forEach(rem => combinedRems.set(rem._id, rem));
      const afterDescendants = combinedRems.size;
      
      // Add all rems from document/portal context
      allRemsInContext.forEach(rem => combinedRems.set(rem._id, rem));
      const afterContext = combinedRems.size;
      
      // Add folder queue rems
      folderQueueRems.forEach(rem => combinedRems.set(rem._id, rem));
      const afterFolderQueue = combinedRems.size;
      
      // Add sources
      sources.forEach(rem => combinedRems.set(rem._id, rem));
      const afterSources = combinedRems.size;
      
      // Add referencing rems (need to fetch parents if needed)
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
      console.log(`[getDueCardsWithPrioritiesSlow]  - After scope rem + descendants: ${afterDescendants} unique rems`);
      console.log(`[getDueCardsWithPrioritiesSlow]  - After adding document/portal context: ${afterContext} (+${afterContext - afterDescendants})`);
      console.log(`[getDueCardsWithPrioritiesSlow]  - After adding folder queue: ${afterFolderQueue} (+${afterFolderQueue - afterContext})`);
      console.log(`[getDueCardsWithPrioritiesSlow]  - After adding sources: ${afterSources} (+${afterSources - afterFolderQueue})`);
      console.log(`[getDueCardsWithPrioritiesSlow]  - After adding references: ${afterReferences} (+${afterReferences - afterSources})`);
      console.log(`[getDueCardsWithPrioritiesSlow]  - Final comprehensive scope size: ${remsToCheck.length} unique Rem`);
  } else {
      // Full KB logic - get all rems that have cards
      console.log(`[getDueCardsWithPrioritiesSlow] Using full KB scope...`);
      const allCards = await plugin.card.getAll();
      const remIdsWithCards = _.uniq(allCards.map(c => c.remId));
      remsToCheck = await plugin.rem.findMany(remIdsWithCards) || [];
      console.log(`[getDueCardsWithPrioritiesSlow] Found ${remsToCheck.length} rems with cards in full KB`);
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
