// components/Reader.tsx
import {
  PDFWebReader,
  usePlugin,
  BuiltInPowerupCodes,
  RemId,
} from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { activeHighlightIdKey, powerupCode, pageRangeWidgetId } from '../lib/consts';
import {
  HTMLActionItem,
  HTMLHighlightActionItem,
  PDFActionItem,
  PDFHighlightActionItem,
  RemActionItem, // Added RemActionItem for type clarity
} from '../lib/incremental_rem';
import {
  getIncrementalReadingPosition,
  getIncrementalPageRange,
  clearIncrementalPDFData,
  addPageToHistory,
  safeRemTextToString,
  PageRangeContext,
  findIncrementalRemForPDF,
} from '../lib/pdfUtils';
import { isIncrementalRem } from '../lib/incremental_rem/cache';

interface ReaderProps {
  actionItem: PDFActionItem | PDFHighlightActionItem | HTMLActionItem | HTMLHighlightActionItem;
}

const isIOS = /iPhone|iPod/.test(navigator.userAgent) && !/iPad/.test(navigator.userAgent);

const sharedProps = {
  height: isIOS ? '100vh' : '100%',
  width: '100%',
  initOnlyShowReader: false,
};

// Define the critical context structure
type AncestorBreadcrumb = { text: string; id: RemId };

interface CriticalContext {
  ancestors: AncestorBreadcrumb[];
  remDisplayName: string;
  incrementalRemId: RemId | null;
  pdfRemId: RemId;
  hasDocumentPowerup: boolean;
}

// Define the metadata structure for deferred calculation
interface Metadata {
  childrenCount: number;
  incrementalChildrenCount: number;
  descendantsCount: number;
  incrementalDescendantsCount: number;
  flashcardCount: number;
  pdfHighlightCount: number;
}

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 10;

