/**
 * Card Cluster rules for a persistent Priority Queue document. Pure — no SDK —
 * so they are unit-tested; queue_doc.ts reads the Rems and applies them.
 *
 * A cluster's members are meant to be practised together: RemNote shows them
 * in order, the earlier ones as context. The draw has always brought every due
 * sibling of a drawn member along (select.ts), but a persistent document has
 * more moments than the draw, and two of them used to split clusters:
 *   - the drain removed a cooling member while its siblings stayed;
 *   - an entry kept across refreshes was never looked at again, so siblings
 *     that came due later — or ancestors swapped in — were never completed.
 */

/**
 * Cooling members to KEEP in the document: a cooling cluster member stays while
 * another member of the same cluster in the document is due and not cooling.
 * A cluster whose due members are all cooling drains as a unit.
 */
export function coolingClusterMembersToKeep(
  cooling: ReadonlySet<string>,
  docTargets: readonly string[],
  parentOf: ReadonlyMap<string, string>,
  isDue: (remId: string) => boolean
): Set<string> {
  const keep = new Set<string>();
  const openByParent = new Set<string>();
  for (const id of docTargets) {
    const parent = parentOf.get(id);
    if (parent && isDue(id) && !cooling.has(id)) openByParent.add(parent);
  }
  for (const id of docTargets) {
    const parent = parentOf.get(id);
    if (parent && cooling.has(id) && openByParent.has(parent)) keep.add(id);
  }
  return keep;
}

/**
 * Due siblings missing from the document, for every cluster a flashcard entry
 * belongs to — cooling or not, like the draw. `blocked` holds what must not be
 * added (already in the document, held back by a due ancestor).
 */
export function missingClusterSiblings(
  fcTargets: readonly string[],
  parentOf: ReadonlyMap<string, string>,
  membersOf: ReadonlyMap<string, readonly string[]>,
  isDue: (remId: string) => boolean,
  blocked: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  const seen = new Set<string>(blocked);
  const parents = new Set<string>();
  for (const id of fcTargets) {
    const parent = parentOf.get(id);
    if (parent) parents.add(parent);
  }
  for (const parent of parents) {
    for (const member of membersOf.get(parent) ?? []) {
      if (seen.has(member) || !isDue(member)) continue;
      seen.add(member);
      out.push(member);
    }
  }
  return out;
}
