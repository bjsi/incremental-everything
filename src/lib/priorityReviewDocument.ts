import { RNPlugin, Rem, RichTextInterface } from '@remnote/plugin-sdk';
import { IncrementalRem } from './types';
import { getCardRandomness, getSortingRandomness, applySortingCriteria } from './sorting';
import { getDueCardsWithPriorities } from './cardPriority';
import { allIncrementalRemKey } from './consts';


// Helper function to find or create a tag
async function findOrCreateTag(plugin: RNPlugin, tagName: string): Promise<Rem | undefined> {
  let tag = await plugin.rem.findByName([tagName], null);
  if (!tag) {
    tag = await plugin.rem.createRem();
    if (tag) {
      await tag.setText([tagName]);
    }
  }
  return tag;
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
): Promise<Rem> {
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
  const scopeRem = scopeRemId ? await plugin.rem.findOne(scopeRemId) : null;
  
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
  const mixedItems: Array<{ rem: Rem; type: 'incremental' | 'flashcard' }> = [];
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

  } else {
    // Handle 'no-cards' or 'no-rem'
    const sourceList = cardRatio === 'no-cards' ? sortedIncRems : sortedCards;
    const type = cardRatio === 'no-cards' ? 'incremental' : 'flashcard';
    for (let i = 0; i < itemCount && i < sourceList.length; i++) {
        const item = sourceList[i];
        const rem = item.remId ? await plugin.rem.findOne(item.remId) : item.rem;
        if (rem) {
            mixedItems.push({ rem, type: type as 'incremental' | 'flashcard' });
        }
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