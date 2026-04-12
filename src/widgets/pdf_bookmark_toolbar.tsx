import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';

export function PdfBookmarkToolbar() {
  const plugin = usePlugin();
  const [remId, setRemId] = useState<string | null>(null);

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
        color: 'var(--rn-clr-content-primary)'
      }}
      onClick={async () => {
        await plugin.widget.openPopup('pdf_bookmark_popup', { remId });
      }}
      title="Manage PDF Bookmark"
    >
      🔖
    </div>
  );
}

renderWidget(PdfBookmarkToolbar);
