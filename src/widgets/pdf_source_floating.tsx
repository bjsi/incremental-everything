import {
  renderWidget,
  usePlugin,
  WidgetLocation,
  ReactRNPlugin,
} from '@remnote/plugin-sdk';
import React, { useEffect, useState } from 'react';
import { SourceReaderView } from '../components/SourceReaderView';
import { sourceFloatingTargetKey, sourceFloatingActiveIdKey } from '../lib/consts';

/**
 * FLOATING variant of the Source popup — non-blocking, opens to the side so the
 * queue/editor stays visible for peeking back and forth without close/reopen.
 *
 * openFloatingWidget has no contextData param, so the resolved target is handed
 * off via session storage (sourceFloatingTargetKey) by the
 * `open-source-in-floating` command. The widget reads its own floatingWidgetId
 * from the widget context to close itself.
 */
export function PdfSourceFloating() {
  const plugin = usePlugin() as ReactRNPlugin;
  const [hostRemId, setHostRemId] = useState<string | null>(null);
  const [hoveredRemId, setHoveredRemId] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [floatingWidgetId, setFloatingWidgetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      try {
        const ctx = await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>();
        setFloatingWidgetId(ctx?.floatingWidgetId ?? null);

        const data =
          (await plugin.storage.getSession<{
            hostRemId: string;
            hoveredRemId: string | null;
            kind: string | null;
          }>(sourceFloatingTargetKey)) || null;
        setHostRemId(data?.hostRemId ?? null);
        setHoveredRemId(data?.hoveredRemId ?? null);
        setKind(data?.kind ?? null);
      } catch (e) {
        console.error('[pdf_source_floating] init error', e);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [plugin]);

  const close = async () => {
    try {
      await plugin.storage.setSession(sourceFloatingActiveIdKey, undefined);
      if (floatingWidgetId) {
        await plugin.window.closeFloatingWidget(floatingWidgetId);
      }
    } catch (e) {
      console.error('[pdf_source_floating] close error', e);
    }
  };

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
      onClose={close}
    />
  );
}

renderWidget(PdfSourceFloating);