export function Reader(props: ReaderProps) {
  const { actionItem } = props;
  const plugin = usePlugin();

  // --- 1. ALL useRef and useState Hooks MUST BE HERE ---
  
  // useRef
  const hasScrolled = React.useRef(false);
  const pdfReaderRef = React.useRef<any>(null);

  // useState (Main UI State)
  const [isReaderReady, setIsReaderReady] = React.useState(false);
  const [currentPage, setCurrentPage] = React.useState<number>(1);
  const [totalPages, setTotalPages] = React.useState<number>(0);
  const [pageInputValue, setPageInputValue] = React.useState<string>('1');
  const [pageRangeStart, setPageRangeStart] = React.useState<number>(1);
  const [pageRangeEnd, setPageRangeEnd] = React.useState<number>(0);
  const [isInputFocused, setIsInputFocused] = React.useState<boolean>(false);
  const [isDarkMode, setIsDarkMode] = React.useState(false);
  const [canRenderPdf, setCanRenderPdf] = React.useState(
    !(isIOS && (actionItem.type === 'pdf' || actionItem.type === 'pdf-highlight'))
  ); 
  
  // useState (Deferred States)
  const [criticalContext, setCriticalContext] = useState<CriticalContext | null>(null);
  const [metadata, setMetadata] = useState<Metadata | null>(null);

  // --- 2. useTrackerPlugin MUST BE HERE ---

  // CRITICAL DATA TRACKER (Minimal: Only used to enforce hook order if needed, but not necessary for logic)
  // Reverting to the simplest tracker just to keep the hook count consistent
  // --- 3. ALL useCallback / useMemo Hooks MUST BE HERE ---
  
  // Save current page position (UPDATED TO USE criticalContext)
  const saveCurrentPage = React.useCallback(async (page: number) => {
    const incRemId = criticalContext?.incrementalRemId;
    if (!incRemId) return;
    
    const pageKey = `incremental_current_page_${incRemId}_${actionItem.rem._id}`;
    await plugin.storage.setSynced(pageKey, page);
  // Dependencies MUST include criticalContext
  }, [criticalContext?.incrementalRemId, actionItem.rem._id, plugin]);

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
      actionItem.rem._id
    );
    setPageRangeStart(1);
    setPageRangeEnd(0);
    setCurrentPage(1);
    setPageInputValue('1');
  }, [criticalContext?.incrementalRemId, actionItem.rem._id, plugin]);
  
  // Metadata Bar Styles (Stabilized)
  const metadataBarStyles = useMemo(() => {
    // ... (rest of styles logic)
    const color = isDarkMode ? '#f9fafb' : '#111827';
    const subColor = isDarkMode ? '#9ca3af' : '#6b7280';
    const border = isDarkMode ? '#374151' : '#e5e7eb';
    const bg = isDarkMode ? '#1f2937' : '#fafafa';
    
    return {
      container: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 12px', 
        borderTop: `1px solid ${border}`, backgroundColor: bg, minHeight: '28px', gap: '12px', 
        flexWrap: 'nowrap' as const, overflow: 'hidden'
      },
      dividerColor: border,
      title: {
        fontSize: '12px', fontWeight: 600, color: color, whiteSpace: 'nowrap' as const, 
        overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '300px'
      },
      statsGroup: {
        display: 'flex', alignItems: 'center', gap: '16px', fontSize: '11px', 
        color: subColor, flex: '1 1 auto', justifyContent: 'center'
      },
      statItem: {
        display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' as const,
      },
      statNumber: { fontWeight: 600, color: color },
      pageButton: {
        padding: '2px 6px', fontSize: '11px', borderRadius: '4px', 
        border: isDarkMode ? '1px solid #4b5563' : '1px solid #e5e7eb',
        backgroundColor: isDarkMode ? '#374151' : '#ffffff', color: isDarkMode ? '#f3f4f6' : '#111827',
        cursor: 'pointer', transition: 'all 0.15s ease', fontWeight: 500
      },
      pageInput: {
        width: '55px', padding: '2px 4px', fontSize: '11px', borderRadius: '4px', 
        border: isDarkMode ? '1px solid #4b5563' : '1px solid #e5e7eb',
        textAlign: 'center' as const, backgroundColor: isDarkMode ? '#374151' : '#ffffff', 
        color: isDarkMode ? '#f3f4f6' : '#111827',
      },
      pageLabel: { fontSize: '11px', color: subColor },
      rangeButton: {
        padding: '2px 8px', fontSize: '11px', borderRadius: '4px', 
        border: isDarkMode ? '1px solid #4b5563' : '1px solid #e5e7eb',
        backgroundColor: isDarkMode ? '#374151' : '#ffffff', color: isDarkMode ? '#f3f4f6' : '#111827',
        cursor: 'pointer', transition: 'all 0.15s ease', fontWeight: 500, display: 'flex', 
        alignItems: 'center', gap: '4px'
      },
      clearButton: {
        padding: '2px 6px', fontSize: '11px', color: isDarkMode ? '#f87171' : '#dc2626',
        cursor: 'pointer', transition: 'opacity 0.15s ease', opacity: 0.7, border: 'none', background: 'none'
      },
      activeRangeButton: {
        backgroundColor: isDarkMode ? '#1e3a8a' : '#eff6ff', borderColor: isDarkMode ? '#3b82f6' : '#3b82f6',
        color: isDarkMode ? '#bfdbfe' : '#1e40af',
      }
    };
  }, [isDarkMode]);

  // Active range button style when a range is set
  const activeRangeButtonStyle = {
    ...metadataBarStyles.rangeButton,
    ...(pageRangeStart > 1 || pageRangeEnd > 0 ? metadataBarStyles.activeRangeButton : {}),
  };
  
  // --- 4. ALL useEffect Hooks MUST BE HERE ---

