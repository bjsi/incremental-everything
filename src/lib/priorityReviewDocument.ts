import { RNPlugin, PluginRem, RichTextInterface } from '@remnote/plugin-sdk';
import { IncrementalRem } from './incremental_rem';
import { getCardRandomness, getSortingRandomness, applySortingCriteria } from './sorting';
import { getDueCardsWithPriorities } from './card_priority';
import { allIncrementalRemKey } from './consts';


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
  
  // 2. Get scope rem if specified
  const scopeRem = scopeRemId ? (await plugin.rem.findOne(scopeRemId)) ?? null : null;
  
  // 3. Get all incremental rems (filtered by scope and due status)
  const allIncrementalRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
  
  // Filter by scope
  let scopedIncRems = allIncrementalRems;
  if (scopeRem) {
    const descendantIds = (await scopeRem.getDescendants()).map(d => d._id);
    scopedIncRems = allIncrementalRems.filter(
      rem => rem.remId === scopeRemId || descendantIds.includes(rem.remId)
    );
  }
  
  // Filter by due date
  const now = Date.now();
  const dueIncRems = scopedIncRems.filter(rem => rem.nextRepDate <= now);
  
  // 4. Get all flashcards (filtered by scope and due status)
  const cardsWithPriority = await getDueCardsWithPriorities(
    plugin,
    scopeRem,
    true  // Include non-prioritized cards
  );
  
  // 5. Apply sorting criteria to create ordered lists
  const incRemRandomness = await getSortingRandomness(plugin);
  const cardRandomness = await getCardRandomness(plugin);
  
  const sortedIncRems = applySortingCriteria(dueIncRems, incRemRandomness);
  const sortedCards = applySortingCriteria(cardsWithPriority, cardRandomness);
  
  // 6. Mix according to ratio - FIXED LOGIC
  const mixedItems: Array<{ rem: PluginRem; type: 'incremental' | 'flashcard' }> = [];
  let incRemIndex = 0;
  let cardIndex = 0;

  if (typeof cardRatio === 'number') {
    while (mixedItems.length < itemCount) {
      let addedThisCycle = false;
      
      // Try to add one incremental rem
      if (incRemIndex < sortedIncRems.length) {
        const rem = await plugin.rem.findOne(sortedIncRems[incRemIndex].remId);
        if (rem) {
          mixedItems.push({ rem, type: 'incremental' });
          addedThisCycle = true;
        }
        incRemIndex++;
      }

      // Try to add flashcards according to ratio
      for (let i = 0; i < cardRatio && mixedItems.length < itemCount; i++) {
        if (cardIndex < sortedCards.length) {
          mixedItems.push({ rem: sortedCards[cardIndex].rem, type: 'flashcard' });
          cardIndex++;
          addedThisCycle = true;
        }
      }
      
      // If we couldn't add anything this cycle, we're done
      if (!addedThisCycle) {
        break;
      }
    }

  } else if (cardRatio === 'no-cards') {
    for (let i = 0; i < itemCount && i < sortedIncRems.length; i++) {
      const item = sortedIncRems[i];
      const rem = await plugin.rem.findOne(item.remId);
      if (rem) {
        mixedItems.push({ rem, type: 'incremental' });
      }
    }
  } else {
    for (let i = 0; i < itemCount && i < sortedCards.length; i++) {
      const item = sortedCards[i];
      mixedItems.push({ rem: item.rem, type: 'flashcard' });
    }
  }
  
  // 7. Create portals in the document
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
  
  // 8. Add metadata to document
    const scopeName = scopeRemId 
    ? (await plugin.rem.findOne(scopeRemId))?.text?.join('') || 'Document'
    : 'Full Knowledge Base';
  const metadataText = `Scope: ${scopeName}
Items: ${mixedItems.length} (${mixedItems.filter(i => i.type === 'incremental').length} incremental, ${mixedItems.filter(i => i.type === 'flashcard').length} flashcards)
Created: ${timestamp}`;

  // Create a code block with metadata
  const metadataRem = await plugin.rem.createRem();
  if (metadataRem) {
    await metadataRem.setText([metadataText]);
    await metadataRem.setIsCode(true);
    await metadataRem.setParent(reviewDoc);
  }
  
  return reviewDoc;
}
