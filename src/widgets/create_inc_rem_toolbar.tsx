import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { createRemFromHighlight } from '../lib/highlightActions';
import { powerupCode } from '../lib/consts';

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

    // Get context for smart destination memory
    const pageRangeContext = await plugin.storage.getSession<{
      incrementalRemId: string | null;
      pdfRemId: string | null;
    }>('pageRangeContext');

    const currentIncRemId = await plugin.storage.getSession<string>('current-inc-rem');

    let contextRemId: string | null = null;

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

    await createRemFromHighlight(plugin as any, highlight, {
      makeIncremental: true,
      contextRemId,
      showPriorityPopupIfNew: true,
    });
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
        src="https://cdn-icons-png.flaticon.com/512/8365/8365483.png"
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
