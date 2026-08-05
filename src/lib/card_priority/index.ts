import { Card, PluginRem, RNPlugin, RemId } from '@remnote/plugin-sdk';
import { getIncrementalRemFromRem } from '../incremental_rem';
import { buildComprehensiveScope } from '../scope_helpers';
import { findClosestAncestorWithAnyPriority } from '../priority_inheritance';
import { syncPriorityBand } from '../priority_bands';
import dayjs from 'dayjs';
import {
  allCardPriorityInfoKey,
  defaultCardPriorityId,
  enableFlashcardPrioritisationId,
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
import { getIESetting } from '../settings';

/**
 * Whether the plugin may write CardPriority tags on its own initiative.
 *
 * Every *automatic* writer checks this: the startup pretagging pass, the
 * per-edit auto-assign, the in-queue card-creation hook, the IncRem inheritance
 * hook and the descendant cascade. With the opt-in off, none of them run, so the
 * plugin never applies the powerup to a rem the user did not explicitly act on.
 *
 * Deliberately NOT applied to user-initiated writes — the priority popups, the
 * quick-priority shortcuts, the batch tools. Those tag exactly one rem the user
 * is looking at, and silently ignoring a slider the user just moved is worse
 * than the write. Hiding the control is the right lever there, not this guard.
 *
 * What is lost while off is the bulk index (taggedRem -> cache -> shield,
 * percentiles, Priority Review Documents), not inheritance itself:
 * getCardPriority resolves an untagged rem's value through its ancestors on
 * every read.
 */
export async function mayAutoWriteCardPriority(plugin: RNPlugin): Promise<boolean> {
  return await getIESetting(plugin, enableFlashcardPrioritisationId);
}

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
 *
 * Performance: when called from the cache builder for many rems, the caller can
 * pre-fetch all cards once via plugin.card.getAll() and pass the per-rem subset
 * via options.preloadedCards. This skips the per-rem rem.getCards() round-trip
 * (the most expensive call inside this function for large KBs).
 *
 * The slot reads are parallelized in a single Promise.all batch; reading
 * source/lastUpdated even when priorityValue ends up null is essentially free
 * (parallel cost is governed by the slowest call) and simplifies the flow.
 */
export async function getCardPriority(
  plugin: RNPlugin,
  rem: PluginRem,
  options?: { preloadedCards?: Card[] }
): Promise<CardPriorityInfo | null> {
  const [cards, priorityValue, source, lastUpdated] = await Promise.all([
    options?.preloadedCards !== undefined
      ? Promise.resolve(options.preloadedCards)
      : rem.getCards(),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT),
  ]);

  const now = Date.now();
  const startOfToday = dayjs().startOf('day').valueOf();
  // `?? Infinity`: disabled cards have nextRepetitionTime === null, which maps to
  // Infinity and therefore never satisfies the <= now check. This implicitly excludes
  // disabled cards from due counts and, consequently, from Priority Review Documents
  // and the due-card-priority cache — without any explicit disabled-card filter.
  const dueCards = cards.filter((card) => (card.nextRepetitionTime ?? Infinity) <= now).length;
  const dueCardsOverdue = cards.filter((card) => (card.nextRepetitionTime ?? Infinity) <= startOfToday).length;
  // Per-card nextRep, captured here so the Weighted Shield of Cards can be
  // bucketed per-card later without re-fetching every card.
  const cardsNextRep: (number | null)[] = cards.map((c) => c.nextRepetitionTime ?? null);

  if (priorityValue) {
    const parsedPriority = parseInt(priorityValue);
    const finalPriority = !isNaN(parsedPriority) ? parsedPriority : 50;

    return {
      remId: rem._id,
      priority: finalPriority,
      source: (source as PrioritySource) || 'default',
      lastUpdated: parseInt(lastUpdated) || now,
      cardCount: cards.length,
      dueCards,
      dueCardsOverdue,
      cardsNextRep,
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
        dueCardsOverdue,
        cardsNextRep,
      };
    }

    const defaultPriority = await getIESetting(plugin, defaultCardPriorityId);
    return {
      remId: rem._id,
      priority: defaultPriority,
      source: 'default' as PrioritySource,
      lastUpdated: 0,
      cardCount: cards.length,
      dueCards,
      dueCardsOverdue,
      cardsNextRep,
    };
  }
}

