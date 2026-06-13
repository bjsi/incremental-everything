import {
  renderWidget,
  usePlugin,
  WidgetLocation,
  ReactRNPlugin,
} from '@remnote/plugin-sdk';
import React, { useEffect, useState } from 'react';
import { SourceReaderView } from '../components/SourceReaderView';

/**
 * Centered-MODAL variant of the Source popup. Renders a Reader source
 * (PDF / HTML article) on top of the queue without navigating away. Blocks the
 * UI beneath it — see pdf_source_floating for the non-blocking variant.
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
    <SourceReaderView
      hostRemId={hostRemId}
      hoveredRemId={hoveredRemId}
      kind={kind}
      onClose={() => plugin.widget.closePopup()}
    />
  );
}

renderWidget(PdfSourcePopup);
