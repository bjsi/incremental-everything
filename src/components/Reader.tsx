// components/Reader.tsx
import { usePlugin, RemId, ReactRNPlugin } from '@remnote/plugin-sdk';
import React, { useMemo } from 'react';
import { activeHighlightIdKey, pageRangeWidgetId } from '../lib/consts';
import { HTMLActionItem, HTMLHighlightActionItem, PDFActionItem, PDFHighlightActionItem, RemActionItem } from '../lib/incremental_rem';
import { getIncrementalReadingPosition, getIncrementalPageRange, clearIncrementalPDFData, PageRangeContext } from '../lib/pdfUtils';
import { Breadcrumb, BreadcrumbItem } from './Breadcrumb';
import { useCriticalContext, useMetadataStats } from './reader/hooks';
import { MemoizedPdfReader, PageControls, StatsGroup } from './reader/ui';
import { usePdfPageControls } from './reader/usePdfPageControls';

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
  const [totalPages, setTotalPages] = React.useState<number>(0);
  const [canRenderPdf, setCanRenderPdf] = React.useState(
    !(isIOS && (actionType === 'pdf' || actionType === 'pdf-highlight'))
  );

  // useState (Deferred States)
  const criticalContext = useCriticalContext(plugin as ReactRNPlugin, pdfRemId, pdfParentId, actionType, highlightExtractId || undefined);
  const metadata = useMetadataStats(plugin as ReactRNPlugin, criticalContext, pdfRemId);

  // --- PDF Controls Hook ---
  const pdfControls = usePdfPageControls(
    plugin,
    criticalContext?.incrementalRemId,
    pdfRemId,
    totalPages
  );

  // --- 2. useRef Hooks ---
  const hasScrolled = React.useRef(false);
  const pdfReaderRef = React.useRef<any>(null);
  const currentPageRef = React.useRef(pdfControls.currentPage);

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
    currentPageRef.current = pdfControls.currentPage;
  }, [pdfControls.currentPage]);

  // NOTE: Session history is saved by the "Next" button handler in answer_buttons.tsx
  // and by handleReviewAndOpenRem. We do NOT save on unmount to avoid duplicate entries.



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
      <div className="metadata-section" style={{ ...metadataBarStyles.container, opacity: isMetadataLoading ? 0.5 : 1 }}>
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
          {...pdfControls}
          totalPages={totalPages}
          metadataBarStyles={metadataBarStyles}
        />
      </div>
    </div>
  );
}
