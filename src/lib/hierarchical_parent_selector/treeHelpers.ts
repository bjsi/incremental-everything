// lib/hierarchical_parent_selector/treeHelpers.ts
// UPDATED: Added filtering for powerup slots (Incremental and CardPriority)

import {
  RNPlugin,
  ReactRNPlugin,
  PluginRem,
  RemId,
  BuiltInPowerupCodes,
} from '@remnote/plugin-sdk';
import { ParentTreeNode, getLastDestinationKey } from './types';
import { resolveRemTextSegments } from '../richTextRemRefs';
import { powerupCode, prioritySlotCode, allIncrementalRemKey } from '../consts';
import { IncrementalRem } from '../incremental_rem';
import { safeRemTextToString, findPDFinRem, findHTMLinRem, getKnownHtmlRemsKey } from '../pdfUtils';
import { calculateRelativePercentile } from '../utils';
import {
  filterOutPowerupSlots,
  getChildrenExcludingSlots
} from '../powerupSlotFilter';
import { getHeadingLevel } from '../outline_restructure';

// ============================================================================
// SESSION CACHE FOR ROOT CANDIDATES
// ============================================================================

/**
 * Cache TTL in milliseconds (30 minutes)
 * Cached data older than this will trigger a full refresh
 */
const ROOT_CANDIDATES_CACHE_TTL = 30 * 60 * 1000;

/**
 * Generate session storage key for root candidates cache
 */
const getRootCandidatesCacheKey = (sourceRemId: string) =>
  `root_candidates_cache_${sourceRemId}`;

/**
 * Generate session storage key for cache refresh signal
 * Widget can watch this to know when to update
 */
export const getCacheRefreshSignalKey = (sourceRemId: string) =>
  `root_candidates_refreshed_${sourceRemId}`;

/**
 * Structure for cached root candidates
 */
interface RootCandidatesCache {
  sourceRemId: string;
  candidates: ParentTreeNode[];
  timestamp: number;
}

/**
 * Creates a ParentTreeNode from a PluginRem.
 * Checks if the rem has children and enriches with priority data if incremental.
 * 
 * UPDATED: Now excludes powerup slots when determining hasChildren
 */
export async function createTreeNode(
  plugin: RNPlugin,
  rem: PluginRem,
  allIncrementalRems: IncrementalRem[],
  depth: number = 0,
  parentId: RemId | null = null
): Promise<ParentTreeNode> {
  const remText = await safeRemTextToString(plugin, rem.text);
  const nameSegments = await resolveRemTextSegments(plugin, rem.text);
  const isIncremental = await rem.hasPowerup(powerupCode);
  const headingLevel = await getHeadingLevel(rem);

  // Check if has children (for expand indicator)
  // UPDATED: Filter out powerup slots from children count
  const children = await getChildrenExcludingSlots(plugin, rem);
  const hasChildren = children.length > 0;

  // Get priority data if incremental
  let priority: number | null = null;
  let percentile: number | null = null;

  if (isIncremental) {
    const priorityProp = await rem.getPowerupProperty(powerupCode, prioritySlotCode);
    if (priorityProp && Array.isArray(priorityProp) && priorityProp.length > 0) {
      priority = parseInt(priorityProp[0] as string);
    }
    if (allIncrementalRems.length > 0) {
      percentile = calculateRelativePercentile(allIncrementalRems, rem._id);
    }
  }

  return {
    remId: rem._id,
    name: remText,
    nameSegments,
    priority,
    percentile,
    isIncremental,
    headingLevel,
    hasChildren,
    isExpanded: false,
    children: [],
    childrenLoaded: false,
    depth,
    parentId,
  };
}

/**
 * Orders a sibling list so headings come first, shallowest level first
 * (H1 before H2 before … H6), and everything else follows in its original
 * editor order. Within the same heading level, editor order is preserved.
 *
 * Rationale: a branch's headings are its table of contents — they're what you
 * usually want to file a highlight under, so they shouldn't be buried among
 * the branch's paragraph/extract children.
 */
export function sortNodesByHeading(nodes: ParentTreeNode[]): ParentTreeNode[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const aLevel = a.node.headingLevel ?? null;
      const bLevel = b.node.headingLevel ?? null;
      if (aLevel !== bLevel) {
        // Non-headings sort after every heading level.
        return (aLevel ?? 7) - (bLevel ?? 7);
      }
      return a.index - b.index; // stable: keep editor order as tie-breaker
    })
    .map(({ node }) => node);
}

