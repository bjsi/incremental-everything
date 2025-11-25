import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import React, { useState } from 'react';
import { allIncrementalRemKey, popupDocumentIdKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { ActionItemType } from '../lib/incremental_rem/types';
import { remToActionItemType } from '../lib/incremental_rem/action_items';
import { buildDocumentScope } from '../lib/scope_helpers';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import '../style.css';
import '../App.css';

dayjs.extend(relativeTime);

interface IncRemWithDetails extends IncrementalRem {
  remText?: string;
  incRemType?: ActionItemType;
}

// Type badge configuration
const TYPE_BADGES: Record<ActionItemType, { emoji: string; label: string; bgColor: string; textColor: string; description: string }> = {
  'pdf': { emoji: '📄', label: 'PDF', bgColor: '#fef3c7', textColor: '#92400e', description: 'A PDF file added as incremental rem' },
  'pdf-highlight': { emoji: '🖍️', label: 'PDF Extract', bgColor: '#fce7f3', textColor: '#9d174d', description: 'Text or area highlighted in a PDF' },
  'pdf-note': { emoji: '📑', label: 'PDF Note', bgColor: '#e0e7ff', textColor: '#3730a3', description: 'A rem created inside a PDF (open PDF → Notes)' },
  'html': { emoji: '🌐', label: 'Web', bgColor: '#dbeafe', textColor: '#1e40af', description: 'A web page added as incremental rem' },
  'html-highlight': { emoji: '🔖', label: 'Web Extract', bgColor: '#d1fae5', textColor: '#065f46', description: 'Text highlighted from a web page' },
  'youtube': { emoji: '▶️', label: 'YouTube', bgColor: '#fee2e2', textColor: '#991b1b', description: 'A YouTube video added as incremental rem' },
  'video': { emoji: '🎬', label: 'Video', bgColor: '#fae8ff', textColor: '#86198f', description: 'A video file added as incremental rem' },
  'rem': { emoji: '📝', label: 'Rem', bgColor: '#f3f4f6', textColor: '#374151', description: 'A regular rem added as incremental rem' },
  'unknown': { emoji: '❓', label: 'Unknown', bgColor: '#f3f4f6', textColor: '#6b7280', description: 'Unknown type' },
};

// Type badge component
function TypeBadge({ type }: { type?: ActionItemType }) {
  if (!type) return null;
  const badge = TYPE_BADGES[type] || TYPE_BADGES['unknown'];
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium"
      style={{
        backgroundColor: badge.bgColor,
        color: badge.textColor,
      }}
      title={badge.description}
    >
      <span>{badge.emoji}</span>
      <span>{badge.label}</span>
    </span>
  );
}

export function IncRemList() {
  const plugin = usePlugin();
  const [loadingRems, setLoadingRems] = useState<boolean>(false);
  const [incRemsWithDetails, setIncRemsWithDetails] = useState<IncRemWithDetails[]>([]);

  const counterData = useTrackerPlugin(
    async (rp) => {
      try {
        // Get the documentId from session storage (set by the counter widget)
        const documentId = await rp.storage.getSession(popupDocumentIdKey);

        // Get all incRems from storage
        const allIncRems = (await rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];

        const now = Date.now();

        // If no document, show all incRems
        if (!documentId) {
          const dueIncRems = allIncRems.filter((incRem) => incRem.nextRepDate <= now);

          // Load details for all incRems
          loadIncRemDetails(allIncRems);

          return {
            due: dueIncRems.length,
            total: allIncRems.length,
            incRems: allIncRems,
          };
        }

        // Build document scope (includes descendants, PDF sources, PDF highlights, PDF descendants)
        const documentScope = await buildDocumentScope(rp, documentId);
        if (documentScope.size === 0) {
          return { due: 0, total: 0, incRems: [] };
        }

        // Filter incRems that belong to this document
        const docIncRems = allIncRems.filter((incRem) => documentScope.has(incRem.remId));
        const dueIncRems = docIncRems.filter((incRem) => incRem.nextRepDate <= now);

        // Load details for document incRems
        loadIncRemDetails(docIncRems);

        return {
          due: dueIncRems.length,
          total: docIncRems.length,
          incRems: docIncRems,
        };
      } catch (error) {
        console.error('INC REM LIST: Error', error);
        return { due: 0, total: 0, incRems: [] };
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

          // Determine the type of this incRem
          let incRemType: ActionItemType = 'unknown';
          try {
            const actionItem = await remToActionItemType(plugin, rem);
            if (actionItem) {
              incRemType = actionItem.type;

              // Check if it's a 'rem' type but actually inside a PDF (pdf-note)
              if (incRemType === 'rem') {
                // Check ancestors to see if any is an UploadedFile (PDF)
                let currentRem = rem;
                let isPdfNote = false;
                for (let i = 0; i < 20; i++) { // Max 20 levels to prevent infinite loop
                  const parent = await currentRem.getParentRem();
                  if (!parent) break;
                  if (await parent.hasPowerup(BuiltInPowerupCodes.UploadedFile)) {
                    isPdfNote = true;
                    break;
                  }
                  currentRem = parent;
                }
                if (isPdfNote) {
                  incRemType = 'pdf-note';
                }
              }
            }
          } catch (typeError) {
            console.error('Error determining rem type:', typeError);
          }

          remsWithDetails.push({
            ...incRem,
            remText: textStr || '[Empty rem]',
            incRemType,
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
  const dueRems = incRemsWithDetails.filter((incRem) => incRem.nextRepDate <= now);
  const scheduledRems = incRemsWithDetails.filter((incRem) => incRem.nextRepDate > now);

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
                  <span className="font-semibold" style={{ color: '#f97316' }}>{counterData.due}</span> due
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
            {dueRems.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="font-bold text-sm px-2 py-1" style={{ color: '#f97316' }}>
                    ⚠️ Due ({dueRems.length})
                  </h3>
                  <div className="flex-1 h-px" style={{ backgroundColor: 'var(--rn-clr-border-primary)' }}></div>
                </div>
                <div className="flex flex-col gap-3">
                  {dueRems.map((incRem) => (
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
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <TypeBadge type={incRem.incRemType} />
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

            {scheduledRems.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="font-bold text-sm px-2 py-1" style={{ color: '#3b82f6' }}>
                    📅 Scheduled ({scheduledRems.length})
                  </h3>
                  <div className="flex-1 h-px" style={{ backgroundColor: 'var(--rn-clr-border-primary)' }}></div>
                </div>
                <div className="flex flex-col gap-3">
                  {scheduledRems.map((incRem) => (
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
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <TypeBadge type={incRem.incRemType} />
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
