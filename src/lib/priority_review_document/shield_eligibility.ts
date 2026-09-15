import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { isCardDue } from './cooling';
import { CoolingScanner } from './cooling_gather';
import { HeldByCoolingAncestor } from './cooling_store';

/**
 * Which of the given due Rems are held back by a COOLING ancestor.
 *
 * The Priority Shield counts only Rems you are free to review now. A cooling
 * Rem is not, and neither is a Rem whose highest due ancestor is cooling: the
 * Priority Queue will not serve it until that ancestor's window ends (select.ts,
 * the "cooling too" branch of the ancestor swap). Left in, such a Rem pins the
 * shield at its priority for up to fifteen days while nothing can be done
 * about it.
 *
 * A Rem whose due ancestor is NOT cooling stays counted, on purpose: that
 * ancestor can be reviewed right now, and the Priority Queue pulls it in first,
 * so the work that frees the child is available.
 *
 * Same rule as the draw — parent and grandparent, the HIGHEST due one decides —
 * so the shield and the queue agree on what is held. Due-ness comes from the
 * scanner's own card facts (the card cache in Full Mode), and the tree from two
 * batched Rem lookups, so this costs no card read.
 */
export async function findHeldByCoolingAncestor(
  plugin: RNPlugin,
  remIds: RemId[],
  scanner: CoolingScanner,
  now: number = Date.now()
): Promise<HeldByCoolingAncestor[]> {
  const ids = [...new Set(remIds)].filter(Boolean);
  if (ids.length === 0) return [];

  const facts = await scanner.cardFacts();
  const dueNow = (id: RemId | null | undefined) =>
    !!id && (facts.get(id) ?? []).some((c) => isCardDue(c, now));

  const rems = (await plugin.rem.findMany(ids)) || [];
  const parentOf = new Map<RemId, RemId>();
  for (const r of rems) if (r.parent) parentOf.set(r._id, r.parent as RemId);

  const parentIds = [...new Set(parentOf.values())];
  const parents = parentIds.length ? (await plugin.rem.findMany(parentIds)) || [] : [];
  const grandparentOf = new Map<RemId, RemId>();
  for (const p of parents) if (p.parent) grandparentOf.set(p._id, p.parent as RemId);

  const held: HeldByCoolingAncestor[] = [];
  for (const id of ids) {
    const parent = parentOf.get(id);
    const grandparent = parent ? grandparentOf.get(parent) : undefined;
    const blocker = dueNow(grandparent) ? grandparent! : dueNow(parent) ? parent! : null;
    if (!blocker) continue;
    const verdict = await scanner.verdictFor(blocker);
    if (verdict) held.push({ remId: id, ancestorRemId: blocker, until: verdict.until });
  }
  return held;
}
