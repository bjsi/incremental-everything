// Apply Heading Levels by Hierarchy (Table of Contents) + level shifting.
//
// Sibling to outline_restructure.ts, but a fundamentally different operation:
// this NEVER reparents rems — it only changes their heading *level* (the
// Header powerup / font size). Two plan builders feed one apply/revert path:
//   - computeTocPlan: map a selection's tree depth → heading level (H_start at
//     the top, +1 per level down, clamped at H_end; rems deeper than the range
//     are left unchanged).
//   - computeShiftPlan: nudge the selected rems' existing headings by ±1.
//
// Both produce a HeadingPlan whose apply captures a HeadingSnapshot of the
// prior levels, so the operation is undoable via the sidebar banner — exactly
// like the outline restructure undo, but on a separate session slot.

import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import {
  HeadingLevel,
  getHeadingLevel,
  applyHeadingLevel,
  clearHeading,
  isMetaRem,
} from './outline_restructure';
import { safeRemTextToString } from './pdfUtils';

// ─── Types ────────────────────────────────────────────────────────────────

// Raw node from the selection walk (no proposed level yet).
export type HeadingNode = {
  remId: string;
  text: string;
  depth: number; // depth within the selection (entry rems = 0)
  currentLevel: HeadingLevel | null; // null = paragraph
  children: HeadingNode[];
};

// A node enriched with the proposed level for the preview / apply.
export type HeadingPlanNode = {
  remId: string;
  text: string;
  depth: number;
  oldLevel: HeadingLevel | null;
  newLevel: HeadingLevel | null;
  children: HeadingPlanNode[];
};

export type HeadingPlan = {
  scopeText: string;
  tree: HeadingPlanNode[];
  changedCount: number; // rems whose level actually changes
};

export type HeadingSnapshotOp = {
  remId: string;
  oldLevel: HeadingLevel | null;
};

export type HeadingSnapshot = {
  timestamp: number;
  scopeText: string;
  ops: HeadingSnapshotOp[];
};

// Session slot for the last heading-assign snapshot (single slot, like the
// restructure one — but deliberately separate so the two undo banners don't
// clobber each other).
export const HEADING_SNAPSHOT_KEY = 'lastHeadingAssignSnapshot';

const clampLevel = (n: number): HeadingLevel =>
  Math.max(1, Math.min(6, n)) as HeadingLevel;

// ─── Collecting the selection ───────────────────────────────────────────────

// Walk the input rems depth-first (document order) into a depth tree. With
// `recurse: false` (used by the shift command) only the input rems themselves
// are collected, each at depth 0 with no children — matching "selected rems
// only". Powerup-property bookkeeping rems (the auto "Size" child of every
// heading) are skipped so they never appear in the preview or get a level.
export async function collectHeadingTree(
  plugin: RNPlugin,
  inputRems: PluginRem[],
  opts: { recurse?: boolean } = {}
): Promise<HeadingNode[]> {
  const recurse = opts.recurse !== false;

  const visit = async (rem: PluginRem, depth: number): Promise<HeadingNode> => {
    const currentLevel = await getHeadingLevel(rem);
    const text = await safeRemTextToString(plugin, (rem as any).text);
    const children: HeadingNode[] = [];
    if (recurse) {
      const rawChildren = (await rem.getChildrenRem()) || [];
      for (const c of rawChildren) {
        if (await isMetaRem(c)) continue;
        children.push(await visit(c, depth + 1));
      }
    }
    return { remId: rem._id, text, depth, currentLevel, children };
  };

  const out: HeadingNode[] = [];
  for (const rem of inputRems) {
    if (await isMetaRem(rem)) continue;
    out.push(await visit(rem, 0));
  }
  return out;
}

// Reduce a selection to its "forest roots": the selected rems that do NOT have
// another selected rem as an ancestor. This dedupes the common case where the
// user selects a whole subtree (a parent AND its descendants) — without it, a
// descendant would be both a depth-0 entry and a recursed child, getting
// visited (and leveled) twice.
async function selectionRoots(
  selectedRems: PluginRem[]
): Promise<PluginRem[]> {
  const ids = new Set(selectedRems.map((r) => r._id));
  const roots: PluginRem[] = [];
  for (const r of selectedRems) {
    let anc = await r.getParentRem();
    let hasSelectedAncestor = false;
    while (anc) {
      if (ids.has(anc._id)) {
        hasSelectedAncestor = true;
        break;
      }
      anc = await anc.getParentRem();
    }
    if (!hasSelectedAncestor) roots.push(r);
  }
  return roots;
}

