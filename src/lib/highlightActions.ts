/**
 * FIXED: highlightActions.ts
 * 
 * This is a patch file showing the fixes for:
 * 1. Priority popup not opening (using await instead of setTimeout)
 * 2. Parent selector should always open when called from Editor (with showPriorityPopupIfNew: true)
 *    even if there are no candidates other than the PDF itself
 * 
 * CHANGES:
 * - Fixed createRemUnderParent to properly await the priority popup
 * - Changed Case A logic: when called from Editor (showPriorityPopupIfNew: true), 
 *   always show the parent selector with the PDF as the only option
 * - The "create directly under PDF without asking" behavior only applies 
 *   when called from the Queue (showPriorityPopupIfNew: false/undefined)
 */

import {
  BuiltInPowerupCodes,
  PluginRem,
  ReactRNPlugin,
  RemId,
  RichTextElementRemInterface,
} from '@remnote/plugin-sdk';
import { parentSelectorWidgetId, powerupCode, allIncrementalRemKey } from './consts';
import { initIncrementalRem } from './incremental_rem';
import { IncrementalRem } from './incremental_rem';
import { removeIncrementalRemCache } from './incremental_rem/cache';
import {
  ParentTreeNode,
  ParentSelectorContext,
} from './hierarchical_parent_selector/types';
import {
  findAllRemsForPDFAsTree,
  getLastSelectedDestination,
  saveLastSelectedDestination,
} from './hierarchical_parent_selector/treeHelpers';
import { safeRemTextToString } from './pdfUtils';

type CreateRemFromHighlightOptions = {
  makeIncremental: boolean;
  sourceDocumentId?: RemId;
  contextRemId?: RemId | null;
  showPriorityPopupIfNew?: boolean;
};

interface ExtendedParentSelectorContext extends ParentSelectorContext {
  showPriorityPopupAfterCreate: boolean;
  highlightWasAlreadyIncremental: boolean;
}

const buildContextForSelector = (
  pdfRemId: RemId,
  extractRem: PluginRem,
  rootCandidates: ParentTreeNode[],
  makeIncremental: boolean,
  contextRemId: RemId | null,
  lastSelectedDestination: RemId | null,
  showPriorityPopupAfterCreate: boolean,
  highlightWasAlreadyIncremental: boolean
): ExtendedParentSelectorContext => {
  console.log('[ParentSelector:HighlightActions] Building context for selector:');
  console.log('[ParentSelector:HighlightActions]   pdfRemId:', pdfRemId);
  console.log('[ParentSelector:HighlightActions]   contextRemId:', contextRemId);
  console.log('[ParentSelector:HighlightActions]   lastSelectedDestination:', lastSelectedDestination);
  console.log('[ParentSelector:HighlightActions]   rootCandidates count:', rootCandidates.length);
  console.log('[ParentSelector:HighlightActions]   showPriorityPopupAfterCreate:', showPriorityPopupAfterCreate);
  console.log('[ParentSelector:HighlightActions]   highlightWasAlreadyIncremental:', highlightWasAlreadyIncremental);
  
  return {
    pdfRemId,
    extractRemId: extractRem._id,
    extractContent: extractRem.text || [],
    rootCandidates,
    makeIncremental,
    contextRemId,
    lastSelectedDestination,
    showPriorityPopupAfterCreate,
    highlightWasAlreadyIncremental,
  };
};

const resolveSourceDocument = async (
  plugin: ReactRNPlugin,
  highlightRem: PluginRem,
  explicitSourceId?: RemId
) => {
  if (explicitSourceId) {
    const explicitSource = await plugin.rem.findOne(explicitSourceId);
    if (explicitSource) return explicitSource;
  }

  if (await highlightRem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) {
    const pdfId = (
      (
        await highlightRem.getPowerupPropertyAsRichText<BuiltInPowerupCodes.PDFHighlight>(
          BuiltInPowerupCodes.PDFHighlight,
          'PdfId'
        )
      )[0] as RichTextElementRemInterface
    )?._id;
    if (pdfId) {
      const pdfRem = await plugin.rem.findOne(pdfId);
      if (pdfRem) return pdfRem;
    }
  }

  if (await highlightRem.hasPowerup(BuiltInPowerupCodes.HTMLHighlight)) {
    const htmlId = (
      (
        await highlightRem.getPowerupPropertyAsRichText<BuiltInPowerupCodes.HTMLHighlight>(
          BuiltInPowerupCodes.HTMLHighlight,
          'HTMLId'
        )
      )[0] as RichTextElementRemInterface
    )?._id;
    if (htmlId) {
      const htmlRem = await plugin.rem.findOne(htmlId);
      if (htmlRem) return htmlRem;
    }
  }

  if (highlightRem.parent) {
    const parentRem = await plugin.rem.findOne(highlightRem.parent);
    if (parentRem) return parentRem;
  }

  return null;
};

