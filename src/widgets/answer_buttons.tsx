import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
  RNPlugin,
  PluginRem,
} from '@remnote/plugin-sdk';
import React, { useMemo, useState, useEffect } from 'react';
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
  queueSessionCacheKey,
  isMobileDeviceKey,
  alwaysUseLightModeOnMobileId
} from '../lib/consts';
import { getIncrementalRemFromRem, handleHextRepetitionClick, reviewRem } from '../lib/incremental_rem';
import { removeIncrementalRemCache } from '../lib/incremental_rem/cache';
import { IncrementalRem } from '../lib/incremental_rem';
import { percentileToHslColor, calculateRelativePercentile, DEFAULT_PERFORMANCE_MODE, PERFORMANCE_MODE_LIGHT } from '../lib/utils';
import { findPDFinRem, addPageToHistory, getCurrentPageKey, getDescendantsToDepth } from '../lib/pdfUtils';
import { QueueSessionCache, setCardPriority, getCardPriority } from '../lib/card_priority';
import { shouldUseLightMode } from '../lib/mobileUtils';

const MAX_DEPTH_CHECK = 3;

/**
 * Smart function to check if a Rem or its descendants have flashcards.
 * **OPTIMIZED: Checks up to MAX_DEPTH_CHECK (3 levels: PluginRem, Children, Grandchildren).**
 * **PERFORMANCE MODE: In Light Mode, skips flashcard checking and adds cardPriority directly.**
 */
const handleCardPriorityInheritance = async (
  plugin: RNPlugin, 
  rem: PluginRem, 
  incRemInfo: IncrementalRem | null
) => {
  if (!rem || !incRemInfo) return;
  
  // Start the timer
  const startTime = Date.now();
  console.log(`[Done Button] 🏁 Starting depth-limited (max ${MAX_DEPTH_CHECK} levels) check for Rem: ${rem._id}`);
  
  try {
    // 1. Check if the Rem already has a *set* cardPriority tag with a non-default source.
    const existingSource = await rem.getPowerupProperty('cardPriority', 'prioritySource');
    
    // If the Rem is tagged AND the source is 'manual' or 'inherited', we stop.
    // We proceed if the Rem is untagged (existingSource is null) or if the tag source is 'default'.
    if (existingSource && typeof existingSource === 'string' && existingSource.toLowerCase() !== 'default') {
      console.log(`[Done Button] Rem already has manual/inherited priority tag. Skipping check. Total time: ${Date.now() - startTime}ms.`);
      return;
    }
    
    // 2. Check if we should use Light Mode for performance
    const useLightMode = await shouldUseLightMode(plugin);
    
    if (useLightMode) {
      // In Light Mode, skip expensive flashcard checking and add cardPriority directly
      await setCardPriority(plugin, rem, incRemInfo.priority, 'manual');
      console.log(`[Done Button] ⚡ Light Mode: Set card priority ${incRemInfo.priority} without flashcard check. Total time: ${Date.now() - startTime}ms.`);
      return;
    }
    
    // 3. Full Mode: Check the Rem itself for flashcards (Depth 1)
    const remCards = await rem.getCards();
    if (remCards && remCards.length > 0) {
      // Rem has its own flashcards, set card priority
      await setCardPriority(plugin, rem, incRemInfo.priority, 'manual');
      console.log(`[Done Button] ✅ Set card priority ${incRemInfo.priority} for Rem with direct flashcards. Total time: ${Date.now() - startTime}ms.`);
      return;
    }
    
    // 4. Full Mode: Check descendants up to MAX_DEPTH_CHECK (Children and Grandchildren)
    // Uses getDescendantsToDepth to avoid fetching the entire hierarchy upfront.
    const descendantsToCheck = await getDescendantsToDepth(rem, MAX_DEPTH_CHECK);
    
    if (descendantsToCheck.length === 0) {
      console.log(`[Done Button] No descendants found within ${MAX_DEPTH_CHECK} levels. Total time: ${Date.now() - startTime}ms.`);
      return;
    }
    
    console.log(`[Done Button] Checking ${descendantsToCheck.length} descendants up to level ${MAX_DEPTH_CHECK}...`);

    // 5. Full Mode: Batch-check the limited descendants with early termination
    const BATCH_SIZE = 50;
    
    for (let i = 0; i < descendantsToCheck.length; i += BATCH_SIZE) {
      const batch = descendantsToCheck.slice(i, i + BATCH_SIZE);
      
      // Check batch in parallel
      const batchResults = await Promise.all(
        batch.map(async (descendant) => {
          const cards = await descendant.getCards();
          return cards && cards.length > 0;
        })
      );
      
      // Check if any descendant in this batch has flashcards
      if (batchResults.some(hasCards => hasCards)) {
        // Found at least one descendant with flashcards
        await setCardPriority(plugin, rem, incRemInfo.priority, 'manual');
        console.log(`[Done Button] ✅ Set card priority ${incRemInfo.priority} for Rem with descendant flashcards. Found in batch starting at index ${i}. Total time: ${Date.now() - startTime}ms.`);
        return; // Early termination
      }
      console.log(`[Done Button] Batch ${Math.floor(i / BATCH_SIZE) + 1} clear. Moving to next batch...`);
    }
    
    // No flashcards found in the Rem or its checked descendants
    console.log(`[Done Button] No flashcards found in Rem or all checked descendants. Total time: ${Date.now() - startTime}ms.`);
    
  } catch (error) {
    console.error(`[Done Button] ❌ Error in handleCardPriorityInheritance. Total time: ${Date.now() - startTime}ms.`, error);
  }
};

