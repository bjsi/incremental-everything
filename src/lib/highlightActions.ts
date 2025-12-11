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

type CreateRemFromHighlightOptions = {
  makeIncremental: boolean;
  sourceDocumentId?: RemId;
  contextRemId?: RemId | null; // The IncRem being reviewed (e.g., "Chapter 1"), null/undefined if PDF itself
  /**
   * If true, check if the highlight is already incremental.
   * - If already incremental: skip priority popup (user already set priority via Toggle Incremental)
   * - If not incremental: show priority popup after creating the rem
   * 
   * This is used when calling from the PDF highlight menu's "Create Incremental Rem" button.
   * When called from the queue (where highlight is already incremental), this can be false or
   * we can detect it automatically.
   */
  showPriorityPopupIfNew?: boolean;
};

// Extended context that includes info about showing priority popup
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
 * This should be called after creating a new incremental rem when the user
 * uses "Create Incremental Rem" directly (not via Toggle Incremental first).
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
 * Creates a new rem under the specified parent with highlight content.
 * 
 * @returns The created rem's ID, or null if creation failed
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

  // Show priority popup if requested (for new incremental rems)
  if (showPriorityPopup && makeIncremental) {
    // Small delay to let the toast show first
    setTimeout(async () => {
      await showPriorityPopupForRem(plugin, newRem._id);
    }, 300);
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
 * Main function to create a rem from a PDF highlight.
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
  // Only show if:
  // 1. showPriorityPopupIfNew is true (caller wants this behavior)
  // 2. The highlight is NOT already incremental (if it was, user already set priority)
  // 3. We're making it incremental
  const shouldShowPriorityPopup = 
    showPriorityPopupIfNew === true && 
    !highlightIsAlreadyIncremental && 
    makeIncremental;
  
  console.log('[ParentSelector:HighlightActions] Should show priority popup:', shouldShowPriorityPopup);

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
  
  // Case A: No candidates found
  if (rootCandidates.length === 0) {
    console.log('[ParentSelector:HighlightActions] DECISION: No candidates, creating under PDF');
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

  // Case B: Single candidate WITHOUT children AND no saved destination
  if (
    rootCandidates.length === 1 &&
    !rootCandidates[0].hasChildren &&
    !lastSelectedDestination
  ) {
    console.log('[ParentSelector:HighlightActions] DECISION: Single candidate without children, using directly');
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

  // Case C: Show popup
  console.log('[ParentSelector:HighlightActions] DECISION: Showing hierarchical popup');
  
  const context = buildContextForSelector(
    sourceDocument._id,
    highlightRem,
    rootCandidates,
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