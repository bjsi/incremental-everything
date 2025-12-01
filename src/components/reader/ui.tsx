import React, { useMemo } from 'react';
import { PDFWebReader, RemId } from '@remnote/plugin-sdk';
import { StatBadge } from '../StatBadge';

export const MemoizedPdfReader = React.memo(
  React.forwardRef<any, { remId: RemId; height?: string }>(function MemoizedPdfReader(
    { remId, height },
    ref
  ) {
    return (
      <PDFWebReader
        ref={ref}
        remId={remId}
        height={height || '100%'}
        width="100%"
        initOnlyShowReader={false}
      />
    );
  })
);

interface StatsProps {
  isLoading: boolean;
  childrenCount: number | string;
  incrementalChildrenCount: number | string;
  descendantsCount: number | string;
  incrementalDescendantsCount: number | string;
  flashcardCount: number | string;
  pdfHighlightCount: number | string;
}

export function StatsGroup({
  isLoading,
  childrenCount,
  incrementalChildrenCount,
  descendantsCount,
  incrementalDescendantsCount,
  flashcardCount,
  pdfHighlightCount,
}: StatsProps) {
  if (isLoading) {
    return <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>Calculating statistics...</span>;
  }

  return (
    <>
      <StatBadge
        value={childrenCount}
        label="children"
        highlight={incrementalChildrenCount}
        highlightLabel="inc"
      />
      <StatBadge
        value={descendantsCount}
        label="descendants"
        highlight={incrementalDescendantsCount}
        highlightLabel="inc"
      />
      <StatBadge value={flashcardCount} label="cards" />
      <StatBadge value={pdfHighlightCount} label="highlights" />
    </>
  );
}

interface PageControlsProps {
  incrementalRemId: RemId | null | undefined;
  currentPage: number;
  pageRangeStart: number;
  pageRangeEnd: number;
  totalPages: number;
  pageInputValue: string;
  onDecrement: () => void;
  onIncrement: () => void;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onInputBlur: () => void;
  onInputFocus: () => void;
  onInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onSetRange: () => void;
  onClearRange: () => void;
  metadataBarStyles: ReturnType<typeof useMemo>;
}

export function PageControls({
  incrementalRemId,
  currentPage,
  pageRangeStart,
  pageRangeEnd,
  totalPages,
  pageInputValue,
  onDecrement,
  onIncrement,
  onInputChange,
  onInputBlur,
  onInputFocus,
  onInputKeyDown,
  onSetRange,
  onClearRange,
  metadataBarStyles,
}: PageControlsProps) {
  if (!incrementalRemId) return null;

  const activeRangeButtonStyle = {
    ...metadataBarStyles.rangeButton,
    ...(pageRangeStart > 1 || pageRangeEnd > 0 ? metadataBarStyles.activeRangeButton : {}),
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flex: '0 0 auto'
      }}
    >
      <button 
        onClick={onDecrement}
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
          onChange={onInputChange}
          onBlur={onInputBlur}
          onFocus={onInputFocus}
          onKeyDown={onInputKeyDown}
          style={metadataBarStyles.pageInput}
        />
        {totalPages > 0 && (
          <span style={metadataBarStyles.pageLabel}>
            / {totalPages}
          </span>
        )}
      </div>
      
      <button 
        onClick={onIncrement}
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
        onClick={onSetRange}
        style={activeRangeButtonStyle}
        title={pageRangeStart > 1 || pageRangeEnd > 0 ? `Current range: ${pageRangeStart}-${pageRangeEnd || '∞'}` : "Set page range"}
      >
        <span>📄</span>
        <span>{pageRangeStart > 1 || pageRangeEnd > 0 ? `${pageRangeStart}-${pageRangeEnd || '∞'}` : 'Range'}</span>
      </button>
      
      {(pageRangeStart > 1 || pageRangeEnd > 0) && (
        <button
          onClick={onClearRange}
          style={metadataBarStyles.clearButton}
          title="Clear page range"
          onMouseOver={(e) => e.currentTarget.style.opacity = '1'}
          onMouseOut={(e) => e.currentTarget.style.opacity = '0.7'}
        >
          ✕
        </button>
      )}
    </div>
  );
}
