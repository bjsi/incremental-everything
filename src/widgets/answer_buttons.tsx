// answer_buttons.tsx (Corrected)
import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
  RNPlugin,
  Rem,
} from '@remnote/plugin-sdk';
import React, { useEffect } from 'react';
import * as _ from 'remeda';
import { NextRepTime } from '../components/NextRepTime';
import {
  allIncrementalRemKey,
  powerupCode,
  activeHighlightIdKey,
  currentIncrementalRemTypeKey,
  displayPriorityShieldId,
  seenRemInSessionKey,
  remnoteEnvironmentId,
  queueSessionCacheKey
} from '../lib/consts';
import { getIncrementalRemInfo, handleHextRepetitionClick, reviewRem } from '../lib/incremental_rem';
import { calculateRelativePriority } from '../lib/priority';
import { IncrementalRem } from '../lib/types';
import { percentileToHslColor } from '../lib/color';
import { findPDFinRem, addPageToHistory, getCurrentPageKey } from '../lib/pdfUtils';
import { QueueSessionCache } from '../lib/cardPriority';

// ** START OF FIX **
// Modified the function to accept the 'remType' to know if it's a PDF.
const handleReviewAndOpenRem = async (plugin: RNPlugin, rem: Rem | undefined, remType: string | null) => {
  if (!rem) return;

  // Added the PDF progress saving logic, copied from handleNextClick.
  if (remType === 'pdf') {
    const pdfRem = await findPDFinRem(plugin, rem);
    if (pdfRem) {
      const pageKey = getCurrentPageKey(rem._id, pdfRem._id);
      const currentPage = await plugin.storage.getSynced<number>(pageKey);
      
      if (currentPage) {
        await addPageToHistory(plugin, rem._id, pdfRem._id, currentPage);
        console.log(`Manually logged page ${currentPage} for ${rem._id} on 'Review & Open' click.`);
      }
    }
  }

  // The original logic is preserved.
  const incRemInfo = await getIncrementalRemInfo(plugin, rem);
  await reviewRem(plugin, incRemInfo);
  await plugin.window.openRem(rem);
};
// ** END OF FIX **

// Enhanced button styles
const buttonStyles = {
  base: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    padding: '8px 12px',
    borderRadius: '6px',
    border: 'none',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    gap: '2px',
    minWidth: '90px',
    height: '44px',
    backgroundColor: 'white',
    boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
  },
  primary: {
    backgroundColor: '#3b82f6',
    color: 'white',
    minWidth: '110px',
  },
  secondary: {
    backgroundColor: '#f3f4f6',
    color: '#374151',
    border: '1px solid #e5e7eb',
  },
  danger: {
    backgroundColor: '#fee2e2',
    color: '#dc2626',
    border: '1px solid #fecaca',
  },
  label: {
    fontSize: '12px',
    fontWeight: 600,
    lineHeight: '1.2',
  },
  sublabel: {
    fontSize: '10px',
    opacity: 0.9,
    fontWeight: 400,
  }
};

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  style?: React.CSSProperties;
  disabled?: boolean;
}

function Button({ children, onClick, variant = 'secondary', style, disabled }: ButtonProps) {
  const variantStyles = variant === 'primary' ? buttonStyles.primary : 
                        variant === 'danger' ? buttonStyles.danger : 
                        buttonStyles.secondary;
  
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...buttonStyles.base,
        ...variantStyles,
        ...style,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.transform = 'translateY(-1px)';
          e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = '0 1px 2px 0 rgba(0, 0, 0, 0.05)';
      }}
    >
      {children}
    </button>
  );
}

