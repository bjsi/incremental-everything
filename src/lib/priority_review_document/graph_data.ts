import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import {
  GRAPH_DATA_KEY_PREFIX,
  priorityGraphPowerupCode,
  priorityGraphDataSlotCode,
} from '../consts';

// ---------------------------------------------------------------------------
// Priority Review Document — graph data storage
//
// The graph is a snapshot of the priority distribution at the moment the review
// document was created; it is never recomputed (recomputing later would give
// different numbers, since priorities move and items get reviewed). So it is the
// only copy of that data and has to persist.
//
// It used to live under a synced key per graph Rem, `priority_review_graph_data_
// <remId>`. That was the worst-behaved family the storage audit found: plugin
// storage has no deletion API, so when the user deleted a Priority Review
// Document its key stayed behind forever, unnameable and unreclaimable — writing
// null does not release the slot. A synced index existed to let a startup sweep
// find those orphans, but it could only ever null them, and the index was empty
// in practice anyway.
//
// The data now lives on the graph Rem itself, in a hidden powerup slot. The Rem
// is created by the plugin (it already carries the Priority Review Graph
// powerup), so this costs no extra tagging, and deleting the review document
// takes the graph data with it. That is the whole point: the lifetime problem
// disappears rather than being swept up afterwards.
//
// Reads fall back to the legacy key and migrate on the way past, per RemNote's
// recommended pattern — no bulk migration pass. Documents created before this
// change keep working and move themselves across the first time they are opened.
// ---------------------------------------------------------------------------

export interface PriorityGraphBin {
  [key: string]: any;
}

export interface ReviewGraphData {
  bins: PriorityGraphBin[];
  binsRelative?: PriorityGraphBin[];
  stats: { incRem: number; card: number } | null;
}

/** Normalizes the two historical shapes into one. The oldest documents stored a
 *  bare array of bins; later ones an object with bins/binsRelative/stats. */
function normalize(stored: any): ReviewGraphData | null {
  if (!stored) return null;
  if (Array.isArray(stored)) return { bins: stored, binsRelative: undefined, stats: null };
  return {
    bins: stored.bins || [],
    binsRelative: stored.binsRelative,
    stats: stored.stats || null,
  };
}

/** Writes the snapshot onto the graph Rem. Values are RichText, so the JSON is
 *  serialized to a string. */
export async function saveReviewGraphData(
  plugin: RNPlugin,
  graphRem: PluginRem,
  data: ReviewGraphData
): Promise<void> {
  await graphRem.setPowerupProperty(priorityGraphPowerupCode, priorityGraphDataSlotCode, [
    JSON.stringify(data),
  ]);
}

/**
 * Reads the snapshot for a graph Rem.
 *
 * Order: the Rem's own property first, then the legacy synced key — and when the
 * legacy key is the one that answers, its value is copied onto the Rem so the
 * next read comes from the property. The legacy key itself cannot be removed
 * until RemNote provides a deletion API; it is recorded in STORAGE_PLAN.md's
 * ledger phase for that day.
 */
export async function loadReviewGraphData(
  plugin: RNPlugin,
  remId: string
): Promise<ReviewGraphData | null> {
  let rem: PluginRem | undefined;
  try {
    rem = (await plugin.rem.findOne(remId)) ?? undefined;
  } catch {
    rem = undefined;
  }

  if (rem) {
    try {
      const raw = await rem.getPowerupProperty(
        priorityGraphPowerupCode,
        priorityGraphDataSlotCode
      );
      if (raw && typeof raw === 'string' && raw.trim() !== '') {
        const parsed = normalize(JSON.parse(raw));
        if (parsed) return parsed;
      }
    } catch (err) {
      // A malformed property should fall through to the legacy key rather than
      // blanking a graph the user can still see data for.
      console.warn('[ReviewGraph] Could not read graph data property, trying legacy key', err);
    }
  }

  let legacy: unknown;
  try {
    legacy = await plugin.storage.getSynced(GRAPH_DATA_KEY_PREFIX + remId);
  } catch {
    return null;
  }

  const parsed = normalize(legacy);
  if (!parsed) return null;

  if (rem) {
    try {
      await saveReviewGraphData(plugin, rem, parsed);
      console.log(`[ReviewGraph] Migrated graph data for ${remId} from synced storage onto the Rem.`);
    } catch (err) {
      console.warn('[ReviewGraph] Migration write failed; continuing from the legacy value', err);
    }
  }

  return parsed;
}
