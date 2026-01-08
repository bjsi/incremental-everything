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
  findAllRemsForHTMLAsTree,
  getLastSelectedDestination,
  saveLastSelectedDestination,
} from './hierarchical_parent_selector/treeHelpers';
import { isHtmlSource } from './pdfUtils';

type CreateRemFromHighlightOptions = {
  makeIncremental: boolean;
  sourceDocumentId?: RemId;
  contextRemId?: RemId | null; // The IncRem being reviewed (e.g., "Chapter 1"), null/undefined if PDF itself
  /**
   * If true, check if the highlight is already incremental.
   * - If already incremental: skip priority popup (user already set priority via Toggle Incremental)
   * - If not incremental: show priority popup after creating the rem
   * * This is used when calling from the PDF highlight menu's "Create Incremental Rem" button.
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
 * Helper to ensure a standard tag "pdfextract" exists.
 * Returns the PluginRem for the tag.
 */
const ensurePdfExtractTag = async (plugin: ReactRNPlugin): Promise<PluginRem | undefined> => {
  const tagName = 'pdfextract';
  console.log(`[ParentSelector:HighlightActions] ensurePdfExtractTag: Searching for "${tagName}"...`);
  // Attempt to find existing tag by name
  const existingTag = await plugin.rem.findByName([tagName], null);
  if (existingTag) {
    console.log('[ParentSelector:HighlightActions] ensurePdfExtractTag: Found existing tag:', existingTag._id);
    return existingTag;
  }
  // Create if missing
  console.log('[ParentSelector:HighlightActions] ensurePdfExtractTag: Creating new tag...');
  const newTag = await plugin.rem.createRem();
  if (newTag) {
    await newTag.setText([tagName]);
    console.log('[ParentSelector:HighlightActions] ensurePdfExtractTag: Created new tag:', newTag._id);
    // Optional: could set it as a stub or move it to a system folder, 
    // but just creating it is sufficient for tagging.
  } else {
    console.error('[ParentSelector:HighlightActions] ensurePdfExtractTag: Failed to create new tag');
  }
  return newTag;
};

/**
 * Creates a new rem under the specified parent with highlight content.
 * * @returns The created rem's ID, or null if creation failed
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
    // DEBUG: Check parentage for priority inheritance
    console.log('[ParentSelector:HighlightActions] Initializing Incremental Rem...');
    console.log('[ParentSelector:HighlightActions] newRem.parent (local):', newRem.parent);

    // Attempt to reload rem to ensure parent is strict?
    // This is a suspicion for why priority inheritance might fail (defaulting to 25 if parent is unknown)
    const reloadedRem = await plugin.rem.findOne(newRem._id);
    console.log('[ParentSelector:HighlightActions] reloadedRem.parent:', reloadedRem?.parent);

    // Pass the reloaded rem if available, otherwise original
    await initIncrementalRem(plugin, reloadedRem || newRem);

    // NEW: Tag the highlight as "pdfextract"
    // This allows CSS to target [data-rem-tags~="pdfextract"]
    console.log('[ParentSelector:HighlightActions] Attempting to tag highlight with "pdfextract"...');
    try {
      const pdfExtractTag = await ensurePdfExtractTag(plugin);
      if (pdfExtractTag) {
        console.log('[ParentSelector:HighlightActions] Found/Created tag rem:', pdfExtractTag._id);
        await highlightRem.addTag(pdfExtractTag._id);
        console.log('[ParentSelector:HighlightActions] Successfully added tag to highlight');
      } else {
        console.log('[ParentSelector:HighlightActions] Failed to ensure pdfextract tag exists');
      }
    } catch (err) {
      console.error('[ParentSelector:HighlightActions] Error adding pdfextract tag:', err);
    }
  }

  // Save this destination for future use
  console.log('[ParentSelector:HighlightActions] About to save last destination...');
  await saveLastSelectedDestination(plugin, pdfRemId, contextRemId, parentId);

  // Clean up the original highlight
  await removeIncrementalRemCache(plugin, highlightRem._id);
  // Remove "Incremental" powerup from the highlight
  await highlightRem.removePowerup(powerupCode);
  // Removed setHighlightColor('Yellow') -> CSS now handles styling via "pdfextract" tag

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
 * Main function to create a rem from a PDF or HTML highlight.
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

  // Step 1: Resolve the source document (PDF or HTML)
  const sourceDocument = await resolveSourceDocument(plugin, highlightRem, sourceDocumentId);
  if (!sourceDocument) {
    console.log('[ParentSelector:HighlightActions] ERROR: Could not find source document');
    await plugin.app.toast('Could not find the source document for this highlight');
    return;
  }

  console.log('[ParentSelector:HighlightActions] Source document resolved:', sourceDocument._id);

  // Check source type: PDF or HTML
  const isPdfSource = await sourceDocument.hasPowerup(BuiltInPowerupCodes.UploadedFile);
  const isHtmlSourceDoc = await isHtmlSource(sourceDocument);

  console.log('[ParentSelector:HighlightActions] Is PDF source:', isPdfSource);
  console.log('[ParentSelector:HighlightActions] Is HTML source:', isHtmlSourceDoc);

  // Step 2: If not a PDF or HTML, create directly under source
  // This handles YouTube videos, regular rems, etc.
  if (!isPdfSource && !isHtmlSourceDoc) {
    console.log('[ParentSelector:HighlightActions] Not a PDF or HTML, creating directly under source');
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

  // Step 3: Find all rems for this source as a tree structure
  // Use appropriate function based on source type
  let rootCandidates: ParentTreeNode[];

  if (isPdfSource) {
    console.log('[ParentSelector:HighlightActions] Finding all rems for PDF as tree...');
    rootCandidates = await findAllRemsForPDFAsTree(plugin, sourceDocument._id);
  } else {
    console.log('[ParentSelector:HighlightActions] Finding all rems for HTML as tree...');
    rootCandidates = await findAllRemsForHTMLAsTree(plugin, sourceDocument._id);
  }

  // FIX: If no candidates found, add the source document itself as the root
  // so the user can select it or create a child under it
  if (rootCandidates.length === 0) {
    console.log('[ParentSelector:HighlightActions] No candidates found, adding source document as root candidate');
    const sourceText = await plugin.richText.toString(sourceDocument.text || []) || (isPdfSource ? 'PDF Document' : 'HTML Document');
    rootCandidates.push({
      remId: sourceDocument._id,
      name: sourceText,
      priority: null,
      percentile: null,
      isIncremental: false,
      hasChildren: false,
      isExpanded: true,
      children: [],
      childrenLoaded: true,
      depth: 0,
      parentId: null
    });
  }

  console.log('[ParentSelector:HighlightActions] Root candidates found (or added):', rootCandidates.length);

  // Step 4: Get last selected destination for this context
  console.log('[ParentSelector:HighlightActions] Getting last selected destination...');
  const lastSelectedDestination = await getLastSelectedDestination(
    plugin,
    sourceDocument._id,
    normalizedContextRemId
  );
  console.log('[ParentSelector:HighlightActions] Last selected destination:', lastSelectedDestination);

  // Step 5: Decision logic - Always show popup for PDF and HTML sources
  // This allows users to choose where to place the new rem

  console.log('[ParentSelector:HighlightActions] DECISION: Showing hierarchical popup');

  const context = buildContextForSelector(
    sourceDocument._id,  // This is used as "pdfRemId" but works for HTML too
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