const handleReviewAndOpenRem = async (
  plugin: RNPlugin,
  rem: PluginRem | undefined,
  remType: string | null | undefined
) => {
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

  const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
  await reviewRem(plugin, incRemInfo ?? undefined);
  await plugin.window.openRem(rem);
};

// Dynamic button styles based on dark mode
const getButtonStyles = (isDarkMode: boolean) => ({
  base: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    padding: '10px 16px',
    borderRadius: '10px',
    border: 'none',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    gap: '3px',
    minWidth: '95px',
    height: '50px',
    backgroundColor: isDarkMode ? '#334155' : '#ffffff',
    color: isDarkMode ? '#e2e8f0' : '#374151',
    boxShadow: isDarkMode
      ? '0 2px 4px rgba(0, 0, 0, 0.3)'
      : '0 2px 4px rgba(0, 0, 0, 0.08)',
  },
  primary: {
    backgroundColor: isDarkMode ? '#3b82f6' : '#2563eb',
    color: '#ffffff',
    minWidth: '115px',
  },
  secondary: {
    backgroundColor: isDarkMode ? '#475569' : '#f8fafc',
    color: isDarkMode ? '#e2e8f0' : '#475569',
    border: isDarkMode ? '1px solid #64748b' : '1px solid #e2e8f0',
  },
  danger: {
    backgroundColor: isDarkMode ? '#7f1d1d' : '#fef2f2',
    color: isDarkMode ? '#fca5a5' : '#dc2626',
    border: isDarkMode ? '1px solid #991b1b' : '1px solid #fecaca',
  },
  label: {
    fontSize: '12px',
    fontWeight: 600,
    lineHeight: '1.2',
  },
  sublabel: {
    fontSize: '10px',
    opacity: 0.85,
    fontWeight: 400,
  },
  hoverShadow: isDarkMode
    ? '0 6px 12px rgba(0, 0, 0, 0.4)'
    : '0 6px 12px rgba(0, 0, 0, 0.12)',
  defaultShadow: isDarkMode
    ? '0 2px 4px rgba(0, 0, 0, 0.3)'
    : '0 2px 4px rgba(0, 0, 0, 0.08)',
});

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  style?: React.CSSProperties;
  disabled?: boolean;
  className?: string;
  isDarkMode?: boolean;
}

function Button({ children, onClick, variant = 'secondary', style, disabled, className, isDarkMode = false }: ButtonProps) {
  const buttonStyles = getButtonStyles(isDarkMode);
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
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = buttonStyles.hoverShadow;
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = buttonStyles.defaultShadow;
      }}
      className={className}
    >
      {children}
    </button>
  );
}