// ToC collection: reduce the selection to forest roots (depth 0), then recurse
// their full subtrees so depth reflects the true outline nesting. Recursing
// into the roots' descendants (selected or not) is intentional — the user
// selects the outline's structure and the command headers everything beneath
// by depth; rems deeper than the chosen range are left unchanged anyway.
export async function collectTocForest(
  plugin: RNPlugin,
  selectedRems: PluginRem[]
): Promise<HeadingNode[]> {
  const roots = await selectionRoots(selectedRems);
  return collectHeadingTree(plugin, roots, { recurse: true });
}

// ─── Plan builders ──────────────────────────────────────────────────────────

// Map tree depth → heading level. The top of the selection becomes `startLevel`
// and each level deeper adds one, up to `endLevel`. Rems nested DEEPER than the
// range keep their current level (left unchanged), as do their descendants.
export function computeTocPlan(
  nodes: HeadingNode[],
  opts: { startLevel: HeadingLevel; endLevel: HeadingLevel; scopeText: string }
): HeadingPlan {
  const { startLevel, endLevel, scopeText } = opts;
  let changedCount = 0;

  const map = (node: HeadingNode): HeadingPlanNode => {
    const target = startLevel + node.depth;
    // Within the range → assign by depth; beyond it → leave the rem unchanged.
    const newLevel: HeadingLevel | null =
      target <= endLevel ? clampLevel(target) : node.currentLevel;
    if (newLevel !== node.currentLevel) changedCount++;
    return {
      remId: node.remId,
      text: node.text,
      depth: node.depth,
      oldLevel: node.currentLevel,
      newLevel,
      children: node.children.map(map),
    };
  };

  const tree = nodes.map(map);
  return { scopeText, tree, changedCount };
}

// Shift the selected rems' existing headings by `delta` (clamped 1–6). Rems
// with no current heading are left untouched (you can't shift a paragraph).
// Operates on the input rems only — children are not collected for shift.
export function computeShiftPlan(
  nodes: HeadingNode[],
  opts: { delta: number; scopeText: string }
): HeadingPlan {
  const { delta, scopeText } = opts;
  let changedCount = 0;

  const map = (node: HeadingNode): HeadingPlanNode => {
    const newLevel: HeadingLevel | null =
      node.currentLevel === null ? null : clampLevel(node.currentLevel + delta);
    if (newLevel !== node.currentLevel) changedCount++;
    return {
      remId: node.remId,
      text: node.text,
      depth: node.depth,
      oldLevel: node.currentLevel,
      newLevel,
      children: node.children.map(map),
    };
  };

  const tree = nodes.map(map);
  return { scopeText, tree, changedCount };
}

// ─── Apply / Revert ───────────────────────────────────────────────────────

// Flatten the plan tree into the ops that actually change a level.
function changedOps(tree: HeadingPlanNode[]): HeadingPlanNode[] {
  const out: HeadingPlanNode[] = [];
  const walk = (n: HeadingPlanNode) => {
    if (n.oldLevel !== n.newLevel) out.push(n);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

// Apply the plan and return a snapshot of prior levels for undo. Wraps the
// writes in `plugin_operation_active` so the batch of heading edits doesn't
// trigger the GlobalRemChanged drift cascade (same guard the restructure and
// cloze creators use).
export async function applyHeadingPlan(
  plugin: RNPlugin,
  plan: HeadingPlan
): Promise<HeadingSnapshot> {
  const ops = changedOps(plan.tree);
  const snapshotOps: HeadingSnapshotOp[] = ops.map((n) => ({
    remId: n.remId,
    oldLevel: n.oldLevel,
  }));

  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    for (const op of ops) {
      const rem = await plugin.rem.findOne(op.remId);
      if (!rem) continue;
      if (op.newLevel === null) {
        await clearHeading(rem);
      } else {
        await applyHeadingLevel(rem, op.newLevel);
      }
    }
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }

  return {
    timestamp: Date.now(),
    scopeText: plan.scopeText,
    ops: snapshotOps,
  };
}

// Restore each rem's prior level (set or clear). Order doesn't matter here —
// unlike the restructure revert, these are independent level edits, not
// position-sensitive reparents.
export async function revertHeadingSnapshot(
  plugin: RNPlugin,
  snapshot: HeadingSnapshot
): Promise<void> {
  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    for (const op of snapshot.ops) {
      const rem = await plugin.rem.findOne(op.remId);
      if (!rem) continue;
      if (op.oldLevel === null) {
        await clearHeading(rem);
      } else {
        await applyHeadingLevel(rem, op.oldLevel);
      }
    }
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}