export function AnswerButtons() {
  console.log('🕹️ AnswerButtons: Render start.');
  const plugin = usePlugin();
  
  useEffect(() => {
    console.log('🕹️ AnswerButtons: Component has mounted.');
    return () => {
      console.log('🕹️ AnswerButtons: Component is unmounting.');
    }
  }, []);

  // --- DATA FETCHING HOOKS ---
  const ctx = useTrackerPlugin(
    async (rp) => {
      const context = await rp.widget.getWidgetContext<WidgetLocation.FlashcardAnswerButtons>();
      console.log('🕹️ AnswerButtons: [DATA] Context object:', context);
      return context;
    },
    []
  );

  const rem = useTrackerPlugin((rp) => {
    const foundRem = rp.rem.findOne(ctx?.remId);
    console.log('🕹️ AnswerButtons: [DATA] Rem object:', foundRem);
    return foundRem;
  }, [ctx?.remId]);

  const incRem = useTrackerPlugin(async () => {
    const info = rem ? await getIncrementalRemInfo(plugin, rem) : undefined;
    console.log('🕹️ AnswerButtons: [DATA] Incremental Rem Info:', info);
    return info;
  }, [rem]);
  
  const allIncrementalRems = useTrackerPlugin((rp) => {
    const allRems = rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey);
    console.log('🕹️ AnswerButtons: [DATA] All Incremental Rems (length):', (allRems || []).length);
    return allRems;
  }, []);

  const shouldDisplayShield = useTrackerPlugin((rp) => {
    const setting = rp.settings.getSetting<boolean>(displayPriorityShieldId);
    console.log('🕹️ AnswerButtons: [DATA] shouldDisplayShield setting:', setting);
    return setting;
  }, []);

  const sessionCache = useTrackerPlugin((rp) => {
    const cache = rp.storage.getSession<QueueSessionCache>(queueSessionCacheKey);
    console.log('🕹️ AnswerButtons: [DATA] sessionCache object:', cache);
    return cache;
  }, []);
  const activeHighlightId = useTrackerPlugin((rp) => rp.storage.getSession<string | null>(activeHighlightIdKey), []);
  const remType = useTrackerPlugin(
    (rp) => rp.storage.getSession<string | null>(currentIncrementalRemTypeKey),
    []
  );
  // --- REWRITTEN: The Shield calculation is now ultra-fast ---
  // --- MODIFIED: This hook is now correctly marked as 'async' ---
  // --- SHIELD CALCULATION HOOK ---
  const shieldStatus = useTrackerPlugin(async (rp) => {
    console.log('🕹️ AnswerButtons: [SHIELD CALC] Starting shield calculation...');
    if (!shouldDisplayShield || !rem || !sessionCache) {
      console.log('🕹️ AnswerButtons: [SHIELD CALC] Aborting early. Conditions not met:', { shouldDisplayShield, hasRem: !!rem, hasCache: !!sessionCache });
      return null;
    }

    const seenRemIds = (await rp.storage.getSession<string[]>(seenRemInSessionKey)) || [];
    console.log('🕹️ AnswerButtons: [SHIELD CALC] Seen Rem IDs (length):', seenRemIds.length);

    // KB Shield
    const dueKb = sessionCache.dueIncRemsInKB || [];
    const unreviewedDueKb = dueKb.filter(
      (r) => !seenRemIds.includes(r.remId) || r.remId === rem._id
    );
    const topMissedInKb = _.minBy(unreviewedDueKb, (r) => r.priority);
    console.log('🕹️ AnswerButtons: [SHIELD CALC] KB Shield - Top missed:', topMissedInKb);
    
    // Doc Shield
    const dueDoc = sessionCache.dueIncRemsInScope || [];
    const unreviewedDueDoc = dueDoc.filter(
      (r) => !seenRemIds.includes(r.remId) || r.remId === rem._id
    );
    const topMissedInDoc = _.minBy(unreviewedDueDoc, (r) => r.priority);
    console.log('🕹️ AnswerButtons: [SHIELD CALC] Doc Shield - Top missed:', topMissedInDoc);

    const result = {
      kb: topMissedInKb ? {
        absolute: topMissedInKb.priority,
        percentile: calculateRelativePriority(allIncrementalRems || [], topMissedInKb.remId),
      } : null,
      doc: topMissedInDoc ? {
        absolute: topMissedInDoc.priority,
        percentile: sessionCache.incRemDocPercentiles?.[topMissedInDoc.remId] ?? null,
      } : null,
    };
    console.log('🕹️ AnswerButtons: [SHIELD CALC] Final shieldStatus object:', result);
    return result;
  }, [rem, sessionCache, shouldDisplayShield, allIncrementalRems]);

    // --- New Logic to handle the "Next" button click ---
  const handleNextClick = async () => {
    if (!rem || !incRem) return;

    // Check if the current view is a PDF
    if (remType === 'pdf') {
      // Find the associated PDF Rem
      const pdfRem = await findPDFinRem(plugin, rem);
      if (pdfRem) {
        // Get the last known page number from storage (the Reader keeps this updated)
        const pageKey = getCurrentPageKey(rem._id, pdfRem._id);
        const currentPage = await plugin.storage.getSynced<number>(pageKey);
        
        if (currentPage) {
          // Manually add the current page to the history before rescheduling
          await addPageToHistory(plugin, rem._id, pdfRem._id, currentPage);
          console.log(`Manually logged page ${currentPage} for ${rem._id} on 'Next' click.`);
        }
      }
    }

    // Proceed with the original "Next" button logic
    await handleHextRepetitionClick(plugin, incRem);
  };

  // Calculate priority percentiles
  let kbPercentile: number | null = null;
  let docPercentile: number | null = null;
  
  if (incRem && allIncrementalRems) {
    kbPercentile = calculateRelativePriority(allIncrementalRems, incRem.remId);

    // NEW: Doc percentile is now an instant lookup from the session cache.
    if (sessionCache?.incRemDocPercentiles) {
      docPercentile = sessionCache.incRemDocPercentiles[incRem.remId];
    }
  }
   console.log('🕹️ AnswerButtons: [CALC] Percentiles:', { kbPercentile, docPercentile });

  const priorityColor = kbPercentile ? percentileToHslColor(kbPercentile) : '#6b7280';

  // Container styles
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '2px 6px 6px 6px', // Reduced top padding from 6px to 2px
  };

  const buttonRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
  };

  const dividerStyle: React.CSSProperties = {
    width: '1px',
    height: '36px',
    backgroundColor: '#e5e7eb',
    margin: '0 4px',
  };

  const priorityBadgeStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: 600,
    color: 'white',
    backgroundColor: priorityColor,
    boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
  };

  const infoBarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    padding: '6px 12px',
    backgroundColor: 'rgba(59, 130, 246, 0.05)',
    borderRadius: '6px',
    fontSize: '12px',
    color: '#1e40af',
    borderLeft: `3px solid ${priorityColor}`,
  };

    console.log('🕹️ AnswerButtons: Final state before render:', {
    hasCtx: !!ctx,
    hasRem: !!rem,
    hasIncRem: !!incRem,
    hasShieldStatus: !!shieldStatus,
    shouldDisplayShield,
  });

  return (
    <div style={containerStyle} className="incremental-everything-answer-buttons">
      {/* Single row of buttons */}
      <div style={buttonRowStyle}>
        {/* MODIFIED: Use the new handler for the "Next" button */}
        <Button variant="primary" onClick={handleNextClick}>
          <div style={buttonStyles.label}>Next</div>
          <div style={buttonStyles.sublabel}>{incRem && <NextRepTime rem={incRem} />}</div>
        </Button>

        <Button
          variant="secondary"
          onClick={async () => { 
            if (ctx?.remId) await plugin.widget.openPopup('reschedule', { remId: ctx.remId }); 
          }}
        >
          <div style={buttonStyles.label}>Reschedule</div>
          <div style={buttonStyles.sublabel}>Set interval</div>
        </Button>

        <Button
          variant="danger"
          onClick={async () => {
            if (!rem || !incRem) return;
            const updatedAllRem = ((await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || []).filter((r) => r.remId !== rem._id);
            await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
            await plugin.queue.removeCurrentCardFromQueue(true);
            await rem.removePowerup(powerupCode);
          }}
        >
          <div style={buttonStyles.label}>Done</div>
          <div style={buttonStyles.sublabel}>Untag</div>
        </Button>

        {/* Divider */}
        <div style={dividerStyle} />

        {/* Secondary Actions Group */}
        <Button
          onClick={async () => { 
            if (ctx?.remId) await plugin.widget.openPopup('priority', { remId: ctx.remId }); 
          }}
        >
          <div style={buttonStyles.label}>Change Priority</div>
        </Button>

        <Button
          onClick={() => handleReviewAndOpenRem(plugin, rem, remType)}
        >
          <div style={buttonStyles.label}>Review & Open</div>
          <div style={buttonStyles.sublabel}>Go to Editor</div>
        </Button>

        <Button
          onClick={async () => {
            if (rem) {
              try {
                const environment = await plugin.settings.getSetting<string>(remnoteEnvironmentId) || 'beta';
                const remnoteDomain = environment === 'beta' ? 'https://beta.remnote.com' : 'https://www.remnote.com';
                const newUrl = `${remnoteDomain}/document/${rem._id}`;
                const newWindow = window.open(newUrl, '_blank');
                
                if (!newWindow || newWindow.closed) {
                  const link = document.createElement('a');
                  link.href = newUrl;
                  link.target = '_blank';
                  link.rel = 'noopener noreferrer';
                  document.body.appendChild(link);
                  link.click();
                  setTimeout(() => document.body.removeChild(link), 100);
                }
              } catch (error) {
                console.error('Error opening document:', error);
                plugin.app.toast('Error opening document');
              }
            }
          }}
          style={{ minWidth: '100px' }}
        >
          <div style={buttonStyles.label}>Open Editor</div>
          <div style={buttonStyles.sublabel}>New Tab</div>
        </Button>

        {activeHighlightId && (
          <>
            <div style={dividerStyle} />
            <Button
              onClick={async () => {
                const highlightRem = await plugin.rem.findOne(activeHighlightId);
                await highlightRem?.scrollToReaderHighlight();
              }}
              style={{
                backgroundColor: '#fbbf24',
                color: '#78350f',
                border: '2px solid #f59e0b',
                animation: 'highlightPulse 2s ease-in-out 3',
                fontWeight: 600,
              }}
            >
              <div style={buttonStyles.label}>📍 Scroll to</div>
              <div style={buttonStyles.sublabel}>Highlight</div>
            </Button>
            <style>{`
              @keyframes highlightPulse {
                0%, 100% {
                  transform: translateY(0) scale(1);
                  box-shadow: 0 2px 4px rgba(251, 191, 36, 0.3);
                }
                50% {
                  transform: translateY(-2px) scale(1.05);
                  box-shadow: 0 6px 12px rgba(251, 191, 36, 0.5);
                }
              }
            `}</style>
          </>
        )}

        {/* Desktop-only hint */}
        {['rem', 'pdf', 'pdf-highlight'].includes(remType || '') && (
          <>
            <div style={dividerStyle} />
            <Button
              style={{ 
                backgroundColor: '#f3f4f6',
                cursor: 'default',
                pointerEvents: 'none'
              }}
              className="desktop-only-hint"
            >
              <div style={buttonStyles.label}>Press 'P' to</div>
              <div style={buttonStyles.sublabel}>Edit in Previewer</div>
            </Button>
          </>
        )}
      </div>

      {/* Priority and Shield Info Bar */}
      {(incRem || (shouldDisplayShield && shieldStatus)) && (
        <div style={infoBarStyle}>
          {/* Priority Display */}
          {incRem && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 500 }}>Priority:</span>
              <div style={priorityBadgeStyle}>
                <span>{incRem.priority}</span>
                {kbPercentile !== null && (
                  <span style={{ opacity: 0.9, fontSize: '11px' }}>
                    ({kbPercentile}% KB{docPercentile !== null && `, ${docPercentile}% Doc`})
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Shield Display */}
          {shouldDisplayShield && shieldStatus && incRem && (
            <>
              <span style={{ color: '#9ca3af' }}>|</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600 }}>🛡️ Priority Shield</span>
                <div style={{ display: 'flex', gap: '12px' }}>
                  {shieldStatus.kb ? (
                    <span>
                      KB: <strong>{shieldStatus.kb.absolute}</strong> ({shieldStatus.kb.percentile}%)
                    </span>
                  ) : (
                    <span>KB: 100%</span>
                  )}
                  {/* --- SIMPLIFIED JSX: Check shieldStatus.doc directly --- */}
                  {shieldStatus.doc ? (
                    <span>
                      Doc: <strong>{shieldStatus.doc.absolute}</strong> ({shieldStatus.doc.percentile}%)
                    </span>
                  ) : (
                    // Only show "Doc: 100%" if we are actually in a document queue.
                    sessionCache?.dueIncRemsInScope && <span>Doc: 100%</span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

renderWidget(AnswerButtons);