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

  // Once the reader has mounted, scroll to the hovered highlight (highlights only).
  // Mirrors the timing used in components/Reader.tsx.
  useEffect(() => {
    if (kind !== 'highlight' || !hoveredRemId || hasScrolled.current) return;
    const t = setTimeout(async () => {
      try {
        const hRem = await plugin.rem.findOne(hoveredRemId);
        if (hRem && typeof hRem.scrollToReaderHighlight === 'function') {
          hRem.scrollToReaderHighlight();
          hasScrolled.current = true;
        }
      } catch (e) {
        console.error('[pdf_source_popup] scroll error', e);
      }
    }, 400);
    return () => clearTimeout(t);
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
