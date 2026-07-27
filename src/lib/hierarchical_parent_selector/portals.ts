// lib/hierarchical_parent_selector/portals.ts
//
// Portal awareness for the Parent Selector.
//
// A portal is a rem that is *not* an ancestor of the rems it shows: it sits
// among some rem's children and mirrors rems that really live elsewhere, so the
// same content can be read and edited from both places. RemNote models it as an
// ordinary child rem of `RemType.PORTAL` carrying no text of its own; the rems
// it mirrors come back from `getPortalDirectlyIncludedRem()`.
//
// The selector used to drop portals entirely: the portal rem has empty text, so
// `filterOutPowerupSlots` classified it as a stray metadata child. A whole
// branch the user can plainly see in the editor was therefore unavailable as a
// filing destination.
//
// We surface the portal's *targets* rather than the portal rem itself. A portal
// rem is not a real parent — but its targets are ordinary rems, so filing under
// one lands the new rem in the target's real home, where it then also appears
// inside the portal. That is exactly the round trip the user expects.

import { RNPlugin, PluginRem, RemId, RemType, PORTAL_TYPE } from '@remnote/plugin-sdk';
import { filterOutPowerupSlots } from '../powerupSlotFilter';

/**
 * One entry in a rem's child list as the selector sees it: either a real child,
 * or a rem mirrored in through a portal that sits among the real children.
 */
export interface ChildRemEntry {
  rem: PluginRem;
  /** The portal rem this entry came through. Undefined for real children. */
  viaPortalId?: RemId;
}

// Portal flavours that are not "a hand-placed window onto other rems" and so
// have no business in a destination picker: an embedded queue is a review
// widget, a scaffold is template machinery, and a search portal's contents are
// a live query result rather than a place the user filed anything.
//
// Note `PORTAL_TYPE.PORTAL` is `undefined` at runtime, so we exclude the known
// special flavours instead of testing for equality with the plain one — that
// also makes a failed lookup degrade to "treat as a plain portal", where
// `getPortalDirectlyIncludedRem` simply returns nothing.
const EXCLUDED_PORTAL_TYPES: unknown[] = [
  PORTAL_TYPE.EMBEDDED_QUEUE,
  PORTAL_TYPE.SCAFFOLD,
  PORTAL_TYPE.SEARCH_PORTAL,
];

/**
 * Some SDK calls hand back the raw serialized rem instead of a live RemObject —
 * `getPortalDirectlyIncludedRem` is one: the value carries `_id`/`text`/`type`
 * but none of the methods, so calling `hasPowerup` on it throws. Everything
 * downstream (heading level, powerup checks, child lookup) needs the real
 * object, so re-fetch by id whenever the methods are missing. Already-live rems
 * pass straight through, costing nothing.
 */
async function hydrateRem(
  plugin: RNPlugin,
  rem: PluginRem | undefined
): Promise<PluginRem | undefined> {
  if (!rem) return undefined;
  if (typeof (rem as Partial<PluginRem>).hasPowerup === 'function') return rem;
  if (!rem._id) return undefined;
  return (await plugin.rem.findOne(rem._id)) ?? undefined;
}

/**
 * Whether `rem` is a portal rem.
 *
 * `rem.type` comes down with the rem itself, so the common case costs nothing
 * and works even on an unhydrated payload. Older/partial payloads can leave it
 * unset; portal rems never carry text, so the `getType()` fallback is bounded
 * to the handful of blank children a rem has rather than every child.
 */
export async function isPortalRem(rem: PluginRem): Promise<boolean> {
  if (rem.type === RemType.PORTAL) return true;
  if (rem.type != null) return false;

  const hasText = Array.isArray(rem.text) && rem.text.length > 0;
  if (hasText) return false;

  if (typeof rem.getType !== 'function') return false;

  try {
    return (await rem.getType()) === RemType.PORTAL;
  } catch {
    return false;
  }
}

// How far up a target's real ancestry we look for another target. Deep enough
// for any realistic outline, bounded so a broken parent chain can't spin.
const PORTAL_ANCESTRY_MAX_DEPTH = 30;

/**
 * Keeps only the outermost rems of a portal's included set.
 *
 * A portal records *every* rem it shows as "directly included", so a branch and
 * the descendants under it all come back together and would render as
 * siblings — which is not how the user sees them in the editor, where the
 * descendants sit under their parent. Dropping any target that descends from
 * another target restores the real shape: only the branch roots appear at the
 * portal's position, and the rest reappear through ordinary parentage once that
 * root is expanded.
 */
