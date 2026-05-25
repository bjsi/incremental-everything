// Restructure Outline by Headings
//
// Algorithm + state types for the "Restructure Outline by Headings" command.
// Detects H1..H6 in a flat candidate list and re-nests paragraphs and lower
// headings under their preceding higher-level heading.

import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { safeRemTextToString } from './pdfUtils';

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

// Detection. The SDK types getFontSize as 'H1'|'H2'|'H3'|undefined, but at
// runtime it also returns 'H4'|'H5'|'H6' (confirmed via probe). Cast accordingly.
export async function getHeadingLevel(rem: PluginRem): Promise<HeadingLevel | null> {
  try {
    const size = (await (rem as any).getFontSize?.()) as string | undefined;
    if (!size || size[0] !== 'H') return null;
    const lvl = parseInt(size.slice(1), 10);
    if (lvl >= 1 && lvl <= 6) return lvl as HeadingLevel;
    return null;
  } catch {
    return null;
  }
}

export type OutlineCandidate = {
  remId: string;
  level: HeadingLevel | null; // null = paragraph
  text: string;               // plain text for display
  originalParentId: string;
  originalPosition: number;
  hasChildren: boolean;
  // For paragraphs with children: true = keep children attached (move together),
  // false = flatten (children become independent candidates inline at this position).
  // Default true. Always true for childless rems / for headings (headings are
  // always recursed regardless of this flag).
  preserveChildren: boolean;
  // Depth in the ORIGINAL tree, relative to the scope root (root's direct children = 0).
  // Used to render the "Before" panel with the input's existing indentation.
  originalDepth: number;
};

export type ProposedNode = {
  candidate: OutlineCandidate;
  children: ProposedNode[];
};

export type PlanOp = {
  remId: string;
  newParentId: string;
  newPosition: number;
};

export type OutlinePlan = {
  scopeRootId: string;
  minHeadingLevel: number; // smallest level present, 0 if none
  ops: PlanOp[];
  proposedTree: ProposedNode[]; // top-level proposed nodes (children of scopeRoot)
};

export type SnapshotOp = {
  remId: string;
  oldParentId: string;
  oldPosition: number;
};

export type OutlineSnapshot = {
  timestamp: number;
  scopeRootId: string;
  scopeRootText: string;
  ops: SnapshotOp[];
};

// ─── Collecting candidates ──────────────────────────────────────────────────

// Walk a set of input rems (depth-first, document order) and flatten them
// into a candidate list. `inputRems` are the entry points: for a single-rem
// command invocation those are the selected rem's children; for multi-rem
// they are the selected rems themselves.
//
// preserveMap lets the preview UI override the default per-rem "preserve
// children" decision. Default: childless rems and headings get preserveChildren=true
// (no effect since they have no children, or headings always recurse anyway);
// non-heading rems WITH children get true by default (keep their subtree
// intact unless the user toggles "Flatten").
export async function collectCandidates(
  plugin: RNPlugin,
  inputRems: PluginRem[],
  preserveMap: Record<string, boolean> = {}
): Promise<OutlineCandidate[]> {
  const out: OutlineCandidate[] = [];

  const visit = async (rem: PluginRem, depth: number) => {
    const level = await getHeadingLevel(rem);
    const children = (await rem.getChildrenRem()) || [];
    const hasChildren = children.length > 0;
    const text = await safeRemTextToString(plugin, (rem as any).text);
    const parentId = (rem as any).parent as string;
    let pos = 0;
    try {
      const p = await (rem as any).positionAmongstSiblings?.();
      if (typeof p === 'number') pos = p;
    } catch { /* ignore */ }

    const remId = rem._id;
    // Default: paragraphs with children keep them; everything else trivially true.
    const preserveDefault = level === null && hasChildren ? true : true;
    const preserveChildren =
      remId in preserveMap ? preserveMap[remId] : preserveDefault;

    out.push({
      remId,
      level,
      text,
      originalParentId: parentId,
      originalPosition: pos,
      hasChildren,
      preserveChildren,
      originalDepth: depth,
    });

    // Recurse:
    //   - headings: always (they are structural)
    //   - paragraphs without preserveChildren: yes (flatten)
    //   - paragraphs with preserveChildren: no (subtree moves as one unit)
    const recurse = level !== null || !preserveChildren;
    if (recurse) {
      for (const child of children) {
        await visit(child, depth + 1);
      }
    }
  };

  for (const rem of inputRems) {
    await visit(rem, 0);
  }
  return out;
}

// ─── Plan ───────────────────────────────────────────────────────────────────

