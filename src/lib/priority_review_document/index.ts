import { RNPlugin, PluginRem, RichTextInterface } from '@remnote/plugin-sdk';
import { IncrementalRem } from '../incremental_rem';
import { getCardRandomness, getSortingRandomness, applySortingCriteria } from '../sorting';
import { getDueCardsWithPriorities } from '../card_priority';
import { 
  allIncrementalRemKey, 
  priorityGraphPowerupCode, 
  GRAPH_DATA_KEY_PREFIX,
  allCardPriorityInfoKey
} from '../consts';
import { CardPriorityInfo } from '../card_priority';
import { calculateAllPercentiles } from '../utils';
import { buildComprehensiveScope } from '../scope_helpers';
import * as _ from 'remeda'; // Ensure remeda is imported for uniqBy if available, or use custom

// Helper function to find or create a tag
async function findOrCreateTag(plugin: RNPlugin, tagName: string): Promise<PluginRem | undefined> {
  let tag = await plugin.rem.findByName([tagName], null);
  if (!tag) {
    tag = await plugin.rem.createRem();
    if (tag) {
      await tag.setText([tagName]);
    }
  }
  return tag;
}

/**
 * Checks whether a Rem has the "Priority Review Queue" tag, meaning the document
 * should behave as a Priority Review queue (special queue scope, history, etc.).
 *
 * @param rem Rem to inspect.
 * @returns True if the rem carries the Priority Review tag.
 */
export async function isPriorityReviewDocument(rem: PluginRem): Promise<boolean> {
  const tags = await rem.getTagRems();
  if (!tags?.length) {
    return false;
  }

  return tags.some((tag) => {
    const text = tag.text;
    const tagTextString =
      typeof text === 'string'
        ? text
        : Array.isArray(text)
        ? text.join('')
        : '';
    return tagTextString.includes('Priority Review Queue');
  });
}

/**
 * Parses the original scope identifier embedded in a Priority Review document title.
 *
 * The title is expected to contain either a portal reference to the original scope
 * (inserted when the review doc is generated) or the literal text "Full Knowledge Base".
 * - Returns the referenced Rem ID when the portal is present.
 * - Returns `null` when the title explicitly indicates the full knowledge base.
 * - Returns `undefined` when the title cannot be parsed so callers can fall back safely.
 */
export async function extractOriginalScopeFromPriorityReview(
  reviewDocRem: PluginRem
): Promise<string | null | undefined> {
  const reviewDocTitle = reviewDocRem.text;
  if (!reviewDocTitle || reviewDocTitle.length === 0) {
    console.warn('Priority Review Document has no title content to parse for scope.');
    return undefined;
  }

  for (const element of reviewDocTitle) {
    if (typeof element === 'object' && element !== null) {
      if ('i' in element && element.i === 'q' && '_id' in element) {
        return element._id as string;
      }
    }
  }

  const textContent = reviewDocTitle.join('');
  if (textContent.includes('Full Knowledge Base')) {
    return null;
  }

  console.warn('Could not extract scope from Priority Review Document title');
  return undefined;
}

export interface ReviewDocumentConfig {
  scopeRemId: string | null;  // null = full KB
  itemCount: number;
  cardRatio: number | 'no-cards' | 'no-rem';
}

/**
 * Create a priority-based review document with mixed content
 */
