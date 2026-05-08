import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
  RNPlugin,
  PluginRem,
  BuiltInPowerupCodes,
} from '@remnote/plugin-sdk';
import React, { useMemo, useRef, useState, useLayoutEffect } from 'react';
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
  displayWeightedShieldId,
  seenRemInSessionKey,
  remnoteEnvironmentId,
  queueSessionCacheKey,
  priorityCalcScopeRemIdsKey,
  incremReviewStartTimeKey,
} from '../lib/consts';
import { getIncrementalRemFromRem, handleNextRepetitionClick, handleNextRepetitionManualOffset, updateReviewRemData } from '../lib/incremental_rem';
import { removeIncrementalRemCache } from '../lib/incremental_rem/cache';
import { IncrementalRem } from '../lib/incremental_rem';
import { percentileToHslColor, calculateRelativePercentile, calculateVolumeBasedPercentile, calculateWeightedShield, PERFORMANCE_MODE_LIGHT } from '../lib/utils';
import { safeRemTextToString, findPDFinRem, findHTMLinRem, addPageToHistory, getPageHistory, getCurrentPageKey, getDescendantsToDepth } from '../lib/pdfUtils';
import { QueueSessionCache, setCardPriority } from '../lib/card_priority';
import { WeightedShieldTooltip } from '../components';
import { shouldUseLightMode } from '../lib/mobileUtils';
import { getHtmlSourceUrl } from '../lib/incRemHelpers';
import { transferToDismissed } from '../lib/dismissed';
import { handleReviewInEditorRem } from '../lib/review_actions';

