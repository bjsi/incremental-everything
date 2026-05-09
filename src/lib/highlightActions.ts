import {
  BuiltInPowerupCodes,
  PluginRem,
  ReactRNPlugin,
  RemId,
  RichTextElementRemInterface,
  RichTextInterface,
  RichTextElementInterface,
} from '@remnote/plugin-sdk';
import { parentSelectorWidgetId, powerupCode, allIncrementalRemKey } from './consts';
import { initIncrementalRem } from './incremental_rem';
import { IncrementalRem } from './incremental_rem';
import { removeIncrementalRemCache } from './incremental_rem/cache';

/**
 * Sanitize a RichTextInterface array so that every element conforms strictly to
 * the shapes accepted by `rem.setText()`.
 *
 * When reading `highlightRem.text` from a PDF highlight that contains images,
 * the internal representation may carry extra/internal properties that RemNote's
 * cross-sandbox `setText` validator rejects with "Invalid input". This function
 * strips each element down to only the keys defined in the plugin SDK types.
 */
const sanitizeRichTextForSetText = (richText: RichTextInterface): RichTextInterface => {
  return richText.map((element): RichTextElementInterface => {
    // Plain strings pass through as-is
    if (typeof element === 'string') return element;

    const el = element as any;
    switch (el.i) {
      case 'm': {
        // RichTextElementTextInterface
        const clean: any = { i: 'm', text: el.text ?? '' };
        // Copy known optional formatting properties (only if present)
        const textKeys = [
          'workInProgressTag', 'workInProgressRem', 'workInProgressPortal',
          'block', 'title',
          // RICH_TEXT_FORMATTING enum values (string keys)
          'cloze', 'u', 'b', 'l', 'code', 'rc', 'hc',
          'h', 'tc', 'dl', 'cl', 'q', 'il',
        ];
        for (const k of textKeys) {
          if (k in el) clean[k] = el[k];
        }
        return clean;
      }

      case 'q': {
        // RichTextElementRemInterface
        const clean: any = { i: 'q', _id: el._id };
        if (el.aliasId !== undefined) clean.aliasId = el.aliasId;
        if (el.pin !== undefined) clean.pin = el.pin;
        if (el.content !== undefined) clean.content = el.content;
        if (el.textOfDeletedRem !== undefined) {
          clean.textOfDeletedRem = sanitizeRichTextForSetText(el.textOfDeletedRem);
        }
        if ('cloze' in el) clean.cloze = el.cloze;
        return clean;
      }

      case 'i': {
        // RichTextImageInterface — this is the key culprit for PDF highlights with images
        const clean: any = { i: 'i', url: el.url };
        // Copy simple optional keys (skip 'percent' — handled separately below)
        const imageKeys = [
          'blocks', 'clozeOrder',
          'loading', 'title', 'transparent', 'imgId',
          'practiceInOrder', 'openOcclusionPopup',
        ];
        for (const k of imageKeys) {
          if (k in el) clean[k] = el[k];
        }
        // width/height: round to integers to avoid potential validator issues with floats
        if (el.width !== undefined) clean.width = Math.round(el.width);
        if (el.height !== undefined) clean.height = Math.round(el.height);
        // percent: SDK only allows 5 | 25 | 50 | 100. The PDF engine sometimes stores
        // the highlight's area percentage (e.g. 68.08…) which the validator rejects.
        const VALID_PERCENTS = new Set([5, 25, 50, 100]);
        if (el.percent !== undefined && VALID_PERCENTS.has(el.percent)) {
          clean.percent = el.percent;
        }
        if (el.label !== undefined) clean.label = sanitizeRichTextForSetText(el.label);
        if (el.frontLabel !== undefined) clean.frontLabel = sanitizeRichTextForSetText(el.frontLabel);
        return clean;
      }

      case 'a': {
        // RichTextAudioInterface
        const clean: any = { i: 'a', url: el.url };
        if (el.onlyAudio !== undefined) clean.onlyAudio = el.onlyAudio;
        if (el.width !== undefined) clean.width = el.width;
        if (el.height !== undefined) clean.height = el.height;
        if (el.percent !== undefined) clean.percent = el.percent;
        return clean;
      }

      case 'p': {
        // RichTextPluginInterface
        const clean: any = { i: 'p', url: el.url };
        if (el.pluginName !== undefined) clean.pluginName = el.pluginName;
        return clean;
      }

      default:
        // For any other element types (latex 'x', card delimiter 's', annotations, etc.)
        // pass through as-is — they rarely appear in PDF highlights.
        return el;
    }
  });
};
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
  const sanitizedHighlightText = sanitizeRichTextForSetText(highlightRem.text || []);
  const contentWithReference = [...sanitizedHighlightText, ' ', sourceLink];

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