/**
 * Shows the priority popup for a rem.
 */
export const showPriorityPopupForRem = async (
  plugin: ReactRNPlugin,
  remId: RemId
): Promise<void> => {
  console.log('[ParentSelector:HighlightActions] Showing priority popup for rem:', remId);
  
  // Store the rem ID for the priority popup to use
  await plugin.storage.setSession('priorityPopupTargetRemId', remId);
  await plugin.widget.openPopup('priority');
};

/**
 * FIXED: Creates a new rem under the specified parent with highlight content.
 * 
 * Changes:
 * - Removed setTimeout and properly await the priority popup
 * - The popup is now shown synchronously after the rem is created
 */
export const createRemUnderParent = async (
  plugin: ReactRNPlugin,
  highlightRem: PluginRem,
  parentId: RemId,
  makeIncremental: boolean,
  pdfRemId: RemId,
  contextRemId: RemId | null,
  parentName?: string,
  showPriorityPopup: boolean = false
): Promise<RemId | null> => {
  console.log('[ParentSelector:HighlightActions] createRemUnderParent called:');
  console.log('[ParentSelector:HighlightActions]   parentId:', parentId);
  console.log('[ParentSelector:HighlightActions]   pdfRemId:', pdfRemId);
  console.log('[ParentSelector:HighlightActions]   contextRemId:', contextRemId);
  console.log('[ParentSelector:HighlightActions]   showPriorityPopup:', showPriorityPopup);
  
  const newRem = await plugin.rem.createRem();
  if (!newRem) {
    await plugin.app.toast('Failed to create rem');
    return null;
  }

  const sourceLink = { i: 'q' as const, _id: highlightRem._id, pin: true };
  const contentWithReference = [...(highlightRem.text || []), ' ', sourceLink];

  await newRem.setText(contentWithReference);
  await newRem.setParent(parentId);

  if (makeIncremental) {
    await initIncrementalRem(plugin, newRem);
  }

  // Save this destination for future use
  console.log('[ParentSelector:HighlightActions] About to save last destination...');
  await saveLastSelectedDestination(plugin, pdfRemId, contextRemId, parentId);

  // Clean up the original highlight
  await removeIncrementalRemCache(plugin, highlightRem._id);
  await highlightRem.removePowerup(powerupCode);
  await highlightRem.setHighlightColor('Yellow');

  const actionText = makeIncremental ? 'incremental rem' : 'rem';
  const parentSuffix = parentName ? ` under "${parentName.slice(0, 30)}..."` : ' under source';
  await plugin.app.toast(`Created ${actionText}${parentSuffix}`);

  // FIXED: Show priority popup if requested (for new incremental rems)
  // Use direct await instead of setTimeout which can fail in plugin context
  if (showPriorityPopup && makeIncremental) {
    console.log('[ParentSelector:HighlightActions] Opening priority popup for new rem:', newRem._id);
    // Small delay to let toast appear, but use proper async/await
    await new Promise(resolve => setTimeout(resolve, 100));
    await showPriorityPopupForRem(plugin, newRem._id);
  }

  return newRem._id;
};

/**
 * Checks if any candidate in the tree has children.
 */
const anyNodeHasChildren = (nodes: ParentTreeNode[]): boolean => {
  return nodes.some(node => node.hasChildren);
};

/**
 * Helper to create a tree node for the PDF itself
 */
