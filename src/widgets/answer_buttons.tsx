import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
  RNPlugin,
  Rem,
} from '@remnote/plugin-sdk';
import React from 'react';
import { NextRepTime } from '../components/NextRepTime';
import {
  allIncrementalRemKey,
  powerupCode,
  activeHighlightIdKey,
  currentIncrementalRemTypeKey,
  currentScopeRemIdsKey,
  displayPriorityShieldId,
  seenRemInSessionKey,
  remnoteEnvironmentId,
} from '../lib/consts';
import { getIncrementalRemInfo, handleHextRepetitionClick, reviewRem } from '../lib/incremental_rem';
import { calculateRelativePriority } from '../lib/priority';
import { IncrementalRem } from '../lib/types';
import { percentileToHslColor } from '../lib/color';
import { calculatePriorityShield } from '../lib/priority_shield';
import { addPageToHistory, findPDFinRem, getCurrentPageKey } from '../lib/pdfUtils'; // Import helpers

const handleReviewAndOpenRem = async (plugin: RNPlugin, rem: Rem | undefined) => {
  if (!rem) return;
  const incRemInfo = await getIncrementalRemInfo(plugin, rem);
  await reviewRem(plugin, incRemInfo);
  await plugin.window.openRem(rem);
};

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
  const plugin = usePlugin();
  const ctx = useTrackerPlugin(
    async (rp) => await rp.widget.getWidgetContext<WidgetLocation.FlashcardAnswerButtons>(),
    []
  );

  const rem = useTrackerPlugin(
    (rp) => rp.rem.findOne(ctx?.remId),
    [ctx?.remId]
  );

  const incRem = useTrackerPlugin(
    async () => rem ? await getIncrementalRemInfo(plugin, rem) : undefined,
    [rem]
  );

    // --- New Logic to handle the "Next" button click ---
  const handleNextClick = async () => {
    if (!rem || !incRem) return;

    // Check if the current view is a PDF
    const remType = await plugin.storage.getSession<string | null>(currentIncrementalRemTypeKey);
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

  const allIncrementalRems = useTrackerPlugin(
    (rp) => rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
    []
  );
  
  const currentScopeRemIds = useTrackerPlugin(
    (rp) => rp.storage.getSession<string[] | null>(currentScopeRemIdsKey),
    []
  );

  const shouldDisplayShield = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(displayPriorityShieldId),
    []
  );

  const shieldStatus = useTrackerPlugin(
    async (rp) => {
      await rp.storage.getSession(allIncrementalRemKey);
      await rp.storage.getSession(seenRemInSessionKey);
      await rp.storage.getSession(currentScopeRemIdsKey);
      
      const currentRemId = ctx?.remId;
      return await calculatePriorityShield(plugin, currentRemId);
    },
    [plugin, ctx?.remId]
  );

  const activeHighlightId = useTrackerPlugin(
    (rp) => rp.storage.getSession<string | null>(activeHighlightIdKey),
    []
  );

  const remType = useTrackerPlugin(
    (rp) => rp.storage.getSession<string | null>(currentIncrementalRemTypeKey),
    []
  );

  // Calculate priority percentiles
  let kbPercentile: number | null = null;
  let docPercentile: number | null = null;
  
  if (incRem && allIncrementalRems) {
    kbPercentile = calculateRelativePriority(allIncrementalRems, incRem.remId);

    if (currentScopeRemIds && currentScopeRemIds.length > 0) {
      const scopedRems = allIncrementalRems.filter(r => currentScopeRemIds.includes(r.remId));
      docPercentile = calculateRelativePriority(scopedRems, incRem.remId);
    }
  }

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
          onClick={() => handleReviewAndOpenRem(plugin, rem)}
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
                    ({kbPercentile}% of KB{docPercentile !== null && `, ${docPercentile}% of Doc`})
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
                  {shieldStatus.kb.absolute !== null ? (
                    <span>
                      KB: <strong>{shieldStatus.kb.absolute}</strong> ({shieldStatus.kb.percentile}%)
                    </span>
                  ) : (
                    <span>KB: 100%</span>
                  )}
                  {currentScopeRemIds && (
                    shieldStatus.doc.absolute !== null ? (
                      <span>
                        Doc: <strong>{shieldStatus.doc.absolute}</strong> ({shieldStatus.doc.percentile}%)
                      </span>
                    ) : (
                      <span>Doc: 100%</span>
                    )
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