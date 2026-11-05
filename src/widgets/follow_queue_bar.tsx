import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  followQueueBarDefaultPosition,
  followQueueBarPositionKey,
  followQueueShownKey,
  followQueueStopKey,
} from '../lib/consts';
import { FloatingPosition, useFloatingWidgetDrag } from '../lib/floating_widget_drag';
import type { PinnedSource } from '../lib/follow_queue_sources_plan';

// Shows that this window follows the queue. Opened and closed by
// lib/follow_queue_sources.ts, which also acts on Stop: that state lives in the
// index widget, out of reach of this iframe. Dragging it anywhere but on a button moves it.

const btn = (background: string): React.CSSProperties => ({
  padding: '5px 10px',
  fontSize: 12,
  fontWeight: 600,
  backgroundColor: background,
  color: 'white',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
});

function FollowQueueBar() {
  const plugin = usePlugin();
  const [widgetId, setWidgetId] = useState<string | null>(null);
  const positionRef = useRef<FloatingPosition | null>(null);

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>();
      positionRef.current =
        (await plugin.storage.getSession<FloatingPosition>(followQueueBarPositionKey)) ||
        followQueueBarDefaultPosition;
      setWidgetId(ctx?.floatingWidgetId ?? null);
    })().catch((e) => console.error('[FollowQueueBar] init error', e));
  }, [plugin]);

  const onDragEnd = useCallback(
    (position: FloatingPosition) => {
      plugin.storage.setSession(followQueueBarPositionKey, position).catch(() => {});
    },
    [plugin]
  );
  const onPointerDown = useFloatingWidgetDrag(plugin, widgetId, positionRef, onDragEnd);

  const shown = useTrackerPlugin(
    (rp) => rp.storage.getSession<PinnedSource[]>(followQueueShownKey),
    []
  );
  // With several sources, one button couldn't say which of them it scrolls.
  const highlightRemId = shown?.length === 1 ? shown[0].highlightRemId : null;

  const scroll = async () => {
    const highlight = highlightRemId ? await plugin.rem.findOne(highlightRemId) : undefined;
    await highlight?.scrollToReaderHighlight();
  };

  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        cursor: 'move',
        userSelect: 'none',
        touchAction: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        fontSize: 12,
        whiteSpace: 'nowrap',
        backgroundColor: '#dbeafe',
        color: '#1e3a8a',
        border: '1px solid #3b82f6',
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      }}
    >
      <span style={{ fontWeight: 600, color: '#1e40af' }}>🧭 Following the queue</span>
      {highlightRemId && (
        <button style={btn('#3b82f6')} onClick={scroll} title="Scroll the reader to the highlight">
          🔖 Scroll to Highlight
        </button>
      )}
      <button
        style={btn('#ef4444')}
        onClick={() => plugin.storage.setSession(followQueueStopKey, Date.now())}
        title="Stop following the queue in this window"
      >
        ■ Stop
      </button>
    </div>
  );
}

renderWidget(withHoverTips(FollowQueueBar));