const createPdfTreeNode = async (
  plugin: ReactRNPlugin,
  pdfRem: PluginRem
): Promise<ParentTreeNode> => {
  const pdfName = await safeRemTextToString(plugin, pdfRem.text);
  const children = await pdfRem.getChildrenRem();
  
  return {
    remId: pdfRem._id,
    name: pdfName || 'PDF Document',
    priority: null,
    percentile: null,
    isIncremental: false,
    hasChildren: children.length > 0,
    isExpanded: false,
    children: [],
    childrenLoaded: false,
    depth: 0,
    parentId: null,
  };
};

/**
 * FIXED: Main function to create a rem from a PDF highlight.
 * 
 * Changes:
 * - Case A (no candidates): When called from Editor (showPriorityPopupIfNew: true),
 *   always show the parent selector with the PDF itself as an option.
 *   This gives the user a chance to choose where to place the IncRem and set priority.
 * - Only auto-create under PDF when called from Queue (showPriorityPopupIfNew: false/undefined)
 */
export const createRemFromHighlight = async (
  plugin: ReactRNPlugin,
  highlightRem: PluginRem,
  options: CreateRemFromHighlightOptions
) => {
  console.log('[ParentSelector:HighlightActions] ============================================');
  console.log('[ParentSelector:HighlightActions] createRemFromHighlight CALLED');
  console.log('[ParentSelector:HighlightActions] options:', JSON.stringify(options, null, 2));
  console.log('[ParentSelector:HighlightActions] ============================================');
  
  const { makeIncremental, sourceDocumentId, contextRemId, showPriorityPopupIfNew } = options;
  
  // Normalize contextRemId: undefined becomes null
  const normalizedContextRemId = contextRemId ?? null;
  
  console.log('[ParentSelector:HighlightActions] Normalized contextRemId:', normalizedContextRemId);

  // Check if the highlight is already an incremental rem
  const highlightIsAlreadyIncremental = await highlightRem.hasPowerup(powerupCode);
  console.log('[ParentSelector:HighlightActions] Highlight is already incremental:', highlightIsAlreadyIncremental);

  // Determine if we should show priority popup after creating the rem
  const shouldShowPriorityPopup = 
    showPriorityPopupIfNew === true && 
    !highlightIsAlreadyIncremental && 
    makeIncremental;
  
  console.log('[ParentSelector:HighlightActions] Should show priority popup:', shouldShowPriorityPopup);

  // Determine if this is being called from the Editor (vs Queue)
  // When called from Editor, we want to always show the parent selector
  const calledFromEditor = showPriorityPopupIfNew === true;
  console.log('[ParentSelector:HighlightActions] Called from Editor:', calledFromEditor);

  // Step 1: Resolve the source document (PDF)
  const sourceDocument = await resolveSourceDocument(plugin, highlightRem, sourceDocumentId);
  if (!sourceDocument) {
    console.log('[ParentSelector:HighlightActions] ERROR: Could not find source document');
    await plugin.app.toast('Could not find the source document for this highlight');
    return;
  }
  
  console.log('[ParentSelector:HighlightActions] Source document resolved:', sourceDocument._id);

  const isPdfSource = await sourceDocument.hasPowerup(BuiltInPowerupCodes.UploadedFile);
  console.log('[ParentSelector:HighlightActions] Is PDF source:', isPdfSource);
  
  // Step 2: If not a PDF, create directly under source
  if (!isPdfSource) {
    console.log('[ParentSelector:HighlightActions] Not a PDF, creating directly under source');
    await createRemUnderParent(
      plugin,
      highlightRem,
      sourceDocument._id,
      makeIncremental,
      sourceDocument._id,
      normalizedContextRemId,
      undefined,
      shouldShowPriorityPopup
    );
    return;
  }

  // Step 3: Find all rems for this PDF as a tree structure
  console.log('[ParentSelector:HighlightActions] Finding all rems for PDF as tree...');
  const rootCandidates = await findAllRemsForPDFAsTree(plugin, sourceDocument._id);
  console.log('[ParentSelector:HighlightActions] Root candidates found:', rootCandidates.length);

  // Step 4: Get last selected destination for this context
  console.log('[ParentSelector:HighlightActions] Getting last selected destination...');
  const lastSelectedDestination = await getLastSelectedDestination(
    plugin,
    sourceDocument._id,
    normalizedContextRemId
  );
  console.log('[ParentSelector:HighlightActions] Last selected destination:', lastSelectedDestination);

  // Step 5: Decision logic
  
  // FIXED Case A: No candidates found
  if (rootCandidates.length === 0) {
    console.log('[ParentSelector:HighlightActions] DECISION: No candidates found');
    
    // FIXED: When called from Editor, always show the parent selector
    // with the PDF itself as an option, so user can see the priority popup
    if (calledFromEditor) {
      console.log('[ParentSelector:HighlightActions] Called from Editor - showing parent selector with PDF as option');
      
      // Create a node for the PDF itself
      const pdfNode = await createPdfTreeNode(plugin, sourceDocument);
      const rootCandidatesWithPdf = [pdfNode];
      
      const context = buildContextForSelector(
        sourceDocument._id,
        highlightRem,
        rootCandidatesWithPdf,
        makeIncremental,
        normalizedContextRemId,
        lastSelectedDestination,
        shouldShowPriorityPopup,
        highlightIsAlreadyIncremental
      );
      
      console.log('[ParentSelector:HighlightActions] Storing context in session...');
      await plugin.storage.setSession('parentSelectorContext', context);
      
      console.log('[ParentSelector:HighlightActions] Opening parent selector popup...');
      await plugin.widget.openPopup(parentSelectorWidgetId);
      return;
    }
    
    // When called from Queue (not Editor), create directly under PDF
    console.log('[ParentSelector:HighlightActions] Called from Queue - creating directly under PDF');
    await createRemUnderParent(
      plugin,
      highlightRem,
      sourceDocument._id,
      makeIncremental,
      sourceDocument._id,
      normalizedContextRemId,
      undefined,
      shouldShowPriorityPopup
    );
    return;
  }

  // Case B: Single candidate WITHOUT children AND no saved destination AND NOT from Editor
  // When called from Editor, always show the selector so user can set priority
  if (
    rootCandidates.length === 1 &&
    !rootCandidates[0].hasChildren &&
    !lastSelectedDestination &&
    !calledFromEditor
  ) {
    console.log('[ParentSelector:HighlightActions] DECISION: Single candidate without children (Queue mode), using directly');
    const [parent] = rootCandidates;
    await createRemUnderParent(
      plugin,
      highlightRem,
      parent.remId,
      makeIncremental,
      sourceDocument._id,
      normalizedContextRemId,
      parent.name,
      shouldShowPriorityPopup
    );
    return;
  }

  // Case C: Show popup (multiple candidates, has children, saved destination, or called from Editor)
  console.log('[ParentSelector:HighlightActions] DECISION: Showing hierarchical popup');
  
  // ENHANCEMENT: Add the PDF itself as an option if it's not already in the list
  const pdfInCandidates = rootCandidates.some(c => c.remId === sourceDocument._id);
  let finalCandidates = rootCandidates;
  
  if (!pdfInCandidates) {
    const pdfNode = await createPdfTreeNode(plugin, sourceDocument);
    // Add PDF at the end as it's usually not the preferred destination
    finalCandidates = [...rootCandidates, pdfNode];
    console.log('[ParentSelector:HighlightActions] Added PDF itself to candidates');
  }
  
  const context = buildContextForSelector(
    sourceDocument._id,
    highlightRem,
    finalCandidates,
    makeIncremental,
    normalizedContextRemId,
    lastSelectedDestination,
    shouldShowPriorityPopup,
    highlightIsAlreadyIncremental
  );
  
  console.log('[ParentSelector:HighlightActions] Storing context in session...');
  await plugin.storage.setSession('parentSelectorContext', context);
  
  // Verify context was stored
  const storedContext = await plugin.storage.getSession<ExtendedParentSelectorContext>('parentSelectorContext');
  console.log('[ParentSelector:HighlightActions] Verified stored context:');
  console.log('[ParentSelector:HighlightActions]   contextRemId:', storedContext?.contextRemId);
  console.log('[ParentSelector:HighlightActions]   lastSelectedDestination:', storedContext?.lastSelectedDestination);
  console.log('[ParentSelector:HighlightActions]   showPriorityPopupAfterCreate:', storedContext?.showPriorityPopupAfterCreate);
  
  console.log('[ParentSelector:HighlightActions] Opening popup...');
  await plugin.widget.openPopup(parentSelectorWidgetId);
};
