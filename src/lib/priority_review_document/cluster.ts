import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';

// The Card Cluster built-in powerup is `cc` — `CardCluster="cc"` in RemNote's own
// powerup table (app bundle, 1.28.19), missing from the SDK's BuiltInPowerupCodes.
// Clusters used to be a tag; RemNote migrated them to `cc` around July 2026, and
// the guessed codes below plus the tag fallback went blind for every migrated
// cluster. `cc` is tried first; the rest only cover a cluster never migrated.
const CARD_CLUSTER_POWERUP_CODES = ['cc', 'cluster', 'cardCluster', 'card-cluster', 'card_cluster', 'cardcluster'];

/**
 * Returns true if `rem` carries the Card Cluster powerup.
 * Tries each known code variant first, then falls back to inspecting
 * the rem's tag-rems for text that contains "cluster" (case-insensitive).
 */
export async function hasCardClusterPowerup(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  for (const code of CARD_CLUSTER_POWERUP_CODES) {
    try {
      if (await rem.hasPowerup(code)) {
        return true;
      }
    } catch (_) {
      // ignore individual failures
    }
  }

  try {
    const tags = await rem.getTagRems();
    if (tags?.length) {
      for (const tag of tags) {
        const tagText = Array.isArray(tag.text)
          ? tag.text.join('')
          : typeof tag.text === 'string'
          ? tag.text
          : '';
        if (tagText.toLowerCase().includes('cluster')) {
          console.log(`[CardCluster] Detected via tag text "${tagText}" on rem ${rem._id}`);
          return true;
        }
      }
    }
  } catch (_) {
    // ignore
  }

  return false;
}

/**
 * Which of a set of Rems sit in a Card Cluster, and who their fellow members
 * are. Memoised per parent, so one refresh can ask about the document's entries
 * before the drain and again after the draw without re-reading the same
 * parents. Reads: one findMany for the Rems, one for their parents, the cluster
 * check once per parent, the children once per cluster.
 */
export class ClusterFinder {
  private readonly clusterMemo = new Map<string, Promise<boolean>>();
  private readonly childrenMemo = new Map<string, Promise<PluginRem[]>>();

  constructor(private readonly plugin: RNPlugin) {}

  async index(remIds: string[]): Promise<{
    /** Member Rem id → its cluster parent id. */
    parentOf: Map<string, string>;
    /** Cluster parent id → its children. */
    membersOf: Map<string, PluginRem[]>;
  }> {
    const parentOf = new Map<string, string>();
    const membersOf = new Map<string, PluginRem[]>();
    const ids = [...new Set(remIds.filter(Boolean))];
    if (!ids.length) return { parentOf, membersOf };
    try {
      const rems = (await this.plugin.rem.findMany(ids)) || [];
      const parentIds = [...new Set(rems.map((r) => r.parent as string | undefined).filter((p): p is string => !!p))];
      const parents = parentIds.length ? (await this.plugin.rem.findMany(parentIds)) || [] : [];
      await Promise.all(
        parents.map(async (parent) => {
          if (!(await this.isCluster(parent))) return;
          membersOf.set(parent._id, await this.children(parent));
        })
      );
      for (const rem of rems) {
        const parent = rem.parent as string | undefined;
        if (parent && membersOf.has(parent)) parentOf.set(rem._id, parent);
      }
    } catch (e) {
      // Fails open: an unreadable cluster is treated as no cluster.
      console.warn('[CardCluster] Cluster lookup failed:', e);
    }
    return { parentOf, membersOf };
  }

  private isCluster(rem: PluginRem): Promise<boolean> {
    let pending = this.clusterMemo.get(rem._id);
    if (!pending) {
      pending = hasCardClusterPowerup(this.plugin, rem).catch(() => false);
      this.clusterMemo.set(rem._id, pending);
    }
    return pending;
  }

  private children(rem: PluginRem): Promise<PluginRem[]> {
    let pending = this.childrenMemo.get(rem._id);
    if (!pending) {
      // getChildrenRem, never the lazy `children` field (see children.ts).
      pending = rem.getChildrenRem().then((kids) => kids || []).catch(() => []);
      this.childrenMemo.set(rem._id, pending);
    }
    return pending;
  }
}
