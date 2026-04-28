import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { powerupCode, incrementalQueueActiveKey } from '../lib/consts';
import { initIncrementalRem } from '../register/powerups';
import {
  getPdfInfoFromHighlight,
  addPageToHistory,
  setIncrementalReadingPosition,
  findPDFinRem
} from '../lib/pdfUtils';

export function ToggleIncrementalToolbar() {
  const plugin = usePlugin();
  const [remId, setRemId] = useState<string | null>(null);
  const [isIncremental, setIsIncremental] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const init = async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.PDFHighlightToolbarLocation>();
      if (!ctx?.remId) return;
      setRemId(ctx.remId);

      const rem = await plugin.rem.findOne(ctx.remId);
      if (rem) {
        setIsIncremental(await rem.hasPowerup(powerupCode));
      }
    };
    init();
  }, [plugin]);

  if (!remId) return null;

  const handleClick = async () => {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) return;

    const currentlyIncremental = await rem.hasPowerup(powerupCode);

    if (currentlyIncremental) {
      await rem.removePowerup(powerupCode);
      setIsIncremental(false);
      await plugin.app.toast('❌ Removed Incremental tag');
    } else {
      await initIncrementalRem(plugin as any, rem);
      setIsIncremental(true);

      // 1. Fetch PDF info from the newly tagged rem
      const { pdfRemId: docId, pageIndex } = await getPdfInfoFromHighlight(plugin as any, rem);

      let contextRemId: string | null = null;

      // 2. Strict Queue Context Check
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

      // 3. Fallback to generic session context if not actively in queue
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

      // 4. Save bookmark position safely to identified context.
      //    pageIndex is null for HTML / PDF Text Reader highlights — we still
      //    want to record the bookmark by highlight rem id so jumps work.
      if (contextRemId && docId) {
        try {
          await addPageToHistory(plugin as any, contextRemId, docId, pageIndex, undefined, rem._id);
          if (pageIndex !== null) {
            await setIncrementalReadingPosition(plugin as any, contextRemId, docId, pageIndex);
          }
          await plugin.app.toast('✅ Tagged & bookmark updated');
        } catch (e) {
          console.error('Error creating bookmark for toggle_incremental_toolbar', e);
          await plugin.app.toast('✅ Tagged as Incremental Rem'); // Fallback toast
        }
      } else {
        await plugin.app.toast('✅ Tagged as Incremental Rem');
      }

      await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
      await plugin.widget.openPopup('priority_interval', { remId: rem._id });
    }
  };

  const tooltipText = isIncremental
    ? 'Remove Incremental tag from this highlight'
    : 'Tag this highlight as an Incremental Rem (auto-bookmarks position)';

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
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.22)' : '0 1px 3px rgba(0,0,0,0.10)',
        backgroundColor: isIncremental
          ? hovered ? 'rgba(59, 130, 246, 0.28)' : 'rgba(59, 130, 246, 0.15)'   // blue shades
          : hovered ? 'rgba(239, 68, 68, 0.28)' : 'rgba(239, 68, 68, 0.15)',   // red shades
        transform: hovered ? 'translateY(-1px)' : 'none',
        border: isIncremental
          ? '1px solid rgba(59, 130, 246, 0.35)'
          : '1px solid rgba(239, 68, 68, 0.35)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={handleClick}
      title={tooltipText}
    >
      <img
        src="icon-toggle-inc.png"
        alt="Toggle Incremental Rem"
        style={{
          width: '16px',
          height: '16px',
          opacity: hovered ? 1 : isIncremental === true ? 1 : 0.7,
          transition: 'opacity 0.15s ease',
          filter: isIncremental === true ? 'none' : 'grayscale(30%)',
        }}
      />
    </div>
  );
}

renderWidget(ToggleIncrementalToolbar);