// Bounds for the "does this branch contain a heading?" probe. Each visited rem
// costs a getFontSize (and each level a getChildrenRem) over the plugin IPC
// bridge, so an unbounded walk on a big chapter would stall the popup. When a
// branch exceeds the budget we return `null` ("don't know") and the caller
// keeps the branch visible — over-showing beats hiding a reachable heading.
const HEADING_PROBE_MAX_DEPTH = 4;
const HEADING_PROBE_MAX_VISITS = 120;

/**
 * Depth-first search for any heading (H1–H6) beneath `rem`.
 * Returns true/false, or null when the budget ran out before deciding.
 */
async function subtreeHasHeading(
  plugin: RNPlugin,
  rem: PluginRem,
  budget: { visits: number },
  depth: number = 0
): Promise<boolean | null> {
  if (depth >= HEADING_PROBE_MAX_DEPTH) return null;

  let children: PluginRem[];
  try {
    children = await getChildrenExcludingSlots(plugin, rem);
  } catch {
    return null;
  }

  let exhausted = false;

  for (const child of children) {
    if (budget.visits <= 0) return null;
    budget.visits--;

    if ((await getHeadingLevel(child)) != null) return true;

    const deeper = await subtreeHasHeading(plugin, child, budget, depth + 1);
    if (deeper === true) return true;
    // A "don't know" anywhere below means we can't claim the branch is empty.
    if (deeper === null) exhausted = true;
  }

  return exhausted ? null : false;
}

/**
 * Fills in `hasHeadingDescendant` for non-heading nodes, which is what lets the
 * "Filter only headers" view keep a plain rem that is the only path to headings
 * below it.
 *
 * Only called when that filter is actually on — the probe costs IPC round-trips
 * per branch, and there's no reason to pay for it otherwise. Nodes already
 * probed are left alone, so this is safe (and cheap) to re-run.
 */
export async function annotateHeadingDescendants(
  plugin: RNPlugin,
  nodes: ParentTreeNode[],
  opts: { recurse?: boolean } = {}
): Promise<ParentTreeNode[]> {
  const out: ParentTreeNode[] = [];

  for (const node of nodes) {
    let updated = node;

    const needsProbe =
      node.headingLevel == null &&
      node.hasHeadingDescendant === undefined &&
      node.hasChildren;

    if (needsProbe) {
      const rem = await plugin.rem.findOne(node.remId);
      if (rem) {
        const result = await subtreeHasHeading(plugin, rem, {
          visits: HEADING_PROBE_MAX_VISITS,
        });
        // `null` stays undefined: unprobed reads as "keep" downstream.
        if (result !== null) updated = { ...updated, hasHeadingDescendant: result };
      }
    } else if (node.headingLevel == null && !node.hasChildren) {
      // Leaf: nothing below it, so the answer is known without any IPC.
      updated = { ...updated, hasHeadingDescendant: false };
    }

    if (opts.recurse && updated.children.length > 0) {
      updated = {
        ...updated,
        children: await annotateHeadingDescendants(plugin, updated.children, opts),
      };
    }

    out.push(updated);
  }

  return out;
}

/**
 * Loads children for a specific node.
 * Returns the children as ParentTreeNode array, preserving editor order.
 * Heading-first ordering is applied at display time (see
 * flattenTreeForDisplay) so the user can toggle it without reloading.
 *
 * `detectHeadingDescendants` (set when "Filter only headers" is on) additionally
 * works out which non-heading children lead to headings further down.
 *
 * UPDATED: Now filters out powerup slots (Incremental, CardPriority)
 */
export async function loadChildrenForNode(
  plugin: RNPlugin,
  parentRemId: RemId,
  allIncrementalRems: IncrementalRem[],
  parentDepth: number,
  opts: { detectHeadingDescendants?: boolean } = {}
): Promise<ParentTreeNode[]> {
  const parentRem = await plugin.rem.findOne(parentRemId);
  if (!parentRem) return [];

  // getChildrenRem() returns children in document order (as shown in editor)
  // UPDATED: Filter out powerup slots
  const children = await getChildrenExcludingSlots(plugin, parentRem);
  const childNodes: ParentTreeNode[] = [];

  for (const child of children) {
    const node = await createTreeNode(
      plugin,
      child,
      allIncrementalRems,
      parentDepth + 1,
      parentRemId
    );
    childNodes.push(node);
  }

  return opts.detectHeadingDescendants
    ? annotateHeadingDescendants(plugin, childNodes)
    : childNodes;
}

