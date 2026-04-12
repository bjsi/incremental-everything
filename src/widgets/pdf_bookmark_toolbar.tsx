import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';

export function PdfBookmarkToolbar() {
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

  return (
    <div
      style={{
        padding: '2px 6px',
        cursor: 'pointer',
        fontSize: '15px',
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
      onClick={async () => {
        await plugin.widget.openPopup('pdf_bookmark_popup', { remId });
      }}
      title="Bookmark Position — save & jump to your reading position"
    >
      🔖
    </div>
  );
}

renderWidget(PdfBookmarkToolbar);
