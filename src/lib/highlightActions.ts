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
import { isHtmlSource, getPdfInfoFromHighlight, addPageToHistory, setIncrementalReadingPosition } from './pdfUtils';

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
  highlightWasAlreadyIncremental: boolean,
  highlightPageIndex: number | null
): ExtendedParentSelectorContext => {
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
    highlightPageIndex,
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
  await plugin.storage.setSession('priorityPopupTargetRemId', remId);
  await plugin.widget.openPopup('priority_interval');
};

/**
 * Helper to ensure a standard tag "pdfextract" exists.
 * Returns the PluginRem for the tag.
 */
const ensurePdfExtractTag = async (plugin: ReactRNPlugin): Promise<PluginRem | undefined> => {
  const tagName = 'pdfextract';
  const existingTag = await plugin.rem.findByName([tagName], null);
  if (existingTag) return existingTag;

  const newTag = await plugin.rem.createRem();
  if (newTag) {
    await newTag.setText([tagName]);
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
    // Reload to ensure parent is set in the SDK cache before initIncrementalRem
    // walks ancestors for priority inheritance. Without this, the new rem can
    // appear parentless and inherit the default priority instead.
    const reloadedRem = await plugin.rem.findOne(newRem._id);

    // When the priority popup will follow, skip the cascade — the popup's
    // intervalBatchSave will fire one with the user's actual priority.
    await initIncrementalRem(plugin, reloadedRem || newRem, { skipInitialCascade: showPriorityPopup });

    try {
      const pdfExtractTag = await ensurePdfExtractTag(plugin);
      if (pdfExtractTag) {
        await highlightRem.addTag(pdfExtractTag._id);
      }
    } catch (err) {
      console.error('[ParentSelector:HighlightActions] Error adding pdfextract tag:', err);
    }
  }

  await saveLastSelectedDestination(plugin, pdfRemId, contextRemId, parentId);

  // Save reading position/bookmark for the queue item.
  // pageIndex is null for HTML / PDF Text Reader highlights — we still record
  // the bookmark by highlight rem id so jumps work in those modes too.
  if (makeIncremental) {
    const { pdfRemId: actualPdf, pageIndex } = await getPdfInfoFromHighlight(plugin, highlightRem);
    if (actualPdf) {
        try {
            const queueCtx = await plugin.storage.getSession<any>('pageRangeContext');
            if (queueCtx && queueCtx.pdfRemId === actualPdf && queueCtx.incrementalRemId) {
                await addPageToHistory(plugin, queueCtx.incrementalRemId, actualPdf, pageIndex, undefined, highlightRem._id);
                if (pageIndex !== null) {
                    await setIncrementalReadingPosition(plugin, queueCtx.incrementalRemId, actualPdf, pageIndex);
                }
            }
        } catch(e) {
            console.error('[ParentSelector:HighlightActions] Error creating bookmark:', e);
        }
    }
  }

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
  const { makeIncremental, sourceDocumentId, contextRemId, showPriorityPopupIfNew } = options;
  const normalizedContextRemId = contextRemId ?? null;

  const highlightIsAlreadyIncremental = await highlightRem.hasPowerup(powerupCode);
  const shouldShowPriorityPopup =
    showPriorityPopupIfNew === true &&
    !highlightIsAlreadyIncremental &&
    makeIncremental;

  const sourceDocument = await resolveSourceDocument(plugin, highlightRem, sourceDocumentId);
  if (!sourceDocument) {
    await plugin.app.toast('Could not find the source document for this highlight');
    return;
  }

  const isPdfSource = await sourceDocument.hasPowerup(BuiltInPowerupCodes.UploadedFile);
  const isHtmlSourceDoc = await isHtmlSource(sourceDocument);

  // For non-PDF/HTML sources (YouTube, regular rems, etc.), create directly under source.
  if (!isPdfSource && !isHtmlSourceDoc) {
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

  let rootCandidates: ParentTreeNode[];
  if (isPdfSource) {
    rootCandidates = await findAllRemsForPDFAsTree(plugin, sourceDocument._id);
  } else {
    rootCandidates = await findAllRemsForHTMLAsTree(plugin, sourceDocument._id);
  }

  // If no candidates found, add the source document itself so the user can select
  // it or create a child under it.
  if (rootCandidates.length === 0) {
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

  const lastSelectedDestination = await getLastSelectedDestination(
    plugin,
    sourceDocument._id,
    normalizedContextRemId
  );

  const { pageIndex: highlightPageIndex } = await getPdfInfoFromHighlight(plugin, highlightRem);

  const context = buildContextForSelector(
    sourceDocument._id,
    highlightRem,
    rootCandidates,
    makeIncremental,
    normalizedContextRemId,
    lastSelectedDestination,
    shouldShowPriorityPopup,
    highlightIsAlreadyIncremental,
    highlightPageIndex
  );

  await plugin.storage.setSession('parentSelectorContext', context);
  await plugin.widget.openPopup(parentSelectorWidgetId);
};