/**
 * Finds all root-level rems associated with a PDF and creates tree nodes.
 * Enhanced version of findAllRemsForPDF that returns a tree structure.
 * 
 * OPTIMIZED: Uses session cache to return instantly on repeated calls.
 * Background refresh keeps the cache up-to-date.
 */
export async function findAllRemsForPDFAsTree(
  plugin: RNPlugin,
  pdfRemId: string
): Promise<ParentTreeNode[]> {
  // console.log('[ParentSelector:TreeHelpers] findAllRemsForPDFAsTree called with pdfRemId:', pdfRemId);

  const cacheKey = getRootCandidatesCacheKey(pdfRemId);
  const cachedData = await plugin.storage.getSession<RootCandidatesCache>(cacheKey);

  // Check if we have valid cached data
  if (cachedData && cachedData.sourceRemId === pdfRemId) {
    const age = Date.now() - cachedData.timestamp;
    // console.log('[ParentSelector:TreeHelpers] ✓ CACHE HIT! Age:', Math.round(age / 1000), 'seconds');

    if (age < ROOT_CANDIDATES_CACHE_TTL) {
      // Cache is fresh - return immediately and refresh in background
      // console.log('[ParentSelector:TreeHelpers] Returning cached candidates:', cachedData.candidates.length);

      // Trigger background refresh (don't await)
      refreshRootCandidatesForPDFInBackground(plugin, pdfRemId);

      return cachedData.candidates;
    } else {
      // console.log('[ParentSelector:TreeHelpers] Cache expired, performing full search');
    }
  } else {
    // console.log('[ParentSelector:TreeHelpers] ✗ CACHE MISS - performing full search');
  }

  // Cache miss or expired - perform full search
  const result = await performFullPDFSearch(plugin, pdfRemId);

  // Store in cache
  const newCache: RootCandidatesCache = {
    sourceRemId: pdfRemId,
    candidates: result,
    timestamp: Date.now()
  };
  await plugin.storage.setSession(cacheKey, newCache);
  // console.log('[ParentSelector:TreeHelpers] Stored', result.length, 'candidates in cache');

  return result;
}

/**
 * Performs the full search for PDF root candidates (expensive operation).
 * This is the original search logic, extracted for reuse.
 */
async function performFullPDFSearch(
  plugin: RNPlugin,
  pdfRemId: string
): Promise<ParentTreeNode[]> {
  const result: ParentTreeNode[] = [];
  const processedRemIds = new Set<string>();

  const allIncrementalRems = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];
  // console.log('[ParentSelector:TreeHelpers] [FullSearch] Found', allIncrementalRems.length, 'incremental rems in cache');

  // PART 0: Local ancestral check
  // Ensures the direct parent containing the PDF is found even if cache is empty or incomplete
  try {
    const pdfRem = await plugin.rem.findOne(pdfRemId);
    if (pdfRem && pdfRem.parent) {
      const isPdfHighlight = await pdfRem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
      if (!isPdfHighlight) {
        const parent = await plugin.rem.findOne(pdfRem.parent);
        if (parent) {
          const foundPDF = await findPDFinRem(plugin, parent, pdfRemId);
          if (foundPDF && foundPDF._id === pdfRemId) {
            const node = await createTreeNode(plugin, parent, allIncrementalRems, 0, null);
            result.push(node);
            processedRemIds.add(parent._id);
          }
        }
      }
    }
  } catch (e) {
    console.error('[ParentSelector:TreeHelpers] Error in ancestral check:', e);
  }

  // PART 1: Search all incremental rems from cache
  for (const incRemInfo of allIncrementalRems) {
    if (processedRemIds.has(incRemInfo.remId)) continue;

    const rem = await plugin.rem.findOne(incRemInfo.remId);
    if (!rem) continue;

    const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
    if (isPdfHighlight) continue;

    const foundPDF = await findPDFinRem(plugin, rem, pdfRemId);

    if (foundPDF && foundPDF._id === pdfRemId) {
      const node = await createTreeNode(plugin, rem, allIncrementalRems, 0, null);
      result.push(node);
      processedRemIds.add(rem._id);
      // console.log('[ParentSelector:TreeHelpers] [FullSearch] Added root candidate (incremental):', node.name);
    }
  }

  // PART 2: Check known rems from storage
  const knownRemsKey = `known_pdf_rems_${pdfRemId}`;
  const knownRemIds = (await plugin.storage.getSynced<string[]>(knownRemsKey)) || [];
  // console.log('[ParentSelector:TreeHelpers] [FullSearch] Found', knownRemIds.length, 'known rems in storage');

  for (const remId of knownRemIds) {
    if (processedRemIds.has(remId)) continue;

    const rem = await plugin.rem.findOne(remId);
    if (!rem) continue;

    const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
    if (isPdfHighlight) continue;

    const foundPDF = await findPDFinRem(plugin, rem, pdfRemId);
    if (foundPDF && foundPDF._id === pdfRemId) {
      const node = await createTreeNode(plugin, rem, allIncrementalRems, 0, null);
      result.push(node);
      processedRemIds.add(rem._id);
      // console.log('[ParentSelector:TreeHelpers] [FullSearch] Added root candidate (known):', node.name);
    }
  }

  // Sort
  result.sort((a, b) => {
    if (a.isIncremental !== b.isIncremental) {
      return a.isIncremental ? -1 : 1;
    }
    if (a.priority !== null && b.priority !== null) {
      return a.priority - b.priority;
    }
    if (a.priority !== null) return -1;
    if (b.priority !== null) return 1;
    return a.name.localeCompare(b.name);
  });

  // console.log('[ParentSelector:TreeHelpers] [FullSearch] Total root candidates:', result.length);
  return result;
}

