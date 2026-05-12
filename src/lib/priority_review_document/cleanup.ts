import { RNPlugin } from '@remnote/plugin-sdk';
import { GRAPH_DATA_KEY_PREFIX, REVIEW_GRAPH_INDEX_KEY } from '../consts';

interface ReviewGraphIndexEntry {
  remId: string;
  createdAt: number;
}

/**
 * Registers a newly-written review-graph data entry in the synced index.
 * Call this immediately after `setSynced(GRAPH_DATA_KEY_PREFIX + graphRemId, ...)`.
 * The index is what allows the startup sweep to find orphaned keys later —
 * the SDK has no way to enumerate synced storage keys.
 */
export async function registerReviewGraphKey(
  plugin: RNPlugin,
  graphRemId: string,
): Promise<void> {
  try {
    const list = (await plugin.storage.getSynced<ReviewGraphIndexEntry[]>(REVIEW_GRAPH_INDEX_KEY)) || [];
    const without = list.filter((e) => e.remId !== graphRemId);
    without.push({ remId: graphRemId, createdAt: Date.now() });
    await plugin.storage.setSynced(REVIEW_GRAPH_INDEX_KEY, without);
  } catch (err) {
    console.warn('[ReviewGraphCleanup] Failed to register key', graphRemId, err);
  }
}

/**
 * Walks the synced index and clears any review-graph data whose graph Rem no
 * longer exists. Designed to run once on plugin activation; cheap because
 * the index typically holds tens of entries (one per Priority Review Document
 * the user has ever created).
 *
 * @returns Count of cleared orphan entries.
 */
export async function cleanupOrphanedReviewGraphs(plugin: RNPlugin): Promise<number> {
  let cleared = 0;
  try {
    const index = (await plugin.storage.getSynced<ReviewGraphIndexEntry[]>(REVIEW_GRAPH_INDEX_KEY)) || [];
    if (index.length === 0) return 0;

    const live: ReviewGraphIndexEntry[] = [];
    for (const entry of index) {
      try {
        const rem = await plugin.rem.findOne(entry.remId);
        if (rem) {
          live.push(entry);
        } else {
          // Rem gone (review doc was deleted) → clear the orphan data entry.
          // SDK has no removeSynced; setSynced(..., null) is the documented pattern.
          await plugin.storage.setSynced(GRAPH_DATA_KEY_PREFIX + entry.remId, null);
          cleared++;
        }
      } catch (err) {
        // If findOne itself throws, keep the entry so we retry on next activation.
        console.warn('[ReviewGraphCleanup] findOne failed for', entry.remId, err);
        live.push(entry);
      }
    }

    if (cleared > 0) {
      await plugin.storage.setSynced(REVIEW_GRAPH_INDEX_KEY, live);
      console.log(`[ReviewGraphCleanup] Cleared ${cleared} orphaned review-graph data entries`);
    }
  } catch (err) {
    console.warn('[ReviewGraphCleanup] Sweep failed', err);
  }
  return cleared;
}