/**
 * Lightweight version of getCardPriority that only resolves the priority value (including inheritance).
 * Does NOT fetch cards or calculate counts, making it suitable for fast-path rendering.
 */
export async function getCardPriorityValue(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<number> {
  // Check direct slot first
  const priorityValue = await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);

  if (priorityValue) {
    const parsed = parseInt(priorityValue);
    return !isNaN(parsed) ? parsed : 50;
  }

  // Check inheritance
  const ancestorPriority = await findClosestAncestorWithPriority(plugin, rem);
  if (ancestorPriority) {
    return ancestorPriority.priority;
  }

  // Default
  return await getIESetting(plugin, defaultCardPriorityId);
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

  // Keep the table-cell badge in step. Static import: a dynamic import() here
  // emits a chunk the RemNote index sandbox cannot evaluate ("Cannot use
  // 'import.meta' outside a module"). priority_bands only pulls constants from
  // card_priority/types, so there is no cycle to dodge. syncPriorityBand writes
  // nothing when the band is already correct, so this cannot loop.
  try {
    await syncPriorityBand(plugin, rem);
  } catch (err) {
    console.error('[CardPriority] band sync failed', err);
  }
}

/**
 * Automatically assign priority to cards based on context.
 *
 * IMPORTANT: Each branch must check whether the existing priority already
 * matches (value + source) before calling setCardPriority. Writing without
 * this guard updates LAST_UPDATED_SLOT with Date.now(), which modifies the
 * Rem and re-fires GlobalRemChanged — creating an infinite ~1 s loop.
 */