/**
 * Refreshes the root candidates cache in the background.
 * Updates the cache and signals the widget to update if needed.
 */
export async function refreshRootCandidatesForPDFInBackground(
  plugin: RNPlugin,
  pdfRemId: string
): Promise<void> {
  // console.log('[ParentSelector:TreeHelpers] [Background] Starting refresh for PDF:', pdfRemId);

  try {
    const result = await performFullPDFSearch(plugin, pdfRemId);

    const cacheKey = getRootCandidatesCacheKey(pdfRemId);
    const newCache: RootCandidatesCache = {
      sourceRemId: pdfRemId,
      candidates: result,
      timestamp: Date.now()
    };
    await plugin.storage.setSession(cacheKey, newCache);

    // Signal the widget that the cache has been refreshed
    const signalKey = getCacheRefreshSignalKey(pdfRemId);
    await plugin.storage.setSession(signalKey, Date.now());

    // console.log('[ParentSelector:TreeHelpers] [Background] Refresh complete. Candidates:', result.length);
  } catch (error) {
    console.error('[ParentSelector:TreeHelpers] [Background] Error during refresh:', error);
  }
}

/**
 * Finds all root-level rems associated with an HTML page and creates tree nodes.
 * Similar to findAllRemsForPDFAsTree but for HTML/Link sources.
 * 
 * OPTIMIZED: Uses session cache to return instantly on repeated calls.
 * Background refresh keeps the cache up-to-date.
 */
export async function findAllRemsForHTMLAsTree(
  plugin: RNPlugin,
  htmlRemId: string
): Promise<ParentTreeNode[]> {
  // console.log('[ParentSelector:TreeHelpers] findAllRemsForHTMLAsTree called with htmlRemId:', htmlRemId);

  const cacheKey = getRootCandidatesCacheKey(htmlRemId);
  const cachedData = await plugin.storage.getSession<RootCandidatesCache>(cacheKey);

  // Check if we have valid cached data
  if (cachedData && cachedData.sourceRemId === htmlRemId) {
    const age = Date.now() - cachedData.timestamp;
    // console.log('[ParentSelector:TreeHelpers] ✓ HTML CACHE HIT! Age:', Math.round(age / 1000), 'seconds');

    if (age < ROOT_CANDIDATES_CACHE_TTL) {
      // console.log('[ParentSelector:TreeHelpers] Returning cached HTML candidates:', cachedData.candidates.length);

      // Trigger background refresh (don't await)
      refreshRootCandidatesForHTMLInBackground(plugin, htmlRemId);

      return cachedData.candidates;
    } else {
      // console.log('[ParentSelector:TreeHelpers] HTML cache expired, performing full search');
    }
  } else {
    // console.log('[ParentSelector:TreeHelpers] ✗ HTML CACHE MISS - performing full search');
  }

  // Cache miss or expired - perform full search
  const result = await performFullHTMLSearch(plugin, htmlRemId);

  // Store in cache
  const newCache: RootCandidatesCache = {
    sourceRemId: htmlRemId,
    candidates: result,
    timestamp: Date.now()
  };
  await plugin.storage.setSession(cacheKey, newCache);
  // console.log('[ParentSelector:TreeHelpers] Stored', result.length, 'HTML candidates in cache');

  return result;
}