async function keepOutermostTargets(
  plugin: RNPlugin,
  targets: PluginRem[]
): Promise<PluginRem[]> {
  if (targets.length < 2) return targets;

  const targetIds = new Set(targets.map((t) => t._id));
  // Seeded with the targets themselves: the common case is a parent that is
  // also in the set, which then costs no lookup at all.
  const parentOf = new Map<RemId, RemId | null>(
    targets.map((t) => [t._id, t.parent ?? null] as const)
  );

  const parentIdOf = async (id: RemId): Promise<RemId | null> => {
    const cached = parentOf.get(id);
    if (cached !== undefined) return cached;
    let parent: RemId | null = null;
    try {
      parent = (await plugin.rem.findOne(id))?.parent ?? null;
    } catch {
      /* treat an unreadable ancestor as the end of the chain */
    }
    parentOf.set(id, parent);
    return parent;
  };

  const outermost: PluginRem[] = [];

  for (const target of targets) {
    const seen = new Set<RemId>([target._id]);
    let cursor: RemId | null = target.parent ?? null;
    let depth = 0;
    let nested = false;

    while (cursor && depth < PORTAL_ANCESTRY_MAX_DEPTH) {
      if (targetIds.has(cursor)) {
        nested = true;
        break;
      }
      if (seen.has(cursor)) break; // defensive: cyclical parent chain
      seen.add(cursor);
      cursor = await parentIdOf(cursor);
      depth++;
    }

    if (!nested) outermost.push(target);
  }

  return outermost;
}

/**
 * The rems a portal mirrors, as live RemObjects in portal order, reduced to the
 * outermost ones so the branch structure the user sees is preserved. Returns []
 * for portal flavours we deliberately ignore (see EXCLUDED_PORTAL_TYPES) and
 * for any lookup failure.
 */
export async function getPortalTargets(
  plugin: RNPlugin,
  portalRem: PluginRem
): Promise<PluginRem[]> {
  try {
    const portalType = await portalRem.getPortalType();
    if (EXCLUDED_PORTAL_TYPES.includes(portalType)) return [];
  } catch {
    // Fall through: treat as a plain portal and let the target lookup decide.
  }

  let rawTargets: PluginRem[];
  try {
    rawTargets = (await portalRem.getPortalDirectlyIncludedRem()) ?? [];
  } catch {
    return [];
  }

  const targets: PluginRem[] = [];
  for (const raw of rawTargets) {
    const target = await hydrateRem(plugin, raw);
    if (target) targets.push(target);
  }

  return keepOutermostTargets(plugin, targets);
}

/**
 * A rem's children as the selector presents them: real children with powerup
 * slots stripped, plus the targets of any portal sitting among them, all in
 * editor order.
 *
 * Portals are separated out *before* the powerup-slot filter runs, because that
 * filter discards text-less children and a portal rem has no text.
 */
export async function getChildEntries(
  plugin: RNPlugin,
  parentRem: PluginRem
): Promise<ChildRemEntry[]> {
  let rawChildren: PluginRem[];
  try {
    rawChildren = await parentRem.getChildrenRem();
  } catch {
    return [];
  }
  if (rawChildren.length === 0) return [];

  const portalIds = new Set<RemId>();
  const plainChildren: PluginRem[] = [];

  for (const child of rawChildren) {
    if (await isPortalRem(child)) {
      portalIds.add(child._id);
    } else {
      plainChildren.push(child);
    }
  }

  const keptIds = new Set(
    (await filterOutPowerupSlots(plugin, plainChildren)).map((r) => r._id)
  );

  const entries: ChildRemEntry[] = [];
  // Seeded with the branch itself so a portal pointing back at its own container
  // can't offer it as its own child. Also dedupes a rem that is both a real
  // child and a portal target, which would otherwise render as two rows.
  const seen = new Set<RemId>([parentRem._id]);

  for (const child of rawChildren) {
    if (keptIds.has(child._id)) {
      if (seen.has(child._id)) continue;
      seen.add(child._id);
      entries.push({ rem: child });
      continue;
    }

    if (!portalIds.has(child._id)) continue;

    for (const target of await getPortalTargets(plugin, child)) {
      if (seen.has(target._id)) continue;
      seen.add(target._id);
      entries.push({ rem: target, viaPortalId: child._id });
    }
  }

  return entries;
}

/**
 * The containers a rem is reachable from through a portal — i.e. the parents of
 * the portal rems that mirror it. These are the rems that, once expanded, will
 * list this rem among their children (see getChildEntries).
 *
 * Used to re-find a remembered destination whose only route from a root
 * candidate goes through a portal, where walking real parents dead-ends.
 */
export async function getPortalContainerIds(rem: PluginRem): Promise<RemId[]> {
  let containers: PluginRem[];
  try {
    containers = await rem.portalsAndDocumentsIn();
  } catch {
    return [];
  }

  const ids: RemId[] = [];
  for (const container of containers) {
    // `portalsAndDocumentsIn` also returns documents, which are plain ancestors
    // and already covered by the real-parent walk.
    if (!(await isPortalRem(container))) continue;
    if (container.parent) ids.push(container.parent);
  }
  return ids;
}
