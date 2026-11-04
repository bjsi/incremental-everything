/**
 * The priority colour map: every priority colour in the plugin (badges, bars,
 * sliders, table and highlight bands) is its priority's place on the unified
 * IncRems + cards scale (lib/unified_percentile.ts), read from one 101-entry
 * table instead of each widget ranking against the caches.
 *
 * Built in the index widget when the priority caches are warm, and again on
 * Refresh priority badges — the same moments the band stylesheets are rebuilt
 * (priorityBandColorsReloadKey). Saved locally too, so the next startup colours
 * correctly before its caches have loaded.
 *
 * Written percentages are not read from here: they keep their own scopes
 * (Card Shield cards-only, Document scope, ...) and stay live.
 */
import type { RNPlugin } from '@remnote/plugin-sdk';
import {
  allCardPriorityInfoKey,
  allIncrementalRemKey,
  allIncrementalRemSlimKey,
  priorityColorScaleKey,
  priorityColorScaleLocalKey,
} from './consts';
import {
  PriorityColorScale,
  UnifiedCardInfo,
  buildPriorityColorScale,
  buildUnifiedRanking,
} from './unified_percentile';

/**
 * Rebuilds the map from the caches and publishes it. A universe too small to
 * rank (caches still cold) publishes nothing, so the saved map from the last
 * run stays in place until a real one replaces it.
 */
export async function refreshPriorityColorScale(plugin: RNPlugin): Promise<PriorityColorScale | null> {
  try {
    // The SLIM IncRem projection: only `priority` is read. The fallback covers a
    // realm holding only the full key.
    const [incSlim, cardInfos] = await Promise.all([
      plugin.storage.getSession<Array<{ priority?: number }>>(allIncrementalRemSlimKey),
      plugin.storage.getSession<UnifiedCardInfo[]>(allCardPriorityInfoKey),
    ]);
    const incRems = incSlim?.length
      ? incSlim
      : await plugin.storage.getSession<Array<{ priority?: number }>>(allIncrementalRemKey);
    const scale = buildPriorityColorScale(buildUnifiedRanking(incRems || [], cardInfos || []));
    if (!scale) return readPriorityColorScale(plugin);
    await Promise.all([
      plugin.storage.setSession(priorityColorScaleKey, scale),
      plugin.storage.setLocal(priorityColorScaleLocalKey, scale),
    ]);
    return scale;
  } catch (err) {
    console.error('[PriorityColorScale] refresh failed', err);
    return readPriorityColorScale(plugin);
  }
}

/** At activation: the map saved by the last run, until the caches are warm. */
export async function restorePriorityColorScale(plugin: RNPlugin): Promise<void> {
  if (await plugin.storage.getSession(priorityColorScaleKey)) return;
  const saved = await plugin.storage.getLocal<PriorityColorScale>(priorityColorScaleLocalKey);
  if (Array.isArray(saved) && saved.length === 101) {
    await plugin.storage.setSession(priorityColorScaleKey, saved);
  }
}

export async function readPriorityColorScale(plugin: RNPlugin): Promise<PriorityColorScale | null> {
  const scale = await plugin.storage.getSession<PriorityColorScale>(priorityColorScaleKey);
  return Array.isArray(scale) && scale.length === 101 ? scale : null;
}