/**
 * Performs the full search for HTML root candidates (expensive operation).
 */
async function performFullHTMLSearch(
  plugin: RNPlugin,
  htmlRemId: string
): Promise<ParentTreeNode[]> {
  const result: ParentTreeNode[] = [];
  const processedRemIds = new Set<string>();

  const allIncrementalRems = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];
  // console.log('[ParentSelector:TreeHelpers] [HTMLSearch] Found', allIncrementalRems.length, 'incremental rems in cache');

  // PART 0: Local ancestral check
  try {
    const htmlRem = await plugin.rem.findOne(htmlRemId);
    if (htmlRem && htmlRem.parent) {
      const isHtmlHighlight = await htmlRem.hasPowerup(BuiltInPowerupCodes.HTMLHighlight);
      if (!isHtmlHighlight) {
        const parent = await plugin.rem.findOne(htmlRem.parent);
        if (parent) {
          const foundHTML = await findHTMLinRem(plugin, parent, htmlRemId);
          if (foundHTML && foundHTML._id === htmlRemId) {
            const node = await createTreeNode(plugin, parent, allIncrementalRems, 0, null);
            result.push(node);
            processedRemIds.add(parent._id);
          }
        }
      }
    }
  } catch (e) {
    console.error('[ParentSelector:TreeHelpers] Error in ancestral check:', e);
  }

  // PART 1: Search all incremental rems from cache
  for (const incRemInfo of allIncrementalRems) {
    if (processedRemIds.has(incRemInfo.remId)) continue;

    const rem = await plugin.rem.findOne(incRemInfo.remId);
    if (!rem) continue;

    // Skip HTML highlights - we want parent rems only
    const isHtmlHighlight = await rem.hasPowerup(BuiltInPowerupCodes.HTMLHighlight);
    if (isHtmlHighlight) continue;

    // Check if this incremental rem has the target HTML as a source
    const foundHTML = await findHTMLinRem(plugin, rem, htmlRemId);

    if (foundHTML && foundHTML._id === htmlRemId) {
      const node = await createTreeNode(plugin, rem, allIncrementalRems, 0, null);
      result.push(node);
      processedRemIds.add(rem._id);
      // console.log('[ParentSelector:TreeHelpers] [HTMLSearch] Added root candidate (incremental):', node.name);
    }
  }

  // PART 2: Check known rems from storage
  const knownRemsKey = getKnownHtmlRemsKey(htmlRemId);
  const knownRemIds = (await plugin.storage.getSynced<string[]>(knownRemsKey)) || [];
  // console.log('[ParentSelector:TreeHelpers] [HTMLSearch] Found', knownRemIds.length, 'known HTML rems in storage');

  for (const remId of knownRemIds) {
    if (processedRemIds.has(remId)) continue;

    const rem = await plugin.rem.findOne(remId);
    if (!rem) continue;

    // Skip HTML highlights
    const isHtmlHighlight = await rem.hasPowerup(BuiltInPowerupCodes.HTMLHighlight);
    if (isHtmlHighlight) continue;

    const foundHTML = await findHTMLinRem(plugin, rem, htmlRemId);
    if (foundHTML && foundHTML._id === htmlRemId) {
      const node = await createTreeNode(plugin, rem, allIncrementalRems, 0, null);
      result.push(node);
      processedRemIds.add(rem._id);
      // console.log('[ParentSelector:TreeHelpers] [HTMLSearch] Added root candidate (known):', node.name);
    }
  }

  // Sort: incremental first, then by priority, then alphabetically
  result.sort((a, b) => {
    if (a.isIncremental !== b.isIncremental) {
      return a.isIncremental ? -1 : 1;
    }
    if (a.priority !== null && b.priority !== null) {
      return a.priority - b.priority;
    }
    if (a.priority !== null) return -1;
    if (b.priority !== null) return 1;
    return a.name.localeCompare(b.name);
  });

  // console.log('[ParentSelector:TreeHelpers] [HTMLSearch] Total root candidates:', result.length);
  return result;
}

/**
 * Refreshes the HTML root candidates cache in the background.
 */
