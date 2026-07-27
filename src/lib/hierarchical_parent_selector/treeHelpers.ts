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
import { getHeadingLevel } from '../outline_restructure';
import { ChildRemEntry, getChildEntries, getPortalContainerIds } from './portals';
import { getBreadcrumbText } from '../incRemHelpers';

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
 * UPDATED: Now excludes powerup slots when determining hasChildren, and counts
 * portal targets as children so a branch whose only content arrives through a
 * portal still gets an expand arrow.
 *
 * `viaPortalId` marks the node as mirrored in through that portal rather than
 * reached by real parentage.
 */
export async function createTreeNode(
  plugin: RNPlugin,
  rem: PluginRem,
  allIncrementalRems: IncrementalRem[],
  depth: number = 0,
  parentId: RemId | null = null,
  viaPortalId?: RemId
): Promise<ParentTreeNode> {
  const remText = await safeRemTextToString(plugin, rem.text);
  const nameSegments = await resolveRemTextSegments(plugin, rem.text);
  const isIncremental = await rem.hasPowerup(powerupCode);
  const headingLevel = await getHeadingLevel(rem);

  // Check if has children (for expand indicator)
  // UPDATED: Filter out powerup slots, fold in portal targets
  const children = await getChildEntries(plugin, rem);
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

  // Where the rem actually lives, so the row can say so on hover. Uses the
  // shared breadcrumb builder, so ancestors read the same way they do in the
  // Reader and Extract Viewer (pins collapse to 📌 instead of expanding into
  // the whole referenced rem). Only paid for on portal rows, which are rare.
  let portalBreadcrumb: string | undefined;
  if (viaPortalId) {
    portalBreadcrumb = (await getBreadcrumbText(plugin, rem, { maxDepth: 8 })) || undefined;
  }

  return {
    remId: rem._id,
    name: remText,
    nameSegments,
    priority,
    percentile,
    isIncremental,
    headingLevel,
    isPortal: viaPortalId ? true : undefined,
    portalId: viaPortalId,
    portalBreadcrumb,
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
 * Depth-first search for any heading (H1–H6) beneath `rem`, following portals
 * as well as real children — a portal's content is visible in this branch, so
 * a heading inside it is a reachable heading.
 *
 * Returns true/false, or null when the budget ran out before deciding.
 * `visited` also stops a portal that loops back to an ancestor from re-walking
 * ground already covered.
 */
async function subtreeHasHeading(
  plugin: RNPlugin,
  rem: PluginRem,
  budget: { visits: number; visited: Set<RemId> },
  depth: number = 0
): Promise<boolean | null> {
  if (depth >= HEADING_PROBE_MAX_DEPTH) return null;

  let children: ChildRemEntry[];
  try {
    children = await getChildEntries(plugin, rem);
  } catch {
    return null;
  }

  let exhausted = false;

  for (const { rem: child } of children) {
    if (budget.visits <= 0) return null;
    if (budget.visited.has(child._id)) continue;
    budget.visits--;
    budget.visited.add(child._id);

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
          visited: new Set([node.remId]),
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
 * UPDATED: Now filters out powerup slots (Incremental, CardPriority), and
 * resolves portals sitting among the children into the rems they mirror, so
 * they can be picked as destinations just like real children.
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

  // Entries come back in document order (as shown in the editor), with powerup
  // slots removed and each portal replaced by the rems it mirrors.
  const children = await getChildEntries(plugin, parentRem);
  const childNodes: ParentTreeNode[] = [];

  for (const { rem: child, viaPortalId } of children) {
    const node = await createTreeNode(
      plugin,
      child,
      allIncrementalRems,
      parentDepth + 1,
      parentRemId,
      viaPortalId
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
 * Breadth-first search upward from `startId` for any root candidate, stepping
 * through portal containers as well as real parents.
 *
 * A rem mirrored by a portal shows up under the portal's own parent, so that
 * container is a genuine step up the tree the user sees — even though no
 * parent link connects them. Returns [rootCandidate, ..., startId], or null.
 *
 * Only used as a fallback: the plain parent walk covers the overwhelming
 * majority of destinations and costs a single lookup per hop, whereas each hop
 * here also asks for the rem's portals.
 */
// Traces the fallback search hop by hop: every visit with its parent and portal
// containers, each hop rejected for not being rendered, the resolved path, and
// whether the destination was found. Off by default; flip to true when a
// remembered destination fails to be restored.
//
// Worth keeping: this route is hard to reason about from the outside — it only
// runs when the plain parent walk fails, and both bugs found here (a portal hop
// silently returning nothing, and a path routed through rems the tree hides)
// looked identical from the UI, namely a destination that just wasn't there.
const PORTAL_PATH_DEBUG = false;

async function findPortalAwarePathToRoot(
  plugin: RNPlugin,
  startId: RemId,
  rootCandidateIds: Set<RemId>,
  maxVisits: number = 200
): Promise<RemId[] | null> {
  const visited = new Set<RemId>([startId]);
  const queue: Array<{ id: RemId; path: RemId[] }> = [{ id: startId, path: [startId] }];
  let visits = 0;

  // What each rem actually lists as children in the selector. A raw `.parent`
  // link is NOT enough: powerup slots, aliases and search portals all have real
  // parent links but are filtered out of the tree, so a path routed through one
  // is a path the walk-down can't reproduce — it finds no node and gives up,
  // stranding the destination. Deriving the hop test from getChildEntries is
  // what keeps the search and the render in agreement. Cached per rem, since
  // the same candidate parent is tested repeatedly.
  const childIdsCache = new Map<RemId, Set<RemId>>();
  const renderedChildIdsOf = async (id: RemId): Promise<Set<RemId>> => {
    const cached = childIdsCache.get(id);
    if (cached) return cached;
    let ids = new Set<RemId>();
    try {
      const rem = await plugin.rem.findOne(id);
      if (rem) ids = new Set((await getChildEntries(plugin, rem)).map((e) => e.rem._id));
    } catch {
      /* unreadable parent: treat as having no children, so no hop goes through it */
    }
    childIdsCache.set(id, ids);
    return ids;
  };

  while (queue.length > 0 && visits < maxVisits) {
    const { id, path } = queue.shift()!;
    visits++;

    const rem = await plugin.rem.findOne(id);
    if (!rem) continue;

    const predecessors: RemId[] = [];
    if (rem.parent) predecessors.push(rem.parent);
    const portalContainers = await getPortalContainerIds(plugin, rem);
    predecessors.push(...portalContainers);

    if (PORTAL_PATH_DEBUG) {
      console.log(
        '[ParentSelector:PortalPath] visit',
        await safeRemTextToString(plugin, rem.text),
        { id, parent: rem.parent, portalContainers }
      );
    }

    for (const predId of predecessors) {
      if (!(await renderedChildIdsOf(predId)).has(id)) {
        if (PORTAL_PATH_DEBUG) {
          console.log(
            '[ParentSelector:PortalPath]   skip hop',
            predId,
            '→',
            id,
            '(parent does not list it — hidden from the tree)'
          );
        }
        continue;
      }

      if (rootCandidateIds.has(predId)) {
        const result = [predId, ...path];
        if (PORTAL_PATH_DEBUG) {
          console.log('[ParentSelector:PortalPath] reached root candidate after', visits, 'visits:', result);
        }
        return result;
      }
      if (visited.has(predId)) continue;
      visited.add(predId);
      queue.push({ id: predId, path: [predId, ...path] });
    }
  }

  if (PORTAL_PATH_DEBUG) {
    console.warn(
      '[ParentSelector:PortalPath] no route to any root candidate after',
      visits,
      'visits (queue drained:', queue.length === 0, ')'
    );
  }
  return null;
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

  let fullPathToExpand: RemId[];

  if (foundRootId) {
    // Reverse the path so it goes from root to destination
    // pathFromDestToRoot is [destination, parent1, parent2, ...]
    // We want [parent2, parent1, destination] (from root candidate's child down to destination)
    pathFromDestToRoot.reverse();

    // The path now is [closest_to_root, ..., destination]
    // We need to expand: rootCandidate -> pathFromDestToRoot[0] -> ... -> destination
    fullPathToExpand = [foundRootId, ...pathFromDestToRoot];
  } else {
    // No root candidate up the real-parent chain. The destination can still be
    // visible in the tree if a portal mirrors it (or one of its ancestors) into
    // a branch, so retry allowing portal hops.
    const portalPath = await findPortalAwarePathToRoot(
      plugin,
      lastDestinationId,
      rootCandidateIds
    );
    if (!portalPath) {
      // console.log('[ParentSelector:TreeHelpers] ERROR: Could not find a root candidate in ancestry chain');
      // console.log('[ParentSelector:TreeHelpers] Path traversed:', pathFromDestToRoot);
      return { tree, foundIndex: -1 };
    }
    fullPathToExpand = portalPath;
  }

  if (PORTAL_PATH_DEBUG) {
    const labels: string[] = [];
    for (const id of fullPathToExpand) {
      const rem = await plugin.rem.findOne(id);
      labels.push(rem ? await safeRemTextToString(plugin, rem.text) : 'unknown');
    }
    console.log(
      `[ParentSelector:TreeHelpers] Path to expand (via ${foundRootId ? 'real parents' : 'portal fallback'}):`,
      labels.join(' › ')
    );
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
      // The path claims this rem is reachable but the tree doesn't list it —
      // i.e. the hop that produced the path disagrees with what the previous
      // step's children actually contain. Silent before; the destination just
      // vanished.
      console.warn(
        '[ParentSelector:TreeHelpers] Path broken — no tree node for',
        nodeIdToExpand,
        `(step ${i} of`,
        fullPathToExpand.length,
        '); expected it among the children of',
        i > 0 ? fullPathToExpand[i - 1] : '(root candidates)'
      );
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

  if (PORTAL_PATH_DEBUG) {
    console.log(
      '[ParentSelector:TreeHelpers] Destination',
      finalIndex >= 0 ? `found at index ${finalIndex}` : 'NOT FOUND',
      `(${flatList.length} rows)`
    );
  }

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

  const traverse = (nodeList: ParentTreeNode[], depth: number, pathPrefix: string) => {
    let list = nodeList;
    if (depth > 0) {
      if (opts.headingsOnly) {
        // Keep headings, plus any non-heading that leads to headings below it
        // (so a plain wrapper rem never makes its headings unreachable).
        // `hasHeadingDescendant === undefined` means "not probed" — keep it,
        // since hiding a branch we haven't inspected could strand content.
        //
        // Portal rows are kept unconditionally: a portal is a deliberate
        // structural link the user placed in this branch, so it carries the
        // same "this is a place to file things" intent a heading does, and it
        // is frequently a plain rem that the filter would otherwise swallow.
        list = list.filter(
          (node) =>
            node.headingLevel != null ||
            node.isPortal ||
            node.hasHeadingDescendant !== false ||
            pinned?.has(node.remId)
        );
      }
      if (opts.headingsFirst) {
        list = sortNodesByHeading(list);
      }
    }

    for (const node of list) {
      // Stamp the node's position in the tree. The same rem can occupy several
      // positions (a root candidate that is also reachable deeper down, or one
      // mirrored in by portals), and expanding one copy hands the very same
      // children array to every copy — so remId/parentId/depth are all
      // identical between them and cannot identify a row. The ancestor path
      // can. Copied rather than mutated, since those shared child objects are
      // reached through more than one path.
      const displayKey = `${pathPrefix}${node.remId}`;
      result.push({ ...node, displayKey });

      if (node.isExpanded && node.children.length > 0) {
        traverse(node.children, depth + 1, `${displayKey}/`);
      }
    }
  };

  traverse(nodes, 0, '');
  return result;
}
