import { renderWidget, usePlugin, WidgetLocation, ReactRNPlugin } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { getPdfInfoFromHighlight, findAllRemsForPDF, findAllRemsForHTML, findPDFinRem, findHTMLinRem, isHtmlSource, addPageToHistory, getPageHistory, PageHistoryEntry, PageRangeContext, setIncrementalReadingPosition, getIncrementalPageRange, safeRemTextToString } from '../lib/pdfUtils';
import { incrementalQueueActiveKey, currentIncRemKey, editorReviewTimerRemIdKey } from '../lib/consts';

export function PdfBookmarkPopup() {
  const plugin = usePlugin() as ReactRNPlugin;
  const [highlightRemId, setHighlightRemId] = useState<string | null>(null);
  const [pdfRemId, setPdfRemId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState<number | null>(null);

  const [activeQueueContext, setActiveQueueContext] = useState<PageRangeContext | null>(null);
  const [activeQueueRemName, setActiveQueueRemName] = useState<string>('');
  // Whether the active context came from the queue or the editor-review timer.
  // The fast-path UI is identical; only the labels change.
  const [activeContextSource, setActiveContextSource] = useState<'queue' | 'editor-timer'>('queue');
  const [associatedRems, setAssociatedRems] = useState<any[]>([]);
  const [historicalBookmarks, setHistoricalBookmarks] = useState<{ remId: string, name: string, history: PageHistoryEntry[] }[]>([]);

  const [loading, setLoading] = useState(true);
  const [highlightTexts, setHighlightTexts] = useState<Record<string, string>>({});

  // Helper to batch-resolve highlight rem texts into a lookup map
  const resolveHighlightTexts = async (entries: PageHistoryEntry[]): Promise<Record<string, string>> => {
    const map: Record<string, string> = {};
    await Promise.all(entries.map(async (entry) => {
      if (!entry.highlightId) return;
      try {
        const hRem = await plugin.rem.findOne(entry.highlightId);
        if (hRem?.text) {
          const text = await safeRemTextToString(plugin as any, hRem.text);
          if (text && text !== 'Untitled') map[entry.highlightId] = text;
        }
      } catch { /* ignore */ }
    }));
    return map;
  };

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
          // Host kind: PDF (UploadedFile) or HTML (Link, non-YouTube). Used to
          // dispatch between findPDFinRem / findHTMLinRem and findAllRemsForPDF
          // / findAllRemsForHTML so that HTML IncRems are discoverable too.
          const hostRem = await plugin.rem.findOne(docId);
          const isHtmlHost = hostRem ? await isHtmlSource(hostRem) : false;

          // Queue detection: read current-inc-rem directly as the primary signal.
          // incrementalQueueActiveKey can get stuck false due to useEffect lifecycle
          // timing, but current-inc-rem is reliably set by setCurrentIncrementalRem
          // on every queue turn.
          const isQueueActive = await plugin.storage.getSession<boolean>(incrementalQueueActiveKey);
          const currentIncRem = await plugin.storage.getSession<string>(currentIncRemKey);
          let activeRemId: string | undefined = (isQueueActive || currentIncRem) ? currentIncRem : undefined;
          let activeSource: 'queue' | 'editor-timer' = 'queue';

          // Editor-Review-Timer fallback: when reviewing in the editor, the
          // URLChange listener clears currentIncRemKey/incrementalQueueActiveKey,
          // so the queue check above misses it. Confirm the timer's rem owns
          // this PDF before trusting it (same safety check as create_inc_rem_toolbar).
          if (!activeRemId) {
            const editorTimerRemId = await plugin.storage.getSession<string>(editorReviewTimerRemIdKey);
            if (editorTimerRemId) {
              const editorTimerRem = await plugin.rem.findOne(editorTimerRemId);
              const foundHost = editorTimerRem
                ? (isHtmlHost
                    ? await findHTMLinRem(plugin, editorTimerRem, docId)
                    : await findPDFinRem(plugin, editorTimerRem, docId))
                : null;
              if (foundHost && foundHost._id === docId) {
                activeRemId = editorTimerRemId;
                activeSource = 'editor-timer';
              }
            }
          }


          if (activeRemId) {
            // ⚡ FAST PATH: We know the IncRem from the active session (queue
            // or editor-review timer). Skip findAllRemsForPDF entirely.
            const activeRem = await plugin.rem.findOne(activeRemId);
            let remName = '';
            if (activeRem?.text) {
              remName = await safeRemTextToString(plugin, activeRem.text);
              setActiveQueueRemName(remName);
            }
            setActiveContextSource(activeSource);
            setActiveQueueContext({
              incrementalRemId: activeRemId as any,
              pdfRemId: docId as any,
              totalPages: 0,
              currentPage: 1
            });

            // Only fetch reading history for this specific rem (1 call, not N)
            const history = await getPageHistory(plugin, activeRemId, docId);
            // Most recent first
            const withHighlights = history
              .filter(h => h.highlightId)
              .sort((a, b) => b.timestamp - a.timestamp);
            if (withHighlights.length > 0) {
              setHistoricalBookmarks([{ remId: activeRemId, name: remName, history: withHighlights }]);
              // Resolve highlight rem texts for display
              resolveHighlightTexts(withHighlights).then(setHighlightTexts);
            }
            // associatedRems stays [] — not rendered in fast-path mode anyway

          } else {
            // 🐌 FULL PATH (non-queue): find all IncRems that read this host doc.
            // For PDFs we get page-range hierarchy; for HTML the range concept
            // doesn't apply and the list ends up flat (range stays null).
            const associated = (await (isHtmlHost
              ? findAllRemsForHTML(plugin, docId)
              : findAllRemsForPDF(plugin, docId))).filter(a => a.isIncremental);

            // Fetch their page ranges to build hierarchy
            const associatedWithRanges = await Promise.all(
              associated.map(async (assoc) => {
                const range = await getIncrementalPageRange(plugin, assoc.remId, docId);
                return { ...assoc, range };
              })
            );

            // Build tree for hierarchical indentation based on bounding page ranges
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
                // Filter to those with highlightId, most recent first
                const withHighlights = history
                  .filter(h => h.highlightId)
                  .sort((a, b) => b.timestamp - a.timestamp);
                return { remId: assoc.remId, name: assoc.name, history: withHighlights };
              })
            );
            const populated = histories.filter(h => h.history.length > 0);
            setHistoricalBookmarks(populated);
            // Resolve highlight rem texts for all entries
            const allEntries = populated.flatMap(h => h.history);
            resolveHighlightTexts(allEntries).then(setHighlightTexts);
          }
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
    // Host doc and highlight are required; page is optional (null for HTML/Text Reader).
    if (!pdfRemId || !highlightRemId) return;
    try {
      await addPageToHistory(plugin, incrementalRemId, pdfRemId, pageIndex, undefined, highlightRemId);
      // Reading-position pointer only makes sense for paginated sources.
      if (pageIndex !== null) {
        await setIncrementalReadingPosition(plugin, incrementalRemId, pdfRemId, pageIndex);
      }
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

  if (!pdfRemId) {
    return <div style={{ padding: '8px', fontSize: '13px', color: 'var(--rn-clr-content-secondary)' }}>No reader context found.</div>;
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
        {pageIndex !== null && (
          <span style={{ fontSize: '12px', color: 'var(--rn-clr-content-secondary)' }}>Page {pageIndex}</span>
        )}
      </div>

      {activeQueueContext && (
        <div style={{ marginBottom: '16px' }}>
          <button
            style={{
              width: '100%', padding: '8px', borderRadius: '4px', border: 'none',
              backgroundColor: 'var(--rn-clr-blue, #3b82f6)', color: 'white', cursor: 'pointer',
              fontWeight: 500, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px'
            }}
            onClick={async () => { await saveBookmark(activeQueueContext.incrementalRemId); plugin.widget.closePopup(); }}
          >
            {activeContextSource === 'editor-timer'
              ? 'Update Current Editor Review Reading'
              : 'Update Current Queue Reading'}
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
          {(() => {
            // Find the best suggestion: shortest range that contains the current page
            let suggestedRemId: string | null = null;
            if (pageIndex !== null) {
              let bestSize = Infinity;
              for (const assoc of associatedRems) {
                if (!assoc.range) continue;
                const { start, end } = assoc.range;
                const pageEnd = end ?? Infinity;
                if (pageIndex >= start && pageIndex <= pageEnd) {
                  const size = pageEnd - start;
                  if (size < bestSize) {
                    bestSize = size;
                    suggestedRemId = assoc.remId;
                  }
                }
              }
            }

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {associatedRems.map((assoc) => {
                  const isSuggested = assoc.remId === suggestedRemId;
                  return (
                    <button
                      key={assoc.remId}
                      style={{
                        textAlign: 'left', padding: '6px 8px', borderRadius: '4px',
                        border: isSuggested ? '1.5px solid var(--rn-clr-blue, #3b82f6)' : '1px solid var(--rn-clr-border-primary)',
                        backgroundColor: isSuggested ? 'var(--rn-clr-blue-light, #eff6ff)' : 'var(--rn-clr-background-secondary)',
                        color: isSuggested ? 'var(--rn-clr-blue, #1e40af)' : 'var(--rn-clr-content-primary)',
                        cursor: 'pointer', fontSize: '11px',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        marginLeft: `${assoc.depth * 14}px`, transition: 'background-color 0.15s ease',
                        fontWeight: isSuggested ? 600 : 400,
                      }}
                      onClick={() => saveBookmark(assoc.remId)}
                      onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-modifier-hover)'}
                      onMouseOut={(e) => e.currentTarget.style.backgroundColor = isSuggested ? 'var(--rn-clr-blue-light, #eff6ff)' : 'var(--rn-clr-background-secondary)'}
                      title={isSuggested ? `Suggested — page ${pageIndex} is within this range` : assoc.name}
                    >
                      {isSuggested ? `★ ${assoc.name}` : assoc.name}
                    </button>
                  );
                })}
              </div>
            );
          })()}
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
                      {activeId
                        ? (activeContextSource === 'editor-timer' ? 'Editor Review Bookmarks:' : 'Queue Reading Bookmarks:')
                        : 'Your Saved Bookmarks:'}
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
                                color: 'var(--rn-clr-blue, #3b82f6)', cursor: 'pointer', fontSize: '12px',
                                display: 'flex', flexDirection: 'column', gap: '2px',
                                fontWeight: 500, transition: 'background-color 0.15s ease', width: '100%'
                              }}
                              onClick={() => jumpToBookmark(entry.highlightId!)}
                              onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-modifier-hover)'}
                              onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)'}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>{typeof entry.page === 'number' ? `📄 Page ${entry.page}` : '🔖 Bookmark'}</span>
                                <span style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '10px', fontWeight: 400 }}>{new Date(entry.timestamp).toLocaleDateString()}</span>
                              </div>
                              {entry.highlightId && highlightTexts[entry.highlightId] && (
                                <div style={{
                                  fontSize: '10px', fontWeight: 400,
                                  color: 'var(--rn-clr-content-secondary)',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  maxWidth: '100%', fontStyle: 'italic'
                                }}>
                                  {highlightTexts[entry.highlightId].length > 90
                                    ? highlightTexts[entry.highlightId].substring(0, 90) + '…'
                                    : highlightTexts[entry.highlightId]}
                                </div>
                              )}
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
                              <span>{typeof entry.page === 'number' ? `Page ${entry.page}` : 'Bookmark'}</span>
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