export async function refreshRootCandidatesForHTMLInBackground(
  plugin: RNPlugin,
  htmlRemId: string
): Promise<void> {
  // console.log('[ParentSelector:TreeHelpers] [Background] Starting refresh for HTML:', htmlRemId);

  try {
    const result = await performFullHTMLSearch(plugin, htmlRemId);

    const cacheKey = getRootCandidatesCacheKey(htmlRemId);
    const newCache: RootCandidatesCache = {
      sourceRemId: htmlRemId,
      candidates: result,
      timestamp: Date.now()
    };
    await plugin.storage.setSession(cacheKey, newCache);

    // Signal the widget that the cache has been refreshed
    const signalKey = getCacheRefreshSignalKey(htmlRemId);
    await plugin.storage.setSession(signalKey, Date.now());

    // console.log('[ParentSelector:TreeHelpers] [Background] HTML refresh complete. Candidates:', result.length);
  } catch (error) {
    console.error('[ParentSelector:TreeHelpers] [Background] Error during HTML refresh:', error);
  }
}


/**
 * Retrieves the last selected destination for a given context.
 * 
 * DEBUG: Added extensive logging
 */
export async function getLastSelectedDestination(
  plugin: RNPlugin,
  pdfRemId: RemId,
  contextRemId: RemId | null
): Promise<RemId | null> {
  const key = getLastDestinationKey(pdfRemId, contextRemId);

  // console.log('[ParentSelector:TreeHelpers] ========== GET LAST DESTINATION ==========');
  // console.log('[ParentSelector:TreeHelpers] pdfRemId:', pdfRemId);
  // console.log('[ParentSelector:TreeHelpers] contextRemId:', contextRemId);
  // console.log('[ParentSelector:TreeHelpers] Generated storage key:', key);

  const stored = await plugin.storage.getSynced<RemId | null>(key);

  // console.log('[ParentSelector:TreeHelpers] Retrieved value:', stored);
  // console.log('[ParentSelector:TreeHelpers] ==========================================');

  return stored || null;
}

/**
 * Saves the last selected destination for a given context.
 * 
 * DEBUG: Added extensive logging
 */
export async function saveLastSelectedDestination(
  plugin: RNPlugin,
  pdfRemId: RemId,
  contextRemId: RemId | null,
  destinationRemId: RemId
): Promise<void> {
  const key = getLastDestinationKey(pdfRemId, contextRemId);

  // console.log('[ParentSelector:TreeHelpers] ========== SAVE LAST DESTINATION ==========');
  // console.log('[ParentSelector:TreeHelpers] pdfRemId:', pdfRemId);
  // console.log('[ParentSelector:TreeHelpers] contextRemId:', contextRemId);
  // console.log('[ParentSelector:TreeHelpers] destinationRemId:', destinationRemId);
  // console.log('[ParentSelector:TreeHelpers] Generated storage key:', key);

  await plugin.storage.setSynced(key, destinationRemId);
}

/**
 * FIXED: Attempts to find and expand the path to the last selected destination.
 * 
 * The key insight: we need to build the ancestry chain from the destination UP to a root,
 * then expand DOWN from the root to the destination.
 */
