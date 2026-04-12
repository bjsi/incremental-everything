import { renderWidget, usePlugin, WidgetLocation, ReactRNPlugin } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { getPdfInfoFromHighlight, findAllRemsForPDF, addPageToHistory, getPageHistory, PageHistoryEntry, PageRangeContext, setIncrementalReadingPosition, findPDFinRem, getIncrementalPageRange } from '../lib/pdfUtils';
import { incrementalQueueActiveKey } from '../lib/consts';

export function PdfBookmarkPopup() {
  const plugin = usePlugin() as ReactRNPlugin;
  const [highlightRemId, setHighlightRemId] = useState<string | null>(null);
  const [pdfRemId, setPdfRemId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState<number | null>(null);

  const [activeQueueContext, setActiveQueueContext] = useState<PageRangeContext | null>(null);
  const [activeQueueRemName, setActiveQueueRemName] = useState<string>('');
  const [associatedRems, setAssociatedRems] = useState<any[]>([]);
  const [historicalBookmarks, setHistoricalBookmarks] = useState<{ remId: string, name: string, history: PageHistoryEntry[] }[]>([]);

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      try {
        const popupContext = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
        const remId = popupContext?.contextData?.remId as string;

        if (!remId) {
          setLoading(false);
          return;
        }

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
          // Strict Queue Context Check: Ensure we truly are in the Active Queue
          const isQueueActive = await plugin.storage.getSession<boolean>(incrementalQueueActiveKey);

          if (isQueueActive) {
            const currentQueueRemId = await plugin.storage.getSession<string>('current-inc-rem');
            if (currentQueueRemId) {
              const currentQueueRem = await plugin.rem.findOne(currentQueueRemId);
              const foundPdf = currentQueueRem ? await findPDFinRem(plugin, currentQueueRem, docId) : null;

              if (foundPdf && foundPdf._id === docId) {
                if (currentQueueRem && currentQueueRem.text) {
                   const textStr = await plugin.richText.toString(currentQueueRem.text);
                   setActiveQueueRemName(textStr);
                }
                setActiveQueueContext({
                  incrementalRemId: currentQueueRemId as any,
                  pdfRemId: docId as any,
                  totalPages: 0,
                  currentPage: 1
                });
              }
            }
          }

          // Fetch all associated incremental reading rems globally
          const associated = await findAllRemsForPDF(plugin, docId);

          // Fetch their page ranges to build hierarchy
          const associatedWithRanges = await Promise.all(
            associated.map(async (assoc) => {
              const range = await getIncrementalPageRange(plugin, assoc.remId, docId);
              return { ...assoc, range };
            })
          );

          // Build tree for hierarchical identation based on bounding page ranges
          const sorted = [...associatedWithRanges].sort((a, b) => {
            if (a.range && b.range) return a.range.start - b.range.start;
            if (a.range && !b.range) return -1;
            if (!a.range && b.range) return 1;
            return a.name.localeCompare(b.name);
          });

          const contains = (outer: any, inner: any) =>
            inner.start >= outer.start &&
            (outer.end === null || inner.end === null || inner.end <= outer.end) &&
            (inner.start > outer.start || (inner.end !== null && (outer.end === null || inner.end < outer.end)));

          const treeItems = sorted.map(item => ({ ...item, depth: 0, parentId: null as string | null }));

          for (let i = 0; i < treeItems.length; i++) {
            if (!treeItems[i].range) continue;
            let bestParentIdx = -1;
            let bestParentSize = Infinity;
            for (let j = 0; j < i; j++) {
              if (!treeItems[j].range) continue;
              if (contains(treeItems[j].range, treeItems[i].range)) {
                const parentSize = (treeItems[j].range!.end ?? Infinity) - treeItems[j].range!.start;
                if (parentSize < bestParentSize) {
                  bestParentSize = parentSize;
                  bestParentIdx = j;
                }
              }
            }
            if (bestParentIdx >= 0) {
              treeItems[i].parentId = treeItems[bestParentIdx].remId;
              treeItems[i].depth = treeItems[bestParentIdx].depth + 1;
            }
          }

          setAssociatedRems(treeItems);

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
      await setIncrementalReadingPosition(plugin, incrementalRemId, pdfRemId, pageIndex);
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
    <div style={{
      padding: '12px', minWidth: '270px', maxWidth: '350px',
      maxHeight: '800px', overflowY: 'auto',
      backgroundColor: 'var(--rn-clr-background-primary)',
      borderRadius: '8px', color: 'var(--rn-clr-content-primary)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
    }}>
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
          {activeQueueRemName && (
             <div style={{ textAlign: 'center', fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginTop: '6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {activeQueueRemName}
             </div>
          )}
        </div>
      )}

      {associatedRems.length > 0 && !activeQueueContext && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--rn-clr-content-secondary)', marginBottom: '8px' }}>Save to Incremental Rem:</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {associatedRems.map((assoc) => (
              <button
                key={assoc.remId}
                style={{
                  textAlign: 'left', padding: '6px 8px', borderRadius: '4px',
                  border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)',
                  color: 'var(--rn-clr-content-primary)', cursor: 'pointer', fontSize: '11px',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  marginLeft: `${assoc.depth * 14}px`, transition: 'background-color 0.15s ease'
                }}
                onClick={() => saveBookmark(assoc.remId)}
                onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-modifier-hover)'}
                onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)'}
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
          {(() => {
            const activeId = activeQueueContext?.incrementalRemId;
            const activeHistoryItems = activeId ? historicalBookmarks.filter(h => h.remId === activeId) : historicalBookmarks;
            const otherHistoryItems = activeId ? historicalBookmarks.filter(h => h.remId !== activeId) : [];

            return (
              <>
                {activeHistoryItems.length > 0 && (
                  <div style={{ marginBottom: otherHistoryItems.length > 0 ? '16px' : '0' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--rn-clr-content-primary)', marginBottom: '8px' }}>
                      {activeId ? "Queue Reading Bookmarks:" : "Your Saved Bookmarks:"}
                    </div>
                    {activeHistoryItems.map(h => (
                      <div key={h.remId} style={{ marginBottom: '8px' }}>
                        {!activeId && <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name}</div>}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {h.history.map((entry, idx) => (
                            <button
                              key={`${entry.timestamp}-${idx}`}
                              style={{
                                textAlign: 'left', padding: '6px 10px', borderRadius: '6px',
                                border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)',
                                color: 'var(--rn-clr-blue, #3b82f6)', cursor: 'pointer', fontSize: '12px', display: 'flex', justifyContent: 'space-between',
                                fontWeight: 500, transition: 'background-color 0.15s ease'
                              }}
                              onClick={() => jumpToBookmark(entry.highlightId!)}
                              onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-modifier-hover)'}
                              onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)'}
                            >
                              <span>📄 Page {entry.page}</span>
                              <span style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '10px', fontWeight: 400 }}>{new Date(entry.timestamp).toLocaleDateString()}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {otherHistoryItems.length > 0 && (
                  <div style={{ opacity: 0.7 }}>
                    <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--rn-clr-content-tertiary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Other Incremental Bookmarks
                    </div>
                    {otherHistoryItems.map(h => (
                      <div key={h.remId} style={{ marginBottom: '6px' }}>
                        <div style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          {h.history.map((entry, idx) => (
                            <button
                              key={`${entry.timestamp}-${idx}`}
                              style={{
                                textAlign: 'left', padding: '4px 6px', borderRadius: '4px',
                                border: 'none', backgroundColor: 'transparent',
                                color: 'var(--rn-clr-content-secondary)', cursor: 'pointer', fontSize: '11px', display: 'flex', justifyContent: 'space-between',
                                transition: 'background-color 0.15s ease'
                              }}
                              onClick={() => jumpToBookmark(entry.highlightId!)}
                              onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-modifier-hover)'}
                              onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                            >
                              <span>Page {entry.page}</span>
                              <span style={{ fontSize: '9px', color: 'var(--rn-clr-content-tertiary)' }}>{new Date(entry.timestamp).toLocaleDateString()}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

renderWidget(PdfBookmarkPopup);
