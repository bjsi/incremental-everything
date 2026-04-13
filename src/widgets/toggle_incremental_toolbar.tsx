import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { powerupCode } from '../lib/consts';
import { initIncrementalRem } from '../register/powerups';
import {
  getPdfInfoFromHighlight,
  addPageToHistory,
  setIncrementalReadingPosition,
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
      await plugin.app.toast('✅ Tagged as Incremental Rem');

      // Automatically set a bookmark for the currently reviewed Queue item (if active)
      const { pdfRemId, pageIndex } = await getPdfInfoFromHighlight(plugin as any, rem);
      if (pdfRemId && pageIndex !== null) {
        try {
          const queueCtx = await plugin.storage.getSession<any>('pageRangeContext');
          if (queueCtx && queueCtx.pdfRemId === pdfRemId && queueCtx.incrementalRemId) {
            await addPageToHistory(plugin as any, queueCtx.incrementalRemId, pdfRemId, pageIndex, undefined, rem._id);
            await setIncrementalReadingPosition(plugin as any, queueCtx.incrementalRemId, pdfRemId, pageIndex);
          }
        } catch (e) {
          console.error('Error creating bookmark for toggle_incremental_toolbar', e);
        }
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
          : hovered ? 'rgba(239, 68, 68, 0.28)'  : 'rgba(239, 68, 68, 0.15)',   // red shades
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
        src="https://cdn-icons-png.flaticon.com/512/1504/1504044.png"
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
