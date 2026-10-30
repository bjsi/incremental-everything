import { usePlugin, ReactRNPlugin, PDFWebReader } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import { safeRemTextToString } from '../lib/pdfUtils';

export interface SourceReaderViewProps {
  /** Source-document rem to feed into PDFWebReader. */
  hostRemId: string;
  /** The originally-hovered rem (a highlight, or the doc itself). */
  hoveredRemId: string | null;
  /** 'highlight' | 'pdf-source' | 'html-source'. */
  kind: string | null;
  /** Close handler — differs between the modal and floating hosts. */
  onClose: () => void;
  /** Floating host only: makes the header a drag handle (lib/floating_widget_drag). */
  onHeaderPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  /** Floating host only: bump after moving the host, so the reader re-reads its position. */
  moveCount?: number;
}

// How long to wait for the host to apply the last move, then how long the reader
// must stay 1px shorter: two changes landing in one host frame would cancel out.
const REANCHOR_DELAY_MS = 100;
const REANCHOR_HOLD_MS = 150;

/**
 * Shared reader UI for both the modal (pdf_source_popup) and floating
 * (pdf_source_floating) Source-popup variants. Renders the SDK PDFWebReader for
 * a Reader source and, for highlights, auto-scrolls to the highlighted passage.
 */
export function SourceReaderView({
  hostRemId,
  hoveredRemId,
  kind,
  onClose,
  onHeaderPointerDown,
  moveCount = 0,
}: SourceReaderViewProps) {
  const plugin = usePlugin() as ReactRNPlugin;
  const hasScrolled = useRef(false);
  const [sourceName, setSourceName] = useState('');
  const [reanchoring, setReanchoring] = useState(false);

  // The PDF canvas caches its on-screen origin and re-reads it only when its size
  // changes, so after a move every click lands where the reader used to be and
  // misses the highlights. Height only: a width change would rescale the page.
  // The padding shrinks the embed's parent, which the SDK forwards to the host.
  useEffect(() => {
    if (!moveCount) return;
    const start = setTimeout(() => setReanchoring(true), REANCHOR_DELAY_MS);
    const end = setTimeout(() => setReanchoring(false), REANCHOR_DELAY_MS + REANCHOR_HOLD_MS);
    return () => {
      clearTimeout(start);
      clearTimeout(end);
    };
  }, [moveCount]);

  // Name of the source document, shown after "Source" in the header.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rem = await plugin.rem.findOne(hostRemId);
        const name = rem ? (await safeRemTextToString(plugin, rem.text)).trim() : '';
        if (!cancelled) setSourceName(name);
      } catch (e) {
        console.error('[SourceReaderView] name lookup error', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hostRemId, plugin]);

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
        // border-box so the 2px border is drawn INSIDE the 100% width/height —
        // otherwise it adds 4px total, overflowing the host and showing scrollbars.
        boxSizing: 'border-box',
        backgroundColor: 'var(--rn-clr-background-primary)',
        border: '2px solid var(--rn-clr-content-tertiary, #6b7280)',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={onHeaderPointerDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          cursor: onHeaderPointerDown ? 'move' : undefined,
          userSelect: onHeaderPointerDown ? 'none' : undefined,
          touchAction: onHeaderPointerDown ? 'none' : undefined,
          // Conspicuous separator: --rn-clr-content-tertiary is a real, clearly
          // visible theme-aware grey (the faint border vars barely showed).
          borderBottom: '2px solid var(--rn-clr-content-tertiary, #6b7280)',
          flex: '0 0 auto',
        }}
      >
        <span
          style={{
            fontWeight: 600,
            fontSize: '13px',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginRight: '8px',
          }}
          title={sourceName || undefined}
        >
          📄 Source
          {sourceName && (
            <span style={{ fontWeight: 400, color: 'var(--rn-clr-content-secondary)' }}>: {sourceName}</span>
          )}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' }}>
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
      <div style={{ flex: '1 1 auto', minHeight: 0, paddingBottom: reanchoring ? 1 : 0 }}>
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
