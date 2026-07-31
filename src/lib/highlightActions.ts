import {
  BuiltInPowerupCodes,
  PluginRem,
  ReactRNPlugin,
  RemId,
  RICH_TEXT_FORMATTING,
  RichTextElementRemInterface,
  RichTextInterface,
} from '@remnote/plugin-sdk';
import { sanitizeRichTextForSetText } from './richTextSanitize';
import { syncPriorityBand } from './priority_bands';
import {
  parentSelectorWidgetId,
  powerupCode,
  incrementalQueueActiveKey,
  currentIncRemKey,
  pendingIncRemCreateTailKey,
} from './consts';
import { initIncrementalRem, getIncrementalRemFromRem } from './incremental_rem';
import { IncrementalRem } from './incremental_rem';
import { removeIncrementalRemCache, updateIncrementalRemCache } from './incremental_rem/cache';

import {
  ParentTreeNode,
  ParentSelectorContext,
} from './hierarchical_parent_selector/types';
import { resolveRemTextSegments } from './richTextRemRefs';
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
  /**
   * True when the highlight being extracted is itself the item currently under
   * review (e.g. the queue's current IncR, or the isolated card viewer). In that
   * case there is no meaningful review parent, and the per-PDF "last destination"
   * would just pin a stale global suggestion regardless of the current page — so
   * we skip it and let page-range matching drive the suggestion instead.
   *
   * This must NOT be inferred from `contextRemId === null`: that is also true when
   * the user simply triggers a highlight in the editor outside any review session,
   * where we DO want to restore the last parent chosen for this PDF.
   */
  highlightIsActiveReviewItem?: boolean;
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

  // When a priority popup will follow a new IncRem, defer everything the popup
  // doesn't need (cache update, tag, last-destination memory, bookmark, highlight
  // cleanup) to the tracker in the persistent index widget. That work costs ~3s of
  // serial SDK writes here and must survive this popup's teardown when the priority
  // popup opens — both solved by handing it to tracker.ts (which also wraps it in the
  // plugin_operation_active / incRemBatchActive suppression flags).
  const deferTail = showPriorityPopup && makeIncremental;

  if (makeIncremental) {
    // Reload to ensure parent is set in the SDK cache before initIncrementalRem
    // walks ancestors for priority inheritance. Without this, the new rem can
    // appear parentless and inherit the default priority instead.
    const reloadedRem = await plugin.rem.findOne(newRem._id);

    // When the priority popup will follow, skip the cascade — the popup's
    // intervalBatchSave will fire one with the user's actual priority. When deferring,
    // also skip the ~750ms cache write — the deferred tail re-adds it in the tracker.
    await initIncrementalRem(plugin, reloadedRem || newRem, {
      skipInitialCascade: showPriorityPopup,
      deferCacheUpdate: deferTail,
    });

    if (deferTail) {
      // Hand the tail to the tracker and open the popup immediately.
      const tailJob = {
        newRemId: newRem._id,
        highlightRemId: highlightRem._id,
        parentId,
        pdfRemId,
        contextRemId,
        parentName: parentName ?? null,
      };
      await plugin.storage.setSession(pendingIncRemCreateTailKey, tailJob);
      await showPriorityPopupForRem(plugin, newRem._id);
      return newRem._id;
    }

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

  // Save reading position/bookmark for the active IncRem context.
  // pageIndex is null for HTML / PDF Text Reader highlights — we still record
  // the bookmark by highlight rem id so jumps work in those modes too.
  //
  // Prefer the explicit contextRemId (resolved by the caller from queue OR editor
  // review timer). Fall back to pageRangeContext for legacy callers that don't pass it.
  if (makeIncremental) {
    const { pdfRemId: actualPdf, pageIndex } = await getPdfInfoFromHighlight(plugin, highlightRem);
    if (actualPdf) {
        try {
            let bookmarkRemId: RemId | null = null;
            if (contextRemId) {
              bookmarkRemId = contextRemId;
            } else {
              const queueCtx = await plugin.storage.getSession<any>('pageRangeContext');
              if (queueCtx && queueCtx.pdfRemId === actualPdf && queueCtx.incrementalRemId) {
                bookmarkRemId = queueCtx.incrementalRemId;
              }
            }
            if (bookmarkRemId) {
                await addPageToHistory(plugin, bookmarkRemId, actualPdf, pageIndex, undefined, highlightRem._id);
                if (pageIndex !== null) {
                    await setIncrementalReadingPosition(plugin, bookmarkRemId, actualPdf, pageIndex);
                }
            }
        } catch(e) {
            console.error('[ParentSelector:HighlightActions] Error creating bookmark:', e);
        }
    }
  }

  // Clean up the original highlight
  await removeIncrementalRemCache(plugin, highlightRem._id);

  // If the highlight is the current queue item, removing its powerup will tear
  // down the queue widget before its own tracker can react. Fire the queue
  // advance simultaneously so the IPC reaches RemNote before the widget sandbox
  // is destroyed (same pattern as the Dismiss button in answer_buttons.tsx).
  const isQueueActive = await plugin.storage.getSession<boolean>(incrementalQueueActiveKey);
  const currentQueueRemId = isQueueActive
    ? await plugin.storage.getSession<string>(currentIncRemKey)
    : undefined;
  const highlightIsCurrentQueueItem =
    !!isQueueActive && currentQueueRemId === highlightRem._id;

  if (highlightIsCurrentQueueItem) {
    await Promise.allSettled([
      highlightRem.removePowerup(powerupCode),
      plugin.queue.removeCurrentCardFromQueue(true),
    ]);
  } else {
    await highlightRem.removePowerup(powerupCode);
  }
  // Removed setHighlightColor('Yellow') -> CSS now handles styling via "pdfextract" tag

  const actionText = makeIncremental ? 'incremental rem' : 'rem';
  const parentSuffix = parentName ? ` under "${parentName.slice(0, 30)}..."` : ' under source';
  await plugin.app.toast(`Created ${actionText}${parentSuffix}`);

  // Non-deferred path: this is only reached when NOT (showPriorityPopup &&
  // makeIncremental), so no priority popup is opened here.
  return newRem._id;
};

