import { RNPlugin, PluginRem, RichTextInterface, RemId, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { IncrementalRem } from '../incremental_rem';
import { getCardRandomness, getSortingRandomness, getWeightSelectionK, applySortingCriteria } from '../sorting';
import { getDueCardsWithPriorities } from '../card_priority';
import {
  allIncrementalRemKey,
  priorityGraphPowerupCode,
  allCardPriorityInfoKey
} from '../consts';
import { CardPriorityInfo, calculateCardRemPercentilesFromCards } from '../card_priority';
import { calculateAllPercentiles } from '../utils';
import { buildComprehensiveScope } from '../scope_helpers';
import { saveReviewGraphData } from './graph_data';
import { ensureReviewQueueTagPinnedOnce } from './sidebar_pin';
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

export interface SkippedAncestorItem {
  remId: string;
  name: string;
  priority: number;
  /** The due ancestor that would have been given away. */
  ancestorRemId: string;
  ancestorName: string;
  /** 1 = parent, 2 = grandparent. */
  level: 1 | 2;
  /** What happened to the ancestor: pulled in as a replacement, already in the
   * document, or unreadable (the descendant is still held back either way). */
  ancestorAction: 'added' | 'already-included' | 'unavailable';
}

interface AncestorInfo {
  parentId: RemId | null;
  hasDueCard: boolean;
  text: any;
}

/**
 * Reads the one thing the spoiler gate needs to know about an ancestor — does it
 * still owe the queue a card — plus its own parent, so the walk can climb one
 * more level without a second lookup.
 *
 * Memoised per Rem id because siblings share ancestors: on a descriptor tree the
 * same parent is consulted once per child, and the same grandparent once per
 * branch, so the cache collapses the fan-out to one read per distinct ancestor.
 *
 * `getCards()` (not the priority cache) is the source of truth here on purpose:
 * a card created since the last cache build is exactly the case that matters
 * most, and the cache would not know about it. It also returns [] for rems
 * inside paused documents, which is the answer we want — a paused ancestor is
 * never going to be practised, so it cannot spoil anything.
 *
 * The due predicate matches the queue's spoiler gate in lib/queue_prefetch: a
 * disabled direction is absent from getCards() entirely, and a never-practised
 * card carries a real nextRepetitionTime, so a brand-new flashcard on the parent
 * counts as due. Fails OPEN — a read that throws reports "not due" and the
 * descendant is kept, rather than being silently withheld.
 */
async function readAncestorInfo(
  plugin: RNPlugin,
  remId: RemId,
  now: number,
  cache: Map<RemId, AncestorInfo>
): Promise<AncestorInfo> {
  const cached = cache.get(remId);
  if (cached) return cached;

  let info: AncestorInfo = { parentId: null, hasDueCard: false, text: undefined };
  try {
    const rem = await plugin.rem.findOne(remId);
    if (rem) {
      const cards = (await rem.getCards()) || [];
      info = {
        parentId: (rem.parent as RemId | undefined) ?? null,
        hasDueCard: cards.some((c: any) => (c.nextRepetitionTime ?? Infinity) <= now),
        text: rem.text,
      };
    }
  } catch (e) {
    console.warn(`[PRD] Ancestor read failed for ${remId}:`, e);
  }

  cache.set(remId, info);
  return info;
}

/**
 * Finds the ancestor whose answer this card would give away.
 *
 * RemNote renders a card's ancestors as context above the question, so
 * practising a second-level descriptor puts its parent descriptor — answer and
 * all — on screen before the parent's own card is ever asked. When both are due
 * and the child happens to be scheduled first, the parent is answered for free;
 * a mature card with years of stability is graded on a memory it never had to
 * retrieve. Native RemNote does not prevent this, so the review document does.
 *
 * SCOPE: parent and grandparent only, as requested. Deeper ancestors are
 * displayed too, but the risk falls off sharply with distance — beyond two
 * levels the context line is usually a section or document title rather than a
 * descriptor carrying an answer — and every extra level is another read per
 * candidate.
 *
 * Returns the HIGHEST due ancestor, not the nearest: when both parent and
 * grandparent are due, releasing the grandparent first frees the parent for the
 * next document, which in turn frees this card — the tree unblocks top-down, one
 * level per review, instead of stalling on a parent that is itself blocked.
 */
async function findDueAncestorSpoiler(
  plugin: RNPlugin,
  rem: PluginRem,
  now: number,
  cache: Map<RemId, AncestorInfo>
): Promise<{ remId: RemId; level: 1 | 2; text: any } | null> {
  const parentId = (rem.parent as RemId | undefined) ?? null;
  if (!parentId) return null;

  const parent = await readAncestorInfo(plugin, parentId, now, cache);

  if (parent.parentId) {
    const grandparent = await readAncestorInfo(plugin, parent.parentId, now, cache);
    if (grandparent.hasDueCard) {
      return { remId: parent.parentId, level: 2, text: grandparent.text };
    }
  }

  if (parent.hasDueCard) {
    return { remId: parentId, level: 1, text: parent.text };
  }

  return null;
}

export interface ReviewDocumentConfig {
  scopeRemId: string | null;  // null = full KB
  itemCount: number;
  cardRatio: number | 'no-cards' | 'no-rem';
  /** When true, flashcard rems inside paused documents are excluded and reported. Default: true. */
  filterPaused: boolean;
  /** Items with priority ≤ this value are kept even when filterPaused is true. Default: 20. */
  pausedPriorityThreshold: number;
}

/**
 * Create a priority-based review document with mixed content
 */
export async function createPriorityReviewDocument(
  plugin: RNPlugin,
  config: ReviewDocumentConfig
): Promise<{
  doc: PluginRem;
  actualItemCount: number;
  skippedPausedItems: SkippedPausedItem[];
  skippedAncestorItems: SkippedAncestorItem[];
}> {
  const { scopeRemId, itemCount, cardRatio, filterPaused, pausedPriorityThreshold } = config;

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

  // Build scope once and reuse for both IncRems and Cards
  const comprehensiveScopeIds = scopeRem
    ? await buildComprehensiveScope(plugin, scopeRem._id)
    : null;

  // IncRems
  let scopedIncRems = allIncRems;
  if (comprehensiveScopeIds) {
    scopedIncRems = allIncRems.filter(r => comprehensiveScopeIds.has(r.remId));
  }
  const dueIncRems = scopedIncRems.filter(rem => rem.nextRepDate <= now);

  // Cards
  // This fetches the actual cards we will use.
  // It might find cards NOT present in allCardInfos if the cache is stale.
  const cardsWithPriority = await getDueCardsWithPriorities(
    plugin,
    scopeRem,
    true,
    comprehensiveScopeIds ?? undefined
  );

  // Skipped paused items are collected lazily inside addCard as cards are pulled.
  // card.getAll() (used by the cache) returns cards for paused rems while
  // rem.getCards() returns [] — the Deck powerup Status slot is the reliable
  // signal. We check only candidates actually considered for inclusion, so the
  // list stays small and meaningful.
  const skippedPausedItems: SkippedPausedItem[] = [];

  // 3b. Establish "Universe" for Percentiles
  // We start with the cached data (allCardInfos) filtered by scope
  const allCardInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
  let universeCardInfos = allCardInfos;
  if (comprehensiveScopeIds) {
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

  // Use the SAFE universe list that definitely includes our due cards.
  // Per-card universe: each rem's percentile is the mean rank of its cards
  // within the expanded per-card population — same value used by the
  // Weighted Shield and the `kbPercentile` shown in the rem's priority badge.
  const cardPercentiles = calculateCardRemPercentilesFromCards(universeCardInfos);

  // --- DEBUG & FIX END ---

  // 4. Apply sorting criteria (Randomness)
  const incRemRandomness = await getSortingRandomness(plugin);
  const cardRandomness = await getCardRandomness(plugin);
  const weightK = await getWeightSelectionK(plugin);

  const sortedIncRems = applySortingCriteria((dueIncRems as any[]), incRemRandomness, weightK);
  const sortedCards = applySortingCriteria(cardsWithPriority, cardRandomness, weightK);

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

  // Priority of every Rem the cache knows about, scope or not. A substituted
  // ancestor is usually in `dueCardByRemId` already; this covers the one that is
  // not — an ancestor sitting just outside a document-scoped selection.
  const cachedPriorityByRemId = new Map(allCardInfos.map(c => [c.remId, c.priority]));

  // Ancestor-spoiler state. Both are filled lazily inside addCard, so the reads
  // are bounded by how many cards the document actually pulls, and the cache
  // collapses the ancestors shared by siblings into one read each.
  const skippedAncestorItems: SkippedAncestorItem[] = [];
  const ancestorInfoCache = new Map<RemId, AncestorInfo>();

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
    // High-priority items (priority ≤ pausedPriorityThreshold) bypass the filter
    // and are always included regardless of pause status.
    if (filterPaused && item.priority > pausedPriorityThreshold && await isInPausedDocument(item.rem)) {
      skippedPausedItems.push({
        remId: item.rem._id,
        name: await safeRemTextToString(plugin, item.rem.text),
        priority: item.priority,
      });
      return true; // advance index without adding to mixedItems
    }

    // Ancestor-spoiler check. A card whose parent or grandparent is itself due
    // would put that ancestor's answer on screen — as the context line above the
    // question — before the ancestor's own card is ever asked. RemNote does not
    // prevent this natively, so the descendant is held back here.
    //
    // SWAP, not skip: the blocking ancestor takes the descendant's place in the
    // document. Dropping the descendant alone would leave the block standing —
    // the ancestor might not be picked this time, and the same pair would collide
    // again in the next document. Practising the ancestor now is what frees the
    // descendant for the next one, so the tree drains top-down instead of
    // deadlocking. The count is preserved too: one item out, one item in.
    const spoiler = await findDueAncestorSpoiler(plugin, item.rem, now, ancestorInfoCache);
    if (spoiler) {
      let ancestorAction: SkippedAncestorItem['ancestorAction'] = 'already-included';

      if (!addedRemIds.has(spoiler.remId)) {
        const ancestorRem = await plugin.rem.findOne(spoiler.remId);
        if (ancestorRem) {
          const ancestorEntry = dueCardByRemId.get(spoiler.remId);
          mixedItems.push({
            rem: ancestorRem,
            type: 'flashcard',
            // The ancestor keeps its own priority when we know it. Falling back
            // to the descendant's is not a guess about the ancestor so much as a
            // statement that it is worth exactly as much as the item it displaced.
            priority: ancestorEntry?.priority ?? cachedPriorityByRemId.get(spoiler.remId) ?? item.priority,
            percentile: cardPercentiles[spoiler.remId] ?? 100,
          });
          // Marking it added also stops sortedCards from queueing it twice when
          // the iteration later reaches its own index.
          addedRemIds.add(spoiler.remId);
          ancestorAction = 'added';
        } else {
          console.warn(`[PRD] Due ancestor ${spoiler.remId} could not be loaded for substitution.`);
          ancestorAction = 'unavailable';
        }
      }

      skippedAncestorItems.push({
        remId: item.rem._id,
        name: await safeRemTextToString(plugin, item.rem.text),
        priority: item.priority,
        ancestorRemId: spoiler.remId,
        ancestorName: await safeRemTextToString(plugin, spoiler.text),
        level: spoiler.level,
        ancestorAction,
      });
      return true; // advance index without adding the descendant
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
    // Siblings need no ancestor-spoiler check of their own: they share this
    // rem's parent and grandparent, so the check above already answered for them.
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

  // 6. Finalise skipped lists and log
  if (skippedPausedItems.length > 0) {
    skippedPausedItems.sort((a, b) => a.priority - b.priority);
    console.log(
      `[PRD] ${skippedPausedItems.length} flashcard rems skipped (paused documents):`,
      skippedPausedItems.map((s) => `P${s.priority} — ${s.name} [${s.remId}]`)
    );
  }

  if (skippedAncestorItems.length > 0) {
    skippedAncestorItems.sort((a, b) => a.priority - b.priority);
    const substituted = skippedAncestorItems.filter((s) => s.ancestorAction === 'added').length;
    console.log(
      `[PRD] ${skippedAncestorItems.length} flashcard rems held back (due ancestor would spoil them), ` +
        `${substituted} ancestors pulled in as replacements:`,
      skippedAncestorItems.map(
        (s) =>
          `P${s.priority} — ${s.name} [${s.remId}] ← blocked by ` +
          `${s.level === 1 ? 'parent' : 'grandparent'} "${s.ancestorName}" [${s.ancestorRemId}] (${s.ancestorAction})`
      )
    );
  }

  // 6. Add metadata to document
  const scopeName = scopeRemId
    ? (await plugin.rem.findOne(scopeRemId))?.text?.join('') || 'Document'
    : 'Full Knowledge Base';

  // Format randomness as percentage
  const incRemRandPct = Math.round(incRemRandomness * 100);
  const cardRandPct = Math.round(cardRandomness * 100);

  // universeCardInfos includes inheritance-only rems (tagged for priority propagation
  // but with cardCount: 0). Filter to actual card-bearing rems for the summary counts.
  const remsWithCards = universeCardInfos.filter(c => (typeof c.cardCount === 'number' ? c.cardCount : 1) > 0);
  const totalCardsInScope = remsWithCards.reduce((sum, info) => {
    return sum + (typeof info.cardCount === 'number' ? info.cardCount : 1);
  }, 0);
  const dueCardsInScope = remsWithCards.reduce((sum, info) => sum + (info.dueCards || 0), 0);
  const dueCardRemsCount = remsWithCards.filter(c => (c.dueCards || 0) > 0).length;

  const skippedLine = skippedPausedItems.length > 0
    ? `\nSkipped (paused docs): ${skippedPausedItems.length} flashcard rems`
    : '';

  const ancestorLine = skippedAncestorItems.length > 0
    ? `\nHeld back (due ancestor): ${skippedAncestorItems.length} flashcard rems, ` +
      `${skippedAncestorItems.filter((s) => s.ancestorAction === 'added').length} ancestors swapped in`
    : '';

  const metadataText = `Scope: ${scopeName}
Scope Size: ${scopedIncRems.length} IncRems, ${remsWithCards.length} Rems with Cards, ${totalCardsInScope} Cards
Due: ${dueIncRems.length} IncRems, ${dueCardRemsCount} Rems with Cards, ${dueCardsInScope} Cards
Selected Items: ${mixedItems.length} (${mixedItems.filter(i => i.type === 'incremental').length} IncRems, ${mixedItems.filter(i => i.type === 'flashcard').length} Rems with Cards)${skippedLine}${ancestorLine}
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

    // Stored on the graph Rem itself rather than under a synced key, so it is
    // deleted along with the review document. Plugin storage has no deletion
    // API, so the old per-graph keys could only ever be orphaned.
    await saveReviewGraphData(plugin, graphRem, graphData);
  }


  // 8. Create portals in the document
  const reviewQueueTag = await findOrCreateTag(plugin, 'Priority Review Queue');
  if (reviewQueueTag) {
    await reviewDoc.addTag(reviewQueueTag);
    // Also live under the tag Rem, rather than at the top level of the knowledge
    // base. This changes nothing the user sees — RemNote lists a review document
    // under its tag as an instance ("All Tagged Bullets") whether or not it is
    // also a child, and a document queue already gathers a tag's instances with
    // their descendants — but it keeps the review documents together instead of
    // scattering one more timestamped top-level document per session.
    await reviewDoc.setParent(reviewQueueTag);
    // The tag Rem is the one door to every review document ever built, so it
    // earns a permanent sidebar slot — offered once, then left to the user.
    await ensureReviewQueueTagPinnedOnce(plugin, reviewQueueTag);
  }

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

  return { doc: reviewDoc, actualItemCount: mixedItems.length, skippedPausedItems, skippedAncestorItems };
}
