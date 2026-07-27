import { RemId, RichTextInterface } from '@remnote/plugin-sdk';
import { RemTextSegment } from '../richTextRemRefs';
import { HeadingLevel } from '../outline_restructure';

/**
 * Represents a node in the hierarchical parent selector tree.
 * Each node can have children that are loaded on-demand when expanded.
 */
export interface ParentTreeNode {
  remId: RemId;
  name: string;                   // Plain-text name (used for sorting/filtering/tooltips)
  nameSegments: RemTextSegment[];  // Display segments — pins render as an icon, not text
  priority: number | null;
  percentile: number | null;
  isIncremental: boolean;
  // Heading level (H1–H6) if the rem carries the built-in Header powerup, else null.
  // Optional because nodes cached by older versions predate this field.
  headingLevel?: HeadingLevel | null;
  // Whether a heading lives somewhere below this (non-heading) rem, so the
  // "Filter only headers" view can keep the branch as a path to it.
  // Tri-state: undefined = not probed yet (treated as "keep", since we can't
  // prove the branch is heading-free). See annotateHeadingDescendants.
  hasHeadingDescendant?: boolean;
  // Set when this rem is only shown here because a portal among the parent's
  // children mirrors it — the rem itself lives elsewhere. Selecting it files
  // the new rem in that real home, which is also what shows inside the portal.
  isPortal?: boolean;
  // The portal rem that mirrored it in (only meaningful with isPortal).
  portalId?: RemId;
  // Breadcrumb of the ancestors it really lives under ("A › B › C"), for the
  // "where it lives" tooltip.
  portalBreadcrumb?: string;
  hasChildren: boolean;        // Indicates if this node has children (shows expand indicator)
  isExpanded: boolean;         // Whether the node is currently expanded
  children: ParentTreeNode[];  // Loaded children (empty until expanded)
  childrenLoaded: boolean;     // Whether children have been fetched
  depth: number;               // Depth in the tree (0 = root level)
  parentId: RemId | null;      // Parent node's remId (for tree navigation)
  // Identifies this node's *position* in the tree (its ancestor path), set by
  // flattenTreeForDisplay. The same rem can legitimately occupy several
  // positions — as a root candidate and again deeper down, or mirrored in by
  // portals — and expanding one copy shares the very same children array with
  // every other copy. Keying rows by rem identity therefore collides; key them
  // by this instead.
  displayKey?: string;
}

/**
 * Context passed to the Parent Selector widget.
 */
export interface ParentSelectorContext {
  pdfRemId: RemId;
  extractRemId: RemId;
  extractContent: RichTextInterface;
  rootCandidates: ParentTreeNode[];
  makeIncremental: boolean;
  contextRemId: RemId | null;
  lastSelectedDestination: RemId | null;
  
  // NEW: Priority popup support
  /** If true, show the priority popup after creating the incremental rem */
  showPriorityPopupAfterCreate?: boolean;
  /** True if the original highlight was already an incremental rem */
  highlightWasAlreadyIncremental?: boolean;
  /** Page index of the PDF highlight, used to suggest the tightest matching IncRem */
  highlightPageIndex?: number | null;
}

/**
 * Storage key generator for last selected destination.
 * 
 * The key is based on:
 * - If contextRemId exists: the specific IncRem (e.g., "Chapter 1")
 * - If contextRemId is null: the PDF itself
 * 
 * This allows different "chapters" of the same PDF to have their own
 * remembered destinations.
 */
export const getLastDestinationKey = (pdfRemId: RemId, contextRemId: RemId | null): string => {
  if (contextRemId) {
    return `parent_selector_last_dest_increm_${contextRemId}`;
  }
  return `parent_selector_last_dest_pdf_${pdfRemId}`;
};

/**
 * Flattens a tree of ParentTreeNodes into a display list.
 * Only includes expanded branches.
 */
export const flattenTreeForDisplay = (nodes: ParentTreeNode[]): ParentTreeNode[] => {
  const result: ParentTreeNode[] = [];
  
  const traverse = (nodeList: ParentTreeNode[]) => {
    for (const node of nodeList) {
      result.push(node);
      if (node.isExpanded && node.children.length > 0) {
        traverse(node.children);
      }
    }
  };
  
  traverse(nodes);
  return result;
};

/**
 * Finds a node in the tree by its remId.
 * Returns the node and its path (array of parent remIds).
 */
export const findNodeInTree = (
  nodes: ParentTreeNode[],
  targetRemId: RemId,
  path: RemId[] = []
): { node: ParentTreeNode; path: RemId[] } | null => {
  for (const node of nodes) {
    if (node.remId === targetRemId) {
      return { node, path };
    }
    if (node.children.length > 0) {
      const found = findNodeInTree(node.children, targetRemId, [...path, node.remId]);
      if (found) return found;
    }
  }
  return null;
};

/**
 * Updates a node in the tree (immutable update).
 * Returns a new tree with the updated node.
 */
export const updateNodeInTree = (
  nodes: ParentTreeNode[],
  targetRemId: RemId,
  updater: (node: ParentTreeNode) => ParentTreeNode
): ParentTreeNode[] => {
  return nodes.map(node => {
    if (node.remId === targetRemId) {
      return updater(node);
    }
    if (node.children.length > 0) {
      return {
        ...node,
        children: updateNodeInTree(node.children, targetRemId, updater)
      };
    }
    return node;
  });
};

/**
 * Expands all nodes along a path to make a target node visible.
 * Used to auto-expand to the last selected destination.
 */
export const expandPathToNode = (
  nodes: ParentTreeNode[],
  path: RemId[]
): ParentTreeNode[] => {
  if (path.length === 0) return nodes;
  
  const [currentId, ...remainingPath] = path;
  
  return nodes.map(node => {
    if (node.remId === currentId) {
      return {
        ...node,
        isExpanded: true,
        children: remainingPath.length > 0 
          ? expandPathToNode(node.children, remainingPath)
          : node.children
      };
    }
    return node;
  });
};
