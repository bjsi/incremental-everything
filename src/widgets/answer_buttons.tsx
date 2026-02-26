import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
  RNPlugin,
  PluginRem,
  BuiltInPowerupCodes,
} from '@remnote/plugin-sdk';
import React, { useMemo } from 'react';
import * as _ from 'remeda';
import dayjs from 'dayjs';
import { IncrementalRep } from '../lib/incremental_rem/types';
import { NextRepTime } from '../components/NextRepTime';
import { DraggableButton } from '../components/buttons/DraggableButton';
import { Button } from '../components/buttons/Button';
import { getButtonStyles } from '../components/buttons/styles';
import {
  allIncrementalRemKey,
  powerupCode,
  activeHighlightIdKey,
  currentIncrementalRemTypeKey,
  displayPriorityShieldId,
  seenRemInSessionKey,
  remnoteEnvironmentId,
  queueSessionCacheKey,
  priorityCalcScopeRemIdsKey,
  incremReviewStartTimeKey,
} from '../lib/consts';
import { getIncrementalRemFromRem, handleNextRepetitionClick, handleNextRepetitionManualOffset, updateReviewRemData } from '../lib/incremental_rem';
import { removeIncrementalRemCache } from '../lib/incremental_rem/cache';
import { IncrementalRem } from '../lib/incremental_rem';
import { percentileToHslColor, calculateRelativePercentile, calculateVolumeBasedPercentile, PERFORMANCE_MODE_LIGHT } from '../lib/utils';
import { safeRemTextToString, findPDFinRem, addPageToHistory, getCurrentPageKey, getDescendantsToDepth } from '../lib/pdfUtils';
import { QueueSessionCache, setCardPriority } from '../lib/card_priority';
import { shouldUseLightMode } from '../lib/mobileUtils';
import { getHtmlSourceUrl } from '../lib/incRemHelpers';
import { transferToDismissed } from '../lib/dismissed';
import { handleReviewAndOpenRem } from '../lib/review_actions';

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
  // console.log(`[Done Button] 🏁 Starting depth-limited (max ${MAX_DEPTH_CHECK} levels) check for Rem: ${rem._id}`);

  try {
    // 1. Check if the Rem already has a *set* cardPriority tag with a non-default source.
    const existingSource = await rem.getPowerupProperty('cardPriority', 'prioritySource');

    // If the Rem is tagged AND the source is 'manual' or 'inherited', we stop.
    // We proceed if the Rem is untagged (existingSource is null) or if the tag source is 'default'.
    if (existingSource && typeof existingSource === 'string' && existingSource.toLowerCase() !== 'default') {
      // console.log(`[Done Button] Rem already has manual/inherited priority tag. Skipping check. Total time: ${Date.now() - startTime}ms.`);
      return;
    }

    // 2. Check if we should use Light Mode for performance
    const useLightMode = await shouldUseLightMode(plugin);

    if (useLightMode) {
      // In Light Mode, skip expensive flashcard checking and add cardPriority directly
      await setCardPriority(plugin, rem, incRemInfo.priority, 'incremental');
      // console.log(`[Done Button] ⚡ Light Mode: Set card priority ${incRemInfo.priority} (source: incremental) without flashcard check. Total time: ${Date.now() - startTime}ms.`);
      return;
    }

    // 3. Full Mode: Check the Rem itself for flashcards (Depth 1)
    const remCards = await rem.getCards();
    if (remCards && remCards.length > 0) {
      // Rem has its own flashcards, set card priority
      await setCardPriority(plugin, rem, incRemInfo.priority, 'incremental');
      // console.log(`[Done Button] ✅ Set card priority ${incRemInfo.priority} (source: incremental) for Rem with direct flashcards. Total time: ${Date.now() - startTime}ms.`);
      return;
    }

    // 4. Full Mode: Check descendants up to MAX_DEPTH_CHECK (Children and Grandchildren)
    // Uses getDescendantsToDepth to avoid fetching the entire hierarchy upfront.
    const descendantsToCheck = await getDescendantsToDepth(rem, MAX_DEPTH_CHECK);

    if (descendantsToCheck.length === 0) {
      // console.log(`[Done Button] No descendants found within ${MAX_DEPTH_CHECK} levels. Total time: ${Date.now() - startTime}ms.`);
      return;
    }

    // console.log(`[Done Button] Checking ${descendantsToCheck.length} descendants up to level ${MAX_DEPTH_CHECK}...`);

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
        await setCardPriority(plugin, rem, incRemInfo.priority, 'incremental');
        // console.log(`[Done Button] ✅ Set card priority ${incRemInfo.priority} (source: incremental) for Rem with descendant flashcards. Found in batch starting at index ${i}. Total time: ${Date.now() - startTime}ms.`);
        return; // Early termination
      }
      // console.log(`[Done Button] Batch ${Math.floor(i / BATCH_SIZE) + 1} clear. Moving to next batch...`);
    }

    // No flashcards found in the Rem or its checked descendants
    // console.log(`[Done Button] No flashcards found in Rem or all checked descendants. Total time: ${Date.now() - startTime}ms.`);

  } catch (error) {
    // console.error(`[Done Button] ❌ Error in handleCardPriorityInheritance. Total time: ${Date.now() - startTime}ms.`, error);
  }
};


