import { RNPlugin, PluginRem, RemId } from '@remnote/plugin-sdk';

/**
 * Reading a Rem's children reliably.
 *
 * DO NOT trust `rem.children`. The plugin bridge fills that field from RemNote's
 * CHILDREN_LAZY_CACHE (`mapRemToPluginInterface` in app.asar: `children:
 * e[CHILDREN_LAZY_CACHE] || []`), and that cache is only populated once
 * something loads the Rem's children — opening the document, expanding it.
 * For a document nobody has opened this session the field is `[]`.
 *
 * Two reliable reads, both walking the always-loaded structure graph
 * (`childrenRemAsync()` → `getTinyGraph().orderedChildrenNumberIds`):
 *
 *   - `getChildrenRem()` — one bridge call, the direct children.
 *   - `getDescendants()` — ONE bridge call for the whole subtree; RemNote does
 *     the recursion on its side. Every returned Rem carries `parent`, so the
 *     children of any node in the subtree, and their counts, come out of a
 *     single call by grouping on it.
 *
 * Cost matters: counting each entry's children with a `getChildrenRem()` per
 * entry is one bridge call per entry. `readChildrenWithCounts` gets the same
 * answer from one call per document.
 *
 * ORDER is promised by neither. Callers that care about position must ask
 * `positionAmongstSiblings()`.
 *
 * Powerup slots are not filtered here. Every slot this plugin's review
 * documents carry (the Priority Queue config, the graph data) is declared
 * `hidden`, and hidden slots have no Rem representation — they never appear as
 * children. The general slot filter (lib/powerupSlotFilter.ts) resolves slot
 * definitions KB-wide on first use, which measured ~12 s, for rows that cannot
 * exist here.
 */
export async function readChildren(plugin: RNPlugin, rem: PluginRem): Promise<PluginRem[]> {
  try {
    return ((await rem.getChildrenRem()) || []) as PluginRem[];
  } catch (e) {
    // Fall back to the lazy field: better a possibly-empty answer than a throw
    // in the middle of a scan.
    console.warn(`[Children] getChildrenRem failed for ${rem._id}, falling back to the lazy field:`, e);
    const ids = (rem.children as RemId[] | undefined) ?? [];
    return ids.length ? (((await plugin.rem.findMany(ids)) || []) as PluginRem[]) : [];
  }
}

export interface ChildrenWithCounts {
  children: PluginRem[];
  /** Number of direct children of each child. Absent key = 0. */
  childCounts: Map<RemId, number>;
}

/**
 * A Rem's direct children, and how many children each of THEM has, from one
 * `getDescendants()` call. Used where "is there anything written under this
 * entry" decides whether it may be deleted — a question a lazily empty list
 * must never answer.
 *
 * Falls back to one `getChildrenRem()` per child if the descendants read throws.
 */
export async function readChildrenWithCounts(plugin: RNPlugin, rem: PluginRem): Promise<ChildrenWithCounts> {
  try {
    const descendants = ((await rem.getDescendants()) || []) as PluginRem[];
    const children: PluginRem[] = [];
    const childCounts = new Map<RemId, number>();
    for (const d of descendants) {
      const parent = d.parent as RemId | undefined;
      if (!parent) continue;
      if (parent === rem._id) children.push(d);
      else childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
    }
    // Only keep counts for direct children; deeper parents were counted too.
    const childIds = new Set(children.map((c) => c._id));
    for (const id of [...childCounts.keys()]) if (!childIds.has(id)) childCounts.delete(id);
    return { children, childCounts };
  } catch (e) {
    console.warn(`[Children] getDescendants failed for ${rem._id}, counting child by child:`, e);
    const children = await readChildren(plugin, rem);
    const childCounts = new Map<RemId, number>();
    await Promise.all(
      children.map(async (c) => {
        const n = (await readChildren(plugin, c)).length;
        if (n) childCounts.set(c._id, n);
      })
    );
    return { children, childCounts };
  }
}
