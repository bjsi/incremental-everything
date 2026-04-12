import { renderWidget, usePlugin, WidgetLocation, ReactRNPlugin } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { getPdfInfoFromHighlight, getAllIncrementsForPDF, addPageToHistory, getPageHistory, PageHistoryEntry, PageRangeContext } from '../lib/pdfUtils';

export function PdfBookmarkPopup() {
  const plugin = usePlugin() as ReactRNPlugin;
  const [highlightRemId, setHighlightRemId] = useState<string | null>(null);
  const [pdfRemId, setPdfRemId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState<number | null>(null);
  
  const [activeQueueContext, setActiveQueueContext] = useState<PageRangeContext | null>(null);
  const [associatedRems, setAssociatedRems] = useState<any[]>([]);
  const [historicalBookmarks, setHistoricalBookmarks] = useState<{remId: string, history: PageHistoryEntry[]}[]>([]);
  
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      try {
        const popupContext = await plugin.widget.getWidgetContext<WidgetLocation.PDFHighlightPopupLocation>();
        if (!popupContext || !popupContext.remId) {
          setLoading(false);
          return;
        }

        const remId = popupContext.remId;
        setHighlightRemId(remId);
        
        const rem = await plugin.rem.findOne(remId);
        if (!rem) {
          setLoading(false);
          return;
        }
        
        const { pdfRemId: docId, pageIndex: pIndex } = await getPdfInfoFromHighlight(plugin, rem);
        setPdfRemId(docId);
        setPageIndex(pIndex);

        if (docId) {
           // Queue Context Check
           const queueCtx = await plugin.storage.getSession<PageRangeContext>('pageRangeContext');
           if (queueCtx && queueCtx.pdfRemId === docId && queueCtx.incrementalRemId) {
             setActiveQueueContext(queueCtx);
           }
           
           // Fetch all associated incremental reading rems
           const associated = await getAllIncrementsForPDF(plugin, docId);
           setAssociatedRems(associated);
           
           // Fetch history for each to find scroll bookmarks
           const histories = await Promise.all(
              associated.map(async (assoc) => {
                 const history = await getPageHistory(plugin, assoc.remId, docId);
                 // Filter to only those with highlightId (actual bookmark scroll positions)
                 const withHighlights = history.filter(h => h.highlightId);
                 return { remId: assoc.remId, name: assoc.name, history: withHighlights };
              })
           );
           setHistoricalBookmarks(histories.filter(h => h.history.length > 0));
        }
      } catch (err) {
        console.error("Error init bookmark popup", err);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [plugin]);

  const saveBookmark = async (incrementalRemId: string) => {
     if (!pdfRemId || pageIndex === null || !highlightRemId) return;
     try {
       await addPageToHistory(plugin, incrementalRemId, pdfRemId, pageIndex, undefined, highlightRemId);
       await plugin.app.toast('✅ Bookmark saved successfully');
     } catch (e) {
       await plugin.app.toast('❌ Failed to save bookmark');
       console.error(e);
     }
  };

  const jumpToBookmark = async (bookmarkHighlightId: string) => {
     const rem = await plugin.rem.findOne(bookmarkHighlightId);
     if (rem && typeof rem.scrollToReaderHighlight === 'function') {
        rem.scrollToReaderHighlight();
     }
  };

  if (loading) {
    return <div style={{ padding: '8px', fontSize: '13px' }}>Loading...</div>;
  }

  if (!pdfRemId || pageIndex === null) {
    return <div style={{ padding: '8px', fontSize: '13px', color: 'var(--rn-clr-content-secondary)' }}>No page context found.</div>;
  }

  return (
    <div style={{ padding: '12px', minWidth: '250px', backgroundColor: 'var(--rn-clr-background-primary)', borderRadius: '6px', color: 'var(--rn-clr-content-primary)' }}>
      <div style={{ marginBottom: '12px', paddingBottom: '8px', borderBottom: '1px solid var(--rn-clr-border-primary)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>🔖 Bookmark Position</span>
        <span style={{ fontSize: '12px', color: 'var(--rn-clr-content-secondary)' }}>Page {pageIndex}</span>
      </div>

      {activeQueueContext && (
        <div style={{ marginBottom: '16px' }}>
          <button 
            style={{ 
              width: '100%', padding: '8px', borderRadius: '4px', border: 'none', 
              backgroundColor: 'var(--rn-clr-blue, #3b82f6)', color: 'white', cursor: 'pointer',
              fontWeight: 500, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px'
            }}
            onClick={() => saveBookmark(activeQueueContext.incrementalRemId)}
          >
            Update Current Queue Reading
          </button>
        </div>
      )}

      {associatedRems.length > 0 && !activeQueueContext && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--rn-clr-content-secondary)', marginBottom: '8px' }}>Save to Incremental Rem:</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {associatedRems.map((assoc) => (
              <button 
                key={assoc.remId}
                style={{ 
                  textAlign: 'left', padding: '6px 8px', borderRadius: '4px', 
                  border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)',
                  color: 'var(--rn-clr-content-primary)', cursor: 'pointer', fontSize: '12px',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}
                onClick={() => saveBookmark(assoc.remId)}
                title={assoc.name}
              >
                {assoc.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {historicalBookmarks.length > 0 && (
         <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--rn-clr-border-secondary)' }}>
           <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--rn-clr-content-secondary)', marginBottom: '8px' }}>Your Saved Bookmarks:</div>
           {historicalBookmarks.map(h => (
              <div key={h.remId} style={{ marginBottom: '8px' }}>
                 <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name}</div>
                 <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {h.history.map((entry, idx) => (
                      <button
                        key={`${entry.timestamp}-${idx}`}
                        style={{
                           textAlign: 'left', padding: '4px 8px', borderRadius: '4px', 
                           border: 'none', backgroundColor: 'var(--rn-clr-background-secondary)',
                           color: 'var(--rn-clr-blue, #3b82f6)', cursor: 'pointer', fontSize: '12px', display: 'flex', justifyContent: 'space-between'
                        }}
                        onClick={() => jumpToBookmark(entry.highlightId!)}
                      >
                        <span>📄 Page {entry.page}</span>
                        <span style={{color: 'var(--rn-clr-content-tertiary)', fontSize: '10px'}}>{new Date(entry.timestamp).toLocaleDateString()}</span>
                      </button>
                    ))}
                 </div>
              </div>
           ))}
         </div>
      )}
    </div>
  );
}

renderWidget(PdfBookmarkPopup);
