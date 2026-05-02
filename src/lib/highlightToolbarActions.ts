import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { createRemFromHighlight } from './highlightActions';
import {
  powerupCode,
  incrementalQueueActiveKey,
  currentIncRemKey,
  editorReviewTimerRemIdKey,
} from './consts';
import {
  getPdfInfoFromHighlight,
  findPDFinRem,
  addPageToHistory,
  setIncrementalReadingPosition,
} from './pdfUtils';
import { initIncrementalRem } from '../register/powerups';

async function resolveContextRemId(
  plugin: ReactRNPlugin,
  docId: string | null,
  opts: { checkEditorTimer: boolean }
): Promise<string | null> {
  let contextRemId: string | null = null;

  const isQueueActive = await plugin.storage.getSession<boolean>(incrementalQueueActiveKey);
  if (isQueueActive && docId) {
    const currentQueueRemId = await plugin.storage.getSession<string>(currentIncRemKey);
    if (currentQueueRemId) {
      const currentQueueRem = await plugin.rem.findOne(currentQueueRemId);
      const foundPdf = currentQueueRem
        ? await findPDFinRem(plugin as any, currentQueueRem, docId)
        : null;
      if (foundPdf && foundPdf._id === docId) {
        contextRemId = currentQueueRemId;
      }
    }
  }

  // Editor Review Timer context: when reviewing an IncRem in the editor, the
  // URLChange listener has cleared currentIncRemKey + incrementalQueueActiveKey,
  // so the queue check above misses it. Confirm the timer's IncRem owns this PDF.
  if (opts.checkEditorTimer && !contextRemId && docId) {
    const editorTimerRemId = await plugin.storage.getSession<string>(editorReviewTimerRemIdKey);
    if (editorTimerRemId) {
      const editorTimerRem = await plugin.rem.findOne(editorTimerRemId);
      const foundPdf = editorTimerRem
        ? await findPDFinRem(plugin as any, editorTimerRem, docId)
        : null;
      if (foundPdf && foundPdf._id === docId) {
        contextRemId = editorTimerRemId;
      }
    }
  }

  if (!contextRemId) {
    const pageRangeContext = await plugin.storage.getSession<{
      incrementalRemId: string | null;
      pdfRemId: string | null;
    }>('pageRangeContext');

    const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);

    if (
      pageRangeContext?.incrementalRemId &&
      pageRangeContext?.pdfRemId &&
      pageRangeContext.incrementalRemId !== pageRangeContext.pdfRemId
    ) {
      contextRemId = pageRangeContext.incrementalRemId;
    } else if (currentIncRemId) {
      const incRem = await plugin.rem.findOne(currentIncRemId);
      if (incRem && (await incRem.hasPowerup(powerupCode))) {
        contextRemId = currentIncRemId;
      }
    }
  }

  return contextRemId;
}

export async function handleCreateExtract(plugin: ReactRNPlugin, remId: string) {
  const highlight = await plugin.rem.findOne(remId);
  if (!highlight) return;

  const { pdfRemId: docId, pageIndex } = await getPdfInfoFromHighlight(plugin as any, highlight);
  const contextRemId = await resolveContextRemId(plugin, docId, { checkEditorTimer: true });

  await createRemFromHighlight(plugin as any, highlight, {
    makeIncremental: true,
    contextRemId,
    showPriorityPopupIfNew: true,
  });

  if (contextRemId && docId) {
    try {
      await addPageToHistory(plugin as any, contextRemId, docId, pageIndex, undefined, highlight._id);
      if (pageIndex !== null) {
        await setIncrementalReadingPosition(plugin as any, contextRemId, docId, pageIndex);
      }
      await plugin.app.toast('✅ Extract created & bookmark updated');
    } catch (e) {
      console.error('Failed to update bookmark position via Toolbar', e);
    }
  }
}

export async function handleToggleIncremental(
  plugin: ReactRNPlugin,
  remId: string
): Promise<boolean> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return false;

  const currentlyIncremental = await rem.hasPowerup(powerupCode);

  if (currentlyIncremental) {
    await rem.removePowerup(powerupCode);
    await plugin.app.toast('❌ Removed Incremental tag');
    return false;
  }

  await initIncrementalRem(plugin as any, rem);

  const { pdfRemId: docId, pageIndex } = await getPdfInfoFromHighlight(plugin as any, rem);
  const contextRemId = await resolveContextRemId(plugin, docId, { checkEditorTimer: false });

  if (contextRemId && docId) {
    try {
      await addPageToHistory(plugin as any, contextRemId, docId, pageIndex, undefined, rem._id);
      if (pageIndex !== null) {
        await setIncrementalReadingPosition(plugin as any, contextRemId, docId, pageIndex);
      }
      await plugin.app.toast('✅ Tagged & bookmark updated');
    } catch (e) {
      console.error('Error creating bookmark for toggle_incremental_toolbar', e);
      await plugin.app.toast('✅ Tagged as Incremental Rem');
    }
  } else {
    await plugin.app.toast('✅ Tagged as Incremental Rem');
  }

  await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
  await plugin.widget.openPopup('priority_interval', { remId: rem._id });
  return true;
}

export async function handleOpenBookmarkPopup(plugin: ReactRNPlugin, remId: string) {
  await plugin.widget.openPopup('pdf_bookmark_popup', { remId });
}
