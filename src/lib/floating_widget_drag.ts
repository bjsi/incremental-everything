import { RNPlugin } from '@remnote/plugin-sdk';
import React, { useCallback } from 'react';

/** A floating widget's host position, in whichever edges it was opened with. */
export type FloatingPosition = { top?: number; left?: number; right?: number; bottom?: number };

// Part of the widget that must stay on screen when dragged toward an edge.
const KEEP_VISIBLE_PX = 120;

// Pointerdowns on these start their own interaction, not a drag.
const INTERACTIVE = 'button, input, label, select, textarea, a';

/**
 * Drag-to-move for a floating widget: returns an onPointerDown handler for the
 * element that should act as its handle (usually the header).
 *
 * RemNote draws no frame or handle for floating widgets — the host only offers
 * setFloatingWidgetPosition, which re-renders the same wrapper (the iframe is
 * not remounted, so the widget keeps its state).
 *
 * - `position` holds the widget's current host position, in the edges it uses
 *   ({top, right}, {left, bottom}, …); the drag shifts those same edges and
 *   writes the result back, so the caller must keep it current. Null = unknown,
 *   and the drag doesn't start.
 * - Pointer capture keeps moves coming while the cursor crosses a nested iframe
 *   or leaves ours.
 * - screenX/Y, not clientX/Y: the iframe moves under the cursor, so client
 *   coordinates drift by however far the host has already moved it.
 * - One position call per animation frame; each is an async host round trip.
 * - The iframe can't read the host window's size, so the screen's size bounds
 *   the drag; the widget's own size is the iframe's.
 */
export function useFloatingWidgetDrag(
  plugin: RNPlugin,
  floatingWidgetId: string | null | undefined,
  position: React.MutableRefObject<FloatingPosition | null>,
  onDragEnd?: (position: FloatingPosition) => void
) {
  return useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const from = position.current;
      if (!floatingWidgetId || !from || e.button !== 0) return;
      if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      handle.setPointerCapture(pointerId);

      const startX = e.screenX;
      const startY = e.screenY;
      let frame: number | null = null;

      const clamp = (v: number, min: number, max: number) => Math.round(Math.min(Math.max(v, min), max));
      const send = () => {
        frame = null;
        if (position.current) {
          plugin.window.setFloatingWidgetPosition(floatingWidgetId, position.current).catch(() => {});
        }
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const dx = ev.screenX - startX;
        const dy = ev.screenY - startY;
        const screenW = window.screen.availWidth;
        const screenH = window.screen.availHeight;
        const w = window.innerWidth;
        const h = window.innerHeight;
        const next: FloatingPosition = {};
        // The handle sits at the top, so the top edge never leaves the screen.
        if (from.top != null) next.top = clamp(from.top + dy, 0, screenH - KEEP_VISIBLE_PX);
        if (from.bottom != null) next.bottom = clamp(from.bottom - dy, KEEP_VISIBLE_PX - h, screenH - h);
        if (from.left != null) next.left = clamp(from.left + dx, KEEP_VISIBLE_PX - w, screenW - KEEP_VISIBLE_PX);
        if (from.right != null) next.right = clamp(from.right - dx, KEEP_VISIBLE_PX - w, screenW - KEEP_VISIBLE_PX);
        position.current = next;
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
        if (position.current) onDragEnd?.(position.current);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    },
    [plugin, floatingWidgetId, position, onDragEnd]
  );
}