import { handleCardPriorityInheritance } from '../lib/card_priority/card_priority_inheritance';

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

  const shouldDisplayWeightedShield = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(displayWeightedShieldId),
    []
  ) ?? false;

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

    // Weighted Shield Calculation
    let weightedKB: number | null = null;
    let weightedDoc: number | null = null;
    let docIncRems: IncrementalRem[] | null = null;

    if (shouldDisplayWeightedShield && allIncRems.length > 0) {
      weightedKB = calculateWeightedShield(
        allIncRems,
        (r) => Date.now() >= r.nextRepDate && (!seenRemIds.includes(r.remId) || r.remId === rem._id)
      );

      if (scopeRemIds) {
        const scopeSet2 = new Set(scopeRemIds);
        docIncRems = allIncRems.filter(r => scopeSet2.has(r.remId));
        if (docIncRems.length > 0) {
          weightedDoc = calculateWeightedShield(
            docIncRems,
            (r) => Date.now() >= r.nextRepDate && (!seenRemIds.includes(r.remId) || r.remId === rem._id)
          );
        }
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
      weightedKB,
      weightedDoc,
      docIncRems,
      seenRemIds,
    };
  }, [shouldDisplayShield, shouldDisplayWeightedShield, coreData?.sessionCache, allIncRems, coreData?.rem?._id, useLightMode, scopeRemIds]);

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

  // Fetch the most recent bookmark highlightId for this IncRem (pdf or html doc reps).
  // Skipped for highlight reps — those auto-scroll to the highlight itself, no
  // separate bookmark concept applies.
  const bookmarkHighlightId = useTrackerPlugin(async (rp) => {
    if (!baseData?.rem) return null;
    const type = await rp.storage.getSession<string | null>(currentIncrementalRemTypeKey);
    if (type !== 'pdf' && type !== 'html') return null;

    const hostRem = type === 'pdf'
      ? await findPDFinRem(rp, baseData.rem)
      : await findHTMLinRem(rp, baseData.rem);
    if (!hostRem) return null;

    const history = await getPageHistory(rp, baseData.rem._id, hostRem._id);
    // Only use the highlight if the LAST entry carries a highlightId.
    // If a manual position was recorded after the highlight bookmark, the button
    // would scroll to a stale position, so we suppress it in that case.
    const lastEntry = history[history.length - 1];
    return lastEntry?.highlightId ?? null;
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

  // Detect whether the stats separator `|` has flex-wrapped to a new line.
  // CSS cannot observe line-breaks in a flex-wrap container, so we compare the
  // vertical position of the separator span against the stats div with a layout effect.
  // The `|` stays in the DOM (opacity: 0 when hidden) so it's always measurable.
  const statsSepRef = useRef<HTMLSpanElement>(null);
  const statsContainerRef = useRef<HTMLDivElement>(null);
  const [statsSepVisible, setStatsSepVisible] = useState(true);

  useLayoutEffect(() => {
    const sep = statsSepRef.current;
    const stats = statsContainerRef.current;
    if (!sep || !stats) return;
    // Compare vertical midpoints rather than top edges: in a centered flex row,
    // elements of different heights have different tops even when on the same row.
    const sepRect = sep.getBoundingClientRect();
    const statsRect = stats.getBoundingClientRect();
    const sepMid = sepRect.top + sepRect.height / 2;
    const statsMid = statsRect.top + statsRect.height / 2;
    const sameRow = Math.abs(sepMid - statsMid) < 4;
    setStatsSepVisible(sameRow);
  }); // No deps — runs after every render so it catches the first render where refs are populated

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

  // --- NEW: Check if current IncRem is directly impacting the shield ---
  const isKbShieldActive = shieldStatusAsync?.kb && incRemInfo.priority === shieldStatusAsync.kb.absolute;
  const isDocShieldActive = shieldStatusAsync?.doc && incRemInfo.priority === shieldStatusAsync.doc.absolute;
  const isAnyShieldActive = isKbShieldActive || isDocShieldActive;

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
    flexWrap: 'wrap',
    gap: '16px',
    padding: '8px 16px',
    backgroundColor: 'var(--rn-clr-background-secondary)',
    borderRadius: '10px',
    fontSize: '12px',
    color: 'var(--rn-clr-content-secondary)',
    borderLeft: `4px solid ${priorityColor}`,
  };

  return (
    <div
      style={containerStyle}
      className="incremental-everything-answer-buttons"
      onMouseDown={(e) => {
        // Prevent the plugin iframe from capturing keyboard focus on non-interactive areas.
        // Without this, clicking the answer buttons area steals focus from RemNote's
        // parent window, blocking native queue shortcuts like "P" (previewer) and "G" (Go to Rem).
        if (!(e.target as HTMLElement).closest('button, [role="button"], a, input, select, textarea')) {
          e.preventDefault();
        }
      }}
      onClick={() => {
        // After any click, return focus to the parent window so native
        // RemNote shortcuts work immediately.
        try {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          window.parent?.focus();
        } catch (_) { /* cross-origin safe */ }
      }}
    >
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
          title="Next (Cmd+Right on Mac; Ctrl+Right on Windows/Linux): Mark as reviewed, calculate next interval, and advance to next item"
        >
          <div style={buttonStyles.label}>Next</div>
          <div style={buttonStyles.sublabel}><NextRepTime rem={incRemInfo} /></div>
        </DraggableButton>

        <Button
          variant="secondary"
          onClick={async () => {
            await plugin.widget.openPopup('reschedule', { remId: ctx.remId });
          }}
          title="Reschedule (Ctrl+J): Manually set custom interval and adjust priority"
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

            // CRITICAL: Both removePowerup and removeCurrentCardFromQueue must be
            // fired simultaneously. removePowerup destroys the widget sandbox
            // shortly after resolving, so any subsequent await never completes.
            // By initiating both calls at once, both IPC messages reach RemNote
            // before either can trigger sandbox destruction.
            console.log('[Dismiss] Firing removePowerup + removeCurrentCardFromQueue simultaneously for rem:', rem._id);
            await Promise.allSettled([
              rem.removePowerup(powerupCode),
              plugin.queue.removeCurrentCardFromQueue(true),
            ]);
            console.log('[Dismiss] Both operations settled');
          }}
          title="Dismiss (Ctrl+D): Permanently finish item by removing its Incremental power-up"
        >
          <div style={buttonStyles.label}>Dismiss</div>
        </Button>

        {/* Divider */}
        <div style={dividerStyle} />

        {/* Secondary Actions Group */}
        <Button
          onClick={async () => {
            await plugin.widget.openPopup('priority', { remId: ctx.remId });
          }}
          title="Change Priority (Ctrl+P / Ctrl+Alt+P): Adjust item's priority on the fly"
        >
          <div style={buttonStyles.label}>Change</div>
          <div style={buttonStyles.label}>Priority</div>
        </Button>

        <Button
          onClick={() => handleReviewInEditorRem(plugin, rem, remType)}
          title="Review in Editor (Ctrl+Shift+J): Reschedule item, open in editor, and start Editor Review Timer"
        >
          <div style={buttonStyles.label}>Review</div>
          <div style={buttonStyles.label}>in Editor</div>
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
          title="Open Editor in New Tab: Instantly open the full source document in a new browser tab"
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
              title="Scroll to Highlight: Instantly snap view back to highlight's position"
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

        {/* Scroll to Bookmark: visible for both pdf and pdf-highlight types */}
        {bookmarkHighlightId && (
          <>
            <div style={dividerStyle} />
            <Button
              onClick={async () => {
                const bookmarkRem = await plugin.rem.findOne(bookmarkHighlightId);
                await bookmarkRem?.scrollToReaderHighlight();
              }}
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                color: 'var(--rn-clr-blue, #3b82f6)',
                border: '2px solid var(--rn-clr-blue, #3b82f6)',
                fontWeight: 600,
              }}
              title="Scroll to Bookmark: Jump to your last saved reading position in the document"
            >
              <div style={buttonStyles.label}>🔖 Scroll</div>
              <div style={buttonStyles.sublabel}>to Bookmark</div>
            </Button>
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
              title="Open URL for Web Clipper 📎: Open original URL in a new tab"
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

        {/* Desktop-only hint — compact informational badge */}
        {['rem', 'pdf', 'pdf-highlight'].includes(remType || '') && (
          <>
            <div style={dividerStyle} />
            <div
              className="desktop-only-hint"
              title="Press 'P' to open the Rem in RemNote's pop-up previewer for quick edits"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '4px 10px',
                borderRadius: '20px',
                border: '1px dashed var(--rn-clr-border-primary)',
                backgroundColor: 'transparent',
                cursor: 'default',
                pointerEvents: 'none',
                userSelect: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '20px',
                height: '20px',
                borderRadius: '4px',
                backgroundColor: 'var(--rn-clr-background-tertiary)',
                border: '1px solid var(--rn-clr-border-primary)',
                boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
                fontSize: '11px',
                fontWeight: 700,
                color: 'var(--rn-clr-content-primary)',
                fontFamily: 'monospace',
                animation: 'keyHintPulse 2.5s ease-in-out infinite',
              }}>P</span>
              <span style={{
                fontSize: '10.5px',
                fontWeight: 500,
                color: 'var(--rn-clr-content-tertiary)',
                letterSpacing: '0.2px',
              }}>Edit</span>
            </div>
            <style>{`
              @keyframes keyHintPulse {
                0%, 100% { opacity: 0.7; transform: scale(1); }
                50% { opacity: 1; transform: scale(1.08); }
              }
            `}</style>
          </>
        )}

        <div style={dividerStyle} />
        <span
          role="button"
          style={{
            cursor: 'pointer',
            fontSize: '18px',
            opacity: 0.7,
            padding: '4px',
            borderRadius: '6px',
            transition: 'opacity 0.2s, background-color 0.2s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={() => window.open('https://github.com/bjsi/incremental-everything/wiki/Reviewing-Items-in-the-Queue', '_blank')}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '1';
            e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '0.7';
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
          title="Help: Guide to Answer Buttons"
        >
          ℹ️
        </span>
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
                  <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{
                      display: 'inline-block',
                      animation: isAnyShieldActive ? 'shieldPulse 2s ease-in-out infinite' : 'none'
                    }}>🛡️</span>
                    <span>IncRem Shield:</span>
                  </span>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    {shieldStatusAsync.kb ? (
                      <span style={{
                        animation: isKbShieldActive ? 'shieldTextGlow 2s ease-in-out infinite' : 'none',
                        color: isKbShieldActive ? 'var(--rn-clr-blue)' : 'inherit'
                      }}>
                        KB: <strong>{shieldStatusAsync.kb.absolute}</strong> ({shieldStatusAsync.kb.percentile?.toFixed(1)}%)
                      </span>
                    ) : (
                      <span>KB: 100%</span>
                    )}
                    {shieldStatusAsync.doc ? (
                      <span style={{
                        animation: isDocShieldActive ? 'shieldTextGlow 2s ease-in-out infinite' : 'none',
                        color: isDocShieldActive ? 'var(--rn-clr-blue)' : 'inherit'
                      }}>
                        Doc: <strong>{shieldStatusAsync.doc.absolute}</strong> ({shieldStatusAsync.doc.percentile?.toFixed(1)}%)
                      </span>
                    ) : (
                      sessionCache?.dueIncRemsInScope && <span>Doc: 100%</span>
                    )}
                  </div>
                </div>
                <style>{`
                  @keyframes shieldPulse {
                    0%, 100% { transform: scale(1); filter: drop-shadow(0 0 0px rgba(59, 130, 246, 0)); }
                    50% { transform: scale(1.15); filter: drop-shadow(0 0 4px rgba(59, 130, 246, 0.6)); }
                  }
                  @keyframes shieldTextGlow {
                    0%, 100% { filter: brightness(1); }
                    50% { filter: brightness(1.3); text-shadow: 0 0 4px rgba(59, 130, 246, 0.3); }
                  }
                `}</style>
              </>
            )}
          </div>

          {/* Separator before Weighted/Reps — hidden when it has wrapped to a new line */}
          <span
            ref={statsSepRef}
            style={{
              color: 'var(--rn-clr-content-tertiary)',
              opacity: statsSepVisible ? 1 : 0,
              pointerEvents: 'none',
            }}
          >|</span>

          {/* Right side: Weighted Shield + Reps — wraps together as a unit */}
          <div ref={statsContainerRef} style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {/* Weighted Shield Display */}
            {!useLightMode && shouldDisplayWeightedShield && shieldStatusAsync &&
              shieldStatusAsync.weightedKB !== null && shieldStatusAsync.weightedKB !== undefined && (
                <>
                  <WeightedShieldTooltip
                    kbValue={shieldStatusAsync.weightedKB}
                    docValue={shieldStatusAsync.weightedDoc}
                    allItems={allIncRems}
                    isDuePredicate={(r: any) => Date.now() >= r.nextRepDate && (!(shieldStatusAsync.seenRemIds || []).includes(r.remId) || r.remId === coreData?.rem?._id)}
                    docItems={shieldStatusAsync.docIncRems}
                    itemLabel="IncRem"
                  />
                  <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>|</span>
                </>
              )
            }

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