/**
 * Payload for the deferred "create IncRem" tail (see pendingIncRemCreateTailKey).
 */
export interface IncRemCreateTailJob {
  newRemId: RemId;
  highlightRemId: RemId;
  parentId: RemId;
  pdfRemId: RemId;
  contextRemId: RemId | null;
  parentName: string | null;
}

/**
 * Runs the deferred tail of a Create-IncRem: the work the priority popup doesn't
 * need. Called by tracker.ts in the persistent index widget (NOT from the popup),
 * where it survives popup teardown and is wrapped in the plugin_operation_active /
 * incRemBatchActive suppression flags by the caller. Each step is independently
 * guarded so one failure doesn't abort the rest.
 */
export const runIncRemCreateTail = async (
  plugin: ReactRNPlugin,
  job: IncRemCreateTailJob
): Promise<void> => {
  const { newRemId, highlightRemId, parentId, pdfRemId, contextRemId, parentName } = job;

  // 1. Re-add the new IncRem to the in-session cache (initIncrementalRem skipped this
  //    on the deferred path). Reads the rem's current priority — if the user has since
  //    saved the popup, intervalBatchSave will have patched it and re-updated the cache;
  //    either ordering converges to the correct value.
  try {
    const newRem = await plugin.rem.findOne(newRemId);
    if (newRem) {
      const incRem = await getIncrementalRemFromRem(plugin, newRem);
      if (incRem) await updateIncrementalRemCache(plugin, incRem);
    }
  } catch (e) {
    console.error('[IncRemTail] cache update failed:', e);
  }

  const highlightRem = await plugin.rem.findOne(highlightRemId);
  if (!highlightRem) return;

  // 2. Tag the original highlight as a pdfextract (drives CSS styling).
  try {
    const pdfExtractTag = await ensurePdfExtractTag(plugin);
    if (pdfExtractTag) await highlightRem.addTag(pdfExtractTag._id);
  } catch (err) {
    console.error('[IncRemTail] pdfextract tag failed:', err);
  }

  // 2b. Mirror the extract's priority band onto that same highlight, so the
  // Highlights side panel badges it and its PDF marker takes the band colour.
  // syncPriorityBand normally propagates this when the priority is written, but
  // the priority popup can be answered before this tail runs — in which case the
  // highlight was not yet reachable as a reference target. Reconciling here is a
  // no-op when the band already matches.
  try {
    const newRemForBand = await plugin.rem.findOne(newRemId);
    if (newRemForBand) await syncPriorityBand(plugin, newRemForBand);
  } catch (err) {
    console.error('[IncRemTail] priority band sync failed:', err);
  }

  // 3. Remember this parent as the last destination for this PDF/context.
  try {
    await saveLastSelectedDestination(plugin, pdfRemId, contextRemId, parentId);
  } catch (e) {
    console.error('[IncRemTail] saveLastSelectedDestination failed:', e);
  }

  // 4. Reading-position bookmark for the active IncRem context.
  try {
    const { pdfRemId: actualPdf, pageIndex } = await getPdfInfoFromHighlight(plugin, highlightRem);
    if (actualPdf) {
      let bookmarkRemId: RemId | null = null;
      if (contextRemId) {
        bookmarkRemId = contextRemId;
      } else {
        const queueCtx = await plugin.storage.getSession<any>('pageRangeContext');
        if (queueCtx && queueCtx.pdfRemId === actualPdf && queueCtx.incrementalRemId) {
          bookmarkRemId = queueCtx.incrementalRemId;
        }
      }
      if (bookmarkRemId) {
        await addPageToHistory(plugin, bookmarkRemId, actualPdf, pageIndex, undefined, highlightRem._id);
        if (pageIndex !== null) {
          await setIncrementalReadingPosition(plugin, bookmarkRemId, actualPdf, pageIndex);
        }
      }
    }
  } catch (e) {
    console.error('[IncRemTail] bookmark failed:', e);
  }

  // 5. Highlight cleanup: evict from IncRem cache + remove the powerup. If the
  //    highlight was the current queue item, advance the queue too — safe here because
  //    the tracker's index widget is never torn down (unlike the popup that queued us).
  try {
    await removeIncrementalRemCache(plugin, highlightRem._id);
    const isQueueActive = await plugin.storage.getSession<boolean>(incrementalQueueActiveKey);
    const currentQueueRemId = isQueueActive
      ? await plugin.storage.getSession<string>(currentIncRemKey)
      : undefined;
    const highlightIsCurrentQueueItem = !!isQueueActive && currentQueueRemId === highlightRem._id;
    if (highlightIsCurrentQueueItem) {
      await Promise.allSettled([
        highlightRem.removePowerup(powerupCode),
        plugin.queue.removeCurrentCardFromQueue(true),
      ]);
    } else {
      await highlightRem.removePowerup(powerupCode);
    }
  } catch (e) {
    console.error('[IncRemTail] highlight cleanup failed:', e);
  }

  // 6. Confirmation toast (deferred so it doesn't block the popup).
  const parentSuffix = parentName ? ` under "${parentName.slice(0, 30)}..."` : ' under source';
  await plugin.app.toast(`Created incremental rem${parentSuffix}`);
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
  const { makeIncremental, sourceDocumentId, contextRemId, showPriorityPopupIfNew, highlightIsActiveReviewItem } = options;
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
      nameSegments: await resolveRemTextSegments(plugin, sourceDocument.text || []),
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

  const { pageIndex: highlightPageIndex } = await getPdfInfoFromHighlight(plugin, highlightRem);

  // When the highlight itself is the rem under review, the lastSelectedDestination
  // key collapses to a global "last parent used for any PDF-highlight extraction
  // from this PDF". That stale value would pin the suggestion regardless of the
  // current page, so skip it and let the parent selector fall through to page-range
  // matching.
  //
  // This must be keyed off the explicit `highlightIsActiveReviewItem` flag, NOT
  // `normalizedContextRemId === null`. The latter is also true when the user
  // triggers a highlight in the editor outside any review session, where we DO
  // want to restore the last parent remembered for this PDF (saved under the
  // per-PDF key in createRemUnderParent).
  const skipLastDestination = highlightIsActiveReviewItem === true && highlightPageIndex !== null;
  const lastSelectedDestination = skipLastDestination
    ? null
    : await getLastSelectedDestination(
        plugin,
        sourceDocument._id,
        normalizedContextRemId
      );

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