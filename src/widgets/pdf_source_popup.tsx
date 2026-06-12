import {
  renderWidget,
  usePlugin,
  WidgetLocation,
  ReactRNPlugin,
  PDFWebReader,
} from '@remnote/plugin-sdk';
import React, { useEffect, useState, useRef } from 'react';

/**
 * Centered-modal popup that renders a Reader source (PDF / HTML article) inside
 * the SDK's PDFWebReader, WITHOUT navigating away from the queue.
 *
 * Context data (set by the `open-source-in-popup` command):
 *   - hostRemId:    the source-document rem to feed into PDFWebReader (required)
 *   - hoveredRemId: the originally-hovered rem (a highlight, or the doc itself)
 *   - kind:         'highlight' | 'pdf-source' | 'html-source'
 */
export function PdfSourcePopup() {
  const plugin = usePlugin() as ReactRNPlugin;
  const [hostRemId, setHostRemId] = useState<string | null>(null);
  const [hoveredRemId, setHoveredRemId] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const hasScrolled = useRef(false);

  useEffect(() => {
    const init = async () => {
      try {
        const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
        const data = ctx?.contextData || {};
        setHostRemId(data.hostRemId ?? null);
        setHoveredRemId(data.hoveredRemId ?? null);
        setKind(data.kind ?? null);
      } catch (e) {
        console.error('[pdf_source_popup] init error', e);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [plugin]);

  // Scroll the popup's PDFWebReader to the hovered highlight (highlights only).
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
                console.error('[pdf_source_popup] scroll attempt threw', e);
              }
            }, delay)
          );
        }
      } catch (e) {
        console.error('[pdf_source_popup] scroll error', e);
      }
    };
    attemptScroll();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [kind, hoveredRemId, plugin]);

  if (loading) {
    return <div style={{ padding: '16px' }}>Loading source…</div>;
  }

  if (!hostRemId) {
    return (
      <div style={{ padding: '16px', color: 'var(--rn-clr-content-secondary)' }}>
        No reader source found for this reference.
      </div>
    );
  }

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
        <button
          onClick={() => plugin.widget.closePopup()}
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

renderWidget(PdfSourcePopup);