export async function expandToLastDestination(
  plugin: RNPlugin,
  tree: ParentTreeNode[],
  lastDestinationId: RemId,
  allIncrementalRems: IncrementalRem[]
): Promise<{ tree: ParentTreeNode[]; foundIndex: number }> {
  // console.log('[ParentSelector:TreeHelpers] ========== EXPAND TO LAST DESTINATION ==========');
  // console.log('[ParentSelector:TreeHelpers] lastDestinationId:', lastDestinationId);
  // console.log('[ParentSelector:TreeHelpers] Root candidates:', tree.map(n => ({ id: n.remId, name: n.name })));

  // Build a Set of root candidate IDs for quick lookup
  const rootCandidateIds = new Set(tree.map(n => n.remId));
  // console.log('[ParentSelector:TreeHelpers] Root candidate IDs:', Array.from(rootCandidateIds));

  // First, check if the destination is in the root level
  const rootIndex = tree.findIndex(node => node.remId === lastDestinationId);
  if (rootIndex !== -1) {
    // console.log('[ParentSelector:TreeHelpers] Found in root level at index:', rootIndex);
    return { tree, foundIndex: rootIndex };
  }

  // Not in root - need to find the path from destination up to a root candidate
  const destinationRem = await plugin.rem.findOne(lastDestinationId);
  if (!destinationRem) {
    // console.log('[ParentSelector:TreeHelpers] ERROR: Destination rem not found!');
    return { tree, foundIndex: -1 };
  }

  const destName = await safeRemTextToString(plugin, destinationRem.text);
  // console.log('[ParentSelector:TreeHelpers] Destination rem found:', destName);

  // Build the path from destination UP to a root candidate
  // pathFromRootToDestination will be [rootCandidate, child1, child2, ..., destination]
  const pathFromDestToRoot: RemId[] = [lastDestinationId];
  let currentRem: PluginRem | undefined = destinationRem;
  let foundRootId: RemId | null = null;
  let iterations = 0;
  const maxIterations = 50; // Safety limit

  // console.log('[ParentSelector:TreeHelpers] Building ancestry path...');

  while (currentRem && currentRem.parent && iterations < maxIterations) {
    iterations++;
    const parentId = currentRem.parent;

    // console.log('[ParentSelector:TreeHelpers]   Checking parent:', parentId);

    // Check if this parent is a root candidate
    if (rootCandidateIds.has(parentId)) {
      foundRootId = parentId;
      // console.log('[ParentSelector:TreeHelpers]   FOUND ROOT CANDIDATE:', parentId);
      break;
    }

    // Not a root candidate, add to path and continue up
    pathFromDestToRoot.push(parentId);

    const parentRem = await plugin.rem.findOne(parentId);
    if (!parentRem) {
      // console.log('[ParentSelector:TreeHelpers]   Parent rem not found, stopping');
      break;
    }

    currentRem = parentRem;
  }

  if (!foundRootId) {
    // console.log('[ParentSelector:TreeHelpers] ERROR: Could not find a root candidate in ancestry chain');
    // console.log('[ParentSelector:TreeHelpers] Path traversed:', pathFromDestToRoot);
    return { tree, foundIndex: -1 };
  }

  // Reverse the path so it goes from root to destination
  // pathFromDestToRoot is [destination, parent1, parent2, ...]
  // We want [parent2, parent1, destination] (from root candidate's child down to destination)
  pathFromDestToRoot.reverse();

  // The path now is [closest_to_root, ..., destination]
  // We need to expand: rootCandidate -> pathFromDestToRoot[0] -> ... -> destination
  const fullPathToExpand = [foundRootId, ...pathFromDestToRoot];

  // console.log('[ParentSelector:TreeHelpers] Full path to expand (root to destination):');
  for (const id of fullPathToExpand) {
    const rem = await plugin.rem.findOne(id);
    const name = rem ? await safeRemTextToString(plugin, rem.text) : 'unknown';
    // console.log('[ParentSelector:TreeHelpers]   -', id, ':', name);
  }

  // Now expand each node along the path (except the last one, which is the destination)
  let updatedTree = [...tree];

  // Helper function to find and update a node in the tree
  const findAndExpandNode = (
    nodes: ParentTreeNode[],
    targetId: RemId,
    newChildren: ParentTreeNode[]
  ): ParentTreeNode[] => {
    return nodes.map(node => {
      if (node.remId === targetId) {
        return {
          ...node,
          children: newChildren,
          childrenLoaded: true,
          isExpanded: true,
        };
      }
      if (node.children.length > 0) {
        return {
          ...node,
          children: findAndExpandNode(node.children, targetId, newChildren),
        };
      }
      return node;
    });
  };

  // Expand each node in the path (except the last one - the destination itself)
  for (let i = 0; i < fullPathToExpand.length - 1; i++) {
    const nodeIdToExpand = fullPathToExpand[i];
    const nextNodeId = fullPathToExpand[i + 1];

    // console.log('[ParentSelector:TreeHelpers] Expanding node:', nodeIdToExpand, 'to reveal:', nextNodeId);

    // Find the node to expand (either in root or nested)
    let nodeToExpand: ParentTreeNode | undefined;

    const findNode = (nodes: ParentTreeNode[]): ParentTreeNode | undefined => {
      for (const n of nodes) {
        if (n.remId === nodeIdToExpand) return n;
        if (n.children.length > 0) {
          const found = findNode(n.children);
          if (found) return found;
        }
      }
      return undefined;
    };

    nodeToExpand = findNode(updatedTree);

    if (!nodeToExpand) {
      // console.log('[ParentSelector:TreeHelpers] ERROR: Could not find node to expand:', nodeIdToExpand);
      break;
    }

    // Load children if not already loaded
    if (!nodeToExpand.childrenLoaded) {
      // console.log('[ParentSelector:TreeHelpers] Loading children for:', nodeToExpand.name);
      const children = await loadChildrenForNode(
        plugin,
        nodeToExpand.remId,
        allIncrementalRems,
        nodeToExpand.depth
      );
      // console.log('[ParentSelector:TreeHelpers] Loaded', children.length, 'children');

      // Update the tree with the new children and expanded state
      updatedTree = findAndExpandNode(updatedTree, nodeIdToExpand, children);
    } else {
      // Just expand it
      updatedTree = updatedTree.map(node => {
        if (node.remId === nodeIdToExpand) {
          return { ...node, isExpanded: true };
        }
        if (node.children.length > 0) {
          return {
            ...node,
            children: (function expandInChildren(children: ParentTreeNode[]): ParentTreeNode[] {
              return children.map(child => {
                if (child.remId === nodeIdToExpand) {
                  return { ...child, isExpanded: true };
                }
                if (child.children.length > 0) {
                  return { ...child, children: expandInChildren(child.children) };
                }
                return child;
              });
            })(node.children),
          };
        }
        return node;
      });
    }
  }

  // Flatten the tree and find the index of the destination
  const flatList = flattenTreeForDisplay(updatedTree);
  const finalIndex = flatList.findIndex(n => n.remId === lastDestinationId);

  // console.log('[ParentSelector:TreeHelpers] Final flattened list has', flatList.length, 'items');
  // console.log('[ParentSelector:TreeHelpers] Destination found at index:', finalIndex);
  // console.log('[ParentSelector:TreeHelpers] ================================================');

  return { tree: updatedTree, foundIndex: finalIndex };
}

