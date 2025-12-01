// components/Reader.tsx
import { usePlugin, RemId } from '@remnote/plugin-sdk';
import React, { useMemo } from 'react';
import { activeHighlightIdKey, pageRangeWidgetId } from '../lib/consts';
import { HTMLActionItem, HTMLHighlightActionItem, PDFActionItem, PDFHighlightActionItem, RemActionItem } from '../lib/incremental_rem';
import { getIncrementalReadingPosition, getIncrementalPageRange, clearIncrementalPDFData, PageRangeContext } from '../lib/pdfUtils';
import { Breadcrumb, BreadcrumbItem } from './Breadcrumb';
import { useCriticalContext, useMetadataStats } from './reader/hooks';
import { MemoizedPdfReader, PageControls, StatsGroup } from './reader/ui';

interface ReaderProps {
  actionItem: PDFActionItem | PDFHighlightActionItem | HTMLActionItem | HTMLHighlightActionItem;
}

const isIOS = /iPhone|iPod/.test(navigator.userAgent) && !/iPad/.test(navigator.userAgent);

export function Reader(props: ReaderProps) {
  const { actionItem } = props;
  const plugin = usePlugin();

  const pdfRemId = actionItem.rem._id;
  const pdfParentId = actionItem.rem.parent;
  const actionType = actionItem.type;
  const highlightExtract =
    actionType === 'pdf-highlight' || actionType === 'html-highlight'
      ? (actionItem as PDFHighlightActionItem | HTMLHighlightActionItem).extract
      : null;
  const highlightExtractId = highlightExtract?._id;

  // --- 1. useState Hooks (MUST come before useRef if refs use state) ---
  const [isReaderReady, setIsReaderReady] = React.useState(false);
  
  // ✅ Define currentPage FIRST
  const [currentPage, setCurrentPage] = React.useState<number>(1);
  
  const [totalPages, setTotalPages] = React.useState<number>(0);
  const [pageInputValue, setPageInputValue] = React.useState<string>('1');
  const [pageRangeStart, setPageRangeStart] = React.useState<number>(1);
  const [pageRangeEnd, setPageRangeEnd] = React.useState<number>(0);
  const [isInputFocused, setIsInputFocused] = React.useState<boolean>(false);
  const [canRenderPdf, setCanRenderPdf] = React.useState(
    !(isIOS && (actionType === 'pdf' || actionType === 'pdf-highlight'))
  ); 
  
  // useState (Deferred States)
  const criticalContext = useCriticalContext(plugin, pdfRemId, pdfParentId, actionType, highlightExtractId || undefined);
  const metadata = useMetadataStats(plugin, criticalContext, pdfRemId);

  // --- 2. useRef Hooks ---
  const hasScrolled = React.useRef(false);
  const pdfReaderRef = React.useRef<any>(null);
  
  // ✅ Now it works because currentPage is already defined
  const currentPageRef = React.useRef(currentPage);

  // --- 2. useTrackerPlugin MUST BE HERE ---

  // CRITICAL DATA TRACKER (Minimal: Only used to enforce hook order if needed, but not necessary for logic)
  // Reverting to the simplest tracker just to keep the hook count consistent
  // --- 3. ALL useCallback / useMemo Hooks MUST BE HERE ---
  
  // Save current page position (UPDATED TO USE criticalContext)
  const saveCurrentPage = React.useCallback(async (page: number) => {
    const incRemId = criticalContext?.incrementalRemId;
    if (!incRemId) return;
    
    const pageKey = `incremental_current_page_${incRemId}_${pdfRemId}`;
    await plugin.storage.setSynced(pageKey, page);
  // Dependencies MUST include criticalContext
  }, [criticalContext?.incrementalRemId, pdfRemId, plugin]);

  // Handle page navigation (UPDATED TO USE saveCurrentPage)
  const incrementPage = React.useCallback(() => {
    const newPage = currentPage + 1;
    const maxPage = pageRangeEnd > 0 ? Math.min(pageRangeEnd, totalPages || Infinity) : (totalPages || Infinity);
    
    if (newPage <= maxPage) {
      setCurrentPage(newPage);
      setPageInputValue(newPage.toString());
      saveCurrentPage(newPage);
    }
  }, [currentPage, totalPages, pageRangeEnd, saveCurrentPage]);

  const decrementPage = React.useCallback(() => {
    const minPage = Math.max(1, pageRangeStart);
    const newPage = Math.max(minPage, currentPage - 1);
    
    setCurrentPage(newPage);
    setPageInputValue(newPage.toString());
    saveCurrentPage(newPage);
  }, [currentPage, pageRangeStart, saveCurrentPage]);

  const handlePageInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setPageInputValue(value);
    
    const page = parseInt(value);
    if (!isNaN(page) && page >= 1) {
      const minPage = Math.max(1, pageRangeStart);
      const maxPage = pageRangeEnd > 0 ? Math.min(pageRangeEnd, totalPages || Infinity) : (totalPages || Infinity);
      
      if (page >= minPage && page <= maxPage) {
        setCurrentPage(page);
        saveCurrentPage(page);
      }
    }
  }, [pageRangeStart, pageRangeEnd, totalPages, saveCurrentPage]);

  const handlePageInputBlur = React.useCallback(() => {
    setIsInputFocused(false);
    const page = parseInt(pageInputValue);
    
    if (isNaN(page) || page < 1) {
      setPageInputValue(currentPage.toString());
    } else {
      const minPage = Math.max(1, pageRangeStart);
      const maxPage = pageRangeEnd > 0 ? Math.min(pageRangeEnd, totalPages || Infinity) : (totalPages || Infinity);
      
      if (page < minPage || page > maxPage) {
        const message = pageRangeEnd > 0 
          ? `Page must be between ${minPage} and ${maxPage}` 
          : `Page must be ${minPage} or higher`;
        
        plugin.app.toast(message);
        setPageInputValue(currentPage.toString());
      } else if (page !== currentPage) {
        setCurrentPage(page);
        saveCurrentPage(page);
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
    const incRemId = criticalContext?.incrementalRemId;
    const pdfRemId = criticalContext?.pdfRemId;
    
    if (!incRemId || !pdfRemId) {
      return;
    }
    
    const context: PageRangeContext = {
      incrementalRemId: incRemId,
      pdfRemId,
      totalPages: totalPages,
      currentPage: currentPage
    };
    
    await plugin.storage.setSession('pageRangeContext', context);
    await plugin.storage.setSession('pageRangePopupOpen', true);
    
    await plugin.widget.openPopup(pageRangeWidgetId);
  }, [criticalContext?.incrementalRemId, criticalContext?.pdfRemId, totalPages, currentPage, plugin]);

  const handleClearPageRange = React.useCallback(async () => {
    const incRemId = criticalContext?.incrementalRemId;
    if (!incRemId) return;
    
    await clearIncrementalPDFData(
      plugin,
      incRemId,
      pdfRemId
    );
    setPageRangeStart(1);
    setPageRangeEnd(0);
    setCurrentPage(1);
    setPageInputValue('1');
  }, [criticalContext?.incrementalRemId, pdfRemId, plugin]);
  
  // Metadata Bar Styles using RemNote CSS variables
  const metadataBarStyles = useMemo(() => ({
    container: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 16px',
      borderTop: '1px solid var(--rn-clr-border-primary)',
      backgroundColor: 'var(--rn-clr-background-secondary)',
      minHeight: '40px',
      gap: '16px',
      flexWrap: 'nowrap' as const,
      overflow: 'hidden'
    },
    dividerColor: 'var(--rn-clr-border-primary)',
    title: {
      fontSize: '13px',
      fontWeight: 600,
      color: 'var(--rn-clr-content-primary)',
      whiteSpace: 'nowrap' as const,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: '280px'
    },
    statsGroup: {
      display: 'flex',
      alignItems: 'center',
      gap: '20px',
      flex: '1 1 auto',
      justifyContent: 'center'
    },
    pageButton: {
      padding: '4px 8px',
      fontSize: '12px',
      borderRadius: '6px',
      border: '1px solid var(--rn-clr-border-primary)',
      backgroundColor: 'var(--rn-clr-background-primary)',
      color: 'var(--rn-clr-content-primary)',
      cursor: 'pointer',
      transition: 'all 0.15s ease',
      fontWeight: 500
    },
    pageInput: {
      width: '50px',
      padding: '4px 6px',
      fontSize: '12px',
      borderRadius: '6px',
      border: '1px solid var(--rn-clr-border-primary)',
      textAlign: 'center' as const,
      backgroundColor: 'var(--rn-clr-background-primary)',
      color: 'var(--rn-clr-content-primary)',
    },
    pageLabel: {
      fontSize: '11px',
      color: 'var(--rn-clr-content-tertiary)'
    },
    rangeButton: {
      padding: '4px 10px',
      fontSize: '11px',
      borderRadius: '6px',
      border: '1px solid var(--rn-clr-border-primary)',
      backgroundColor: 'var(--rn-clr-background-primary)',
      color: 'var(--rn-clr-content-secondary)',
      cursor: 'pointer',
      transition: 'all 0.15s ease',
      fontWeight: 500,
      display: 'flex',
      alignItems: 'center',
      gap: '4px'
    },
    clearButton: {
      padding: '4px 8px',
      fontSize: '11px',
      color: 'var(--rn-clr-red, #dc2626)',
      cursor: 'pointer',
      transition: 'opacity 0.15s ease',
      opacity: 0.7,
      border: 'none',
      background: 'none'
    },
    activeRangeButton: {
      backgroundColor: 'var(--rn-clr-blue-light, #eff6ff)',
      borderColor: 'var(--rn-clr-blue, #3b82f6)',
      color: 'var(--rn-clr-blue, #1e40af)',
    }
  }), []);

  // Handle breadcrumb click to navigate to ancestor
  const handleBreadcrumbClick = React.useCallback(async (ancestorId: string) => {
    const ancestorRem = await plugin.rem.findOne(ancestorId as RemId);
    if (ancestorRem) {
      await plugin.window.openRem(ancestorRem);
    }
  }, [plugin]);
  
  // --- 4. ALL useEffect Hooks MUST BE HERE ---
  // iOS PDF Render Effect
  React.useEffect(() => {
    if (isIOS && (actionType === 'pdf' || actionType === 'pdf-highlight')) {
      const timer = setTimeout(() => {
        setCanRenderPdf(true);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [actionType]);

  React.useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  // NOTE: Session history is saved by the "Next" button handler in answer_buttons.tsx
  // and by handleReviewAndOpenRem. We do NOT save on unmount to avoid duplicate entries.
 

  
  // Page Range/Position Loader and Poller (Updated to use criticalContext)
  React.useEffect(() => {
    const incRemId = criticalContext?.incrementalRemId;
    if (!incRemId) return;
    // ... (rest of logic)
    const loadAndValidateSettings = async () => {
      const savedPagePromise = getIncrementalReadingPosition(
        plugin,
        incRemId,
        pdfRemId
      );
      const rangePromise = getIncrementalPageRange(
        plugin,
        incRemId,
        pdfRemId
      );
      // ... (rest of load logic)
      const [savedPage, range] = await Promise.all([savedPagePromise, rangePromise]);
  
      const startRange = range?.start || 1;
      const endRange = range?.end || 0;
      setPageRangeStart(startRange);
      setPageRangeEnd(endRange);
      // ... (rest of setting page logic)
      
      let initialPage = savedPage && savedPage > 0 ? savedPage : startRange;
      const minPage = Math.max(1, startRange);
      if (initialPage < minPage) { initialPage = minPage; }
      if (endRange > 0 && initialPage > endRange) { initialPage = endRange; }
      setCurrentPage(initialPage);
      setPageInputValue(initialPage.toString());
    };
    
    loadAndValidateSettings();
  
    const checkForChanges = async () => {
        const range = await getIncrementalPageRange(
          plugin,
          incRemId,
          pdfRemId
        );
        
        const newStart = range?.start || 1;
        const newEnd = range?.end || 0;
        // ... (rest of comparison/update logic)
        if (newStart !== pageRangeStart || newEnd !== pageRangeEnd) {
            setPageRangeStart(newStart);
            setPageRangeEnd(newEnd);
            
            const minPage = Math.max(1, newStart);
            const maxPage = newEnd > 0 ? Math.min(newEnd, totalPages || Infinity) : (totalPages || Infinity);
            
            setCurrentPage(currentVal => {
              let correctedPage = currentVal;
              if (currentVal < minPage) { correctedPage = minPage; } 
              else if (currentVal > maxPage) { correctedPage = maxPage; }
              
              if (correctedPage !== currentVal) {
                 setPageInputValue(correctedPage.toString());
                 saveCurrentPage(correctedPage);
                 return correctedPage;
              }
              return currentVal;
            });
        }
    };
  
    const interval = setInterval(checkForChanges, 2000);
      
    return () => clearInterval(interval);
  
  }, [criticalContext?.incrementalRemId, pdfRemId, plugin, totalPages, pageRangeStart, pageRangeEnd, saveCurrentPage]);

  // Handle highlights
  React.useEffect(() => {
    const isHighlight = actionType === 'pdf-highlight' || actionType === 'html-highlight';

    if (isHighlight && !hasScrolled.current && isReaderReady) {
      setTimeout(() => {
        highlightExtract?.scrollToReaderHighlight();
        hasScrolled.current = true;
      }, 100);
    }

    const extractId = isHighlight ? highlightExtractId : null;
    plugin.storage.setSession(activeHighlightIdKey, extractId);

    return () => {
      plugin.storage.setSession(activeHighlightIdKey, null);
    };
  }, [actionType, highlightExtractId, plugin, isReaderReady]);

  // Initialize reader
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setIsReaderReady(true);
    }, 200);

    return () => clearTimeout(timer);
  }, [pdfRemId]);

  // Reset state when switching documents
  React.useEffect(() => {
    setIsReaderReady(false);
    hasScrolled.current = false;
  }, [pdfRemId]);
  
  // --- 5. RENDER START ---
  
  // Use state variables for rendering
  const isContextLoading = !criticalContext;
  const isMetadataLoading = !metadata;
  
  const { 
    ancestors = [], 
    remDisplayName = 'Loading...',
    incrementalRemId,
    hasDocumentPowerup = false,
  } = criticalContext || {}; 

  const {
    childrenCount = '...',
    incrementalChildrenCount = '...',
    descendantsCount = '...',
    incrementalDescendantsCount = '...',
    flashcardCount = '...',
    pdfHighlightCount = '...',
  } = metadata || {};


  return (
    <div className="pdf-reader-viewer" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      
      {/* Breadcrumb Section */}
      <div
        className="breadcrumb-section"
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--rn-clr-border-primary)',
          backgroundColor: 'var(--rn-clr-background-secondary)',
          flexShrink: 0,
          opacity: isContextLoading ? 0.2 : 1,
          minHeight: '28px',
        }}
      >
        <Breadcrumb
          items={ancestors as BreadcrumbItem[]}
          isLoading={isContextLoading}
          loadingText="Loading breadcrumbs..."
          onClick={handleBreadcrumbClick}
        />
      </div>
      
      {/* PDF Reader Section (Renders INSTANTLY) */}
      <div className="pdf-reader-section flex-1 overflow-hidden">
        {canRenderPdf ? (
          <MemoizedPdfReader
            ref={pdfReaderRef}
            remId={pdfRemId}
            height={isIOS ? '100vh' : '100%'}
            key={pdfRemId} // Ensure key is the PDF rem ID
          />
        ) : (
          <div style={{ padding: '20px', textAlign: 'center' }}>Loading PDF for iOS...</div>
        )}
      </div>
      
      {/* Improved Metadata Section */}
      <div className="metadata-section" style={{...metadataBarStyles.container, opacity: isMetadataLoading ? 0.5 : 1}}>
        {/* Left: Title */}
        <div style={{
           display: 'flex',
           alignItems: 'center',
           gap: '12px',
           minWidth: 0,
           flex: '0 1 auto'
        }}>
          <span style={metadataBarStyles.title} title={remDisplayName}>
            {remDisplayName}
          </span>
        </div>

        {/* Center: Stats */}
        <div style={metadataBarStyles.statsGroup}>
          <StatsGroup
            isLoading={isMetadataLoading}
            childrenCount={childrenCount}
            incrementalChildrenCount={incrementalChildrenCount}
            descendantsCount={descendantsCount}
            incrementalDescendantsCount={incrementalDescendantsCount}
            flashcardCount={flashcardCount}
            pdfHighlightCount={pdfHighlightCount}
          />
        </div>

        {/* Right: Page Controls */}
        <PageControls
          incrementalRemId={incrementalRemId}
          currentPage={currentPage}
          pageRangeStart={pageRangeStart}
          pageRangeEnd={pageRangeEnd}
          totalPages={totalPages}
          pageInputValue={pageInputValue}
          metadataBarStyles={metadataBarStyles}
          onDecrement={decrementPage}
          onIncrement={incrementPage}
          onInputChange={handlePageInputChange}
          onInputBlur={handlePageInputBlur}
          onInputFocus={() => setIsInputFocused(true)}
          onInputKeyDown={handlePageInputKeyDown}
          onSetRange={handleSetPageRange}
          onClearRange={handleClearPageRange}
        />
      </div>
    </div>
  );
}
