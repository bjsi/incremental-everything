// components/Reader.tsx
import {
  PDFWebReader,
  usePlugin,
  useTrackerPlugin,
  BuiltInPowerupCodes,
  WidgetLocation,
  useRunAsync, // Import useRunAsync, you'll need it
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

const isIOS = /iPhone|iPod/.test(navigator.userAgent) && !/iPad/.test(navigator.userAgent);

const sharedProps = {
  height: isIOS ? '100vh' : '100%',
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

  // --- START: Dark Mode Detection ---
  // Detect RemNote's dark mode by checking for the .dark class
  const [isDarkMode, setIsDarkMode] = React.useState(false);

  React.useEffect(() => {
    let lastKnownDarkMode = false;

    // Function to check if dark mode is active
    const checkDarkMode = () => {
      // Check multiple locations where RemNote might apply the dark class
      const htmlHasDark = document.documentElement.classList.contains('dark');
      const bodyHasDark = document.body?.classList.contains('dark');
      
      // Also check if we're in an iframe and check the parent
      let parentHasDark = false;
      try {
        if (window.parent && window.parent !== window) {
          parentHasDark = window.parent.document.documentElement.classList.contains('dark');
        }
      } catch (e) {
        // Cross-origin iframe, can't access parent
      }

      // Also check for dark mode by looking at computed background color
      const backgroundColor = window.getComputedStyle(document.body).backgroundColor;
      const isDarkByColor = backgroundColor && 
        backgroundColor.startsWith('rgb') && 
        (() => {
          const matches = backgroundColor.match(/\d+/g);
          if (matches && matches.length >= 3) {
            const [r, g, b] = matches.map(Number);
            // If average RGB is less than 128, it's dark
            return (r + g + b) / 3 < 128;
          }
          return false;
        })();

      const isDark = htmlHasDark || bodyHasDark || parentHasDark || isDarkByColor;
      
      // Only update state and log if the value actually changed
      if (isDark !== lastKnownDarkMode) {
        lastKnownDarkMode = isDark;
        setIsDarkMode(isDark);
        
        // Debug logging only on change
        console.log('[Reader Dark Mode] Theme changed to:', isDark ? 'DARK' : 'LIGHT', {
          htmlHasDark,
          bodyHasDark,
          parentHasDark,
          isDarkByColor,
          backgroundColor
        });
      }
    };

    // Create a MutationObserver to watch for class changes
    const observer = new MutationObserver(() => {
      checkDarkMode();
    });

    // Observe both html and body elements
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });

    if (document.body) {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class']
      });
    }

    // Also observe style changes that might indicate theme change
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style']
    });

    // Initial check
    checkDarkMode();

    // Re-check periodically in case we miss the mutation (less frequently)
    const interval = setInterval(checkDarkMode, 2000);

    // Cleanup
    return () => {
      observer.disconnect();
      clearInterval(interval);
    };
  }, []);
  // --- END: Dark Mode Detection ---

  const remData = useTrackerPlugin(async (rp) => {
    try {
      const pdfRem = actionItem.rem;
      if (!pdfRem) return null;

      // --- DEBUG ---
      console.log('[READER DEBUG] Starting remData tracker for PDF:', pdfRem._id);

      // Find the incremental rem context
      let incrementalRem = null;

      // --- START FIX ---
      // NEW STEP 0: Check if the PDF Rem IS the Incremental Rem.
      // This is the case you described.
      try {
        if (await pdfRem.hasPowerup(powerupCode)) {
          incrementalRem = pdfRem;
        }
        console.log('[READER DEBUG] 0. Found from self-check?', incrementalRem?._id || 'No');
      } catch (selfCheckError) {
        console.error('[READER DEBUG] Error during self-check:', selfCheckError);
      }
      // --- END FIX ---
      
      // Try to get from widget context first
      // MODIFIED: Added `if (!incrementalRem)`
      if (!incrementalRem) {
        try {
          const widgetContext = await plugin.widget.getWidgetContext();
          if (widgetContext?.remId && widgetContext.remId !== pdfRem._id) {
            const contextRem = await plugin.rem.findOne(widgetContext.remId);
            if (contextRem && (await contextRem.hasPowerup(powerupCode))) {
              incrementalRem = contextRem;
            }
          }
          // --- DEBUG ---
          console.log('[READER DEBUG] 1. Found from context?', incrementalRem?._id || 'No');
        } catch (contextError) {
          console.log(
            '[READER DEBUG] No widget context available:',
            (contextError as Error).message
          );
        }
      }

      // Check parent rem
      // MODIFIED: Added `if (!incrementalRem)`
      if (!incrementalRem && pdfRem.parent) {
        try {
          const parentRem = await plugin.rem.findOne(pdfRem.parent);
          if (parentRem && (await parentRem.hasPowerup(powerupCode))) {
            incrementalRem = parentRem;
          }
          // --- DEBUG ---
          console.log('[READER DEBUG] 2. Found from parent?', incrementalRem?._id || 'No');
        } catch (error) {
          console.error('[READER DEBUG] Error finding parent rem:', error);
        }
      }

      // Search for incremental rems containing this PDF
      // MODIFIED: Added `if (!incrementalRem)`
      if (!incrementalRem) {
        try {
          // --- DEBUG ---
          console.log('[READER DEBUG] 3. Starting targeted KB search...');

          const incPowerup = await plugin.powerup.getPowerupByCode(powerupCode);
          if (incPowerup) {
            const allIncRems = await incPowerup.taggedRem();

            for (const candidateRem of allIncRems) {
              const descendants = await candidateRem.getDescendants();
              if (descendants.some((desc) => desc._id === pdfRem._id)) {
                incrementalRem = candidateRem;
                break; // Found it
              }
            }
          }
          // --- DEBUG ---
          console.log(
            '[READER DEBUG] 3. Found from targeted KB search?',
            incrementalRem?._id || 'No'
          );
        } catch (searchError) {
          console.log('[READER DEBUG] Error in targeted KB search:', searchError);
        }
      }
      
      const rem = incrementalRem || pdfRem;
      // --- DEBUG ---
      console.log(
        `[READER DEBUG] Using rem for data: ${rem._id} (Is Incremental: ${!!incrementalRem})`
      );

      const remText = rem.text ? await plugin.richText.toString(rem.text) : '';
      const hasDocumentPowerup = await rem.hasPowerup(BuiltInPowerupCodes.Document);

      // Get statistics
      const children = await rem.getChildrenRem();
      const childrenCount = children.length;
      const isIncrementalChecks = await Promise.all(
        children.map((child) => child.hasPowerup(powerupCode))
      );
      const incrementalChildrenCount = isIncrementalChecks.filter(Boolean).length;

      const descendants = await rem.getDescendants();
      const descendantsCount = descendants.length;
      const isIncrementalDescendantChecks = await Promise.all(
        descendants.map((descendant) => descendant.hasPowerup(powerupCode))
      );
      const incrementalDescendantsCount =
        isIncrementalDescendantChecks.filter(Boolean).length;

      const remsToCheckForCards = [rem, ...descendants];
      const cardArrays = await Promise.all(
        remsToCheckForCards.map((r) => r.getCards())
      );
      const flashcardCount = cardArrays.reduce((total, cards) => total + cards.length, 0);

      // Get highlight count
      let pdfHighlightCount = 0;
      try {
        const pdfChildren = await pdfRem.getChildrenRem();
        const pdfDescendants = await pdfRem.getDescendants();
        const allPdfRems = [...pdfChildren, ...pdfDescendants];
        const highlightChecks = await Promise.all(
          allPdfRems.map((child) => child.hasPowerup(BuiltInPowerupCodes.PDFHighlight))
        );
        pdfHighlightCount = highlightChecks.filter(Boolean).length;
      } catch (highlightError) {
        console.error('[READER DEBUG] Error counting PDF highlights:', highlightError);
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
            id: currentParent,
          });

          currentParent = parentRem.parent;
          depth++;
        } catch (error) {
          console.error('[READER DEBUG] Error processing ancestor:', error);
          break;
        }
      }

      // --- DEBUG ---
      console.log(`[READER DEBUG] FINAL incrementalRemId: ${incrementalRem?._id || null}`);

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
        pdfRemId: pdfRem._id,
      };
    } catch (error) {
      console.error('[READER DEBUG] Error in remData tracker:', error);
      return null;
    }
  }, [actionItem.rem?._id, actionItem.rem?.parent]);
  
  // --- NEW: Add state to control PDF rendering on iOS ---
  const [canRenderPdf, setCanRenderPdf] = React.useState(
    !(isIOS && (actionItem.type === 'pdf' || actionItem.type === 'pdf-highlight'))
  );

  // --- NEW: Add an effect to enable rendering after a short delay ---
  React.useEffect(() => {
    // Log the value of isIOS every time this effect runs
    console.log('Reader.tsx: Checking for iOS...', { isIOS });
    if (isIOS && (actionItem.type === 'pdf' || actionItem.type === 'pdf-highlight')) {
      const timer = setTimeout(() => {
        setCanRenderPdf(true);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [actionItem.type]);


  // Save current page position (but NOT to history)
  const saveCurrentPage = React.useCallback(async (page: number) => {
    if (!remData?.incrementalRemId) return;
    
    const pageKey = `incremental_current_page_${remData.incrementalRemId}_${actionItem.rem._id}`;
    await plugin.storage.setSynced(pageKey, page);
    console.log(`Saved current page ${page} for incremental rem ${remData.incrementalRemId}`);
    // Note: We do NOT add to history here - only save the position
  }, [remData?.incrementalRemId, actionItem.rem._id, plugin]);

  // Save to history only once when leaving the card
  React.useEffect(() => {
    // Track the page when component mounts
    const startPage = currentPage;
    
    return () => {
      // Cleanup function runs when component unmounts (leaving the card)
      if (remData?.incrementalRemId && currentPage) {
        // Add to history only once when leaving
        addPageToHistory(
          plugin,
          remData.incrementalRemId,
          actionItem.rem._id,
          currentPage
        ).then(() => {
          console.log(`Added final page ${currentPage} to history when leaving card`);
        });
      }
    };
  }, [remData?.incrementalRemId, actionItem.rem._id, plugin]); // Remove currentPage from dependencies

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

  // This single, combined hook replaces the two previous hooks that caused a race condition.
  React.useEffect(() => {
    // If we don't have the incremental rem context, do nothing.
    if (!remData?.incrementalRemId) return;
    
    const loadAndValidateSettings = async () => {
      // 1. Load data from storage in parallel.
      const savedPagePromise = getIncrementalReadingPosition(
        plugin,
        remData.incrementalRemId,
        actionItem.rem._id
      );
      const rangePromise = getIncrementalPageRange(
        plugin,
        remData.incrementalRemId,
        actionItem.rem._id
      );
      const [savedPage, range] = await Promise.all([savedPagePromise, rangePromise]);
  
      // 2. Set the state for the page range first.
      const startRange = range?.start || 1;
      const endRange = range?.end || 0;
      setPageRangeStart(startRange);
      setPageRangeEnd(endRange);
      console.log(`Loaded page range ${startRange}-${endRange}`);
  
      // 3. Determine the initial page, defaulting to the start of the range or 1.
      let initialPage = savedPage && savedPage > 0 ? savedPage : startRange;
  
      // 4. Validate the initial page against the just-loaded range.
      // Note: We don't use `totalPages` here yet, as it might not be ready.
      const minPage = Math.max(1, startRange);
      if (initialPage < minPage) {
        initialPage = minPage;
      }
      // We only validate against the end of the range if it's explicitly set.
      if (endRange > 0 && initialPage > endRange) {
        initialPage = endRange;
      }
  
      // 5. Set the final page state.
      console.log(`Loading initial page: ${initialPage}`);
      setCurrentPage(initialPage);
      setPageInputValue(initialPage.toString());
    };
    
    loadAndValidateSettings();
  
    // This interval will now handle live updates if the user changes the range in the popup
    const checkForChanges = async () => {
        if (!remData?.incrementalRemId) return; // Guard inside interval

        const range = await getIncrementalPageRange(
          plugin,
          remData.incrementalRemId,
          actionItem.rem._id
        );
        
        const newStart = range?.start || 1;
        const newEnd = range?.end || 0;
  
        // Check if the range has actually changed in storage by comparing with state
        if (newStart !== pageRangeStart || newEnd !== pageRangeEnd) {
            console.log(`Page range updated via polling: ${newStart}-${newEnd}`);
            setPageRangeStart(newStart);
            setPageRangeEnd(newEnd);
  
            // Now, re-validate the current page against the NEW range
            // This time, we can safely use totalPages because the PDF is likely loaded
            const minPage = Math.max(1, newStart);
            const maxPage = newEnd > 0 ? Math.min(newEnd, totalPages || Infinity) : (totalPages || Infinity);
  
            // Use a function to get the latest currentPage state to avoid stale closures
            setCurrentPage(currentVal => {
              let correctedPage = currentVal;
              if (currentVal < minPage) {
                correctedPage = minPage;
              } else if (currentVal > maxPage) {
                correctedPage = maxPage;
              }
    
              if (correctedPage !== currentVal) {
                 console.log(`Correcting current page from ${currentVal} to ${correctedPage} due to range update.`);
                 setPageInputValue(correctedPage.toString());
                 saveCurrentPage(correctedPage);
                 return correctedPage;
              }
              return currentVal;
            });
        }
    };
  
    const interval = setInterval(checkForChanges, 2000);
      
    // Cleanup the interval when the component unmounts
    return () => clearInterval(interval);
  
  }, [remData?.incrementalRemId, actionItem.rem._id, plugin, totalPages]);

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
      <div className="pdf-reader-viewer" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div className="pdf-reader-section flex-1 overflow-hidden">
          <PDFWebReader 
            remId={actionItem.rem._id} 
            {...sharedProps}
            key={actionItem.rem._id}
          />
        </div>
        <div className="metadata-section px-4 py-2 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
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

  // --- START FIX: Use CSS Variables ---
  // Hard-coded dark mode colors for reliable rendering
  const metadataBarStyles = {
    container: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '4px 12px',
      borderTop: isDarkMode ? '1px solid #374151' : '1px solid #e5e7eb',
      backgroundColor: isDarkMode ? '#1f2937' : '#fafafa',
      minHeight: '28px',
      gap: '12px',
      flexWrap: 'nowrap' as const,
      overflow: 'hidden'
    },
    leftSection: {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      minWidth: 0,
      flex: '0 1 auto'
    },
    title: {
      fontSize: '12px',
      fontWeight: 600,
      color: isDarkMode ? '#f9fafb' : '#111827',
      whiteSpace: 'nowrap' as const,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: '300px'
    },
    statsGroup: {
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      fontSize: '11px',
      color: isDarkMode ? '#9ca3af' : '#6b7280',
      flex: '1 1 auto',
      justifyContent: 'center'
    },
    statItem: {
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      whiteSpace: 'nowrap' as const
    },
    statNumber: {
      fontWeight: 600,
      color: isDarkMode ? '#e5e7eb' : '#374151'
    },
    pageControls: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      flex: '0 0 auto'
    },
    pageButton: {
      padding: '2px 6px',
      fontSize: '11px',
      borderRadius: '4px',
      border: isDarkMode ? '1px solid #4b5563' : '1px solid #e5e7eb',
      backgroundColor: isDarkMode ? '#374151' : '#ffffff',
      color: isDarkMode ? '#f3f4f6' : '#111827',
      cursor: 'pointer',
      transition: 'all 0.15s ease',
      fontWeight: 500
    },
    pageInput: {
      width: '55px',
      padding: '2px 4px',
      fontSize: '11px',
      borderRadius: '4px',
      border: isDarkMode ? '1px solid #4b5563' : '1px solid #e5e7eb',
      textAlign: 'center' as const,
      backgroundColor: isDarkMode ? '#374151' : '#ffffff',
      color: isDarkMode ? '#f3f4f6' : '#111827',
    },
    pageLabel: {
      fontSize: '11px',
      color: isDarkMode ? '#9ca3af' : '#6b7280',
    },
    rangeButton: {
      padding: '2px 8px',
      fontSize: '11px',
      borderRadius: '4px',
      border: isDarkMode ? '1px solid #4b5563' : '1px solid #e5e7eb',
      backgroundColor: isDarkMode ? '#374151' : '#ffffff',
      color: isDarkMode ? '#f3f4f6' : '#111827',
      cursor: 'pointer',
      transition: 'all 0.15s ease',
      fontWeight: 500,
      display: 'flex',
      alignItems: 'center',
      gap: '4px'
    },
    clearButton: {
      padding: '2px 6px',
      fontSize: '11px',
      color: isDarkMode ? '#f87171' : '#dc2626',
      cursor: 'pointer',
      transition: 'opacity 0.15s ease',
      opacity: 0.7,
      border: 'none',
      background: 'none'
    }
  };

  // Active range button style when a range is set
  const activeRangeButtonStyle = {
    ...metadataBarStyles.rangeButton,
    ...(pageRangeStart > 1 || pageRangeEnd > 0 ? {
      backgroundColor: isDarkMode ? '#1e3a8a' : '#eff6ff',
      borderColor: isDarkMode ? '#3b82f6' : '#3b82f6',
      color: isDarkMode ? '#bfdbfe' : '#1e40af',
    } : {}),
  };

  return (
    <div className="pdf-reader-viewer" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Breadcrumb Section */}
      {ancestors.length > 0 && (
        <div className="breadcrumb-section" style={{
          padding: '8px 12px',
          borderBottom: isDarkMode ? '1px solid #374151' : '1px solid #e5e7eb',
          backgroundColor: isDarkMode ? '#111827' : '#f9fafb',
          flexShrink: 0
        }}>
          <div style={{
            fontSize: '11px',
            color: isDarkMode ? '#9ca3af' : '#6b7280',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}>
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
        {/* --- UPDATE: Conditionally render the PDFWebReader based on the new state --- */}
        {canRenderPdf ? (
          <PDFWebReader 
            ref={pdfReaderRef}
            remId={actionItem.rem._id} 
            {...sharedProps}
            key={actionItem.rem._id}
          />
        ) : (
          <div style={{ padding: '20px', textAlign: 'center' }}>Loading PDF for iOS...</div>
        )}
      </div>
      
      {/* Improved Metadata Section */}
      <div className="metadata-section" style={metadataBarStyles.container}>
        {/* Left: Title */}
        <div style={metadataBarStyles.leftSection}>
          <span style={metadataBarStyles.title} title={remDisplayName}>
            {remDisplayName}
          </span>
        </div>

        {/* Center: Stats */}
        <div style={metadataBarStyles.statsGroup}>
          <div style={metadataBarStyles.statItem}>
            <span style={metadataBarStyles.statNumber}>{childrenCount}</span>
            <span>direct children</span>
            {incrementalChildrenCount > 0 && (
              <span style={{ color: '#3b82f6' }}>({incrementalChildrenCount} inc)</span>
            )}
          </div>
          
          <div style={metadataBarStyles.statItem}>
            <span style={metadataBarStyles.statNumber}>{descendantsCount}</span>
            <span>descendants</span>
            {incrementalDescendantsCount > 0 && (
              <span style={{ color: '#3b82f6' }}>({incrementalDescendantsCount} inc)</span>
            )}
          </div>
          
          <div style={metadataBarStyles.statItem}>
            <span style={metadataBarStyles.statNumber}>{flashcardCount}</span>
            <span>cards</span>
          </div>
          
          <div style={metadataBarStyles.statItem}>
            <span style={metadataBarStyles.statNumber}>{pdfHighlightCount}</span>
            <span>highlights</span>
          </div>
        </div>

        {/* Right: Page Controls */}
        {incrementalRemId && (
          <div style={metadataBarStyles.pageControls}>
            <button 
              onClick={decrementPage}
              style={{
                ...metadataBarStyles.pageButton,
                opacity: currentPage <= Math.max(1, pageRangeStart) ? 0.4 : 1,
                cursor: currentPage <= Math.max(1, pageRangeStart) ? 'not-allowed' : 'pointer'
              }}
              disabled={currentPage <= Math.max(1, pageRangeStart)}
            >
              ←
            </button>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {/* --- START FIX: Apply pageLabel style --- */}
              <span style={metadataBarStyles.pageLabel}>Page</span>
              {/* --- END FIX --- */}
              <input
                type="number"
                min={Math.max(1, pageRangeStart)}
                max={pageRangeEnd > 0 ? Math.min(pageRangeEnd, totalPages || Infinity) : (totalPages || undefined)}
                value={pageInputValue}
                onChange={handlePageInputChange}
                onBlur={handlePageInputBlur}
                onFocus={() => setIsInputFocused(true)}
                onKeyDown={handlePageInputKeyDown}
                style={metadataBarStyles.pageInput}
              />
              {totalPages > 0 && (
                /* --- START FIX: Apply pageLabel style --- */
                <span style={metadataBarStyles.pageLabel}>
                  / {totalPages}
                </span>
                /* --- END FIX --- */
              )}
            </div>
            
            <button 
              onClick={incrementPage}
              style={{
                ...metadataBarStyles.pageButton,
                opacity: (totalPages > 0 && currentPage >= Math.min(pageRangeEnd > 0 ? pageRangeEnd : Infinity, totalPages)) ? 0.4 : 1,
                cursor: (totalPages > 0 && currentPage >= Math.min(pageRangeEnd > 0 ? pageRangeEnd : Infinity, totalPages)) ? 'not-allowed' : 'pointer'
              }}
              disabled={totalPages > 0 && currentPage >= Math.min(pageRangeEnd > 0 ? pageRangeEnd : Infinity, totalPages)}
            >
              →
            </button>
            
            <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--rn-clr-border-primary, #e5e7eb)', margin: '0 4px' }} />
            
            <button
              onClick={handleSetPageRange}
              // --- START FIX: Use the conditional style object ---
              style={activeRangeButtonStyle}
              // --- END FIX ---
              title={pageRangeStart > 1 || pageRangeEnd > 0 ? `Current range: ${pageRangeStart}-${pageRangeEnd || '∞'}` : "Set page range"}
            >
              <span>📄</span>
              <span>{pageRangeStart > 1 || pageRangeEnd > 0 ? `${pageRangeStart}-${pageRangeEnd || '∞'}` : 'Range'}</span>
            </button>
            
            {(pageRangeStart > 1 || pageRangeEnd > 0) && (
              <button
                onClick={handleClearPageRange}
                style={metadataBarStyles.clearButton}
                title="Clear page range"
                onMouseOver={(e) => e.currentTarget.style.opacity = '1'}
                onMouseOut={(e) => e.currentTarget.style.opacity = '0.7'}
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}