export async function autoAssignCardPriority(plugin: RNPlugin, rem: PluginRem): Promise<number> {
  const existingPriority = await getCardPriority(plugin, rem);

  // Automatic writer: no tag is applied while flashcard prioritisation is off.
  // The resolved value is still returned, so callers that only want to *know* the
  // priority keep working.
  if (!(await mayAutoWriteCardPriority(plugin))) {
    return existingPriority?.priority ?? (await getIESetting(plugin, defaultCardPriorityId));
  }

  if (existingPriority && (existingPriority.source === 'manual' || existingPriority.source === 'incremental')) {
    return existingPriority.priority;
  }

  const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
  if (incRemInfo) {
    // Skip write if already up-to-date (prevents infinite GlobalRemChanged loop)
    if (existingPriority && existingPriority.source === 'incremental' && existingPriority.priority === incRemInfo.priority) {
      return incRemInfo.priority;
    }
    await setCardPriority(plugin, rem, incRemInfo.priority, 'incremental');
    return incRemInfo.priority;
  }

  const ancestorPriority = await findClosestAncestorWithPriority(plugin, rem);

  if (ancestorPriority) {
    // Skip write if already up-to-date (prevents infinite GlobalRemChanged loop).
    // Untagged rems with matching inherited priority intentionally stay untagged: the
    // widget already falls back to getCardPriority() (which returns the inherited value
    // with lastUpdated: 0) when there's no cache entry, and the deferred batch still
    // pushes them into the cache by remId regardless of tag status. Force-tagging on
    // every ambient edit causes a write storm in the GlobalRemChanged listener.
    if (existingPriority && existingPriority.source === 'inherited' && existingPriority.priority === ancestorPriority.priority) {
      return ancestorPriority.priority;
    }
    await setCardPriority(plugin, rem, ancestorPriority.priority, 'inherited');
    return ancestorPriority.priority;
  }

  if (existingPriority && existingPriority.source === 'inherited') {
    return existingPriority.priority;
  }

  const defaultPriority = await getIESetting(plugin, defaultCardPriorityId);
  // Skip write if already up-to-date (prevents infinite GlobalRemChanged loop).
  // Untagged rems with matching default priority intentionally stay untagged: the widget
  // falls back to getCardPriority() and the deferred batch still pushes them into the
  // cache by remId regardless of tag status.
  if (existingPriority && existingPriority.source === 'default' && existingPriority.priority === defaultPriority) {
    return defaultPriority;
  }
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
  if (existingPriority && (existingPriority.source === 'manual' || existingPriority.source === 'incremental')) {
    return { priority: existingPriority.priority, source: existingPriority.source };
  }

  const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
  if (incRemInfo) {
    return { priority: incRemInfo.priority, source: 'incremental' };
  }

  const ancestorPriority = await findClosestAncestorWithPriority(plugin, rem);

  if (ancestorPriority) {
    return { priority: ancestorPriority.priority, source: 'inherited' };
  }

  if (existingPriority && existingPriority.source === 'inherited') {
    return { priority: existingPriority.priority, source: 'inherited' };
  }

  const defaultPriority = await getIESetting(plugin, defaultCardPriorityId);
  return { priority: defaultPriority, source: 'default' };
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
  includeNonPrioritized: boolean = true,
  precomputedScopeIds?: Set<RemId>
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
    return getDueCardsWithPrioritiesSlow(plugin, scopeRem, includeNonPrioritized, precomputedScopeIds);
  }

  console.log(`[getDueCardsWithPriorities] Cache loaded: ${allCardInfos.length} card priority entries`);

  const priorityMap = new Map<RemId, CardPriorityInfo>();
  allCardInfos.forEach((info) => priorityMap.set(info.remId, info));

  let scopeRemIds: Set<RemId>;

  if (precomputedScopeIds) {
    scopeRemIds = precomputedScopeIds;
    console.log(`[getDueCardsWithPriorities] Reusing precomputed scope: ${scopeRemIds.size} unique rems`);
  } else if (scopeRem) {
    console.log(`[getDueCardsWithPriorities] Gathering comprehensive scope...`);
    scopeRemIds = await buildComprehensiveScope(plugin, scopeRem._id);
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
  includeNonPrioritized: boolean = true,
  precomputedScopeIds?: Set<RemId>
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

  // Build a map of remId -> due card count.
  // Disabled cards (nextRepetitionTime === null → Infinity) are excluded implicitly.
  const remDueCardCount = new Map<RemId, number>();
  for (const card of allCards) {
    if ((card.nextRepetitionTime ?? Infinity) <= now) {
      remDueCardCount.set(card.remId, (remDueCardCount.get(card.remId) || 0) + 1);
    }
  }

  console.log(`[getDueCardsWithPrioritiesSlow] Found ${remDueCardCount.size} rems with due cards`);

  let remsToCheckIds: Set<RemId>;

  if (precomputedScopeIds) {
    remsToCheckIds = precomputedScopeIds;
    console.log(`[getDueCardsWithPrioritiesSlow] Reusing precomputed scope: ${remsToCheckIds.size} unique rems`);
  } else if (scopeRem) {
    console.log(`[getDueCardsWithPrioritiesSlow] Starting comprehensive scope gathering...`);
    remsToCheckIds = await buildComprehensiveScope(plugin, scopeRem._id);
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
 * Recalculates inherited priorities for an entire tree dynamically.
 * Highly optimized for batch operations where multiple ancestors changed.
 */
export async function recalculateTreeInheritance(
  plugin: RNPlugin,
  rootRem: PluginRem
): Promise<number> {
  return recalculateTreeInheritanceBatch(plugin, [rootRem]);
}

/**
 * Batch form of recalculateTreeInheritance: cascades from MANY roots in a single pass.
 *
 * Why this exists: bulk flows — batch card priority over a tag, batch IncRem
 * priority, interval batch save — produce one cascade root per modified rem
 * (hundreds of them). Running them one at a time repeated the whole setup per
 * root; a 625-rem batch cost ~17 minutes of background cascades, nearly all of it
 * repeated plugin.card.getAll() calls back when this function used one.
 *
 * Here the has-cards index and the defaultCardPriority setting are resolved ONCE,
 * and the union of all roots' descendants is deduplicated before the walk —
 * overlapping subtrees (common when the selection is a tag's members) are visited
 * a single time.
 *
 * @param onProgress optional callback invoked as descendant batches complete, so
 *   long-running bulk cascades can report progress instead of going silent.
 */
export async function recalculateTreeInheritanceBatch(
  plugin: RNPlugin,
  rootRems: PluginRem[],
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  if (rootRems.length === 0) return 0;

  // Union of every root's descendants, deduplicated by rem id. Roots frequently
  // share subtrees (or are each other's descendants) in bulk operations, and
  // walking a rem twice is pure waste — the second pass finds the value already
  // correct and does nothing.
  const descendantsById = new Map<string, PluginRem>();
  for (const rootRem of rootRems) {
    const descendants = await rootRem.getDescendants();
    for (const d of descendants) {
      if (!descendantsById.has(d._id)) descendantsById.set(d._id, d);
    }
  }
  const descendants = [...descendantsById.values()];

  // Fast path: roots with no descendants at all (e.g. freshly-created leaf
  // extracts) have nothing to cascade into, so skip the has-cards work below.
  // This used to be the difference between a new-IncRem save costing seconds and
  // costing nothing, back when that work was a full plugin.card.getAll().
  if (descendants.length === 0) {
    return 0;
  }

  // Which descendants own flashcards. This used to call plugin.card.getAll() and
  // reduce the whole card database to a set of rem ids — a ~29s cost per cascade
  // on a large library, paid on the interactive editing path, to answer a
  // question about a handful of rems.
  //
  // Preferred source: the card-priority cache, which is itself built from one
  // getAll() at startup and therefore carries identical semantics (disabled
  // cards and paused decks included). Costs one session read.
  //
  // The cache is absent in Light Mode and incomplete until its deferred phase
  // finishes; the loop below then falls back to per-rem rem.getCards(). That
  // under-reports rems whose cards are all disabled or in a paused deck, and the
  // error direction is the safe one: fewer rems are tagged, never more, so it
  // cannot recreate the rogue-tag bug the guard below exists to prevent. Such
  // rems are excluded from due counts anyway (getCardPriority maps a null
  // nextRepetitionTime to Infinity), so they reach neither the shield nor a
  // Priority Review Document — a stale tag on them changes nothing visible.
  const cacheLoaded = await plugin.storage.getSession<boolean>('card_priority_cache_fully_loaded');
  const cachedInfos = cacheLoaded
    ? (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || []
    : [];
  const remIdsWithCards: Set<string> | null = cacheLoaded
    ? new Set(cachedInfos.filter((i) => i.cardCount > 0).map((i) => i.remId))
    : null;

  // Hoisted out of the per-descendant loop: this is a constant for the whole walk.
  const defaultPriority = await getIESetting(plugin, defaultCardPriorityId);
  const { updateCardPriorityCache } = await import('./cache');

  let updatedCount = 0;
  const batchSize = 50;
  for (let i = 0; i < descendants.length; i += batchSize) {
    const batch = descendants.slice(i, i + batchSize);

    await Promise.all(batch.map(async (descendant) => {
      const incInfo = await getIncrementalRemFromRem(plugin, descendant);
      if (incInfo) return;

      // ROGUE-TAG GUARD (root cause fix):
      // Only touch descendants that genuinely own flashcards. getDescendants()
      // returns EVERYTHING in the subtree — tag slots, property values, list
      // items, chapter headers — and the old code refreshed/created cardPriority
      // on all of them (every one came back source 'inherited'/'default' from
      // getCardPriority, never null). That blanket walk is exactly how the rogue
      // tags spread (confirmed by the structure dump: dozens of card-less nodes
      // carrying source 'inherited'). Tagless card-less descendants inherit
      // dynamically via findClosestAncestorWithPriority() and need no physical
      // tag; card-less tagged rems are rogue artifacts the sanitizer removes —
      // we must not perpetuate them here.
      //
      // Fallback path fetches the cards to answer "has cards", then hands them to
      // getCardPriority as `preloadedCards` so they are not fetched twice — the
      // old code paid getAll() *and* a rem.getCards() inside getCardPriority for
      // every descendant it touched.
      let preloadedCards: Card[] | undefined;
      if (remIdsWithCards) {
        if (!remIdsWithCards.has(descendant._id)) return;
      } else {
        preloadedCards = await descendant.getCards();
        if (preloadedCards.length === 0) return;
      }

      const cardInfo = await getCardPriority(
        plugin,
        descendant,
        preloadedCards ? { preloadedCards } : undefined
      );
      if (!cardInfo || (cardInfo.source !== 'manual' && cardInfo.source !== 'incremental')) {
        const closerAncestor = await findClosestAncestorWithPriority(plugin, descendant);
        const targetPriority = closerAncestor ? closerAncestor.priority : defaultPriority;
        const targetSource = closerAncestor ? 'inherited' : 'default';

        if (!cardInfo || cardInfo.priority !== targetPriority || cardInfo.source !== targetSource) {
          await setCardPriority(plugin, descendant, targetPriority, targetSource);
          // We let the caller flush the cache updates
          await updateCardPriorityCache(plugin, descendant._id);
          updatedCount++;
        }
      }
    }));

    onProgress?.(Math.min(i + batchSize, descendants.length), descendants.length);
  }
  return updatedCount;
}

export * from './types';
export * from './cache';
export * from './batch';
