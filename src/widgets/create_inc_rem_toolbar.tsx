import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useState } from 'react';
import { createRemFromHighlight } from '../lib/highlightActions';
import { powerupCode, incrementalQueueActiveKey, currentIncRemKey } from '../lib/consts';
import {
  getPdfInfoFromHighlight,
  findPDFinRem,
  addPageToHistory,
  setIncrementalReadingPosition,
} from '../lib/pdfUtils';

export function CreateIncRemToolbar() {
  const plugin = usePlugin();
  const [hovered, setHovered] = useState(false);

  const handleClick = async () => {
    // Always read the widget context fresh at click time.
    // If the toolbar widget is reused across highlight selections (not remounted),
    // a cached remId from a previous mount would cause extracts from the wrong highlight.
    const ctx = await plugin.widget.getWidgetContext<WidgetLocation.PDFHighlightToolbarLocation>();
    const remId = ctx?.remId;
    if (!remId) return;

    const highlight = await plugin.rem.findOne(remId);
    if (!highlight) return;

    // 1. Fetch the exact PDF Context from the highlight
    const { pdfRemId: docId, pageIndex } = await getPdfInfoFromHighlight(plugin as any, highlight);

    let contextRemId: string | null = null;

    // 2. Queue context check: confirm the current queue rem actually owns this
    // highlight's PDF before trusting it as contextRemId. This prevents the
    // wrong IncRem being used when multiple sections share the same PDF.
    const isQueueActive = await plugin.storage.getSession<boolean>(incrementalQueueActiveKey);

    if (isQueueActive && docId) {
      const currentQueueRemId = await plugin.storage.getSession<string>(currentIncRemKey);
      if (currentQueueRemId) {
        const currentQueueRem = await plugin.rem.findOne(currentQueueRemId);
        const foundPdf = currentQueueRem ? await findPDFinRem(plugin as any, currentQueueRem, docId) : null;
        if (foundPdf && foundPdf._id === docId) {
          contextRemId = currentQueueRemId;
        }
      }
    }

    // 3. Fallback to generic context if not explicitly matched via the active queue
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

    // 4. Extract logic
    await createRemFromHighlight(plugin as any, highlight, {
      makeIncremental: true,
      contextRemId,
      showPriorityPopupIfNew: true,
    });

    // 5. Save the bookmark position dynamically to the identified contextRem
    if (contextRemId && docId && pageIndex !== null) {
      try {
        await addPageToHistory(plugin as any, contextRemId, docId, pageIndex, undefined, highlight._id);
        await setIncrementalReadingPosition(plugin as any, contextRemId, docId, pageIndex);

        // Optional: show a combined toast to indicate both tasks succeeded
        await plugin.app.toast('✅ Extract created & bookmark updated');
      } catch (e) {
        console.error('Failed to update bookmark position via Toolbar', e);
      }
    }
  };

  return (
    <div
      style={{
        padding: '2px 6px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '4px',
        color: 'var(--rn-clr-content-primary)',
        transition: 'box-shadow 0.15s ease, background-color 0.15s ease, transform 0.1s ease',
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.18)' : 'none',
        backgroundColor: hovered ? 'var(--rn-clr-background-secondary, rgba(0,0,0,0.06))' : 'transparent',
        transform: hovered ? 'translateY(-1px)' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={handleClick}
      title="Create a standalone Incremental Rem from this highlight"
    >
      <img
        src="icon-extract.png"
        alt="Create Incremental Rem"
        style={{
          width: '16px',
          height: '16px',
          opacity: hovered ? 1 : 0.85,
          transition: 'opacity 0.15s ease',
        }}
      />
    </div>
  );
}

renderWidget(CreateIncRemToolbar);