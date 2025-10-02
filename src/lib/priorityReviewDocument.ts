import { RNPlugin, Rem } from '@remnote/plugin-sdk';
import { IncrementalRem } from './types';
import { getCardRandomness, getSortingRandomness, getCardsPerRem, applySortingCriteria } from './sorting';
import { getDueCardsWithPriorities } from './flashcardPriority';
import { allIncrementalRemKey } from './consts';

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
  
  // 1. Create the review document
  const timestamp = new Date().toLocaleString();
  const scopeName = scopeRemId 
    ? (await plugin.rem.findOne(scopeRemId))?.text?.join('') || 'Document'
    : 'Full KB';
  const docName = `Priority Review - ${scopeName} - ${timestamp}`;
  
  const reviewDoc = await plugin.app.createNewDocument(docName);
  
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
  
  // 6. Mix according to ratio
  const mixedItems: Array<{ rem: Rem; type: 'incremental' | 'flashcard' }> = [];
  
  if (cardRatio === 'no-cards') {
    // Only incremental rems
    for (const incRem of sortedIncRems.slice(0, itemCount)) {
      const rem = await plugin.rem.findOne(incRem.remId);
      if (rem) mixedItems.push({ rem, type: 'incremental' });
    }
  } else if (cardRatio === 'no-rem') {
    // Only flashcards
    for (const flashcard of sortedCards.slice(0, itemCount)) {
      mixedItems.push({ rem: flashcard.rem, type: 'flashcard' });
    }
  } else {
    // Mix based on ratio
    const cardsPerIncRem = cardRatio;
    let incRemIndex = 0;
    let cardIndex = 0;
    let itemCounter = 0;
    
    while (mixedItems.length < itemCount && 
           (incRemIndex < sortedIncRems.length || cardIndex < sortedCards.length)) {
      
      // Add incremental rem
      if (incRemIndex < sortedIncRems.length && itemCounter % (cardsPerIncRem + 1) === 0) {
        const rem = await plugin.rem.findOne(sortedIncRems[incRemIndex].remId);
        if (rem) {
          mixedItems.push({ rem, type: 'incremental' });
          incRemIndex++;
        }
      } 
      // Add flashcards
      else if (cardIndex < sortedCards.length) {
        mixedItems.push({ rem: sortedCards[cardIndex].rem, type: 'flashcard' });
        cardIndex++;
      }
      // Fallback to incremental if no flashcards left
      else if (incRemIndex < sortedIncRems.length) {
        const rem = await plugin.rem.findOne(sortedIncRems[incRemIndex].remId);
        if (rem) {
          mixedItems.push({ rem, type: 'incremental' });
          incRemIndex++;
        }
      }
      
      itemCounter++;
    }
  }
  
  // 7. Create portals in the document
  for (const item of mixedItems) {
    const portal = await plugin.richText.rem(item.rem).value();
    const child = await reviewDoc.addChild(portal);
    
    // Add type indicator
    const typeTag = item.type === 'incremental' ? '[INC]' : '[FC]';
    await child.setText([typeTag, ' ', ...portal]);
  }
  
  // 8. Add metadata to document
  await reviewDoc.addTag('Priority Review Queue');
  await reviewDoc.setText([
    `Priority Review Document`,
    '\n',
    `Scope: ${scopeName}`,
    '\n',
    `Items: ${mixedItems.length} (${mixedItems.filter(i => i.type === 'incremental').length} incremental, ${mixedItems.filter(i => i.type === 'flashcard').length} flashcards)`,
    '\n',
    `Created: ${timestamp}`
  ]);
  
  return reviewDoc;
}