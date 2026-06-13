import { usePlugin, ReactRNPlugin, PDFWebReader } from '@remnote/plugin-sdk';
import React, { useEffect, useRef } from 'react';

export interface SourceReaderViewProps {
  /** Source-document rem to feed into PDFWebReader. */
  hostRemId: string;
  /** The originally-hovered rem (a highlight, or the doc itself). */
  hoveredRemId: string | null;
  /** 'highlight' | 'pdf-source' | 'html-source'. */
  kind: string | null;
  /** Close handler — differs between the modal and floating hosts. */
  onClose: () => void;
}

/**
 * Shared reader UI for both the modal (pdf_source_popup) and floating
 * (pdf_source_floating) Source-popup variants. Renders the SDK PDFWebReader for
 * a Reader source and, for highlights, auto-scrolls to the highlighted passage.
 */
export function SourceReaderView({ hostRemId, hoveredRemId, kind, onClose }: SourceReaderViewProps) {
  const plugin = usePlugin() as ReactRNPlugin;
  const hasScrolled = useRef(false);

  // Scroll the reader to the hovered highlight (highlights only).
  //
  // PDF.js / the native reader takes several seconds to mount inside the iframe
  // (worker init, fake-window setup), so a single early scroll is dropped. We
  // mirror the proven escalating-retry timing from lib/remHelpers
  // (consumePendingScrollRequest): fire repeatedly until it lands.
  useEffect(() => {
    if (kind !== 'highlight' || !hoveredRemId || hasScrolled.current) return;
    hasScrolled.current = true;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const attemptScroll = async () => {
      try {
        const hRem = await plugin.rem.findOne(hoveredRemId);
        if (!hRem || typeof hRem.scrollToReaderHighlight !== 'function') return;
        for (const delay of [1200, 2500, 4000, 6000]) {
          timers.push(
            setTimeout(() => {
              if (cancelled) return;
              try {
                hRem.scrollToReaderHighlight();
              } catch (e) {
                console.error('[SourceReaderView] scroll attempt threw', e);
              }
            }, delay)
          );
        }
      } catch (e) {
        console.error('[SourceReaderView] scroll error', e);
      }
    };
    attemptScroll();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [kind, hoveredRemId, plugin]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        backgroundColor: 'var(--rn-clr-background-primary)',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--rn-clr-border-primary)',
          flex: '0 0 auto',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: '13px' }}>📄 Source</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {kind === 'highlight' && hoveredRemId && (
            <button
              onClick={async () => {
                try {
                  const hRem = await plugin.rem.findOne(hoveredRemId);
                  if (hRem && typeof hRem.scrollToReaderHighlight === 'function') {
                    hRem.scrollToReaderHighlight();
                  }
                } catch (e) {
                  console.error('[SourceReaderView] manual scroll error', e);
                }
              }}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                fontWeight: 600,
                backgroundColor: 'transparent',
                color: '#3b82f6',
                border: '2px solid #3b82f6',
                borderRadius: '4px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#3b82f6';
                e.currentTarget.style.color = 'white';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '#3b82f6';
              }}
              title="Scroll the reader to the highlight"
            >
              🔖 Scroll to Highlight
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: '16px',
              color: 'var(--rn-clr-content-secondary)',
            }}
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <PDFWebReader
          key={hostRemId}
          remId={hostRemId}
          height="100%"
          width="100%"
          initOnlyShowReader={true}
        />
      </div>
    </div>
  );
}
