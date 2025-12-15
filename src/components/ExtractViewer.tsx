// components/ExtractViewer.tsx
// UPDATED: Added filtering for powerup slots (Incremental and CardPriority)

import React, { useState, useEffect, useCallback } from 'react';
import { PluginRem, RNPlugin, DocumentViewer, BuiltInPowerupCodes, RemId } from '@remnote/plugin-sdk';
import { powerupCode, allCardPriorityInfoKey } from '../lib/consts';
import { safeRemTextToString } from '../lib/pdfUtils';
import { 
  getChildrenExcludingSlots, 
  getDescendantsExcludingSlots 
} from '../lib/powerupSlotFilter';
import { CardPriorityInfo } from '../lib/card_priority';

interface ExtractViewerProps {
  rem: PluginRem;
  plugin: RNPlugin;
}

// Define the critical context structure
interface CriticalContext {
  hasDocumentPowerup: boolean;
  ancestors: Array<{ text: string; id: RemId }>;
}

// Define the metadata structure (already deferred)
interface Metadata {
  childrenCount: number;
  incrementalChildrenCount: number;
  descendantsCount: number;
  incrementalDescendantsCount: number;
  flashcardCount: number;
}

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 10; 

export function ExtractViewer({ rem, plugin }: ExtractViewerProps) {
  if (!rem) return null;

  // --- STATE 1: DEFERRED METADATA (Statistics) ---
  const [metadata, setMetadata] = useState<Metadata | null>(null);

  // --- STATE 2: DEFERRED CRITICAL CONTEXT (Breadcrumbs & Status) ---
  const [criticalContext, setCriticalContext] = useState<CriticalContext | null>(null);

  // -----------------------------------------------------------
  // 1. EFFECT FOR DEFERRED CRITICAL CONTEXT (Breadcrumbs & Status)
  //    - This replaces the slow parts of the original remData tracker.
  // -----------------------------------------------------------
  useEffect(() => {
    setCriticalContext(null);

    const loadCriticalData = async () => {
      // 1. Check Document Powerup (fast)
      const hasDocumentPowerup = await rem.hasPowerup(BuiltInPowerupCodes.Document);

      // 2. Get Ancestors (slow part)
      const ancestorList: CriticalContext['ancestors'] = [];
      let currentParent = rem.parent;
      let depth = 0;
      const maxDepth = 10;

      while (currentParent && depth < maxDepth) {
        try {
          // Add a yield point here to prevent blocking if the hierarchy is deep.
          if (depth % 2 === 0) {
              await new Promise(resolve => setTimeout(resolve, 1));
          }

          const parentRem = await plugin.rem.findOne(currentParent);
          if (!parentRem || !parentRem.text) break;
          
          const parentText = await safeRemTextToString(plugin, parentRem.text);
          
          ancestorList.unshift({
            text: parentText.slice(0, 30) + (parentText.length > 30 ? '...' : ''),
            id: currentParent
          });
          
          currentParent = parentRem.parent;
          depth++;
        } catch (error) {
          break;
        }
      }

      setCriticalContext({
        hasDocumentPowerup,
        ancestors: ancestorList
      });
    };
    
    // Execute after a short delay to ensure initial render is not blocked
    const timeoutId = setTimeout(() => {
      loadCriticalData().catch(console.error);
    }, 10); 

    return () => clearTimeout(timeoutId);
    
  }, [rem._id, plugin]);
  
/**
 * OPTIMIZED METADATA CALCULATION FOR ExtractViewer.tsx
 * 
 * Replace the existing useEffect for metadata calculation with this optimized version.
 * 
 * Key optimization: Uses allCardPriorityInfoKey cache instead of per-rem getCards() calls.
 * This avoids the SDK inconsistency where rem.getCards() sometimes returns [] for valid flashcards.
 * 
 * Performance improvement:
 * - Before: N API calls (one per rem in remsToProcess)
 * - After: 1 session storage read + in-memory filtering
 */

// Add this import at the top of the file:
// import { allCardPriorityInfoKey } from '../lib/consts';
// import { CardPriorityInfo } from '../lib/card_priority';

// -----------------------------------------------------------
// 2. EFFECT FOR DEFERRED METADATA CALCULATION (Statistics)
// OPTIMIZED: Uses allCardPriorityInfoKey cache instead of per-rem getCards()
// -----------------------------------------------------------
useEffect(() => {
  setMetadata(null); 
  
  const calculateMetadata = async () => {
    console.log("[ExtractViewer] Starting OPTIMIZED metadata calculation (using cache)...");
    const startTime = Date.now();
    
    // UPDATED: Filter out powerup slots from descendants
    const descendants = await getDescendantsExcludingSlots(plugin, rem);
    const descendantsCount = descendants.length;
    
    // UPDATED: Filter out powerup slots from children
    const children = await getChildrenExcludingSlots(plugin, rem);
    const childrenCount = children.length;

    const remsToProcess = [rem, ...descendants];
    
    // Create a Set of children IDs for quick lookup
    const childrenIds = new Set(children.map(c => c._id));
    
    // Create a Set of all rem IDs we're processing for fast lookup
    const remsToProcessIds = new Set(remsToProcess.map(r => r._id));
    
    // OPTIMIZATION: Use the pre-built cache instead of calling rem.getCards() for each rem
    // The cache already contains cardCount for each rem
    const allCardInfos = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey) || [];
    
    // Build a map of remId -> card count for rems in our scope
    const cardCountByRemId = new Map<string, number>();
    for (const cardInfo of allCardInfos) {
      if (remsToProcessIds.has(cardInfo.remId)) {
        cardCountByRemId.set(cardInfo.remId, cardInfo.cardCount);
      }
    }
    console.log(`[ExtractViewer] Found ${cardCountByRemId.size} rems with cards in scope (from cache)`);
    
    let incrementalDescendantsCount = 0;
    let flashcardCount = 0;
    let incrementalChildrenCount = 0;
    let processedCount = 0;
    
    // Process in batches - but now we only need to check hasPowerup, not getCards
    for (let i = 0; i < remsToProcess.length; i += BATCH_SIZE) {
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
      processedCount += batch.length;
      
      if (i + BATCH_SIZE < remsToProcess.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    setMetadata({
      childrenCount,
      incrementalChildrenCount,
      descendantsCount,
      incrementalDescendantsCount,
      flashcardCount,
    });
    
    const elapsedTime = Date.now() - startTime;
    console.log(`[ExtractViewer] OPTIMIZED metadata calculation complete. Processed ${processedCount} rems in ${elapsedTime}ms.`);
  };

  const timeoutId = setTimeout(() => {
    calculateMetadata().catch(console.error);
  }, 50); 
  
  return () => clearTimeout(timeoutId);
  
}, [rem._id, plugin]);


  // -----------------------------------------------------------
  // 3. MAIN RENDER LOGIC
  // -----------------------------------------------------------

  // --- IMMEDIATE RENDER ---
  // We no longer rely on remData. We use null coalescing for the deferred state.
  
  const isMetadataLoading = !metadata;
  const {
    childrenCount = '...',
    incrementalChildrenCount = '...',
    descendantsCount = '...',
    incrementalDescendantsCount = '...',
    flashcardCount = '...'
  } = metadata || {}; 

  // Fallback for Critical Context (Breadcrumbs/Status)
  const isContextLoading = !criticalContext;
  const ancestors = criticalContext?.ancestors || [];
  const hasDocumentPowerup = criticalContext?.hasDocumentPowerup ?? false;

  const handleAncestorClick = useCallback(
    async (ancestorId: RemId) => {
      const ancestorRem = await plugin.rem.findOne(ancestorId);
      if (ancestorRem) {
        await plugin.window.openRem(ancestorRem);
      }
    },
    [plugin]
  );
  
  return (
    <div className="extract-viewer" style={{ height: '100vh', display: 'grid', gridTemplateRows: 'auto 1fr auto' }}>
      {/* Breadcrumb Section (Hidden/Placeholder while loading context) */}
      <div className={`breadcrumb-section px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0 ${isContextLoading ? 'opacity-0 h-8' : 'h-auto'}`}>
        {!isContextLoading && ancestors.length > 0 && (
          <div className="text-sm text-gray-600 dark:text-gray-400">
            {ancestors.map((ancestor, index) => (
              <span
                key={ancestor.id}
                onClick={() => handleAncestorClick(ancestor.id)}
                style={{ cursor: 'pointer' }}
              >
                {ancestor.text}
                {index < ancestors.length - 1 && ' › '}
              </span>
            ))}
          </div>
        )}
      </div>
      
      {/* DocumentViewer Section (Renders immediately using rem._id) */}
      <div className="document-viewer-section overflow-hidden">
        <DocumentViewer width={'100%'} height={'100%'} documentId={rem._id} />
      </div>
      
      {/* Metadata Section (Updates when metadata is ready) */}
      <div className={`metadata-section px-4 py-3 border-t flex-shrink-0 ${isMetadataLoading ? 'opacity-50' : ''}`} 
           style={{
             borderColor: '#e5e7eb',
             backgroundColor: isMetadataLoading ? 'rgba(0,0,0,0.05)' : 'transparent',
           }}
      >
        <div className="text-xs text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-between">
            <span>
              {isContextLoading ? 'Loading...' : (hasDocumentPowerup ? 'Document' : 'Extract')} • Incremental Rem
            </span>
            <div className="flex items-center gap-4">
              {isMetadataLoading ? (
                <span>Calculating statistics...</span>
              ) : (
                <>
                  <span>
                    {childrenCount} direct {childrenCount === 1 ? 'child' : 'children'} ({incrementalChildrenCount} incremental)
                  </span>                
                  <span>
                    {descendantsCount} {descendantsCount === 1 ? 'descendant' : 'descendants'} ({incrementalDescendantsCount} incremental)
                  </span>
                  <span>
                    {flashcardCount} {flashcardCount === 1 ? 'flashcard' : 'flashcards'}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