export function AnswerButtons() {
  const plugin = usePlugin();

  // Separate lightweight trackers for UI state
  const useLightMode = useTrackerPlugin(
    async (rp) => await shouldUseLightMode(rp),
    []
  ) || false;

  const allIncRems = useTrackerPlugin(
    (rp) => rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
    []
  ) || [];

  const shouldDisplayShield = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(displayPriorityShieldId),
    []
  ) ?? true;

  const activeHighlightId = useTrackerPlugin(
    (rp) => rp.storage.getSession<string | null>(activeHighlightIdKey),
    []
  );

  const remType = useTrackerPlugin(
    (rp) => rp.storage.getSession<string | null>(currentIncrementalRemTypeKey),
    []
  );

  const scopeRemIds = useTrackerPlugin(
    (rp) => rp.storage.getSession<string[] | null>(priorityCalcScopeRemIdsKey),
    []
  );

  const baseData = useTrackerPlugin(async (rp) => {
    const ctx = await rp.widget.getWidgetContext<WidgetLocation.FlashcardAnswerButtons>();
    if (!ctx?.remId) return null;

    const rem = await rp.rem.findOne(ctx.remId);
    if (!rem) return null;

    const incRemInfo = await getIncrementalRemFromRem(rp, rem);
    if (!incRemInfo) return null;

    return {
      ctx,
      rem,
      incRemInfo,
    };
  }, []);

  const sessionCacheData = useTrackerPlugin(async (rp) => {
    if (useLightMode || !baseData?.rem) {
      return null;
    }
    return await rp.storage.getSession<QueueSessionCache>(queueSessionCacheKey);
  }, [useLightMode, baseData?.rem?._id]);

  const coreData = baseData ? { ...baseData, sessionCache: sessionCacheData } : null;

  const shieldStatusAsync = useTrackerPlugin(async (rp) => {
    if (useLightMode || !shouldDisplayShield || !coreData?.sessionCache) return null;

    const seenRemIds = (await rp.storage.getSession<string[]>(seenRemInSessionKey)) || [];

    const { sessionCache, rem } = coreData;
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

    const kbPercentile = topMissedInKb ? calculateVolumeBasedPercentile(
      allIncRems,
      topMissedInKb.priority,
      (r) => !seenRemIds.includes(r.remId) || r.remId === rem._id
    ) : null;

    if (topMissedInKb) {
      // console.log(`[AnswerButtons] KB Shield: Priority ${topMissedInKb.priority}, Percentile ${kbPercentile}%, Universe ${allIncRems.length}`);
    }


    // DOC Shield Calculation
    let docPercentile: number | null = null;
    if (topMissedInDoc && scopeRemIds) {
      const scopeSet = new Set(scopeRemIds);
      const allIncRemsInScope = allIncRems.filter(r => scopeSet.has(r.remId));
      if (allIncRemsInScope.length > 0) {
        docPercentile = calculateVolumeBasedPercentile(
          allIncRemsInScope,
          topMissedInDoc.priority,
          (r) => !seenRemIds.includes(r.remId) || r.remId === rem._id
        );
        // console.log(`[AnswerButtons] Doc Shield: Priority ${topMissedInDoc.priority}, Percentile ${docPercentile}%, Universe ${allIncRemsInScope.length}`);
      }
    }

    return {
      kb: topMissedInKb ? {
        absolute: topMissedInKb.priority,
        percentile: kbPercentile ?? null,
      } : null,
      doc: topMissedInDoc ? {
        absolute: topMissedInDoc.priority,
        percentile: docPercentile,
      } : null,
    };
  }, [shouldDisplayShield, coreData?.sessionCache, allIncRems, coreData?.rem?._id, useLightMode]);

  const htmlSourceUrl = useTrackerPlugin(async (rp) => {
    // console.log('[htmlSourceUrl] rem:', baseData?.rem?._id, 'remType:', remType);
    if (!baseData?.rem) return null;
    const type = await rp.storage.getSession<string | null>(currentIncrementalRemTypeKey);
    // console.log('[htmlSourceUrl] type from session:', type);
    if (type !== 'html' && type !== 'html-highlight') return null;
    const url = await getHtmlSourceUrl(rp, baseData.rem, type);
    // console.log('[htmlSourceUrl] found URL:', url);
    return url;
  }, [baseData?.rem?._id, remType]);

  // ✅ MEMOIZE CALCULATIONS (but they must run every render, not conditionally)
  const percentiles = useMemo(() => {
    if (!coreData) return { kb: null, doc: null };

    const { incRemInfo, sessionCache } = coreData;
    const kbPercentile = calculateRelativePercentile(allIncRems, incRemInfo.remId);
    const docPercentile = sessionCache?.incRemDocPercentiles?.[incRemInfo.remId] ?? null;

    return { kb: kbPercentile, doc: docPercentile };
  }, [coreData, allIncRems]);

  // Calculate history stats for display (must be before early returns)
  const historyStats = useMemo(() => {
    if (!coreData?.incRemInfo?.history || coreData.incRemInfo.history.length === 0) {
      return { reps: 0, totalMinutes: 0 };
    }
    // Only count real repetitions (events that count for interval calculation)
    // Includes: undefined, 'rep', 'rescheduledInQueue', 'executeRepetition'
    // Excludes: 'madeIncremental', 'dismissed', 'rescheduledInEditor', 'manualDateReset'
    const realReps = coreData.incRemInfo.history.filter(
      h => h.eventType === undefined ||
        h.eventType === 'rep' ||
        h.eventType === 'rescheduledInQueue' ||
        h.eventType === 'executeRepetition'
    );
    const reps = realReps.length;
    const totalSeconds = realReps.reduce((total, rep) => total + (rep.reviewTimeSeconds || 0), 0);
    const totalMinutes = Math.round(totalSeconds / 6) / 10; // Round to 1 decimal
    return { reps, totalMinutes };
  }, [coreData?.incRemInfo?.history]);

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

  const { ctx, rem, incRemInfo, sessionCache } = coreData;

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

    await handleNextRepetitionClick(plugin, incRemInfo);
  };

  const runManualNext = async (mode: 'today' | 'tomorrow') => {
    const offset = mode === 'tomorrow' ? 1 : 0;
    await handleNextRepetitionManualOffset(plugin, incRemInfo, offset);
  };

  const priorityColor = percentiles.kb ? percentileToHslColor(percentiles.kb) : '#6b7280';
  const buttonStyles = getButtonStyles();

  // Container styles using RemNote CSS variables
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '8px 12px 12px 12px',
    backgroundColor: 'var(--rn-clr-background-primary)',
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
    backgroundColor: 'var(--rn-clr-border-primary)',
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
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  };

  const infoBarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    padding: '8px 16px',
    backgroundColor: 'var(--rn-clr-background-secondary)',
    borderRadius: '10px',
    fontSize: '12px',
    color: 'var(--rn-clr-content-secondary)',
    borderLeft: `4px solid ${priorityColor}`,
  };

  return (
    <div style={containerStyle} className="incremental-everything-answer-buttons">
      {/* Single row of buttons */}
      <div style={buttonRowStyle}>
        <DraggableButton
          variant="primary"
          onClick={handleNextClick}
          onDragUp={() => runManualNext('tomorrow')}
          onDragDown={() => runManualNext('today')}
          overlayUpText="Repeat tomorrow"
          overlayDownText="Repeat today"
          dragThreshold={12}
        >
          <div style={buttonStyles.label}>Next</div>
          <div style={buttonStyles.sublabel}><NextRepTime rem={incRemInfo} /></div>
        </DraggableButton>

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
            await handleCardPriorityInheritance(plugin, rem, incRemInfo);

            //Calculate review time and add current history entry
            const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
            const reviewTimeSeconds = startTime ? dayjs().diff(dayjs(startTime), 'second') : 0;

            const currentRep: IncrementalRep = {
              date: Date.now(),
              scheduled: incRemInfo.nextRepDate,
              reviewTimeSeconds: reviewTimeSeconds,
              eventType: 'rep',
              priority: incRemInfo.priority,
            };

            const updatedHistory = [...(incRemInfo.history || []), currentRep];

            // Save updated history to dismissed powerup BEFORE removing incremental
            await transferToDismissed(plugin, rem, updatedHistory);

            // Remove from session cache
            await removeIncrementalRemCache(plugin, rem._id);

            // removePowerup causes the widget to unmount, killing the async chain.
            // The tracker polling loop (every 500ms) will detect the powerup is gone
            // and call removeCurrentCardFromQueue — so we must NOT call it here too,
            // otherwise the double-call races and skips the next card.
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
                backgroundColor: 'var(--rn-clr-yellow, #fbbf24)',
                color: 'var(--rn-clr-content-primary)',
                border: '2px solid var(--rn-clr-yellow, #f59e0b)',
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

        {/* Open URL for Clipper - Only for HTML type rems */}
        {(remType === 'html' || remType === 'html-highlight') && htmlSourceUrl && (
          <>
            <div style={dividerStyle} />
            <Button
              onClick={async () => {
                try {
                  // Open the URL in a new tab
                  const newWindow = window.open(htmlSourceUrl, '_blank');

                  // Fallback if popup was blocked
                  if (!newWindow || newWindow.closed) {
                    const link = document.createElement('a');
                    link.href = htmlSourceUrl;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    document.body.appendChild(link);
                    link.click();
                    setTimeout(() => document.body.removeChild(link), 100);
                  }

                  // Show a helpful toast
                  await plugin.app.toast('📎 URL opened! Use RemNote Clipper in the browser to take notes.');
                } catch (error) {
                  console.error('Error opening URL:', error);
                  await plugin.app.toast('Error opening URL');
                }
              }}
              className="clipper-button"
              style={{
                backgroundColor: 'var(--rn-clr-blue-light, #dbeafe)',
                color: 'var(--rn-clr-blue-dark, #1e40af)',
                border: '2px solid var(--rn-clr-blue, #3b82f6)',
                animation: 'clipperPulse 2.5s ease-in-out infinite',
                fontWeight: 600,
                minWidth: '110px',
              }}
            >
              <div style={{ ...buttonStyles.label, display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span>📎</span>
                <span>Open URL</span>
              </div>
              <div style={buttonStyles.sublabel}>Use Clipper</div>
            </Button>
            <style>{`
              @keyframes clipperPulse {
                0%, 100% {
                  transform: translateY(0) scale(1);
                  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
                }
                50% {
                  transform: translateY(-2px) scale(1.02);
                  box-shadow: 0 6px 16px rgba(59, 130, 246, 0.5);
                }
              }
              @keyframes clipperShine {
                0% {
                  background-position: -200% center;
                }
                100% {
                  background-position: 200% center;
                }
              }
              .clipper-button {
                position: relative;
                overflow: hidden;
              }
              .clipper-button::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(
                  90deg,
                  transparent 0%,
                  rgba(255, 255, 255, 0.2) 50%,
                  transparent 100%
                );
                background-size: 200% 100%;
                animation: clipperShine 3s ease-in-out infinite;
                pointer-events: none;
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
                backgroundColor: 'var(--rn-clr-background-tertiary)',
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
          {/* Left side: Priority and Shield */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {/* Priority Display */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600 }}>Priority:</span>
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
                <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>|</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontWeight: 600 }}>🛡️ IncRem Shield:</span>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    {shieldStatusAsync.kb ? (
                      <span>
                        KB: <strong>{shieldStatusAsync.kb.absolute}</strong> ({shieldStatusAsync.kb.percentile?.toFixed(1)}%)
                      </span>
                    ) : (
                      <span>KB: 100%</span>
                    )}
                    {shieldStatusAsync.doc ? (
                      <span>
                        Doc: <strong>{shieldStatusAsync.doc.absolute}</strong> ({shieldStatusAsync.doc.percentile?.toFixed(1)}%)
                      </span>
                    ) : (
                      sessionCache?.dueIncRemsInScope && <span>Doc: 100%</span>
                    )}
                  </div>
                </div>
              </>
            )}
            {/* Separator before History */}
            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>|</span>

            {/* Repetition History Stats and Icon */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>
                <strong>{historyStats.reps}</strong> Reps, <strong>{historyStats.totalMinutes}</strong> min
              </span>
              <span
                role="button"
                style={{
                  cursor: 'pointer',
                  fontSize: '16px',
                  opacity: 0.7,
                  padding: '4px',
                  borderRadius: '6px',
                  transition: 'opacity 0.2s, background-color 0.2s',
                }}
                onClick={() => plugin.widget.openPopup('repetition_history', { remId: ctx.remId })}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '1';
                  e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '0.7';
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                title="Repetition History"
              >
                📊
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

renderWidget(AnswerButtons);
