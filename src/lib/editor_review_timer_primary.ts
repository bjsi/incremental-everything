import { RNPlugin } from '@remnote/plugin-sdk';
import { useEffect, useState } from 'react';
import { editorReviewTimerInstancesKey } from './consts';

/* One Editor Review Timer across split panes.

   DocumentAboveToolbar mounts an instance of the timer in every document pane, so
   a split view showed the same bar once per pane. The widget context has no pane
   id, and the iframes all share one src (`?widgetName=…&pluginId=…`), so neither
   CSS nor the context can tell them apart. What does is the host's getDimensions:
   given any live instance id of this plugin, it returns that iframe's bounding
   rect — undefined once the instance is destroyed, a zero rect while its pane is
   hidden (a background tab).

   So the instances list their ids in a session key, and each one measures them
   all and renders only if it comes first in reading order among the visible ones:
   top-most, then left-most. That is stable while panes are navigated, which
   first-come ownership is not (navigating a pane remounts its instance and would
   hand the timer to another pane). The list is read-modify-written from several
   iframes, so an id can be lost to a race; every poll re-adds its own, and drops
   the ids the host no longer knows. */

const POLL_MS = 1500;
// Pane headers differ by a few px; panes on the same row count as level.
const SAME_ROW_PX = 24;

type Measured = { id: number; top: number; left: number; width: number };

function comesFirst(a: Measured, b: Measured): boolean {
  if (Math.abs(a.top - b.top) > SAME_ROW_PX) return a.top < b.top;
  if (a.left !== b.left) return a.left < b.left;
  return a.id < b.id;
}

async function isPrimary(plugin: RNPlugin, selfId: number): Promise<boolean> {
  const registered = (await plugin.storage.getSession<number[]>(editorReviewTimerInstancesKey)) || [];
  const ids = registered.includes(selfId) ? registered : [...registered, selfId];
  const rects = await Promise.all(
    ids.map((id) => plugin.widget.getDimensions(id).catch(() => undefined))
  );

  const live: Measured[] = [];
  ids.forEach((id, i) => {
    const rect = rects[i];
    if (rect) live.push({ id, top: rect.top, left: rect.left, width: rect.width });
  });
  const liveIds = live.map((m) => m.id);
  if (liveIds.length !== registered.length || liveIds.some((id) => !registered.includes(id))) {
    await plugin.storage.setSession(editorReviewTimerInstancesKey, liveIds);
  }

  const self = live.find((m) => m.id === selfId);
  // Cannot measure itself: show, as every instance did before.
  if (!self) return true;
  const visible = live.filter((m) => m.width > 0);
  if (visible.length === 0) return true;
  const first = visible.reduce((best, m) => (comesFirst(m, best) ? m : best));
  return first.id === selfId;
}

/**
 * Whether this instance is the one that shows the timer. undefined until the
 * first measurement. Re-measured only while a review runs; between reviews the
 * last answer stands, so the primary is still mounted when a review ends.
 */
export function useIsPrimaryEditorReviewTimer(plugin: RNPlugin, reviewActive: boolean): boolean | undefined {
  const [primary, setPrimary] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!reviewActive) return;
    let cancelled = false;
    let selfId: number | null = null;

    const poll = async () => {
      try {
        if (selfId === null) {
          const ctx = await plugin.widget.getWidgetContext();
          selfId = Number(ctx?.widgetInstanceId);
        }
        const result = Number.isFinite(selfId) ? await isPrimary(plugin, selfId!) : true;
        if (!cancelled) setPrimary(result);
      } catch (e) {
        console.error('[editor_review_timer] Primary pane check failed:', e);
        if (!cancelled) setPrimary(true);
      }
    };

    void poll();
    const intervalId = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [plugin, reviewActive]);

  return primary;
}
