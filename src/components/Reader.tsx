// components/Reader.tsx
import {
  PDFWebReader,
  usePlugin,
  useTracker,
  BuiltInPowerupCodes,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React from 'react';
import { activeHighlightIdKey, powerupCode, pageRangeWidgetId } from '../lib/consts';
import {
  HTMLActionItem,
  HTMLHighlightActionItem,
  PDFActionItem,
  PDFHighlightActionItem,
} from '../lib/types';
import {
  getIncrementalReadingPosition,
  getIncrementalPageRange,
  clearIncrementalPDFData,
  addPageToHistory,
} from '../lib/pdfUtils';

interface ReaderProps {
  actionItem: PDFActionItem | PDFHighlightActionItem | HTMLActionItem | HTMLHighlightActionItem;
}

const sharedProps = {
  height: '100%',
  width: '100%',
  initOnlyShowReader: false,
};

export function Reader(props: ReaderProps) {
  const { actionItem } = props;
  const plugin = usePlugin();
  const hasScrolled = React.useRef(false);
  const [isReaderReady, setIsReaderReady] = React.useState(false);
  const pdfReaderRef = React.useRef<any>(null);
  const [currentPage, setCurrentPage] = React.useState<number>(1);
  const [totalPages, setTotalPages] = React.useState<number>(0);
  const [pageInputValue, setPageInputValue] = React.useState<string>('1');
  const [pageRangeStart, setPageRangeStart] = React.useState<number>(1);
  const [pageRangeEnd, setPageRangeEnd] = React.useState<number>(0);
  const [isInputFocused, setIsInputFocused] = React.useState<boolean>(false);

  const remData = useTracker(async (rp) => {
    try {
      const pdfRem = actionItem.rem;
      if (!pdfRem) return null;

      console.log('PDF Rem ID:', pdfRem._id, 'Parent:', pdfRem.parent);

      // Find the incremental rem context
      let incrementalRem = null;
      
      // Try to get from widget context first
      try {
        const widgetContext = await plugin.widget.getWidgetContext();
        if (widgetContext?.remId && widgetContext.remId !== pdfRem._id) {
          const contextRem = await plugin.rem.findOne(widgetContext.remId);
          if (contextRem && await contextRem.hasPowerup(powerupCode)) {
            incrementalRem = contextRem;
            console.log('Found incremental rem from context:', incrementalRem._id);
          }
        }
      } catch (contextError) {
        console.log('No widget context available:', contextError.message);
      }

      // Check parent rem
      if (!incrementalRem && pdfRem.parent) {
        try {
          const parentRem = await plugin.rem.findOne(pdfRem.parent);
          if (parentRem && await parentRem.hasPowerup(powerupCode)) {
            incrementalRem = parentRem;
          }
        } catch (error) {
          console.error('Error finding parent rem:', error);
        }
      }

      // Search for incremental rems containing this PDF
      if (!incrementalRem) {
        try {
          const allRems = await plugin.rem.findMany();
          for (const candidateRem of allRems) {
            if (await candidateRem.hasPowerup(powerupCode)) {
              const descendants = await candidateRem.getDescendants();
              if (descendants.some(desc => desc._id === pdfRem._id)) {
                incrementalRem = candidateRem;
                console.log('Found incremental rem containing PDF:', incrementalRem._id);
                break;
              }
            }
          }
        } catch (searchError) {
          console.log('Error searching for referencing rems:', searchError);
        }
      }
      
      const rem = incrementalRem || pdfRem;
      console.log('Using rem for data:', rem._id, 'isIncremental:', !!incrementalRem);

      const remText = rem.text ? await plugin.richText.toString(rem.text) : '';
      const hasDocumentPowerup = await rem.hasPowerup(BuiltInPowerupCodes.Document);

      // Get statistics
      const children = await rem.getChildrenRem();
      const childrenCount = children.length;
      const isIncrementalChecks = await Promise.all(
        children.map(child => child.hasPowerup(powerupCode))
      );
      const incrementalChildrenCount = isIncrementalChecks.filter(Boolean).length;

      const descendants = await rem.getDescendants();
      const descendantsCount = descendants.length;
      const isIncrementalDescendantChecks = await Promise.all(
        descendants.map(descendant => descendant.hasPowerup(powerupCode))
      );
      const incrementalDescendantsCount = isIncrementalDescendantChecks.filter(Boolean).length;

      const remsToCheckForCards = [rem, ...descendants];
      const cardArrays = await Promise.all(
        remsToCheckForCards.map(r => r.getCards())
      );
      const flashcardCount = cardArrays.reduce((total, cards) => total + cards.length, 0);

      // Get highlight count
      let pdfHighlightCount = 0;
      try {
        const pdfChildren = await pdfRem.getChildrenRem();
        const pdfDescendants = await pdfRem.getDescendants();
        const allPdfRems = [...pdfChildren, ...pdfDescendants];
        const highlightChecks = await Promise.all(
          allPdfRems.map(child => child.hasPowerup(BuiltInPowerupCodes.PDFHighlight))
        );
        pdfHighlightCount = highlightChecks.filter(Boolean).length;
        console.log('PDF highlight count:', pdfHighlightCount);
      } catch (highlightError) {
        console.error('Error counting PDF highlights:', highlightError);
      }

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
          console.error('Error processing ancestor:', error);
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
        ancestors: ancestorList,
        isUsingIncrementalParent: !!incrementalRem,
        remDisplayName: remText || 'Untitled Rem',
        pdfHighlightCount,
        incrementalRemId: incrementalRem?._id || null,
        pdfRemId: pdfRem._id
      };
    } catch (error) {
      console.error('Error in remData tracker:', error);
      return null;
    }
  }, [actionItem.rem?._id, actionItem.rem?.parent]);

  // Save current page when it changes
  const saveCurrentPage = React.useCallback(async (page: number) => {
    if (!remData?.incrementalRemId) return;
    
    const pageKey = `incremental_current_page_${remData.incrementalRemId}_${actionItem.rem._id}`;
    await plugin.storage.setSynced(pageKey, page);
    console.log(`Saved current page ${page} for incremental rem ${remData.incrementalRemId}`);
  }, [remData?.incrementalRemId, actionItem.rem._id, plugin]);

  // Save final page to history when unmounting (leaving the card)
  React.useEffect(() => {
    return () => {
      // Cleanup function runs when component unmounts
      if (remData?.incrementalRemId && currentPage) {
        // Add to history only when leaving
        addPageToHistory(
          plugin,
          remData.incrementalRemId,
          actionItem.rem._id,
          currentPage
        ).then(() => {
          console.log(`Added page ${currentPage} to history when leaving card`);
        });
      }
    };
  }, [remData?.incrementalRemId, actionItem.rem._id, currentPage, plugin]);

  // Handle page navigation
  const incrementPage = React.useCallback(() => {
    const newPage = currentPage + 1;
    const maxPage = pageRangeEnd > 0 ? Math.min(pageRangeEnd, totalPages || Infinity) : (totalPages || Infinity);
    
    if (newPage <= maxPage) {
      setCurrentPage(newPage);
      setPageInputValue(newPage.toString());
      saveCurrentPage(newPage);
      console.log(`Incremented to page ${newPage}`);
    }
  }, [currentPage, totalPages, pageRangeEnd, saveCurrentPage]);

  const decrementPage = React.useCallback(() => {
    const minPage = Math.max(1, pageRangeStart);
    const newPage = Math.max(minPage, currentPage - 1);
    
    setCurrentPage(newPage);
    setPageInputValue(newPage.toString());
    saveCurrentPage(newPage);
    console.log(`Decremented to page ${newPage}`);
  }, [currentPage, pageRangeStart, saveCurrentPage]);

  const handlePageInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setPageInputValue(value);
    
    // Immediately update page if value is valid
    const page = parseInt(value);
    if (!isNaN(page) && page >= 1) {
      const minPage = Math.max(1, pageRangeStart);
      const maxPage = pageRangeEnd > 0 ? Math.min(pageRangeEnd, totalPages || Infinity) : (totalPages || Infinity);
      
      if (page >= minPage && page <= maxPage) {
        setCurrentPage(page);
        saveCurrentPage(page);
        console.log(`Updated page to ${page} via input`);
      }
    }
  }, [pageRangeStart, pageRangeEnd, totalPages, saveCurrentPage]);

  const handlePageInputBlur = React.useCallback(() => {
    setIsInputFocused(false);
    // Validate and correct input on blur
    const page = parseInt(pageInputValue);
    
    if (isNaN(page) || page < 1) {
      // Reset to current valid page
      setPageInputValue(currentPage.toString());
    } else {
      const minPage = Math.max(1, pageRangeStart);
      const maxPage = pageRangeEnd > 0 ? Math.min(pageRangeEnd, totalPages || Infinity) : (totalPages || Infinity);
      
      if (page < minPage || page > maxPage) {
        // Show error message
        const message = pageRangeEnd > 0 
          ? `Page must be between ${minPage} and ${maxPage}` 
          : `Page must be ${minPage} or higher`;
        
        plugin.app.toast(message);
        
        // Reset to previous valid value
        setPageInputValue(currentPage.toString());
      } else if (page !== currentPage) {
        // Valid page number that's different from current
        setCurrentPage(page);
        saveCurrentPage(page);
        console.log(`Set page to ${page} on blur`);
      }
    }
  }, [pageInputValue, currentPage, pageRangeStart, pageRangeEnd, totalPages, saveCurrentPage, plugin]);

  const handlePageInputKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  const handleSetPageRange = React.useCallback(async () => {
    if (!remData?.incrementalRemId || !remData?.pdfRemId) {
      console.log('Reader: Cannot open page range - no incremental rem ID or PDF ID');
      return;
    }
    
    // Store context for the popup with PDF ID
    const context = {
      incrementalRemId: remData.incrementalRemId,
      pdfRemId: remData.pdfRemId,
      totalPages: totalPages,
      currentPage: currentPage
    };
    
    console.log('Reader: Storing page range context:', context);
    await plugin.storage.setSession('pageRangeContext', context);
    
    // Set a flag that we're waiting for popup to close
    await plugin.storage.setSession('pageRangePopupOpen', true);
    
    console.log('Reader: Opening page range popup with widget ID:', pageRangeWidgetId);
    await plugin.widget.openPopup(pageRangeWidgetId);
    console.log('Reader: Page range popup open command sent');
  }, [remData?.incrementalRemId, remData?.pdfRemId, totalPages, currentPage, plugin]);

  // Listen for popup close and reload settings
  React.useEffect(() => {
    const checkForChanges = async () => {
      if (!remData?.incrementalRemId) return;
      
      // Always check for page range changes
      const range = await getIncrementalPageRange(
        plugin,
        remData.incrementalRemId,
        actionItem.rem._id
      );
      
      if (range) {
        if (range.start !== pageRangeStart || range.end !== pageRangeEnd) {
          setPageRangeStart(range.start);
          setPageRangeEnd(range.end);
          console.log(`Page range updated: ${range.start}-${range.end}`);
          
          // Ensure current page is within new range
          const minPage = Math.max(1, range.start);
          const maxPage = range.end > 0 ? Math.min(range.end, totalPages || Infinity) : (totalPages || Infinity);
          
          if (currentPage < minPage) {
            setCurrentPage(minPage);
            setPageInputValue(minPage.toString());
            saveCurrentPage(minPage);
          } else if (currentPage > maxPage) {
            setCurrentPage(maxPage);
            setPageInputValue(maxPage.toString());
            saveCurrentPage(maxPage);
          }
        }
      } else if (pageRangeStart !== 1 || pageRangeEnd !== 0) {
        setPageRangeStart(1);
        setPageRangeEnd(0);
        console.log('Page range cleared');
      }
    };
    
    // Check every 2 seconds
    const interval = setInterval(checkForChanges, 2000);
    
    // Also check immediately when this effect runs
    checkForChanges();
    
    return () => clearInterval(interval);
  }, [remData?.incrementalRemId, actionItem.rem._id, plugin, pageRangeStart, pageRangeEnd, currentPage, totalPages, saveCurrentPage]);

  const handleClearPageRange = React.useCallback(async () => {
    if (!remData?.incrementalRemId) return;
    
    await clearIncrementalPDFData(
      plugin,
      remData.incrementalRemId,
      actionItem.rem._id
    );
    setPageRangeStart(1);
    setPageRangeEnd(0);
    setCurrentPage(1);
    setPageInputValue('1');
    console.log('Cleared all page data');
  }, [remData?.incrementalRemId, actionItem.rem._id, plugin]);

  // Load saved settings only once when component mounts or rem changes
  React.useEffect(() => {
    if (!remData?.incrementalRemId) return;
    
    const loadSavedSettings = async () => {
      const savedPage = await getIncrementalReadingPosition(
        plugin,
        remData.incrementalRemId!,
        actionItem.rem._id
      );
      
      if (savedPage && savedPage > 0) {
        console.log(`Loading saved page ${savedPage}`);
        setCurrentPage(savedPage);
        setPageInputValue(savedPage.toString());
      }
      
      const range = await getIncrementalPageRange(
        plugin,
        remData.incrementalRemId!,
        actionItem.rem._id
      );
      
      if (range) {
        setPageRangeStart(range.start);
        setPageRangeEnd(range.end);
        console.log(`Loaded page range ${range.start}-${range.end}`);
      } else {
        setPageRangeStart(1);
        setPageRangeEnd(0);
      }
    };
    
    loadSavedSettings();
  }, [remData?.incrementalRemId, actionItem.rem._id, plugin]);

  // Handle highlights
  React.useEffect(() => {
    const isHighlight =
      actionItem.type === 'pdf-highlight' || actionItem.type === 'html-highlight';

    if (isHighlight && !hasScrolled.current && isReaderReady) {
      setTimeout(() => {
        actionItem.extract.scrollToReaderHighlight();
        hasScrolled.current = true;
      }, 100);
    }

    const extractId = isHighlight ? actionItem.extract._id : null;
    plugin.storage.setSession(activeHighlightIdKey, extractId);

    return () => {
      plugin.storage.setSession(activeHighlightIdKey, null);
    };
  }, [actionItem, plugin, isReaderReady]);

  // Initialize reader
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setIsReaderReady(true);
    }, 200);

    return () => clearTimeout(timer);
  }, [actionItem.rem._id]);

  // Reset state when switching documents
  React.useEffect(() => {
    setIsReaderReady(false);
    hasScrolled.current = false;
  }, [actionItem.rem._id]);

  if (!remData) {
    return (
      <div className="pdf-reader-viewer" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div className="pdf-reader-section flex-1 overflow-hidden">
          <PDFWebReader 
            remId={actionItem.rem._id} 
            {...sharedProps}
            key={actionItem.rem._id}
          />
        </div>
        <div className="metadata-section px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            <div className="flex items-center justify-between">
              <span>Loading metadata...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { 
    hasDocumentPowerup, 
    childrenCount, 
    ancestors, 
    incrementalChildrenCount,
    descendantsCount,
    incrementalDescendantsCount,
    flashcardCount,
    remDisplayName,
    pdfHighlightCount,
    incrementalRemId
  } = remData;

  return (
    <div className="pdf-reader-viewer" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
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
      
      {/* PDF Reader Section */}
      <div className="pdf-reader-section flex-1 overflow-hidden">
        <PDFWebReader 
          ref={pdfReaderRef}
          remId={actionItem.rem._id} 
          {...sharedProps}
          key={actionItem.rem._id}
        />
      </div>
      
      {/* Metadata Section */}
      <div className="metadata-section px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-between">
            <span>
              {remDisplayName} • Incremental Rem
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
              <span>
                {pdfHighlightCount} {pdfHighlightCount === 1 ? 'highlight' : 'highlights'}
              </span>
              {incrementalRemId && (
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-2">
                    <button 
                      onClick={decrementPage}
                      className="px-2 py-1 text-xs border rounded hover:bg-gray-100 dark:hover:bg-gray-800 dark:border-gray-600"
                      disabled={currentPage <= Math.max(1, pageRangeStart)}
                    >
                      ←
                    </button>
                    
                    <div className="flex items-center gap-1">
                      <span className="text-xs">Page</span>
                      <input
                        type="number"
                        min={Math.max(1, pageRangeStart)}
                        max={pageRangeEnd > 0 ? Math.min(pageRangeEnd, totalPages || Infinity) : (totalPages || undefined)}
                        value={pageInputValue}
                        onChange={handlePageInputChange}
                        onBlur={handlePageInputBlur}
                        onFocus={() => setIsInputFocused(true)}
                        onKeyDown={handlePageInputKeyDown}
                        className="w-12 px-1 py-1 text-xs border rounded text-center dark:bg-gray-800 dark:border-gray-600"
                      />
                      {totalPages > 0 && <span className="text-xs">of {totalPages}</span>}
                    </div>
                    
                    <button 
                      onClick={incrementPage}
                      className="px-2 py-1 text-xs border rounded hover:bg-gray-100 dark:hover:bg-gray-800 dark:border-gray-600"
                      disabled={totalPages > 0 && currentPage >= Math.min(pageRangeEnd > 0 ? pageRangeEnd : Infinity, totalPages)}
                    >
                      →
                    </button>
                  </span>
                  
                  <button
                    onClick={handleSetPageRange}
                    className="px-2 py-1 text-xs border rounded hover:bg-gray-100 dark:hover:bg-gray-800 dark:border-gray-600"
                    title={pageRangeStart > 1 || pageRangeEnd > 0 ? `Range: ${pageRangeStart}-${pageRangeEnd || '∞'}` : "Set page range for this incremental rem"}
                  >
                    {pageRangeStart > 1 || pageRangeEnd > 0 ? `📄 ${pageRangeStart}-${pageRangeEnd || '∞'}` : '📄 Range'}
                  </button>
                  
                  <button
                    onClick={handleClearPageRange}
                    className="px-1 py-1 text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                    title="Clear all page data"
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}