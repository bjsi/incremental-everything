/**
 * The priority colour map for React components (see lib/priority_color_scale.ts).
 *
 * One subscription per widget iframe, shared by every component in it: a list
 * of a thousand badges reads the session key once, not a thousand times.
 */
import { useEffect, useReducer } from 'react';
import { usePlugin } from '@remnote/plugin-sdk';
import { priorityColorScaleKey } from '../lib/consts';
import { PriorityColorScale, scalePercentile } from '../lib/unified_percentile';
import { percentileToHslColor } from '../lib/utils';

let current: PriorityColorScale | null = null;
let started = false;
const listeners = new Set<() => void>();

function ensureSubscribed(plugin: ReturnType<typeof usePlugin>) {
  if (started) return;
  started = true;
  plugin.track(async (rp) => {
    const scale = await rp.storage.getSession<PriorityColorScale>(priorityColorScaleKey);
    const next = Array.isArray(scale) && scale.length === 101 ? scale : null;
    if (next === current) return;
    current = next;
    listeners.forEach((l) => l());
  });
}

/** The colour map, or null until one has been built (then callers fall back). */
export function usePriorityColorScale(): PriorityColorScale | null {
  const plugin = usePlugin();
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    ensureSubscribed(plugin);
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, [plugin]);
  return current;
}

/**
 * The colour of a priority: its place on the unified scale when the map exists,
 * else `fallbackPercentile` (the caller's own ranking), else the absolute value.
 */
export function priorityColor(
  scale: PriorityColorScale | null,
  priority: number,
  fallbackPercentile?: number | null
): string {
  if (scale) return percentileToHslColor(scalePercentile(scale, priority));
  return percentileToHslColor(fallbackPercentile ?? priority);
}

/** The percentile behind that colour (for "top x%" hover text). */
export function priorityScalePercentile(
  scale: PriorityColorScale | null,
  priority: number
): number | undefined {
  return scale ? scalePercentile(scale, priority) : undefined;
}
