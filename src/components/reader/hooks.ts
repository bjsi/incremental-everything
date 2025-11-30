import { BuiltInPowerupCodes, ReactRNPlugin, RemId } from '@remnote/plugin-sdk';
import { useEffect, useState } from 'react';
import { powerupCode } from '../../lib/consts';
import { findIncrementalRemForPDF, safeRemTextToString } from '../../lib/pdfUtils';

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
      const rem = criticalContext.incrementalRemId 
        ? await plugin.rem.findOne(criticalContext.incrementalRemId) 
        : await plugin.rem.findOne(pdfRemId);
        
      if (!rem || cancelled) return;

      const descendants = await rem.getDescendants();
      if (cancelled) return;
      const descendantsCount = descendants.length;
      const children = await rem.getChildrenRem();
      if (cancelled) return;
      const childrenCount = children.length;

      const remsToProcess = [rem, ...descendants];
      
      let incrementalDescendantsCount = 0;
      let flashcardCount = 0;
      let incrementalChildrenCount = 0;
      
      for (let i = 0; i < remsToProcess.length; i += BATCH_SIZE) {
        if (cancelled) return;
        const batch = remsToProcess.slice(i, i + BATCH_SIZE);
        
        const batchResults = await Promise.all(
          batch.map(async (r) => ({
            remId: r._id,
            isIncremental: await r.hasPowerup(powerupCode),
            cards: await r.getCards(),
          }))
        );
        
        for (const result of batchResults) {
          if (result.isIncremental) {
              incrementalDescendantsCount++;
          }
          if (result.cards.length > 0) {
              flashcardCount += result.cards.length;
          }
          if (children.some(c => c._id === result.remId) && result.isIncremental) {
              incrementalChildrenCount++;
          }
        }
        
        if (i + BATCH_SIZE < remsToProcess.length) await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
      
      let pdfHighlightCount = 0;
      try {
        const pdfRem = await plugin.rem.findOne(pdfRemId);
        if (!pdfRem) {
          throw new Error('PDF rem not found while counting highlights');
        }
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
          
          if (i + highlightBatchSize < allPdfRems.length) await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }

      } catch (highlightError) {
        console.error('[READER DEBUG] Error counting PDF highlights:', highlightError);
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
