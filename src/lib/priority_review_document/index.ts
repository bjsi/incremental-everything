import { RNPlugin, PluginRem, RichTextInterface, RemId, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
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
import { registerReviewGraphKey } from './cleanup';
import { safeRemTextToString } from '../pdfUtils';
import * as _ from 'remeda'; // Ensure remeda is imported for uniqBy if available, or use custom

// Possible powerup codes for the Card Cluster built-in powerup.
// RemNote exposes it via the /cluster slash command but does not publish
// the code in BuiltInPowerupCodes, so we try several plausible variants.
const CARD_CLUSTER_POWERUP_CODES = ['cluster', 'cardCluster', 'card-cluster', 'card_cluster', 'cardcluster'];

/**
 * Returns true if `rem` carries the Card Cluster powerup.
 * Tries each known code variant first, then falls back to inspecting
 * the rem's tag-rems for text that contains "cluster" (case-insensitive).
 */
async function hasCardClusterPowerup(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  // Try every plausible powerup code
  for (const code of CARD_CLUSTER_POWERUP_CODES) {
    try {
      if (await rem.hasPowerup(code)) {
        console.log(`[CardCluster] Detected via powerup code "${code}" on rem ${rem._id}`);
        return true;
      }
    } catch (_) {
      // ignore individual failures
    }
  }

  // Fallback: inspect tag-rems for text containing "cluster"
  try {
    const tags = await rem.getTagRems();
    if (tags?.length) {
      for (const tag of tags) {
        const tagText = Array.isArray(tag.text)
          ? tag.text.join('')
          : typeof tag.text === 'string'
          ? tag.text
          : '';
        if (tagText.toLowerCase().includes('cluster')) {
          console.log(`[CardCluster] Detected via tag text "${tagText}" on rem ${rem._id}`);
          return true;
        }
      }
    }
  } catch (_) {
    // ignore
  }

  return false;
}

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

export interface SkippedPausedItem {
  remId: string;
  name: string;
  priority: number;
}

/**
 * Walks the ancestor chain of a rem to detect if it lives inside a paused
 * document. A document is considered paused when its Deck powerup Status
 * slot equals "Paused".
 *
 * Note: card.getAll() returns cards for paused-document rems (unlike
 * rem.getCards() which returns []). This check is the reliable way to
 * detect that state without relying on rem.getCards() behaviour.
 */
async function isInPausedDocument(rem: PluginRem): Promise<boolean> {
  let cursor = await rem.getParentRem();
  while (cursor) {
    if (await cursor.hasPowerup(BuiltInPowerupCodes.Deck)) {
      const status = await cursor.getPowerupProperty(BuiltInPowerupCodes.Deck, 'Status');
      return status === 'Paused';
    }
    cursor = await cursor.getParentRem();
  }
  return false;
}

export interface ReviewDocumentConfig {
  scopeRemId: string | null;  // null = full KB
  itemCount: number;
  cardRatio: number | 'no-cards' | 'no-rem';
  /** When true, flashcard rems inside paused documents are excluded and reported. Default: true. */
  filterPaused: boolean;
}

/**
 * Create a priority-based review document with mixed content
 */
export async function createPriorityReviewDocument(
  plugin: RNPlugin,
  config: ReviewDocumentConfig
): Promise<{ doc: PluginRem; actualItemCount: number; skippedPausedItems: SkippedPausedItem[] }> {
  const { scopeRemId, itemCount, cardRatio, filterPaused } = config;

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

  // Skipped paused items are collected lazily inside addCard as cards are pulled.
  // card.getAll() (used by the cache) returns cards for paused rems while
  // rem.getCards() returns [] — the Deck powerup Status slot is the reliable
  // signal. We check only candidates actually considered for inclusion, so the
  // list stays small and meaningful.
  const skippedPausedItems: SkippedPausedItem[] = [];

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
  const incRemPercentiles = calculateAllPercentiles(scopedIncRems as any);

  // Use the SAFE universe list that definitely includes our due cards
  const cardPercentiles = calculateAllPercentiles(universeCardInfos);

  // --- DEBUG & FIX END ---

  // 4. Apply sorting criteria (Randomness)
  const incRemRandomness = await getSortingRandomness(plugin);
  const cardRandomness = await getCardRandomness(plugin);

  const sortedIncRems = applySortingCriteria((dueIncRems as any[]), incRemRandomness);
  const sortedCards = applySortingCriteria(cardsWithPriority, cardRandomness);

  // 5. Mix Items & Attach Pre-calculated Percentiles
  interface MixedItem {
    rem: PluginRem;
    type: 'incremental' | 'flashcard';
    priority: number;
    percentile: number;
  }

  const mixedItems: MixedItem[] = [];
  // Track which rem IDs we have already added to avoid duplicates
  const addedRemIds = new Set<RemId>();
  let incRemIndex = 0;
  let cardIndex = 0;

  // Build a fast lookup: remId -> sorted card entry, for cluster sibling resolution
  const dueCardByRemId = new Map(sortedCards.map(c => [c.rem._id, c]));

  const addIncRem = async (idx: number) => {
    if (idx >= sortedIncRems.length) return false;
    const item = sortedIncRems[idx];
    const rem = await plugin.rem.findOne(item.remId);
    if (rem) {
      // Lookup the percentile relative to the entire scope universe
      // Fallback to 100 (lowest rank) if not found
      const percentile = incRemPercentiles[(item as any).remId] ?? 100;

      mixedItems.push({
        rem,
        type: 'incremental',
        priority: (item as any).priority,
        percentile: percentile
      });
      return true;
    }
    return false;
  };

  /**
   * Add the card at sortedCards[idx] to mixedItems, skipping if already added.
   * If its direct parent carries the Card Cluster powerup, also enqueue all
   * siblings (other children of that parent) that have due cards — so RemNote
   * can present them as a native cluster in the review queue.
   */
  const addCard = async (idx: number): Promise<boolean> => {
    if (idx >= sortedCards.length) return false;
    const item = sortedCards[idx];

    // Always advance past already-added rems so the caller can keep iterating
    if (addedRemIds.has(item.rem._id)) return true;

    // Lazy paused-document check — only runs for cards actually pulled into
    // consideration, so ancestor walks are bounded by how many cards we need.
    if (filterPaused && await isInPausedDocument(item.rem)) {
      skippedPausedItems.push({
        remId: item.rem._id,
        name: await safeRemTextToString(plugin, item.rem.text),
        priority: item.priority,
      });
      return true; // advance index without adding to mixedItems
    }

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
    addedRemIds.add(item.rem._id);

    // --- Card Cluster expansion ---
    // Check if this rem's direct parent has the Card Cluster powerup.
    // If so, add all sibling rems (same parent) that have due cards.
    try {
      const parentId = item.rem.parent as RemId | undefined;
      if (parentId) {
        const parentRem = await plugin.rem.findOne(parentId);
        if (parentRem && await hasCardClusterPowerup(plugin, parentRem)) {
          console.log(`[CardCluster] Expanding cluster for parent ${parentId}`);
          // Fetch the parent's direct children
          const siblings = await parentRem.getChildrenRem();
          if (siblings?.length) {
            for (const sibling of siblings) {
              if (sibling._id === item.rem._id) continue; // skip self
              if (addedRemIds.has(sibling._id)) continue;  // already queued
              // Only add siblings that have due cards (present in dueCardByRemId)
              const siblingEntry = dueCardByRemId.get(sibling._id);
              if (siblingEntry) {
                let siblingPercentile = cardPercentiles[sibling._id];
                if (siblingPercentile === undefined) siblingPercentile = 100;
                mixedItems.push({
                  rem: sibling,
                  type: 'flashcard',
                  priority: siblingEntry.priority,
                  percentile: siblingPercentile
                });
                addedRemIds.add(sibling._id);
                console.log(`[CardCluster] Added cluster sibling ${sibling._id}`);
              }
            }
          }
        }
      }
    } catch (clusterErr) {
      // Non-fatal: cluster expansion failure should not break the document creation
      console.warn('[CardCluster] Error during cluster expansion:', clusterErr);
    }

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
          if (await addCard(cardIndex)) { cardIndex++; addedThisCycle = true; }
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
      await addCard(i);
    }
  }

  // 6. Finalise skipped list and log
  if (skippedPausedItems.length > 0) {
    skippedPausedItems.sort((a, b) => a.priority - b.priority);
    console.log(
      `[PRD] ${skippedPausedItems.length} flashcard rems skipped (paused documents):`,
      skippedPausedItems.map((s) => `P${s.priority} — ${s.name} [${s.remId}]`)
    );
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

  const skippedLine = skippedPausedItems.length > 0
    ? `\nSkipped (paused docs): ${skippedPausedItems.length} flashcard rems`
    : '';

  const metadataText = `Scope: ${scopeName}
Scope Size: ${scopedIncRems.length} IncRems, ${universeCardInfos.length} Rems with Cards, ${totalCardsInScope} Cards
Selected Items: ${mixedItems.length} (${mixedItems.filter(i => i.type === 'incremental').length} IncRems, ${mixedItems.filter(i => i.type === 'flashcard').length} Rems with Cards)${skippedLine}
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

  // Initialize bins. Two label styles:
  //   'integer' for discrete absolute-priority values → `0-4, 5-9, ..., 95-100`
  //   'range'   for continuous percentile space      → `0-5, 5-10, ..., 95-100`
  // Last bucket is inclusive of 100 in both styles (priority/percentile is clamped).
  const createBins = (style: 'integer' | 'range') => Array(20).fill(0).map((_, i) => ({
    range: style === 'integer'
      ? (i === 19 ? '95-100' : `${i * 5}-${i * 5 + 4}`)
      : `${i * 5}-${(i + 1) * 5}`,
    incRem: 0,
    card: 0,
  }));

  const binsAbsolute = createBins('integer');
  const binsRelative = createBins('range');

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
    // Track this graph Rem so the startup sweep can clear its data later
    // if the user deletes the Priority Review Document.
    await registerReviewGraphKey(plugin, graphRem._id);
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

  return { doc: reviewDoc, actualItemCount: mixedItems.length, skippedPausedItems };
}