export async function createPriorityReviewDocument(
  plugin: RNPlugin,
  config: ReviewDocumentConfig
): Promise<PluginRem> {
  const { scopeRemId, itemCount, cardRatio } = config;

  // 1. Create the review document with rem reference in title
  const timestamp = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  
  // Create a blank Rem first
  const reviewDoc = await plugin.rem.createRem();
  if (!reviewDoc) {
    throw new Error("Failed to create the initial review document Rem.");
  }
  
  // Build the document name with rem reference if there's a scope
  let docNameContent: RichTextInterface;
  
  if (scopeRemId) {
    const scopeRem = await plugin.rem.findOne(scopeRemId);
    if (scopeRem) {
      // Create rich text with rem reference
      docNameContent = [
        'Priority Review - ',
        {
          i: 'q',  // Rem reference/portal
          _id: scopeRem._id,
        },
        ` - ${timestamp}`
      ];
    } else {
      // Fallback if scope rem not found
      docNameContent = [`Priority Review - Document - ${timestamp}`];
    }
  } else {
    // Full KB scope
    docNameContent = [`Priority Review - Full Knowledge Base - ${timestamp}`];
  }
  
  // Set the rich text name and make it a document
  await reviewDoc.setText(docNameContent);
  await reviewDoc.setIsDocument(true);
  
  // 2. Fetch Data
  const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];

  // 3. Get DUE items (Fresh calculation)
  const scopeRem = scopeRemId ? (await plugin.rem.findOne(scopeRemId)) ?? null : null;
  const now = Date.now();
  
  // IncRems
  let scopedIncRems = allIncRems;
  if (scopeRem) {
    // Also use comprehensive scope for IncRems to catch portals/tables
    const comprehensiveScopeIds = await buildComprehensiveScope(plugin, scopeRem._id);
    scopedIncRems = allIncRems.filter(r => comprehensiveScopeIds.has(r.remId));
  }
  const dueIncRems = scopedIncRems.filter(rem => rem.nextRepDate <= now);
  
  // Cards
  // This fetches the actual cards we will use. 
  // It might find cards NOT present in allCardInfos if the cache is stale.
  const cardsWithPriority = await getDueCardsWithPriorities(
    plugin,
    scopeRem,
    true
  );

  // --- DEBUG & FIX START ---
  
  // 3b. Establish "Universe" for Percentiles
  // We start with the cached data (allCardInfos) filtered by scope
  const allCardInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
  let universeCardInfos = allCardInfos;
  if (scopeRem) {
    // FIX: Use comprehensive scope to capture portal contents
    const comprehensiveScopeIds = await buildComprehensiveScope(plugin, scopeRem._id);
    universeCardInfos = allCardInfos.filter(c => comprehensiveScopeIds.has(c.remId));
  }

  // Safety merge: Identify cards that are Due but missing from the Universe Cache
  // This handles edge cases where getDueCardsWithPriorities logic differs slightly
  const universeRemIds = new Set(universeCardInfos.map(c => c.remId));
  const missingCards = cardsWithPriority.filter(c => !universeRemIds.has(c.rem._id));

  if (missingCards.length > 0) {
    // 2. Deduplicate missing items by RemId so we don't add the same Rem multiple times
    const uniqueMissingRems = _.uniqBy(missingCards, c => c.rem._id);
    
    console.warn(`[PriorityGraph] Found ${missingCards.length} due cards missing from cache. Merged ${uniqueMissingRems.length} unique Rems into universe.`);
    
    // Note: You might also need to map these to match the CardPriorityInfo shape 
    // depending on your type definitions, but fixing the filter prevents the false alarm.
    const missingCardInfos = uniqueMissingRems.map(item => ({
      remId: item.rem._id,
      priority: item.priority,
      source: item.source,
      // You may need to fill other CardPriorityInfo fields like cardCount/dueCards/lastUpdated with defaults
      cardCount: 1, 
      dueCards: 1,
      lastUpdated: Date.now()
    }));

    universeCardInfos = [...universeCardInfos, ...missingCardInfos];
  } else {
    console.log(`[PriorityGraph] All ${cardsWithPriority.length} due cards are present in cache.`);
  }

  // Calculate "Relative Percentiles" maps: { [remId]: percentile (0-100) }
  // scopedIncRems is already filtered above
  const incRemPercentiles = calculateAllPercentiles(scopedIncRems);
  
  // Use the SAFE universe list that definitely includes our due cards
  const cardPercentiles = calculateAllPercentiles(universeCardInfos);

  // --- DEBUG & FIX END ---
  
  // 4. Apply sorting criteria (Randomness)
  const incRemRandomness = await getSortingRandomness(plugin);
  const cardRandomness = await getCardRandomness(plugin);
  
  const sortedIncRems = applySortingCriteria(dueIncRems, incRemRandomness);
  const sortedCards = applySortingCriteria(cardsWithPriority, cardRandomness);
  
  // 5. Mix Items & Attach Pre-calculated Percentiles
  interface MixedItem {
    rem: PluginRem;
    type: 'incremental' | 'flashcard';
    priority: number;
    percentile: number;
  }

  const mixedItems: MixedItem[] = [];
  let incRemIndex = 0;
  let cardIndex = 0;

  const addIncRem = async (idx: number) => {
    if (idx >= sortedIncRems.length) return false;
    const item = sortedIncRems[idx];
    const rem = await plugin.rem.findOne(item.remId);
    if (rem) {
      // Lookup the percentile relative to the entire scope universe
      // Fallback to 100 (lowest rank) if not found
      const percentile = incRemPercentiles[item.remId] ?? 100;
      
      mixedItems.push({ 
        rem, 
        type: 'incremental', 
        priority: item.priority,
        percentile: percentile 
      });
      return true;
    }
    return false;
  };

  const addCard = (idx: number) => {
    if (idx >= sortedCards.length) return false;
    const item = sortedCards[idx];
    
    // Lookup percentile with debug log if missing
    let percentile = cardPercentiles[item.rem._id];
    
    if (percentile === undefined) {
      console.warn(`[PriorityGraph] Percentile missing for Card Rem: ${item.rem._id}. Fallback to 100.`);
      percentile = 100;
    }
    
    mixedItems.push({ 
      rem: item.rem, 
      type: 'flashcard', 
      priority: item.priority,
      percentile: percentile
    });
    return true;
  };

  if (typeof cardRatio === 'number') {
    while (mixedItems.length < itemCount) {
      let addedThisCycle = false;
      if (incRemIndex < sortedIncRems.length) {
        if (await addIncRem(incRemIndex)) { incRemIndex++; addedThisCycle = true; }
      }

      for (let i = 0; i < cardRatio && mixedItems.length < itemCount; i++) {
        if (cardIndex < sortedCards.length) {
          if (addCard(cardIndex)) { cardIndex++; addedThisCycle = true; }
        }
      }
      
      if (!addedThisCycle) break;
    }

  } else if (cardRatio === 'no-cards') {
    for (let i = 0; i < itemCount && i < sortedIncRems.length; i++) {
      await addIncRem(i);
    }
  } else {
    for (let i = 0; i < itemCount && i < sortedCards.length; i++) {
      addCard(i);
    }
  }
  
  // 6. Add metadata to document
    const scopeName = scopeRemId 
    ? (await plugin.rem.findOne(scopeRemId))?.text?.join('') || 'Document'
    : 'Full Knowledge Base';
    
  // Format randomness as percentage
  const incRemRandPct = Math.round(incRemRandomness * 100);
  const cardRandPct = Math.round(cardRandomness * 100);

  // Total Cards: 
  // - If cardCount is defined (cached item), use it (even if 0).
  // - If cardCount is missing (merged from due list), assume 1 (since it is due, it must have cards).
  const totalCardsInScope = universeCardInfos.reduce((sum, info) => {
    const count = typeof info.cardCount === 'number' ? info.cardCount : 1;
    return sum + count;
  }, 0);

  const metadataText = `Scope: ${scopeName} 
Scope Size: ${scopedIncRems.length} IncRems, ${universeCardInfos.length} Rems with Cards, ${totalCardsInScope} Cards
Selected Items: ${mixedItems.length} (${mixedItems.filter(i => i.type === 'incremental').length} IncRems, ${mixedItems.filter(i => i.type === 'flashcard').length} Rems with Cards)
Randomness: IncRem ${incRemRandPct}%, Cards ${cardRandPct}%
Created: ${timestamp}`;

  // Create a code block with metadata
  const metadataRem = await plugin.rem.createRem();
  if (metadataRem) {
    await metadataRem.setText([metadataText]);
    await metadataRem.setIsCode(true);
    await metadataRem.setParent(reviewDoc);
  }

  // 7. Generate Graph Data and Insert Graph Widget
  
  // Initialize bins (0-5, 5-10, ... 95-100)
  const createBins = () => Array(20).fill(0).map((_, i) => ({
    range: `${i * 5}-${(i + 1) * 5}`,
    incRem: 0,
    card: 0,
  }));

  const binsAbsolute = createBins();
  const binsRelative = createBins();

  for (const item of mixedItems) {
    // Fill Absolute Bins
    const pAbs = Math.max(0, Math.min(100, item.priority));
    const absIndex = Math.min(Math.floor(pAbs / 5), 19);
    
    // Fill Relative Bins
    const pRel = Math.max(0, Math.min(100, item.percentile));
    const relIndex = Math.min(Math.floor(pRel / 5), 19);

    if (item.type === 'incremental') {
      binsAbsolute[absIndex].incRem++;
      binsRelative[relIndex].incRem++;
    } else {
      binsAbsolute[absIndex].card++;
      binsRelative[relIndex].card++;
    }
  }

  // Create the Rem for the graph
  const graphRem = await plugin.rem.createRem();
  if (graphRem) {
    await graphRem.setParent(reviewDoc);
    await graphRem.setText(["Priority Distribution Graph"]);
    
    // CRITICAL FIX: Add the Powerup explicitly by Code
    await graphRem.addPowerup(priorityGraphPowerupCode);
    
    // Save the graph data in storage associated with this Rem
    // We use synced storage so it persists across sessions
    // UPDATED: Save object with bins AND stats
    const graphData = {
      bins: binsAbsolute,
      binsRelative: binsRelative,
      stats: {
        incRem: incRemRandPct,
        card: cardRandPct
      }
    };
    
    await plugin.storage.setSynced(GRAPH_DATA_KEY_PREFIX + graphRem._id, graphData);
  }

    
  // 8. Create portals in the document
  const reviewQueueTag = await findOrCreateTag(plugin, 'Priority Review Queue');
  if (reviewQueueTag) { await reviewDoc.addTag(reviewQueueTag); }

  for (const item of mixedItems) {
    // Create a regular rem that will contain the portal reference
    const childRem = await plugin.rem.createRem();
    if (!childRem) continue;
    
    // Set it as a child of the review document first
    await childRem.setParent(reviewDoc);
    
    // Set its text to be a portal reference to the target rem
    const portalContent: RichTextInterface = [
      {
        i: 'q',
        _id: item.rem._id,
      }
    ];
    await childRem.setText(portalContent);

    // Add type tag
    const typeTagText = item.type === 'incremental' ? 'INC' : 'FC';
    const typeTag = await findOrCreateTag(plugin, typeTagText);
    if (typeTag) { await childRem.addTag(typeTag); }
  }
  
  return reviewDoc;
}
