import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
  RNPlugin,
  Rem,
} from '@remnote/plugin-sdk';
import React, { useMemo } from 'react';
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

const handleReviewAndOpenRem = async (plugin: RNPlugin, rem: Rem | undefined, remType: string | null) => {
  if (!rem) return;

  if (remType === 'pdf') {
    const pdfRem = await findPDFinRem(plugin, rem);
    if (pdfRem) {
      const pageKey = getCurrentPageKey(rem._id, pdfRem._id);
      const currentPage = await plugin.storage.getSynced<number>(pageKey);
      
      if (currentPage) {
        await addPageToHistory(plugin, rem._id, pdfRem._id, currentPage);
      }
    }
  }

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

  // ✅ ALL HOOKS MUST BE CALLED UNCONDITIONALLY AT THE TOP
  
  // ✅ Get the performance mode setting first
  const performanceMode = useTrackerPlugin(
    (rp) => rp.settings.getSetting<string>('performanceMode'), 
    []
  ) || 'full';
  
  // Consolidate core data into a single tracker
  const coreData = useTrackerPlugin(async (rp) => {
    const ctx = await rp.widget.getWidgetContext<WidgetLocation.FlashcardAnswerButtons>();
    if (!ctx?.remId) return null;

    const rem = await rp.rem.findOne(ctx.remId);
    if (!rem) return null;

    const incRemInfo = await getIncrementalRemInfo(rp, rem);
    if (!incRemInfo) return null;

    // 🔌 Conditionally fetch sessionCache based on performanceMode
    const [allIncRems, sessionCache, shouldDisplayShield] = await Promise.all([
      rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
      (performanceMode === 'full')
        ? rp.storage.getSession<QueueSessionCache>(queueSessionCacheKey)
        : Promise.resolve(null), // In 'light' mode, resolve to null
      rp.settings.getSetting<boolean>(displayPriorityShieldId),
    ]);

    return {
      ctx,
      rem,
      incRemInfo,
      allIncRems: allIncRems || [],
      sessionCache, // This will be null in 'light' mode
      shouldDisplayShield: shouldDisplayShield ?? true,
      performanceMode: performanceMode, // Pass the mode to the component
    };
  }, [performanceMode]); // 🔌 Add performanceMode to the dependency array

  // Separate lightweight trackers for UI state
  const activeHighlightId = useTrackerPlugin(
    (rp) => rp.storage.getSession<string | null>(activeHighlightIdKey), 
    []
  );
  
  const remType = useTrackerPlugin(
    (rp) => rp.storage.getSession<string | null>(currentIncrementalRemTypeKey),
    []
  );

  // Async shield calculation
  const shieldStatusAsync = useTrackerPlugin(async (rp) => {
    // 🔌 Add check for light mode
    if (performanceMode === 'light' || !coreData?.shouldDisplayShield || !coreData?.sessionCache) return null;

    const seenRemIds = (await rp.storage.getSession<string[]>(seenRemInSessionKey)) || [];
    
    const { sessionCache, allIncRems, rem } = coreData;
    const dueKb = sessionCache.dueIncRemsInKB || [];
    const unreviewedDueKb = dueKb.filter(
      (r) => !seenRemIds.includes(r.remId) || r.remId === rem._id
    );
    const topMissedInKb = _.minBy(unreviewedDueKb, (r) => r.priority);
    
    const dueDoc = sessionCache.dueIncRemsInScope || [];
    const unreviewedDueDoc = dueDoc.filter(
      (r) => !seenRemIds.includes(r.remId) || r.remId === rem._id
    );
    const topMissedInDoc = _.minBy(unreviewedDueDoc, (r) => r.priority);

    return {
      kb: topMissedInKb ? {
        absolute: topMissedInKb.priority,
        percentile: calculateRelativePriority(allIncRems, topMissedInKb.remId),
      } : null,
      doc: topMissedInDoc ? {
        absolute: topMissedInDoc.priority,
        percentile: sessionCache.incRemDocPercentiles?.[topMissedInDoc.remId] ?? null,
      } : null,
    };
  }, [coreData?.shouldDisplayShield, coreData?.sessionCache, coreData?.allIncRems, coreData?.rem._id, performanceMode]);

  // ✅ MEMOIZE CALCULATIONS (but they must run every render, not conditionally)
  const percentiles = useMemo(() => {
    if (!coreData) return { kb: null, doc: null };
    
    const { allIncRems, incRemInfo, sessionCache } = coreData;
    const kbPercentile = calculateRelativePriority(allIncRems, incRemInfo.remId);
    const docPercentile = sessionCache?.incRemDocPercentiles?.[incRemInfo.remId] ?? null;
    
    return { kb: kbPercentile, doc: docPercentile };
  }, [coreData]);

  // ✅ NOW we can do early returns AFTER all hooks are called
  if (!coreData) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center',
        padding: '20px',
        color: '#6b7280',
        fontSize: '13px'
      }}>
        Loading...
      </div>
    );
  }

  const { ctx, rem, incRemInfo, allIncRems, sessionCache, shouldDisplayShield } = coreData;

  // Event handlers
  const handleNextClick = async () => {
    if (remType === 'pdf') {
      const pdfRem = await findPDFinRem(plugin, rem);
      if (pdfRem) {
        const pageKey = getCurrentPageKey(rem._id, pdfRem._id);
        const currentPage = await plugin.storage.getSynced<number>(pageKey);
        
        if (currentPage) {
          await addPageToHistory(plugin, rem._id, pdfRem._id, currentPage);
        }
      }
    }

    await handleHextRepetitionClick(plugin, incRemInfo);
  };

  const priorityColor = percentiles.kb ? percentileToHslColor(percentiles.kb) : '#6b7280';

  // Container styles
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '2px 6px 6px 6px',
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
        <Button variant="primary" onClick={handleNextClick}>
          <div style={buttonStyles.label}>Next</div>
          <div style={buttonStyles.sublabel}><NextRepTime rem={incRemInfo} /></div>
        </Button>

        <Button
          variant="secondary"
          onClick={async () => { 
            await plugin.widget.openPopup('reschedule', { remId: ctx.remId }); 
          }}
        >
          <div style={buttonStyles.label}>Reschedule</div>
          <div style={buttonStyles.sublabel}>Set interval</div>
        </Button>

        <Button
          variant="danger"
          onClick={async () => {
            const updatedAllRem = allIncRems.filter((r) => r.remId !== rem._id);
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
            await plugin.widget.openPopup('priority', { remId: ctx.remId }); 
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
              <div style={buttonStyles.label}>🔍 Scroll to</div>
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
      {(incRemInfo || (shouldDisplayShield && shieldStatusAsync)) && (
        <div style={infoBarStyle}>
          {/* Priority Display */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 500 }}>Priority:</span>
            <div style={priorityBadgeStyle}>
              <span>{incRemInfo.priority}</span>
              {/* Show KB percentile (always current). Doc percentile removed from cache after priority change. */}
              {percentiles.kb !== null && (
                <span style={{ opacity: 0.9, fontSize: '11px' }}>
                  ({percentiles.kb}% KB
                  {/* 🔌 Conditionally show Doc percentile */}
                  {performanceMode === 'full' && percentiles.doc !== null && `, ${percentiles.doc}% Doc`})
                </span>
              )}
            </div>
            {/* Show refresh icon only when Doc percentile is missing (will be recalculated on next queue) */}
            {percentiles.kb !== null && percentiles.doc === null && (
              <span 
                style={{ 
                  fontSize: '16px', 
                  opacity: 0.6,
                  cursor: 'help'
                }}
                title="Doc percentile will be recalculated when you start a new queue session"
              >
                ⟳
              </span>
            )}
          </div>

          {/* Shield Display */}
          {/* 🔌 Conditionally show Shield */}
          {performanceMode === 'full' && shouldDisplayShield && shieldStatusAsync && (
            <>
              <span style={{ color: '#9ca3af' }}>|</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600 }}>🛡️ Priority Shield</span>
                <div style={{ display: 'flex', gap: '12px' }}>
                  {shieldStatusAsync.kb ? (
                    <span>
                      KB: <strong>{shieldStatusAsync.kb.absolute}</strong> ({shieldStatusAsync.kb.percentile}%)
                    </span>
                  ) : (
                    <span>KB: 100%</span>
                  )}
                  {shieldStatusAsync.doc ? (
                    <span>
                      Doc: <strong>{shieldStatusAsync.doc.absolute}</strong> ({shieldStatusAsync.doc.percentile}%)
                    </span>
                  ) : (
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