// Dark Mode Detection Effect
  React.useEffect(() => {
    let lastKnownDarkMode = false;

    const checkDarkMode = () => {
      // Logic for checking dark mode...
      const htmlHasDark = document.documentElement.classList.contains('dark');
      const bodyHasDark = document.body?.classList.contains('dark');
      
      let parentHasDark = false;
      try {
        if (window.parent && window.parent !== window) {
          parentHasDark = window.parent.document.documentElement.classList.contains('dark');
        }
      } catch (e) {
        // Cross-origin iframe, can't access parent
      }

      const backgroundColor = window.getComputedStyle(document.body).backgroundColor;
      let isDarkByColor = false;

      if (backgroundColor && backgroundColor.startsWith('rgb')) {
        const matches = backgroundColor.match(/\d+/g);
        if (matches && matches.length >= 3) {
          const [r, g, b] = matches.map(Number);
          isDarkByColor = (r + g + b) / 3 < 128;
        }
      }

      const isDark = Boolean(htmlHasDark || bodyHasDark || parentHasDark || isDarkByColor);
      
      if (isDark !== lastKnownDarkMode) {
        lastKnownDarkMode = isDark;
        setIsDarkMode(isDark);
      }
    };

    const observer = new MutationObserver(() => { checkDarkMode(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    if (document.body) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    
    checkDarkMode();
    const interval = setInterval(checkDarkMode, 2000);

    return () => {
      observer.disconnect();
      clearInterval(interval);
    };
  }, []);

  // DEFERRED CRITICAL CONTEXT CALCULATION (NEW: Replaces slow tracker logic)
  React.useEffect(() => {
    const pdfRem = actionItem.rem;
    setCriticalContext(null);

    const loadCriticalData = async () => {
      const incrementalRem = await findIncrementalRemForPDF(plugin, pdfRem, true);

      const rem = incrementalRem || pdfRem;
      const remText = rem.text ? await safeRemTextToString(plugin, rem.text) : 'Untitled Rem';
      const hasDocumentPowerup = await rem.hasPowerup(BuiltInPowerupCodes.Document);

      // 2. Get Ancestors (also slow)
      const ancestorList: CriticalContext['ancestors'] = [];
      let currentParent = rem.parent;
      let depth = 0;
      const maxDepth = 10;

      while (currentParent && depth < maxDepth) {
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
        } catch (error) {
          break;
        }
      }

      setCriticalContext({
        ancestors: ancestorList,
        remDisplayName: remText,
        incrementalRemId: incrementalRem?._id || null,
        pdfRemId: pdfRem._id,
        hasDocumentPowerup: hasDocumentPowerup,
      });
    };
    
    // Execute after a short delay to ensure initial render is not blocked
    const timeoutId = setTimeout(() => {
      loadCriticalData().catch(console.error);
    }, 50); 

    return () => clearTimeout(timeoutId);
    
  }, [actionItem.rem._id, actionItem.rem.parent, plugin]);


  // DEFERRED METADATA CALCULATION (Statistics)
  React.useEffect(() => {
    if (!criticalContext) return;
    
    // Reset metadata when context changes
    setMetadata(null); 
    
    const calculateMetadata = async () => {
      // Find the correct rem to calculate stats on (the Incremental Rem or the PDF itself)
      const rem = criticalContext.incrementalRemId 
        ? await plugin.rem.findOne(criticalContext.incrementalRemId) 
        : actionItem.rem;
        
      if (!rem) return;

      // START OF HEAVY I/O (Time-sliced)
      const descendants = await rem.getDescendants();
      const descendantsCount = descendants.length;
      const children = await rem.getChildrenRem();
      const childrenCount = children.length;

      const remsToProcess = [rem, ...descendants];
      
      let incrementalDescendantsCount = 0;
      let flashcardCount = 0;
      let incrementalChildrenCount = 0;
      
      for (let i = 0; i < remsToProcess.length; i += BATCH_SIZE) {
        const batch = remsToProcess.slice(i, i + BATCH_SIZE);
        
        const batchResults = await Promise.all(
          batch.map(async (r) => ({
            remId: r._id,
            isIncremental: await isIncrementalRem(plugin, r._id),
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
        
        // Yield thread
        if (i + BATCH_SIZE < remsToProcess.length) await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
      
      // Get highlight count (Time-sliced)
      let pdfHighlightCount = 0;
      try {
        const pdfRem = actionItem.rem;
        const pdfChildren = await pdfRem.getChildrenRem();
        const pdfDescendants = await pdfRem.getDescendants();
        const allPdfRems = [...pdfChildren, ...pdfDescendants];
        
        const highlightBatchSize = 100;
        for (let i = 0; i < allPdfRems.length; i += highlightBatchSize) {
          const highlightBatch = allPdfRems.slice(i, i + highlightBatchSize);
          
          const highlightChecks = await Promise.all(
            highlightBatch.map((child) => child.hasPowerup(BuiltInPowerupCodes.PDFHighlight))
          );
          pdfHighlightCount += highlightChecks.filter(Boolean).length;
          
          // Yield thread
          if (i + highlightBatchSize < allPdfRems.length) await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }

      } catch (highlightError) {
        console.error('[READER DEBUG] Error counting PDF highlights:', highlightError);
      }
      // END OF HEAVY I/O

      setMetadata({
        childrenCount,
        incrementalChildrenCount,
        descendantsCount,
        incrementalDescendantsCount,
        flashcardCount,
        pdfHighlightCount
      });
    };

    const timeoutId = setTimeout(() => {
        calculateMetadata().catch(console.error);
    }, 50); 
    
    return () => clearTimeout(timeoutId);
    
  }, [criticalContext, actionItem.rem._id, plugin]);
  
  // iOS PDF Render Effect
  React.useEffect(() => {
    if (isIOS && (actionItem.type === 'pdf' || actionItem.type === 'pdf-highlight')) {
      const timer = setTimeout(() => {
        setCanRenderPdf(true);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [actionItem.type]);

// Save to history only once when leaving the card (THE FIX IS HERE)
  React.useEffect(() => {
    // Capture the current context and page for the cleanup function
    const incRemId = criticalContext?.incrementalRemId;
    const finalPage = currentPage;

    return () => {
      // Use the captured local variables
      if (incRemId && finalPage) {
        addPageToHistory(
          plugin,
          incRemId,
          actionItem.rem._id,
          finalPage
        ).then(() => {
          // Log is already in addPageToHistory
        });
      }
    };
  // Dependencies are incRemId (from criticalContext) and currentPage
  }, [criticalContext?.incrementalRemId, actionItem.rem._id, plugin, currentPage]);
 
  // Page Range/Position Loader and Poller (Updated to use criticalContext)
  React.useEffect(() => {
    const incRemId = criticalContext?.incrementalRemId;
    if (!incRemId) return;
    // ... (rest of logic)
    const loadAndValidateSettings = async () => {
      const savedPagePromise = getIncrementalReadingPosition(
        plugin,
        incRemId,
        actionItem.rem._id
      );
      const rangePromise = getIncrementalPageRange(
        plugin,
        incRemId,
        actionItem.rem._id
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
          actionItem.rem._id
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
  
  }, [criticalContext?.incrementalRemId, actionItem.rem._id, plugin, totalPages, pageRangeStart, pageRangeEnd, saveCurrentPage]);

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

  // --- 5. RENDER START ---
  
  // Use remId from props immediately for Document Viewer
  const pdfRemId = actionItem.rem._id;
  
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
      
      {/* Breadcrumb Section (Placeholder until context loads) */}
      <div className="breadcrumb-section" style={{
        padding: '8px 12px',
        borderBottom: isDarkMode ? '1px solid #374151' : '1px solid #e5e7eb',
        backgroundColor: isDarkMode ? '#111827' : '#f9fafb',
        flexShrink: 0,
        opacity: isContextLoading ? 0.2 : 1, // Dim while loading
        minHeight: '28px', // Ensure a minimum height so layout doesn't jump
      }}>
        {!isContextLoading && ancestors.length > 0 && (
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
        )}
        {isContextLoading && <span style={{fontSize: '11px'}}>Loading breadcrumbs...</span>}
      </div>
      
      {/* PDF Reader Section (Renders INSTANTLY) */}
      <div className="pdf-reader-section flex-1 overflow-hidden">
        {canRenderPdf ? (
          <PDFWebReader 
            ref={pdfReaderRef}
            remId={pdfRemId} 
            {...sharedProps}
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
          {isMetadataLoading ? (
            <span>Calculating statistics...</span>
          ) : (
            <>
              <div style={metadataBarStyles.statItem}>
                <span style={metadataBarStyles.statNumber}>{childrenCount}</span>
                <span>direct children</span>
                {incrementalChildrenCount > 0 && (
                  <span style={{ color: isDarkMode ? '#60a5fa' : '#3b82f6' }}>({incrementalChildrenCount} inc)</span>
                )}
              </div>
              
              <div style={metadataBarStyles.statItem}>
                <span style={metadataBarStyles.statNumber}>{descendantsCount}</span>
                <span>descendants</span>
                {incrementalDescendantsCount > 0 && (
                  <span style={{ color: isDarkMode ? '#60a5fa' : '#3b82f6' }}>({incrementalDescendantsCount} inc)</span>
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
            </>
          )}
        </div>

        {/* Right: Page Controls */}
        {incrementalRemId && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flex: '0 0 auto'
          }}>
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
              <span style={metadataBarStyles.pageLabel}>Page</span>
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
                <span style={metadataBarStyles.pageLabel}>
                  / {totalPages}
                </span>
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
            
            <div
              style={{
                width: '1px',
                height: '16px',
                backgroundColor: metadataBarStyles.dividerColor,
                margin: '0 4px',
              }}
            />
            
            <button
              onClick={handleSetPageRange}
              style={activeRangeButtonStyle}
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
