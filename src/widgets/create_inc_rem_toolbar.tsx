import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { createRemFromHighlight } from '../lib/highlightActions';
import { powerupCode, incrementalQueueActiveKey } from '../lib/consts';
import {
  getPdfInfoFromHighlight,
  findPDFinRem,
  addPageToHistory,
  setIncrementalReadingPosition
} from '../lib/pdfUtils';

export function CreateIncRemToolbar() {
  const plugin = usePlugin();
  const [remId, setRemId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const init = async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.PDFHighlightToolbarLocation>();
      if (ctx && ctx.remId) {
        setRemId(ctx.remId);
      }
    };
    init();
  }, [plugin]);

  if (!remId) return null;

  const handleClick = async () => {
    const highlight = await plugin.rem.findOne(remId);
    if (!highlight) return;

    // 1. Fetch the exact PDF Context from the highlight
    const { pdfRemId: docId, pageIndex } = await getPdfInfoFromHighlight(plugin as any, highlight);

    let contextRemId: string | null = null;

    // 2. Strict Queue Context Check (Syncs logic with pdf_bookmark_popup.tsx)
    const isQueueActive = await plugin.storage.getSession<boolean>(incrementalQueueActiveKey);

    if (isQueueActive) {
      const currentQueueRemId = await plugin.storage.getSession<string>('current-inc-rem');
      if (currentQueueRemId) {
        const currentQueueRem = await plugin.rem.findOne(currentQueueRemId);
        const foundPdf = currentQueueRem && docId ? await findPDFinRem(plugin as any, currentQueueRem, docId) : null;

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

      const currentIncRemId = await plugin.storage.getSession<string>('current-inc-rem');

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