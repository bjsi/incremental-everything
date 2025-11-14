import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useState } from 'react';
import { allIncrementalRemKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

interface IncRemWithDetails extends IncrementalRem {
  remText?: string;
}

export function IncRemList() {
  const plugin = usePlugin();
  const [loadingRems, setLoadingRems] = useState<boolean>(false);
  const [incRemsWithDetails, setIncRemsWithDetails] = useState<IncRemWithDetails[]>([]);

  const counterData = useTrackerPlugin(
    async (rp) => {
      try {
        console.log('INC REM LIST: Starting calculation');

        // Get the documentId from session storage (set by the counter widget)
        const documentId = await rp.storage.getSession('popup_document_id');

        console.log('INC REM LIST: Document ID from session storage', documentId);

        // Get all incRems from storage
        const allIncRems = (await rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
        console.log('INC REM LIST: Got allIncRems', allIncRems.length);

        const now = Date.now();

        // If no document, show all incRems
        if (!documentId) {
          console.log('INC REM LIST: No document found, showing all incRems');
          const pendingIncRems = allIncRems.filter((incRem) => incRem.nextRepDate <= now);

          // Load details for all incRems
          loadIncRemDetails(allIncRems);

          return {
            pending: pendingIncRems.length,
            total: allIncRems.length,
            incRems: allIncRems,
          };
        }

        // Get all descendants of the current document
        console.log('INC REM LIST: Finding document', documentId);
        const currentDoc = await rp.rem.findOne(documentId);
        if (!currentDoc) {
          console.log('INC REM LIST: Document not found', documentId);
          return { pending: 0, total: 0, incRems: [] };
        }

        console.log('INC REM LIST: Getting descendants...');
        const descendants = await currentDoc.getDescendants();
        console.log('INC REM LIST: Got descendants', descendants.length);

        const descendantIds = new Set([documentId, ...descendants.map((d) => d._id)]);

        // Filter incRems that belong to this document
        const docIncRems = allIncRems.filter((incRem) => descendantIds.has(incRem.remId));
        const pendingIncRems = docIncRems.filter((incRem) => incRem.nextRepDate <= now);

        // Load details for document incRems
        loadIncRemDetails(docIncRems);

        const result = {
          pending: pendingIncRems.length,
          total: docIncRems.length,
          incRems: docIncRems,
        };

        console.log('INC REM LIST: Loaded for document', {
          documentId: documentId,
          result,
        });

        return result;
      } catch (error) {
        console.error('INC REM LIST: Error', error);
        return { pending: 0, total: 0, incRems: [] };
      }
    },
    []
  );

  const loadIncRemDetails = async (incRems: IncrementalRem[]) => {
    if (loadingRems) return;

    setLoadingRems(true);
    const remsWithDetails: IncRemWithDetails[] = [];

    for (const incRem of incRems) {
      try {
        const rem = await plugin.rem.findOne(incRem.remId);
        if (rem) {
          const text = await rem.text;
          let textStr: string;

          if (typeof text === 'string') {
            textStr = text;
          } else if (Array.isArray(text)) {
            // If text is an array of rich text elements, try to extract text from them
            textStr = text
              .map((item: any) => {
                if (typeof item === 'string') return item;
                if (item?.text) return item.text;
                if (item?.i === 'q') return '[Quote]';
                if (item?.i === 'i') return '[Image]';
                if (item?.url) return '[Link]';
                return '';
              })
              .filter(Boolean)
              .join(' ');

            if (!textStr) textStr = '[Complex content]';
          } else {
            textStr = '[Complex content]';
          }

          // Truncate very long text
          if (textStr.length > 200) {
            textStr = textStr.substring(0, 200) + '...';
          }

          remsWithDetails.push({
            ...incRem,
            remText: textStr || '[Empty rem]',
          });
        }
      } catch (error) {
        console.error('Error loading rem details:', error);
      }
    }

    setIncRemsWithDetails(remsWithDetails);
    setLoadingRems(false);
  };

  const handleClose = async () => {
    await plugin.widget.closePopup();
  };

  const handleRemClick = async (remId: string) => {
    try {
      const rem = await plugin.rem.findOne(remId);
      if (rem) {
        await plugin.window.openRem(rem);
        // Close the popup after opening the rem
        await plugin.widget.closePopup();
      }
    } catch (error) {
      console.error('Error opening rem:', error);
    }
  };

  const now = Date.now();
  const pendingRems = incRemsWithDetails.filter((incRem) => incRem.nextRepDate <= now);
  const futureRems = incRemsWithDetails.filter((incRem) => incRem.nextRepDate > now);

  return (
    <div className="flex flex-col h-full" style={{
      maxHeight: '600px',
      backgroundColor: 'var(--rn-clr-background-primary)'
    }}>
      {/* Header */}
      <div className="px-6 py-5" style={{
        borderBottom: '1px solid var(--rn-clr-border-primary)',
        backgroundColor: 'var(--rn-clr-background-secondary)'
      }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-3xl">📚</div>
            <div>
              <h2 className="text-2xl font-bold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                Incremental Rems
              </h2>
              {counterData && (
                <div className="text-sm mt-1" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                  <span className="font-semibold" style={{ color: '#f97316' }}>{counterData.pending}</span> pending
                  {' • '}
                  <span className="font-semibold" style={{ color: '#3b82f6' }}>{counterData.total}</span> total
                </div>
              )}
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-2 rounded-lg transition-colors"
            style={{
              color: 'var(--rn-clr-content-secondary)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            title="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loadingRems ? (
          <div className="text-center py-8" style={{ color: 'var(--rn-clr-content-secondary)' }}>Loading rems...</div>
        ) : incRemsWithDetails.length === 0 ? (
          <div className="text-center py-8" style={{ color: 'var(--rn-clr-content-secondary)' }}>No incremental rems found</div>
        ) : (
          <div className="flex flex-col gap-4">
            {pendingRems.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="font-bold text-sm px-2 py-1" style={{ color: '#f97316' }}>
                    ⚠️ Pending ({pendingRems.length})
                  </h3>
                  <div className="flex-1 h-px" style={{ backgroundColor: 'var(--rn-clr-border-primary)' }}></div>
                </div>
                <div className="flex flex-col gap-3">
                  {pendingRems.map((incRem) => (
                    <div
                      key={incRem.remId}
                      onClick={() => handleRemClick(incRem.remId)}
                      className="group relative p-4 rounded cursor-pointer transition-all"
                      style={{
                        backgroundColor: 'var(--rn-clr-background-secondary)',
                        border: '1px solid var(--rn-clr-border-primary)',
                        borderLeft: '4px solid #f97316',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)';
                      }}
                    >
                      <div className="font-medium text-base mb-2 pr-6" style={{ color: 'var(--rn-clr-content-primary)' }}>
                        {incRem.remText || 'Loading...'}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded" style={{
                          backgroundColor: '#fed7aa',
                          color: '#9a3412'
                        }}>
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                          {incRem.priority}
                        </span>
                        <span style={{ color: 'var(--rn-clr-content-secondary)' }}>
                          Due {dayjs(incRem.nextRepDate).fromNow()}
                        </span>
                      </div>
                      {incRem.history && incRem.history.length > 0 && (
                        <div className="mt-2 pt-2 text-xs flex items-center gap-2" style={{
                          borderTop: '1px solid var(--rn-clr-border-primary)',
                          color: 'var(--rn-clr-content-tertiary)'
                        }}>
                          Last reviewed {dayjs(incRem.history[incRem.history.length - 1].date).fromNow()} • {incRem.history.length} review{incRem.history.length !== 1 ? 's' : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {futureRems.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="font-bold text-sm px-2 py-1" style={{ color: '#3b82f6' }}>
                    📅 Scheduled ({futureRems.length})
                  </h3>
                  <div className="flex-1 h-px" style={{ backgroundColor: 'var(--rn-clr-border-primary)' }}></div>
                </div>
                <div className="flex flex-col gap-3">
                  {futureRems.map((incRem) => (
                    <div
                      key={incRem.remId}
                      onClick={() => handleRemClick(incRem.remId)}
                      className="group relative p-4 rounded cursor-pointer transition-all"
                      style={{
                        backgroundColor: 'var(--rn-clr-background-secondary)',
                        border: '1px solid var(--rn-clr-border-primary)',
                        borderLeft: '4px solid #3b82f6',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)';
                      }}
                    >
                      <div className="font-medium text-base mb-2 pr-6" style={{ color: 'var(--rn-clr-content-primary)' }}>
                        {incRem.remText || 'Loading...'}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded" style={{
                          backgroundColor: '#bfdbfe',
                          color: '#1e3a8a'
                        }}>
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                          {incRem.priority}
                        </span>
                        <span style={{ color: 'var(--rn-clr-content-secondary)' }}>
                          Due {dayjs(incRem.nextRepDate).fromNow()}
                        </span>
                      </div>
                      {incRem.history && incRem.history.length > 0 && (
                        <div className="mt-2 pt-2 text-xs flex items-center gap-2" style={{
                          borderTop: '1px solid var(--rn-clr-border-primary)',
                          color: 'var(--rn-clr-content-tertiary)'
                        }}>
                          Last reviewed {dayjs(incRem.history[incRem.history.length - 1].date).fromNow()} • {incRem.history.length} review{incRem.history.length !== 1 ? 's' : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

renderWidget(IncRemList);