export function AnswerButtons() {
  const plugin = usePlugin();
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Dark mode detection
  useEffect(() => {
    const checkDarkMode = () => {
      const htmlHasDark = document.documentElement.classList.contains('dark');
      const bodyHasDark = document.body?.classList.contains('dark');

      let parentHasDark = false;
      try {
        if (window.parent && window.parent !== window) {
          parentHasDark = window.parent.document.documentElement.classList.contains('dark');
        }
      } catch (e) {}

      const backgroundColor = window.getComputedStyle(document.body).backgroundColor;
      let isDarkByColor = false;

      if (backgroundColor && backgroundColor.startsWith('rgb')) {
        const matches = backgroundColor.match(/\d+/g);
        if (matches && matches.length >= 3) {
          const [r, g, b] = matches.map(Number);
          isDarkByColor = (r + g + b) / 3 < 128;
        }
      }

      setIsDarkMode(Boolean(htmlHasDark || bodyHasDark || parentHasDark || isDarkByColor));
    };

    checkDarkMode();
    const interval = setInterval(checkDarkMode, 2000);
    return () => clearInterval(interval);
  }, []);

  // ✅ ALL HOOKS MUST BE CALLED UNCONDITIONALLY AT THE TOP

  // ✅ Track the values that determine effective mode
  const performanceModeSetting = useTrackerPlugin(
    (rp) => rp.settings.getSetting<string>('performanceMode'),
    []
  ) || DEFAULT_PERFORMANCE_MODE;

  const isMobile = useTrackerPlugin(
    async (rp) => await rp.storage.getSynced<boolean>(isMobileDeviceKey),
    []
  );

  const alwaysUseLightOnMobile = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(alwaysUseLightModeOnMobileId),
    []
  );

  // ✅ Calculate effective mode (synchronous!)
  const useLightMode = performanceModeSetting === PERFORMANCE_MODE_LIGHT || 
                       (isMobile && alwaysUseLightOnMobile !== false);
  
  // Consolidate core data into a single tracker
  const coreData = useTrackerPlugin(async (rp) => {
    const ctx = await rp.widget.getWidgetContext<WidgetLocation.FlashcardAnswerButtons>();
    if (!ctx?.remId) return null;

    const rem = await rp.rem.findOne(ctx.remId);
    if (!rem) return null;

    const incRemInfo = await getIncrementalRemFromRem(rp, rem);
    if (!incRemInfo) return null;

    // 🔌 Conditionally fetch sessionCache based on effective performanceMode
    const [allIncRems, sessionCache, shouldDisplayShield] = await Promise.all([
      rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
      (!useLightMode)
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
      useLightMode: useLightMode, // Pass the mode to the component
    };
  }, [useLightMode]); 

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
    if (useLightMode || !coreData?.shouldDisplayShield || !coreData?.sessionCache) return null;

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
        percentile: calculateRelativePercentile(allIncRems, topMissedInKb.remId),
      } : null,
      doc: topMissedInDoc ? {
        absolute: topMissedInDoc.priority,
        percentile: sessionCache.incRemDocPercentiles?.[topMissedInDoc.remId] ?? null,
      } : null,
    };
  }, [coreData?.shouldDisplayShield, coreData?.sessionCache, coreData?.allIncRems, coreData?.rem._id, useLightMode]);

  // ✅ MEMOIZE CALCULATIONS (but they must run every render, not conditionally)
  const percentiles = useMemo(() => {
    if (!coreData) return { kb: null, doc: null };
    
    const { allIncRems, incRemInfo, sessionCache } = coreData;
    const kbPercentile = calculateRelativePercentile(allIncRems, incRemInfo.remId);
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

    const queueMode = await plugin.storage.getSession<string>('current-queue-mode');
    // Map RemNote's mode to your enum
    const mappedMode = queueMode === 'practice-all' ? 'practice-all' 
      : queueMode === 'in-order' ? 'in-order' 
      : 'srs';

    await handleHextRepetitionClick(plugin, incRemInfo, mappedMode);
  };

  const priorityColor = percentiles.kb ? percentileToHslColor(percentiles.kb) : '#6b7280';
  const buttonStyles = getButtonStyles(isDarkMode);

  // Container styles with dark mode support
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '8px 12px 12px 12px',
    backgroundColor: isDarkMode ? '#1e293b' : 'transparent',
    borderRadius: '12px',
  };

  const buttonRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
  };

  const dividerStyle: React.CSSProperties = {
    width: '1px',
    height: '40px',
    backgroundColor: isDarkMode ? '#475569' : '#e2e8f0',
    margin: '0 6px',
  };

  const priorityBadgeStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 12px',
    borderRadius: '14px',
    fontSize: '12px',
    fontWeight: 600,
    color: 'white',
    backgroundColor: priorityColor,
    boxShadow: isDarkMode
      ? '0 2px 4px rgba(0,0,0,0.3)'
      : '0 2px 4px rgba(0,0,0,0.1)',
  };

  const infoBarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    padding: '8px 16px',
    backgroundColor: isDarkMode ? 'rgba(59, 130, 246, 0.15)' : 'rgba(59, 130, 246, 0.05)',
    borderRadius: '10px',
    fontSize: '12px',
    color: isDarkMode ? '#93c5fd' : '#1e40af',
    borderLeft: `4px solid ${priorityColor}`,
  };

  return (
    <div style={containerStyle} className="incremental-everything-answer-buttons">
      {/* Single row of buttons */}
      <div style={buttonRowStyle}>
        <Button variant="primary" onClick={handleNextClick} isDarkMode={isDarkMode}>
          <div style={buttonStyles.label}>Next</div>
          <div style={buttonStyles.sublabel}><NextRepTime rem={incRemInfo} /></div>
        </Button>

        <Button
          variant="secondary"
          isDarkMode={isDarkMode}
          onClick={async () => {
            await plugin.widget.openPopup('reschedule', { remId: ctx.remId });
          }}
        >
          <div style={buttonStyles.label}>Reschedule</div>
          <div style={buttonStyles.sublabel}>Set interval</div>
        </Button>

        <Button
          variant="danger"
          isDarkMode={isDarkMode}
          onClick={async () => {
                  // 1. AWAIT the *critical, fast* inheritance check (up to 3 levels deep)
                  await handleCardPriorityInheritance(plugin, rem, incRemInfo);

                  // 2. Proceed with the final, destructive Done button logic
                  await removeIncrementalRemCache(plugin, rem._id);
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
          isDarkMode={isDarkMode}
          onClick={async () => {
            await plugin.widget.openPopup('priority', { remId: ctx.remId });
          }}
        >
          <div style={buttonStyles.label}>Change Priority</div>
        </Button>

        <Button
          isDarkMode={isDarkMode}
          onClick={() => handleReviewAndOpenRem(plugin, rem, remType)}
        >
          <div style={buttonStyles.label}>Review & Open</div>
          <div style={buttonStyles.sublabel}>Go to Editor</div>
        </Button>

        <Button
          isDarkMode={isDarkMode}
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
              isDarkMode={isDarkMode}
              onClick={async () => {
                const highlightRem = await plugin.rem.findOne(activeHighlightId);
                await highlightRem?.scrollToReaderHighlight();
              }}
              style={{
                backgroundColor: isDarkMode ? '#d97706' : '#fbbf24',
                color: isDarkMode ? '#fef3c7' : '#78350f',
                border: isDarkMode ? '2px solid #f59e0b' : '2px solid #f59e0b',
                animation: 'highlightPulse 2s ease-in-out 3',
                fontWeight: 600,
              }}
            >
              <div style={buttonStyles.label}>Scroll to</div>
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
              isDarkMode={isDarkMode}
              style={{
                backgroundColor: isDarkMode ? '#334155' : '#f3f4f6',
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
                  {!useLightMode && percentiles.doc !== null && `, ${percentiles.doc}% Doc`})
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
          {!useLightMode && shouldDisplayShield && shieldStatusAsync && (
            <>
              <span style={{ color: isDarkMode ? '#64748b' : '#9ca3af' }}>|</span>
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
