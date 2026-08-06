import { RNPlugin } from '@remnote/plugin-sdk';
import { GRAPH_DATA_KEY_PREFIX, REVIEW_GRAPH_INDEX_KEY } from '../consts';

// LEGACY. Graph data now lives on the graph Rem itself (see ./graph_data.ts), so
// nothing registers new entries here any more and no new orphans are created —
// deleting a Priority Review Document now takes its graph data with it.
//
// What remains is a sweep over the entries written BEFORE that change. It can
// only blank their values, not delete the keys (plugin storage has no deletion
// API and writing null does not release the slot), so its benefit is limited to
// reclaiming the bytes of graphs whose Rem is gone. Retire this once RemNote
// ships deletion and the ledger sweep in STORAGE_PLAN.md Phase 7 can run.

interface ReviewGraphIndexEntry {
  remId: string;
  createdAt: number;
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
