import React from 'react';
import { Rem, RNPlugin, useTracker, DocumentViewer, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { powerupCode } from '../lib/consts';

interface ExtractViewerProps {
  rem: Rem;
  plugin: RNPlugin;
}

export function ExtractViewer({ rem, plugin }: ExtractViewerProps) {
  const remData = useTracker(async (rp) => {
    if (!rem) return null;

    const remText = rem.text ? await plugin.richText.toString(rem.text) : '';
    const hasDocumentPowerup = await rem.hasPowerup(BuiltInPowerupCodes.Document);

    // Get direct children and count incremental ones
    const children = await rem.getChildrenRem();
    const childrenCount = children.length;
    const isIncrementalChecks = await Promise.all(
      children.map(child => child.hasPowerup(powerupCode))
    );
    const incrementalChildrenCount = isIncrementalChecks.filter(Boolean).length;

    // Get all descendants and count incremental ones
    const descendants = await rem.getDescendants();
    const descendantsCount = descendants.length;
    const isIncrementalDescendantChecks = await Promise.all(
      descendants.map(descendant => descendant.hasPowerup(powerupCode))
    );
    const incrementalDescendantsCount = isIncrementalDescendantChecks.filter(Boolean).length;

    // --- UPDATED: Correctly count all flashcard types ---
    const remsToCheckForCards = [rem, ...descendants];
    
    // Fetch the card arrays for every rem and descendant in parallel.
    const cardArrays = await Promise.all(
      remsToCheckForCards.map(r => r.getCards())
    );

    // Sum the number of cards found in each array.
    const flashcardCount = cardArrays.reduce((total, cards) => total + cards.length, 0);
    // ----------------------------------------------------

    // Get ancestors for breadcrumb
    const ancestorList = [];
    let currentParent = rem.parent;
    let depth = 0;
    const maxDepth = 10;

    while (currentParent && depth < maxDepth) {
      try {
        const parentRem = await plugin.rem.findOne(currentParent);
        if (!parentRem || !parentRem.text) break;
        
        const parentText = await plugin.richText.toString(parentRem.text);
        
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
    
    return {
      text: remText,
      hasDocumentPowerup,
      childrenCount,
      incrementalChildrenCount,
      descendantsCount,
      incrementalDescendantsCount,
      flashcardCount,
      ancestors: ancestorList
    };
  }, [rem?._id, rem?.parent]);
  
  if (!rem || !remData) return null;
  
  const { 
    hasDocumentPowerup, 
    childrenCount, 
    ancestors, 
    incrementalChildrenCount,
    descendantsCount,
    incrementalDescendantsCount,
    flashcardCount
  } = remData;
  
  return (
    <div className="extract-viewer" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Breadcrumb Section */}
      {ancestors.length > 0 && (
        <div className="breadcrumb-section px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="text-sm text-gray-600 dark:text-gray-400">
            {ancestors.map((ancestor, index) => (
              <span key={ancestor.id}>
                {ancestor.text}
                {index < ancestors.length - 1 && ' › '}
              </span>
            ))}
          </div>
        </div>
      )}
      
      {/* DocumentViewer Section */}
      <div className="document-viewer-section flex-1 overflow-hidden">
        <DocumentViewer width={'100%'} height={'100%'} documentId={rem._id} />
      </div>
      
      {/* Metadata Section */}
      <div className="metadata-section px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-between">
            <span>
              {hasDocumentPowerup ? 'Document' : 'Extract'} • Incremental Rem
            </span>
            <div className="flex items-center gap-4">
              <span>
                {childrenCount} direct {childrenCount === 1 ? 'child' : 'children'} ({incrementalChildrenCount} incremental)
              </span>                
              <span>
                {descendantsCount} {descendantsCount === 1 ? 'descendant' : 'descendants'} ({incrementalDescendantsCount} incremental)
              </span>
              <span>
                {flashcardCount} {flashcardCount === 1 ? 'flashcard' : 'flashcards'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}