/**
 * Options controlling how a branch's children are presented.
 * Both are per-device user settings; see parentSelectorHeadingsOnlyKey /
 * parentSelectorHeadingsFirstKey.
 */
export interface TreeDisplayOptions {
  /** Show only heading (H1–H6) children inside expanded branches. */
  headingsOnly?: boolean;
  /** Hoist heading children above the rest, shallowest level first. */
  headingsFirst?: boolean;
  /**
   * Rems that must stay visible regardless of `headingsOnly` — the remembered
   * destination and the suggested rem, which are frequently plain (non-heading)
   * rems and would otherwise be filtered out of the very list that offers them.
   * Their ancestors are kept too, so the row is actually reachable.
   */
  alwaysShowRemIds?: Set<RemId>;
}

/**
 * Expands a set of "must stay visible" rem ids into that set plus every
 * ancestor of those rems within the loaded tree.
 */
function collectPinnedWithAncestors(
  nodes: ParentTreeNode[],
  pinned: Set<RemId>
): Set<RemId> {
  const result = new Set<RemId>();

  const walk = (list: ParentTreeNode[], ancestors: RemId[]) => {
    for (const node of list) {
      const path = [...ancestors, node.remId];
      if (pinned.has(node.remId)) {
        for (const id of path) result.add(id);
      }
      if (node.children.length > 0) walk(node.children, path);
    }
  };

  walk(nodes, []);
  return result;
}

/**
 * Helper to flatten tree for display.
 *
 * Root candidates (depth 0) are always kept and always keep their incoming
 * order — both options are about navigating a rem's own tree, not about
 * narrowing or reshuffling the IncRem candidate list.
 */
export function flattenTreeForDisplay(
  nodes: ParentTreeNode[],
  opts: TreeDisplayOptions = {}
): ParentTreeNode[] {
  const result: ParentTreeNode[] = [];
  const pinned =
    opts.headingsOnly && opts.alwaysShowRemIds?.size
      ? collectPinnedWithAncestors(nodes, opts.alwaysShowRemIds)
      : null;

  const traverse = (nodeList: ParentTreeNode[], depth: number) => {
    let list = nodeList;
    if (depth > 0) {
      if (opts.headingsOnly) {
        // Keep headings, plus any non-heading that leads to headings below it
        // (so a plain wrapper rem never makes its headings unreachable).
        // `hasHeadingDescendant === undefined` means "not probed" — keep it,
        // since hiding a branch we haven't inspected could strand content.
        list = list.filter(
          (node) =>
            node.headingLevel != null ||
            node.hasHeadingDescendant !== false ||
            pinned?.has(node.remId)
        );
      }
      if (opts.headingsFirst) {
        list = sortNodesByHeading(list);
      }
    }

    for (const node of list) {
      result.push(node);
      if (node.isExpanded && node.children.length > 0) {
        traverse(node.children, depth + 1);
      }
    }
  };

  traverse(nodes, 0);
  return result;
}