// Build a reparenting plan from the flat candidate list.
// Heading stack: when we encounter H_n we pop until the top has level < n,
// attach this heading to the top (or scope root), then push it. Paragraphs
// attach to the current top heading (or scope root) but don't push.
export function buildPlan(
  candidates: OutlineCandidate[],
  scopeRootId: string
): OutlinePlan {
  const headingLevels = candidates
    .filter((c) => c.level !== null)
    .map((c) => c.level as number);

  if (headingLevels.length === 0) {
    return { scopeRootId, minHeadingLevel: 0, ops: [], proposedTree: [] };
  }
  const minHeadingLevel = Math.min(...headingLevels);

  type StackEntry = { candidate: OutlineCandidate; node: ProposedNode };
  const stack: StackEntry[] = [];
  const tree: ProposedNode[] = [];

  const ops: PlanOp[] = [];
  const positionByParent: Record<string, number> = {};
  const nextPos = (parentId: string): number => {
    const p = positionByParent[parentId] ?? 0;
    positionByParent[parentId] = p + 1;
    return p;
  };

  for (const c of candidates) {
    const node: ProposedNode = { candidate: c, children: [] };

    if (c.level !== null) {
      // Pop until the stack top has a STRICTLY lower level than this heading.
      while (
        stack.length > 0 &&
        (stack[stack.length - 1].candidate.level as number) >= c.level
      ) {
        stack.pop();
      }
      const parentId =
        stack.length > 0
          ? stack[stack.length - 1].candidate.remId
          : scopeRootId;
      if (stack.length > 0) {
        stack[stack.length - 1].node.children.push(node);
      } else {
        tree.push(node);
      }
      ops.push({ remId: c.remId, newParentId: parentId, newPosition: nextPos(parentId) });
      stack.push({ candidate: c, node });
    } else {
      // Paragraph: attach to current top heading (or root if no heading yet).
      const parentId =
        stack.length > 0
          ? stack[stack.length - 1].candidate.remId
          : scopeRootId;
      if (stack.length > 0) {
        stack[stack.length - 1].node.children.push(node);
      } else {
        tree.push(node);
      }
      ops.push({ remId: c.remId, newParentId: parentId, newPosition: nextPos(parentId) });
      // Paragraphs do NOT push onto the heading stack.
    }
  }

  return { scopeRootId, minHeadingLevel, ops, proposedTree: tree };
}

// ─── Apply / Revert ─────────────────────────────────────────────────────────

// Apply the plan and return a snapshot for undo. Captures each rem's CURRENT
// parent and position BEFORE moving, so revert can restore the exact prior state.
export async function applyPlan(
  plugin: RNPlugin,
  plan: OutlinePlan
): Promise<OutlineSnapshot> {
  const snapshotOps: SnapshotOp[] = [];

  // Capture pre-state for every rem we'll touch.
  for (const op of plan.ops) {
    const rem = await plugin.rem.findOne(op.remId);
    if (!rem) continue;
    const oldParentId = (rem as any).parent as string;
    let oldPosition = 0;
    try {
      const p = await (rem as any).positionAmongstSiblings?.();
      if (typeof p === 'number') oldPosition = p;
    } catch { /* ignore */ }
    snapshotOps.push({ remId: op.remId, oldParentId, oldPosition });
  }

  // Apply in plan order. setParent with positionAmongstSiblings places the rem
  // at the requested index in the new parent's child list. Document order is
  // preserved because we increment positions per-parent as we build the plan.
  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    for (const op of plan.ops) {
      const rem = await plugin.rem.findOne(op.remId);
      if (!rem) continue;
      await rem.setParent(op.newParentId, op.newPosition);
    }
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }

  const scopeRoot = await plugin.rem.findOne(plan.scopeRootId);
  const scopeRootText = scopeRoot
    ? await safeRemTextToString(plugin, (scopeRoot as any).text)
    : 'Untitled';

  return {
    timestamp: Date.now(),
    scopeRootId: plan.scopeRootId,
    scopeRootText,
    ops: snapshotOps,
  };
}

// Revert applies snapshot ops in REVERSE order so that any rem whose old
// parent was itself moved during the original apply ends up correctly placed.
export async function revertSnapshot(
  plugin: RNPlugin,
  snapshot: OutlineSnapshot
): Promise<void> {
  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    for (let i = snapshot.ops.length - 1; i >= 0; i--) {
      const op = snapshot.ops[i];
      const rem = await plugin.rem.findOne(op.remId);
      if (!rem) continue;
      await rem.setParent(op.oldParentId, op.oldPosition);
    }
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}

// Storage key for the last-applied snapshot (session-scoped, single slot).
export const OUTLINE_SNAPSHOT_KEY = 'lastOutlineRestructureSnapshot';
