// components/reader/hooks.ts
// UPDATED: Added filtering for powerup slots (Incremental and CardPriority)

import { BuiltInPowerupCodes, ReactRNPlugin, RemId } from '@remnote/plugin-sdk';
import { useEffect, useState } from 'react';
import { powerupCode, allCardPriorityInfoKey } from '../../lib/consts';
import { findIncrementalRemForPDF, safeRemTextToString } from '../../lib/pdfUtils';
import { 
  getChildrenExcludingSlots, 
  getDescendantsExcludingSlots,
  filterOutPowerupSlots 
} from '../../lib/powerupSlotFilter';
import { CardPriorityInfo } from '../../lib/card_priority';

export type AncestorBreadcrumb = { text: string; id: RemId };

export interface CriticalContext {
  ancestors: AncestorBreadcrumb[];
  remDisplayName: string;
  incrementalRemId: RemId | null;
  pdfRemId: RemId;
  hasDocumentPowerup: boolean;
}

export interface Metadata {
  childrenCount: number;
  incrementalChildrenCount: number;
  descendantsCount: number;
  incrementalDescendantsCount: number;
  flashcardCount: number;
  pdfHighlightCount: number;
}

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 10;

export function useCriticalContext(
  plugin: ReactRNPlugin,
  pdfRemId: RemId,
  pdfParentId: RemId | null,
  actionType: 'pdf' | 'pdf-highlight' | 'html' | 'html-highlight' | 'rem' | 'youtube' | 'video',
  highlightExtractId?: RemId
) {
  const [criticalContext, setCriticalContext] = useState<CriticalContext | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadCriticalData = async () => {
      const pdfRem = await plugin.rem.findOne(pdfRemId);
      if (!pdfRem || cancelled) return;
      const incrementalRem = await findIncrementalRemForPDF(plugin, pdfRem, true);

      const rem = incrementalRem || pdfRem;

      const isHighlight = actionType === 'pdf-highlight' || actionType === 'html-highlight';
      const remForName = isHighlight && highlightExtractId
        ? await plugin.rem.findOne(highlightExtractId)
        : rem;
      if (!remForName || cancelled) return;

      const remText = remForName.text ? await safeRemTextToString(plugin, remForName.text) : 'Untitled Rem';
      const hasDocumentPowerup = await rem.hasPowerup(BuiltInPowerupCodes.Document);

      const ancestorList: CriticalContext['ancestors'] = [];
      let currentParent = rem.parent;
      let depth = 0;
      const maxDepth = 10;

      while (currentParent && depth < maxDepth && !cancelled) {
        if (depth % 2 === 0) await new Promise(resolve => setTimeout(resolve, 1));

        try {
          const parentRem = await plugin.rem.findOne(currentParent);
          if (!parentRem || !parentRem.text) break;

          const parentText = await safeRemTextToString(plugin, parentRem.text);

          ancestorList.unshift({
            text: parentText.slice(0, 30) + (parentText.length > 30 ? '...' : ''),
            id: currentParent,
          });

          currentParent = parentRem.parent;
          depth++;
        } catch {
          break;
        }
      }

      if (cancelled) return;

      const nextContext: CriticalContext = {
        ancestors: ancestorList,
        remDisplayName: remText,
        incrementalRemId: incrementalRem?._id || null,
        pdfRemId: pdfRem._id,
        hasDocumentPowerup: hasDocumentPowerup,
      };

      setCriticalContext((prev) => {
        if (
          prev &&
          prev.pdfRemId === nextContext.pdfRemId &&
          prev.incrementalRemId === nextContext.incrementalRemId &&
          prev.remDisplayName === nextContext.remDisplayName &&
          prev.hasDocumentPowerup === nextContext.hasDocumentPowerup &&
          prev.ancestors.length === nextContext.ancestors.length &&
          prev.ancestors.every((a, idx) => {
            const b = nextContext.ancestors[idx];
            return a.id === b.id && a.text === b.text;
          })
        ) {
          return prev;
        }
        return nextContext;
      });
    };
    
    const timeoutId = setTimeout(() => {
      loadCriticalData().catch(console.error);
    }, 50); 

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
    
  }, [pdfRemId, pdfParentId, actionType, highlightExtractId, plugin]);

  return criticalContext;
}

/**
 * OPTIMIZED useMetadataStats HOOK FOR components/reader/hooks.ts
 * 
 * Replace the existing useMetadataStats function with this optimized version.
 * 
 * Key optimization: Uses allCardPriorityInfoKey cache instead of per-rem getCards() calls.
 * This avoids the SDK inconsistency where rem.getCards() sometimes returns [] for valid flashcards.
 * 
 * Performance improvement:
 * - Before: N API calls (one per rem in remsToProcess)
 * - After: 1 session storage read + in-memory filtering
 */

// Add these imports at the top of the file:
// import { allCardPriorityInfoKey } from '../../lib/consts';
// import { CardPriorityInfo } from '../../lib/card_priority';

