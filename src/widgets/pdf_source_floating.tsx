import {
  renderWidget,
  usePlugin,
  WidgetLocation,
  ReactRNPlugin,
  AppEvents,
} from '@remnote/plugin-sdk';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { SourceReaderView } from '../components/SourceReaderView';
import {
  sourceFloatingTargetKey,
  sourceFloatingActiveIdKey,
  sourceFloatingPositionKey,
  sourceFloatingDefaultPosition,
} from '../lib/consts';

type FloatPosition = { top: number; right: number };

// Part of the float that must stay on screen when dragged toward an edge.
const KEEP_VISIBLE_PX = 120;

/**
 * FLOATING variant of the Source popup — non-blocking, opens to the side so the
 * queue/editor stays visible for peeking back and forth without close/reopen.
 *
 * openFloatingWidget has no contextData param, so the resolved target is handed
 * off via session storage (sourceFloatingTargetKey) by the
 * `open-source-in-floating` command. The widget reads its own floatingWidgetId
 * from the widget context to close itself, and to move itself when its header
 * is dragged.
 */
export function PdfSourceFloating() {
  const plugin = usePlugin() as ReactRNPlugin;
  const [hostRemId, setHostRemId] = useState<string | null>(null);
  const [hoveredRemId, setHoveredRemId] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [floatingWidgetId, setFloatingWidgetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const positionRef = useRef<FloatPosition>(sourceFloatingDefaultPosition);

  useEffect(() => {
    const init = async () => {
      try {
        const ctx = await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>();
        setFloatingWidgetId(ctx?.floatingWidgetId ?? null);
        positionRef.current =
          (await plugin.storage.getSession<FloatPosition>(sourceFloatingPositionKey)) ||
          sourceFloatingDefaultPosition;

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

  const close = useCallback(async () => {
    try {
      await plugin.storage.setSession(sourceFloatingActiveIdKey, undefined);
      if (floatingWidgetId) {
        await plugin.window.closeFloatingWidget(floatingWidgetId);
      }
    } catch (e) {
      console.error('[pdf_source_floating] close error', e);
    }
  }, [plugin, floatingWidgetId]);

  // Esc-to-close, without letting the queue swallow Esc.
  //
  // `stealKeys(['Escape'])` stops RemNote from acting on Esc while the float is
  // open (so the queue doesn't close) and routes the press to us via
  // `StealKeyEvent`; stolen keys auto-release when the widget closes. A local
  // `keydown` listener covers the case where focus sits on the widget shell.
  //
  // NOTE: when focus is inside the PDF iframe, the browser traps Esc there — so
  // neither the queue nor this handler sees it; use the ✕ button in that case.
  useEffect(() => {
    if (!floatingWidgetId) return;

    plugin.window.stealKeys(floatingWidgetId, ['Escape']).catch(() => {});

    const isEsc = (e: any): boolean => {
      const raw = e?.key ?? e?.code ?? e?.keys ?? e?.data?.key ?? e?.data?.keys ?? '';
      const s = Array.isArray(raw) ? raw.join(',') : String(raw);
      return /esc/i.test(s);
    };

    // Per-widget `widget.*` events (like StealKeyEvent) are delivered keyed by
    // the floating widget id — an `undefined` listener key never matches, which
    // is why an app-focused Esc didn't reach us before.
    const onStealKey = (e: any) => { if (isEsc(e)) close(); };
    plugin.event.addListener(AppEvents.StealKeyEvent, floatingWidgetId, onStealKey);

    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      plugin.event.removeListener(AppEvents.StealKeyEvent, floatingWidgetId, onStealKey);
      document.removeEventListener('keydown', onKeyDown);
      plugin.window.releaseKeys(floatingWidgetId, ['Escape']).catch(() => {});
    };
  }, [floatingWidgetId, plugin, close]);

  // Drag-by-header. RemNote draws no frame or handle for floating widgets — the
  // host only offers setFloatingWidgetPosition, which re-renders the same
  // wrapper (the iframe is not remounted, so the reader keeps its page).
  //
  // - Pointer capture keeps moves coming while the cursor crosses the nested
  //   PDF iframe or leaves ours.
  // - screenX/Y, not clientX/Y: the iframe moves under the cursor, so client
  //   coordinates drift by however far the host has already moved it.
  // - One position call per animation frame; each is an async host round trip.
  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!floatingWidgetId || e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      handle.setPointerCapture(pointerId);

      const start = { x: e.screenX, y: e.screenY, ...positionRef.current };
      let frame: number | null = null;

      const send = () => {
        frame = null;
        plugin.window.setFloatingWidgetPosition(floatingWidgetId, positionRef.current).catch(() => {});
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const maxTop = window.screen.availHeight - KEEP_VISIBLE_PX;
        const minRight = KEEP_VISIBLE_PX - window.innerWidth;
        const maxRight = window.screen.availWidth - KEEP_VISIBLE_PX;
        positionRef.current = {
          top: Math.round(Math.min(Math.max(start.top + ev.screenY - start.y, 0), maxTop)),
          right: Math.round(Math.min(Math.max(start.right - (ev.screenX - start.x), minRight), maxRight)),
        };
        if (frame === null) frame = requestAnimationFrame(send);
      };
      const onEnd = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        if (frame !== null) cancelAnimationFrame(frame);
        send();
        plugin.storage.setSession(sourceFloatingPositionKey, positionRef.current).catch(() => {});
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    },
    [floatingWidgetId, plugin]
  );

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
      onHeaderPointerDown={onHeaderPointerDown}
    />
  );
}

renderWidget(PdfSourceFloating);