export function useMetadataStats(
  plugin: ReactRNPlugin,
  criticalContext: CriticalContext | null,
  pdfRemId: RemId
) {
  const [metadata, setMetadata] = useState<Metadata | null>(null);

  useEffect(() => {
    if (!criticalContext) return;
    let cancelled = false;
    
    const calculateMetadata = async () => {
      console.log("[Reader] Starting OPTIMIZED metadata calculation (using cache)...");
      const startTime = Date.now();
      
      const rem = criticalContext.incrementalRemId 
        ? await plugin.rem.findOne(criticalContext.incrementalRemId) 
        : await plugin.rem.findOne(pdfRemId);
        
      if (!rem || cancelled) return;

      // UPDATED: Filter out powerup slots from descendants and children
      const descendants = await getDescendantsExcludingSlots(plugin, rem);
      if (cancelled) return;
      const descendantsCount = descendants.length;
      
      const children = await getChildrenExcludingSlots(plugin, rem);
      if (cancelled) return;
      const childrenCount = children.length;

      // Process descendants (already filtered)
      const remsToProcess = [rem, ...descendants];
      
      // Create a Set of children IDs for quick lookup
      const childrenIds = new Set(children.map(c => c._id));
      
      // Create a Set of all rem IDs we're processing for fast lookup
      const remsToProcessIds = new Set(remsToProcess.map(r => r._id));
      
      // OPTIMIZATION: Use the pre-built cache instead of calling rem.getCards() for each rem
      // The cache already contains cardCount for each rem
      const allCardInfos = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey) || [];
      if (cancelled) return;
      
      // Build a map of remId -> card count for rems in our scope
      const cardCountByRemId = new Map<string, number>();
      for (const cardInfo of allCardInfos) {
        if (remsToProcessIds.has(cardInfo.remId)) {
          cardCountByRemId.set(cardInfo.remId, cardInfo.cardCount);
        }
      }
      console.log(`[Reader] Found ${cardCountByRemId.size} rems with cards in scope (from cache)`);
      
      let incrementalDescendantsCount = 0;
      let flashcardCount = 0;
      let incrementalChildrenCount = 0;
      
      // Process in batches - but now we only need to check hasPowerup, not getCards
      for (let i = 0; i < remsToProcess.length; i += BATCH_SIZE) {
        if (cancelled) return;
        const batch = remsToProcess.slice(i, i + BATCH_SIZE);
        
        const batchResults = await Promise.all(
          batch.map(async (r) => ({
            remId: r._id,
            isIncremental: await r.hasPowerup(powerupCode),
            // Use the pre-built map instead of calling getCards()
            cardCount: cardCountByRemId.get(r._id) || 0,
          }))
        );
        
        for (const result of batchResults) {
          if (result.isIncremental) {
            incrementalDescendantsCount++;
          }
          // Use the card count from our map
          flashcardCount += result.cardCount;
          
          // Use the Set for O(1) lookup instead of Array.some
          if (childrenIds.has(result.remId) && result.isIncremental) {
            incrementalChildrenCount++;
          }
        }
        
        if (i + BATCH_SIZE < remsToProcess.length) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }
      
      // Count PDF highlights (these are different from powerup slots, so we count normally)
      // This part remains unchanged - PDF highlights don't have the same SDK inconsistency
      let pdfHighlightCount = 0;
      try {
        const pdfRem = await plugin.rem.findOne(pdfRemId);
        if (!pdfRem) {
          throw new Error('PDF rem not found while counting highlights');
        }
        
        // Get all PDF children and descendants (without filtering - we want highlights)
        const pdfChildren = await pdfRem.getChildrenRem();
        const pdfDescendants = await pdfRem.getDescendants();
        const allPdfRems = [...pdfChildren, ...pdfDescendants];
        
        const highlightBatchSize = 100;
        for (let i = 0; i < allPdfRems.length; i += highlightBatchSize) {
          if (cancelled) return;
          const highlightBatch = allPdfRems.slice(i, i + highlightBatchSize);
          
          const highlightChecks = await Promise.all(
            highlightBatch.map((child) => child.hasPowerup(BuiltInPowerupCodes.PDFHighlight))
          );
          pdfHighlightCount += highlightChecks.filter(Boolean).length;
          
          if (i + highlightBatchSize < allPdfRems.length) {
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
          }
        }

      } catch (highlightError) {
        console.error('[Reader] Error counting PDF highlights:', highlightError);
      }

      if (cancelled) return;

      const nextMetadata: Metadata = {
        childrenCount,
        incrementalChildrenCount,
        descendantsCount,
        incrementalDescendantsCount,
        flashcardCount,
        pdfHighlightCount
      };

      setMetadata((prev) => {
        if (
          prev &&
          prev.childrenCount === nextMetadata.childrenCount &&
          prev.incrementalChildrenCount === nextMetadata.incrementalChildrenCount &&
          prev.descendantsCount === nextMetadata.descendantsCount &&
          prev.incrementalDescendantsCount === nextMetadata.incrementalDescendantsCount &&
          prev.flashcardCount === nextMetadata.flashcardCount &&
          prev.pdfHighlightCount === nextMetadata.pdfHighlightCount
        ) {
          return prev;
        }
        return nextMetadata;
      });
      
      const elapsedTime = Date.now() - startTime;
      console.log(`[Reader] OPTIMIZED metadata calculation complete in ${elapsedTime}ms.`);
    };

    const timeoutId = setTimeout(() => {
      calculateMetadata().catch(console.error);
    }, 50); 
    
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
    
  }, [criticalContext, pdfRemId, plugin]);

  return metadata;
}

