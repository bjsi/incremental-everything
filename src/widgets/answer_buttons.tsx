import { recordCompanionHandoff } from '../lib/companion/handoff';
import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
  RNPlugin,
  PluginRem,
  BuiltInPowerupCodes,
} from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useMemo, useRef, useState, useLayoutEffect, useEffect } from 'react';
import { repCountsForScheduling } from '../lib/incremental_rem/types';
import { NextRepTime } from '../components/NextRepTime';
import { DraggableButton } from '../components/buttons/DraggableButton';
import { Button } from '../components/buttons/Button';
import { getButtonStyles } from '../components/buttons/styles';
import { RescheduleIcon, DismissIcon, PriorityIcon, ReviewInEditorIcon, NewTabIcon, LocateIcon, BookmarkIcon, NoteIcon, HelpIcon, HistoryIcon, LinkIcon } from '../components/buttons/ActionIcons';
import {
  allIncrementalRemKey,
  activeHighlightIdKey,
  currentIncrementalRemTypeKey,
  displayPriorityShieldId,
  displayWeightedShieldId,
  seenRemInSessionKey,
  remnoteEnvironmentId,
  queueSessionCacheKey,
  priorityCalcScopeRemIdsKey,
  seenCardInSessionKey,
  allCardPriorityInfoKey,
  cardPriorityCacheRefreshKey,
  coolingCacheKey,
} from '../lib/consts';
import { computeLiveShields } from '../lib/live_shield';
import { CoolingCache, shieldExclusionIds } from '../lib/priority_review_document/cooling_store';
import { PriorityShieldValue } from '../components/PriorityShieldValue';
import { ShieldIcon } from '../components/ShieldIcon';
import { priorityColor as colorForPriority, usePriorityColorScale } from '../components/priorityColor';
import { buildUnifiedRanking, unifiedPercentileAt, unifiedRankingFor } from '../lib/unified_percentile';
import { getIncrementalRemFromRem, requestQueueDashboardRefocus } from '../lib/incremental_rem';
import {
  queueNextRepetition,
  queueManualOffset,
  captureQueueReviewSeconds,
  enqueueReviewJob,
  newReviewJobId,
} from '../lib/incremental_rem/review_jobs';
import { openRemInBrowserTab } from '../lib/remHelpers';
import { IncrementalRem } from '../lib/incremental_rem';
import { calculateRelativePercentile, PERFORMANCE_MODE_LIGHT } from '../lib/utils';
import { safeRemTextToString, getActivePdfForIncRem, findHTMLinRem, getPageHistory, getDescendantsToDepth } from '../lib/pdfUtils';
import { getRemReadPoint } from '../lib/remReadPoint';
import { resolveRemTextForBreadcrumb } from '../lib/richTextRemRefs';
import { CardPriorityInfo, QueueSessionCache, setCardPriority } from '../lib/card_priority';
import { WeightedShieldTooltip } from '../components';
import { shouldUseLightMode } from '../lib/mobileUtils';
import { getHtmlSourceUrl } from '../lib/incRemHelpers';
import { setPendingReviewNote, getPendingReviewNote, MAX_NOTE_LENGTH } from '../lib/history_notes';
import { handleReviewInEditorRem } from '../lib/review_actions';

import { getIESetting, useIESetting } from '../lib/settings';

/** Below this width the bar takes its compact form. A phone in portrait is 320 to 430. */
const NARROW_BAR_PX = 520;

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

  const shouldDisplayShield = useIESetting(displayPriorityShieldId);
  const shouldDisplayWeightedShield = useIESetting(displayWeightedShieldId);

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

  // --- Priority Shield (IncRems + cards) and its IncRem side ---
  // Raw inputs come from trackers; the shield itself is a memo over them, so
  // the 8 MB card cache is read only when it changes, not on every re-run.
  const shieldInputsWanted = !useLightMode && !!shouldDisplayShield && !!coreData?.sessionCache;
  const seenRemIdsList = useTrackerPlugin(
    (rp) => rp.storage.getSession<string[]>(seenRemInSessionKey),
    []
  );
  const seenCardIdsList = useTrackerPlugin(
    (rp) => rp.storage.getSession<string[]>(seenCardInSessionKey),
    []
  );
  const cardCacheRefresh = useTrackerPlugin(
    (rp) => rp.storage.getSession(cardPriorityCacheRefreshKey),
    []
  );
  const allCardInfos = useTrackerPlugin(
    async (rp) => {
      if (!shieldInputsWanted) return null;
      return (await rp.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) ?? [];
    },
    [shieldInputsWanted, cardCacheRefresh]
  );
  const coolingCache = useTrackerPlugin(
    (rp) => rp.storage.getSession<CoolingCache>(coolingCacheKey),
    []
  );

  const shieldStatusAsync = useMemo(() => {
    if (!shieldInputsWanted || !coreData?.sessionCache || !allCardInfos) return null;
    const { sessionCache, rem } = coreData;
    const seenRemIds = seenRemIdsList ?? [];
    const scopeSet = scopeRemIds ? new Set(scopeRemIds) : null;

    const live = computeLiveShields({
      allIncRems,
      dueIncRemsKb: sessionCache.dueIncRemsInKB ?? [],
      dueIncRemsDoc: sessionCache.dueIncRemsInScope ?? [],
      seenRemIds: new Set(seenRemIds),
      allCardInfos,
      overdueCardsKb: sessionCache.overdueCardsInKB ?? [],
      overdueCardsDoc: sessionCache.overdueCardsInScope ?? [],
      seenCardRemIds: new Set(seenCardIdsList ?? []),
      coolingRemIds: shieldExclusionIds(coolingCache),
      scopeRemIds: scopeSet,
      currentIncRemId: rem._id,
      computeWeighted: !!shouldDisplayWeightedShield,
    });

    // The IncRem-only universe, for the Weighted Shield popup's selection odds.
    const docIncRems = scopeSet ? allIncRems.filter((r) => scopeSet.has(r.remId)) : null;

    return {
      unifiedKb: live.kb.unified,
      unifiedDoc: live.doc?.unified ?? null,
      incRemKb: live.kb.incRem,
      incRemDoc: live.doc ? live.doc.incRem : null,
      hasDoc: !!live.doc,
      weightedKB: live.kb.unified?.weightedShield ?? null,
      weightedDoc: live.doc?.unified?.weightedShield ?? null,
      jointKb: live.jointKb,
      jointDoc: live.jointDoc && live.jointDoc.length > 0 ? live.jointDoc : null,
      docIncRems,
      seenRemIds,
    };
  }, [shieldInputsWanted, coreData?.sessionCache, coreData?.rem?._id, allIncRems, allCardInfos, seenRemIdsList, seenCardIdsList, coolingCache, scopeRemIds, shouldDisplayWeightedShield]);

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
      ? await getActivePdfForIncRem(rp, baseData.rem)
      : await findHTMLinRem(rp, baseData.rem);
    if (!hostRem) return null;

    const history = await getPageHistory(rp, baseData.rem._id, hostRem._id);
    // Only use the highlight if the LAST entry carries a highlightId.
    // If a manual position was recorded after the highlight bookmark, the button
    // would scroll to a stale position, so we suppress it in that case.
    const lastEntry = history[history.length - 1];
    return lastEntry?.highlightId ?? null;
  }, [baseData?.rem?._id, remType]);

  // Read point on the IncRem's OWN outline (a bookmarked descendant rem). Only
  // surfaced for hybrid cards reviewed as a PDF/HTML source — pure rem-type cards
  // already show the read point in the ExtractViewer body. The in-queue reader
  // can't navigate to a descendant without leaving the queue, so this is an
  // informational chip that points the user to "Review in Editor" instead of
  // navigating. Also flags whether the read point is the most recent reading
  // action (vs the PDF/HTML bookmark).
  const remReadPointInfo = useTrackerPlugin(async (rp) => {
    if (!baseData?.rem) return null;
    const type = await rp.storage.getSession<string | null>(currentIncrementalRemTypeKey);
    if (type !== 'pdf' && type !== 'html') return null;

    const entry = await getRemReadPoint(rp, baseData.rem._id);
    if (!entry?.highlightId) return null;

    const targetRem = await rp.rem.findOne(entry.highlightId);
    if (!targetRem) return null;
    const text = await resolveRemTextForBreadcrumb(rp, targetRem.text || []);

    const hostRem = type === 'pdf'
      ? await getActivePdfForIncRem(rp, baseData.rem)
      : await findHTMLinRem(rp, baseData.rem);
    let readerTs = 0;
    if (hostRem) {
      const hist = await getPageHistory(rp, baseData.rem._id, hostRem._id);
      readerTs = hist[hist.length - 1]?.timestamp ?? 0;
    }
    return {
      targetRemId: entry.highlightId,
      text,
      isLatest: (entry.timestamp ?? 0) > readerTs,
    };
  }, [baseData?.rem?._id, remType]);


  // ✅ MEMOIZE CALCULATIONS (but they must run every render, not conditionally)
  // The written "% KB / % Doc" follow the shield on screen: with the Priority
  // Shield (IncRems + cards) they are on its unified scale, so the IncRem's rank
  // and the shield's compare directly; with no shield, IncRems only.
  const unifiedRankings = useMemo(() => {
    if (!allCardInfos || allIncRems.length + allCardInfos.length === 0) return null;
    const kb = unifiedRankingFor(allIncRems, allCardInfos);
    if (!scopeRemIds) return { kb, doc: null };
    const scope = new Set(scopeRemIds);
    const doc = buildUnifiedRanking(
      allIncRems.filter((r) => scope.has(r.remId)),
      allCardInfos.filter((c) => scope.has(c.remId))
    );
    return { kb, doc: doc.total > 0 ? doc : null };
  }, [allIncRems, allCardInfos, scopeRemIds]);

  const percentiles = useMemo(() => {
    if (!coreData) return { kb: null, doc: null, unified: false };

    const { incRemInfo, sessionCache } = coreData;
    if (unifiedRankings) {
      return {
        kb: unifiedPercentileAt(unifiedRankings.kb, incRemInfo.priority),
        doc: unifiedRankings.doc ? unifiedPercentileAt(unifiedRankings.doc, incRemInfo.priority) : null,
        unified: true,
      };
    }
    const kbPercentile = calculateRelativePercentile(allIncRems, incRemInfo.remId);
    const docPercentile = sessionCache?.incRemDocPercentiles?.[incRemInfo.remId] ?? null;

    return { kb: kbPercentile, doc: docPercentile, unified: false };
  }, [coreData, allIncRems, unifiedRankings]);

  const colorScale = usePriorityColorScale();

  // Calculate history stats for display (must be before early returns)
  const historyStats = useMemo(() => {
    if (!coreData?.incRemInfo?.history || coreData.incRemInfo.history.length === 0) {
      return { reps: 0, totalMinutes: 0 };
    }
    // Only count real repetitions (events that count for interval calculation).
    // Uses the shared scheduling predicate — excludes markers, slot edits, and
    // 'importedRep' (imported flashcard reviews never belong to a rem's schedule).
    const realReps = coreData.incRemInfo.history.filter(h => repCountsForScheduling(h.eventType));
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

  // Review note (📝): parked per-rem in session storage on every keystroke and
  // attached to the history entry written by whichever action ends this review
  // (Next / Reschedule / Dismiss) — see stampNoteAndContext in lib/history_notes.
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const currentRemId = baseData?.rem?._id;
  useEffect(() => {
    // New card: reset the input, then prefill from a previously parked note
    // (e.g. typed earlier this session but not yet consumed).
    setNoteOpen(false);
    setNoteText('');
    if (!currentRemId) return;
    getPendingReviewNote(plugin, currentRemId).then((parked) => {
      if (parked) {
        setNoteText(parked);
        setNoteOpen(true);
      }
    });
  }, [currentRemId]);

  // A phone, or any pane this narrow: the bar shrinks to one row of icon buttons
  // and one line of figures (about a third of the full bar's height). Decided by
  // the frame's own width, which is the queue's, so a narrow desktop pane gets it too.
  const [barWidth, setBarWidth] = useState(() => window.innerWidth);
  const narrow = barWidth > 0 && barWidth < NARROW_BAR_PX;
  // On the smallest phones the scheduler's chip gives its place to the interval.
  const tight = barWidth > 0 && barWidth < 360;
  useEffect(() => {
    const onResize = () => setBarWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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

  // Next and the Today/Tomorrow drag hand their writes to the tracker
  // (lib/incremental_rem/review_jobs.ts) and advance the queue at once.
  const handleNextClick = async () => {
    await queueNextRepetition(plugin, rem._id, { syncPdfPage: remType === 'pdf' });
  };

  const runManualNext = async (mode: 'today' | 'tomorrow') => {
    await queueManualOffset(plugin, rem._id, mode === 'tomorrow' ? 1 : 0);
  };

  // The colour is the priority's, on the plugin-wide colour map.
  const priorityColor = colorScale || percentiles.kb
    ? colorForPriority(colorScale, incRemInfo.priority, percentiles.kb)
    : '#6b7280';
  const buttonStyles = getButtonStyles();

  // When both a reader bookmark and an outline read point exist, the reader
  // bookmark is the "latest" only when the read point isn't (mirrors the editor
  // timer's marker). With no read point there's nothing to compare, so no badge.
  const readerBookmarkIsLatest = !!remReadPointInfo && !remReadPointInfo.isLatest;

  // --- NEW: Check if current IncRem is directly impacting the shield ---
  // Pulses when this IncRem is the element setting the Priority Shield.
  const isKbShieldActive = shieldStatusAsync?.unifiedKb?.absolute != null && incRemInfo.priority === shieldStatusAsync.unifiedKb.absolute;
  const isDocShieldActive = shieldStatusAsync?.unifiedDoc?.absolute != null && incRemInfo.priority === shieldStatusAsync.unifiedDoc.absolute;
  const isAnyShieldActive = isKbShieldActive || isDocShieldActive;

  // Container styles using RemNote CSS variables
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: narrow ? '5px' : '6px',
    padding: narrow ? '4px 6px 6px' : '6px 12px 10px',
    backgroundColor: 'var(--rn-clr-background-primary)',
    borderRadius: '12px',
  };

  const buttonRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: narrow ? '4px' : '6px',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
  };

  const dividerStyle: React.CSSProperties = {
    width: '1px',
    height: '26px',
    backgroundColor: 'var(--rn-clr-border-primary)',
    margin: '0 4px',
  };
  // The groups are told apart by a rule on a wide bar, and by nothing on a narrow one.
  const divider = narrow ? null : <div style={dividerStyle} />;

  // Icon + one-word label stacked: the secondary actions stay narrow so the
  // button row fits on one line beside the conditional buttons. On a narrow bar
  // they are squares with the icon alone; the label stays in the tooltip.
  const compactButtonStyle: React.CSSProperties = narrow
    ? { minWidth: '36px', width: '36px', height: '36px', padding: 0, gap: 0 }
    : { minWidth: '56px', padding: '5px 8px', gap: '3px' };
  const iconSize = narrow ? 18 : 15;
  const label = (text: string, strong = false) =>
    narrow ? null : <div style={{ ...compactLabelStyle, fontWeight: strong ? 600 : 500 }}>{text}</div>;

  // The quiet controls at the end of the row: note, help.
  const quietButtonStyle = (active: boolean): React.CSSProperties => ({
    cursor: 'pointer',
    width: narrow ? '36px' : '30px',
    height: narrow ? '36px' : '30px',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    color: active ? 'var(--rn-clr-content-accent, #3b82f6)' : 'var(--rn-clr-content-tertiary)',
    backgroundColor: active ? 'var(--rn-clr-background-tertiary)' : 'transparent',
    border: narrow ? '1px solid var(--rn-clr-border-primary)' : '1px solid transparent',
    transition: 'color 0.15s ease, background-color 0.15s ease',
  });

  const compactLabelStyle: React.CSSProperties = {
    fontSize: '10.5px',
    fontWeight: 500,
    lineHeight: '1.1',
    whiteSpace: 'nowrap',
  };

  const priorityBadgeStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: narrow ? '1px 8px' : '2px 10px',
    borderRadius: '999px',
    fontSize: narrow ? '11px' : '12px',
    fontWeight: 600,
    lineHeight: '1.5',
    color: 'white',
    backgroundColor: priorityColor,
    whiteSpace: 'nowrap',
  };

  const infoBarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: narrow ? '2px 10px' : '4px 14px',
    padding: narrow ? '3px 8px' : '5px 14px',
    backgroundColor: 'var(--rn-clr-background-secondary)',
    borderRadius: '8px',
    fontSize: narrow ? '11px' : '11.5px',
    color: 'var(--rn-clr-content-secondary)',
    borderLeft: `3px solid ${priorityColor}`,
    fontVariantNumeric: 'tabular-nums',
  };
  const barSeparator = <span style={{ color: 'var(--rn-clr-border-primary)' }}>|</span>;

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
      onClick={(e) => {
        // After any click, return focus to the parent window so native
        // RemNote shortcuts work immediately. EXCEPT for text inputs (the
        // review-note field) — blurring those would make typing impossible.
        if ((e.target as HTMLElement).closest('input, textarea')) return;
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
          // On a narrow bar Next takes the room the icon buttons leave.
          wrapperStyle={narrow ? { flex: '1 1 96px', minWidth: 0 } : undefined}
          style={narrow ? { width: '100%', minWidth: 0, height: '36px', padding: '0 8px', overflow: 'hidden' } : undefined}
        >
          {/* DraggableButton lays its children out in a row (beside the ↕ grip):
              the two lines are stacked here, or run on one line on a narrow bar. */}
          <div
            style={{
              display: 'flex',
              flexDirection: narrow ? 'row' : 'column',
              alignItems: narrow ? 'baseline' : 'center',
              gap: narrow ? '6px' : '3px',
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <div style={{ ...buttonStyles.label, flex: 'none' }}>Next</div>
            <div style={{ ...buttonStyles.sublabel, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
              <NextRepTime rem={incRemInfo} showScheduler={!tight} />
            </div>
          </div>
        </DraggableButton>

        <Button
          variant="secondary"
          onClick={async () => {
            await plugin.widget.openPopup('reschedule', { remId: ctx.remId });
          }}
          style={compactButtonStyle}
          title="Reschedule (Ctrl+J): Manually set custom interval and adjust priority"
        >
          <RescheduleIcon size={iconSize} />
          {label('Reschedule')}
        </Button>

        <Button
          variant="danger"
          onClick={async () => {
            // Card priority, the move to Dismissed and the powerup removal run in
            // the tracker (lib/incremental_rem/review_jobs.ts); the queue moves on now.
            const reviewTimeSeconds = (await captureQueueReviewSeconds(plugin)) ?? 0;
            await enqueueReviewJob(plugin, {
              id: newReviewJobId(rem._id),
              kind: 'dismiss',
              remId: rem._id,
              rep: { reviewTimeSeconds },
              cardPriorityInheritance: true,
              confirmedAt: Date.now(),
            });

            // Like "Next", leaving the rem should restore the queue dashboard.
            // Set the flag BEFORE advancing (the persistent QueueLoadCard
            // listener consumes it once the next card loads).
            await requestQueueDashboardRefocus(plugin, 'dismiss-button');
            await plugin.queue.removeCurrentCardFromQueue(true);
          }}
          style={compactButtonStyle}
          title="Dismiss (Ctrl+D): Permanently finish item by removing its Incremental power-up"
        >
          <DismissIcon size={iconSize} />
          {label('Dismiss', true)}
        </Button>

        {divider}

        {/* Secondary Actions Group */}
        <Button
          onClick={async () => {
            await plugin.widget.openPopup('priority', { remId: ctx.remId });
          }}
          style={compactButtonStyle}
          title="Change Priority (Ctrl+P / Ctrl+Alt+P): Adjust item's priority on the fly"
        >
          <PriorityIcon size={iconSize} />
          {label('Priority')}
        </Button>

        <Button
          onClick={() => handleReviewInEditorRem(plugin, rem, remType)}
          style={compactButtonStyle}
          title="Review in Editor (Ctrl+Shift+J): Reschedule item, open in editor, and start Editor Review Timer"
        >
          <ReviewInEditorIcon size={iconSize} />
          {label('In Editor')}
        </Button>

        {/* A browser tab is a desktop notion: left out of the narrow bar. */}
        {!narrow && (
          <Button
            onClick={() => openRemInBrowserTab(plugin, rem._id)}
            style={compactButtonStyle}
            title="Open Editor in New Tab: Instantly open the full source document in a new browser tab"
          >
            <NewTabIcon size={iconSize} />
            {label('New Tab')}
          </Button>
        )}

        {/* Scroll to Highlight / Bookmark: compact, beside the other reader actions. */}
        {activeHighlightId && (
          <>
            <Button
              onClick={async () => {
                const highlightRem = await plugin.rem.findOne(activeHighlightId);
                await highlightRem?.scrollToReaderHighlight();
              }}
              style={{
                ...compactButtonStyle,
                backgroundColor: 'var(--rn-clr-yellow, #fbbf24)',
                color: '#422006',
                border: '1px solid var(--rn-clr-yellow, #f59e0b)',
                animation: 'highlightPulse 2s ease-in-out 3',
              }}
              title="Scroll to Highlight: Instantly snap view back to highlight's position"
            >
              <LocateIcon size={iconSize} />
              {label('To Highlight', true)}
            </Button>
            <style>{`
              @keyframes highlightPulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(251, 191, 36, 0); }
                50% { box-shadow: 0 0 0 4px rgba(251, 191, 36, 0.45); }
              }
            `}</style>
          </>
        )}

        {/* Scroll to Bookmark: visible for both pdf and pdf-highlight types */}
        {bookmarkHighlightId && (
          <Button
            onClick={async () => {
              const bookmarkRem = await plugin.rem.findOne(bookmarkHighlightId);
              await bookmarkRem?.scrollToReaderHighlight();
            }}
            style={{
              ...compactButtonStyle,
              position: 'relative',
              color: 'var(--rn-clr-blue, #3b82f6)',
              border: '1px solid var(--rn-clr-blue, #3b82f6)',
            }}
            title={
              'Scroll to Bookmark: Jump to your last saved reading position in the document' +
              (readerBookmarkIsLatest ? ' (saved more recently than the read point)' : '')
            }
          >
            <BookmarkIcon size={iconSize} />
            {label('To Bookmark', true)}
            {/* "Latest" marker: saved more recently than the read point. */}
            {readerBookmarkIsLatest && (
              <span
                style={{
                  position: 'absolute',
                  top: '4px',
                  right: '4px',
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: 'currentColor',
                }}
              />
            )}
          </Button>
        )}

        {/* Review-note toggle — compact icon (styled like the ℹ️ help icon).
            Tinted while the input is open or a note is pending. */}
        <span
          role="button"
          aria-label="Review note"
          onClick={() => setNoteOpen((o) => !o)}
          style={quietButtonStyle(noteOpen || !!noteText)}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = noteOpen || noteText ? 'var(--rn-clr-background-tertiary)' : 'transparent';
          }}
          title="Review note: attach an observation to this repetition's history entry (saved when you press Next / Reschedule / Dismiss)"
        >
          <NoteIcon size={narrow ? 18 : 17} />
        </span>

        {/* Read point (hybrid cards): a read point is set on a descendant rem.
            The in-queue reader can't jump there without leaving the queue, so a
            confirm dialog opens it in the Editor — reusing the Review-in-Editor
            flow (records the rep + starts the timer for this IncRem) but
            navigating to the read-point descendant instead. */}
        {remReadPointInfo && (
          <>
            {divider}
            <Button
              onClick={async () => {
                const ok = window.confirm(
                  `Open the read point in the Editor?\n\n"${remReadPointInfo.text}"\n\n` +
                  `This records a review for the current Incremental Rem (like "Review in Editor"), ` +
                  `starts its timer, and opens the read point rem in the editor so you can resume reading there.`
                );
                if (!ok) return;
                await handleReviewInEditorRem(plugin, rem, remType, {
                  navigateToRemId: remReadPointInfo.targetRemId,
                });
              }}
              style={{
                color: 'var(--rn-clr-green, #16a34a)',
                border: '1px solid var(--rn-clr-green, #16a34a)',
                fontWeight: 600,
                position: 'relative',
                ...(narrow ? compactButtonStyle : {}),
              }}
              title={`Read point set on a descendant rem: "${remReadPointInfo.text}". Click to open it in the Editor — this reviews the current IncRem (starts its timer) and jumps to the read point.`}
            >
              {narrow ? (
                <>
                  <BookmarkIcon size={iconSize} />
                  {remReadPointInfo.isLatest && (
                    <span style={{ position: 'absolute', top: '4px', right: '4px', width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'currentColor' }} />
                  )}
                </>
              ) : (
                <>
                  <div style={buttonStyles.label}>🔖 Read point{remReadPointInfo.isLatest ? ' • latest' : ''}</div>
                  <div style={buttonStyles.sublabel}>Open in Editor →</div>
                </>
              )}
            </Button>
          </>
        )}



        {/* Open URL for the Companion - Only for HTML type rems */}
        {(remType === 'html' || remType === 'html-highlight') && htmlSourceUrl && (
          <>
            {divider}
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

                  // After opening it, so the click still counts as one for the popup blocker.
                  // The page's document itself (not a highlight in it): the
                  // Companion counts its reading, and Next leaves that time to it.
                  if (remType === 'html' && baseData?.rem) {
                    await recordCompanionHandoff(plugin, baseData.rem._id, htmlSourceUrl).catch((err) =>
                      console.warn('[Use Companion] hand-off not recorded:', err)
                    );
                  }

                  // Show a helpful toast
                  await plugin.app.toast('📎 URL opened! Use the Incremental RemNote Companion in Chrome to read and extract.');
                } catch (error) {
                  console.error('Error opening URL:', error);
                  await plugin.app.toast('Error opening URL');
                }
              }}
              className="clipper-button"
              style={{
                backgroundColor: 'var(--rn-clr-blue-light, #dbeafe)',
                color: 'var(--rn-clr-blue-dark, #1e40af)',
                border: '1px solid var(--rn-clr-blue, #3b82f6)',
                animation: 'clipperPulse 2.5s ease-in-out infinite',
                fontWeight: 600,
                minWidth: '104px',
                ...(narrow ? compactButtonStyle : {}),
              }}
              title="Open URL for the Companion 📎: Open the original page in a new tab, to read it with the Chrome Companion Extension"
            >
              {narrow ? (
                <LinkIcon size={iconSize} />
              ) : (
                <>
                  <div style={{ ...buttonStyles.label, display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <LinkIcon size={14} />
                    <span>Open URL</span>
                  </div>
                  <div style={buttonStyles.sublabel}>Use Companion</div>
                </>
              )}
            </Button>
            <style>{`
              @keyframes clipperPulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
                50% { box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.35); }
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

        {!narrow && (
          <span
            role="button"
            aria-label="Help"
            style={quietButtonStyle(false)}
            onClick={() => window.open('https://hugomarins.github.io/incremental-remnote/Reviewing-Items-in-the-Queue/', '_blank')}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            title="Help: Guide to Answer Buttons"
          >
            <HelpIcon size={17} />
          </span>
        )}
      </div>

      {/* Review-note input — parked in session storage on every keystroke and
          attached to this repetition's history entry by Next/Reschedule/Dismiss. */}
      {noteOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--rn-clr-content-tertiary)' }}>
          <NoteIcon size={15} />
          <input
            type="text"
            autoFocus
            value={noteText}
            maxLength={MAX_NOTE_LENGTH}
            placeholder={narrow ? 'Note for this repetition…' : 'Observation for this repetition (saved with Next / Reschedule / Dismiss)…'}
            onChange={(e) => {
              setNoteText(e.target.value);
              setPendingReviewNote(plugin, rem._id, e.target.value).catch(console.error);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setNoteOpen(false);
              }
              // Keep queue shortcuts from firing while typing.
              e.stopPropagation();
            }}
            style={{
              flex: 1,
              minWidth: 0,
              // 16px on a phone: a smaller field makes iOS zoom the page on focus.
              fontSize: narrow ? '16px' : '12px',
              padding: '6px 10px',
              borderRadius: '8px',
              border: '1px solid var(--rn-clr-border-primary)',
              backgroundColor: 'var(--rn-clr-background-secondary)',
              color: 'var(--rn-clr-content-primary)',
              outline: 'none',
            }}
          />
        </div>
      )}

      {/* Priority and Shield Info Bar */}
      {(incRemInfo || (shouldDisplayShield && shieldStatusAsync)) && (
        <div style={infoBarStyle}>
          {/* Left side: Priority and Shield */}
          <div style={{ display: 'flex', alignItems: 'center', gap: narrow ? '10px' : '14px' }}>
            {/* Priority Display */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
              {!narrow && <span style={{ fontWeight: 600 }}>Priority</span>}
              <div style={priorityBadgeStyle}>
                <span>{incRemInfo.priority}</span>
                {/* Show KB percentile (always current). Doc percentile removed from cache after priority change. */}
                {percentiles.kb !== null && (
                  <span
                    style={{ opacity: 0.9, fontSize: '0.92em', fontWeight: 500 }}
                    title={percentiles.unified
                      ? 'Rank among all IncRems and cards, the Priority Shield’s scale'
                      : 'Rank among IncRems'}
                  >
                    {percentiles.kb}% KB
                    {/* 🔌 Conditionally show Doc percentile */}
                    {!useLightMode && percentiles.doc !== null && ` · ${percentiles.doc}% Doc`}
                  </span>
                )}
              </div>
              {/* Show refresh icon only when Doc percentile is missing (will be recalculated on next queue) */}
              {!percentiles.unified && percentiles.kb !== null && percentiles.doc === null && (
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
                {barSeparator}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }} title="Priority Shield">
                    <span style={{
                      display: 'inline-flex',
                      animation: isAnyShieldActive ? 'shieldPulse 2s ease-in-out infinite' : 'none'
                    }}><ShieldIcon kind="priority" /></span>
                    {!narrow && <span>Shield</span>}
                  </span>
                  <div style={{ display: 'flex', gap: narrow ? '8px' : '12px' }}>
                    {shieldStatusAsync.unifiedKb?.absolute != null ? (
                      <PriorityShieldValue
                        label="KB"
                        entry={shieldStatusAsync.unifiedKb}
                        style={{
                          animation: isKbShieldActive ? 'shieldTextGlow 2s ease-in-out infinite' : 'none',
                          color: isKbShieldActive ? 'var(--rn-clr-blue)' : 'inherit'
                        }}
                      />
                    ) : (
                      <span>KB: 100%</span>
                    )}
                    {shieldStatusAsync.unifiedDoc?.absolute != null ? (
                      <PriorityShieldValue
                        label="Doc"
                        entry={shieldStatusAsync.unifiedDoc}
                        style={{
                          animation: isDocShieldActive ? 'shieldTextGlow 2s ease-in-out infinite' : 'none',
                          color: isDocShieldActive ? 'var(--rn-clr-blue)' : 'inherit'
                        }}
                      />
                    ) : (
                      shieldStatusAsync.hasDoc && <span>Doc: 100%</span>
                    )}
                  </div>
                  {/* The IncRem side's own absolute: where the reading backlog starts. */}
                  <span
                    style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '11px' }}
                    title="IncRem Shield: the highest-priority Incremental Rem still due (absolute priority)"
                  >
                    IncRem: {shieldStatusAsync.incRemKb ?? '✓'}
                    {shieldStatusAsync.hasDoc && ` · ${shieldStatusAsync.incRemDoc ?? '✓'}`}
                  </span>
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
              color: 'var(--rn-clr-border-primary)',
              opacity: statsSepVisible ? 1 : 0,
              pointerEvents: 'none',
            }}
          >|</span>

          {/* Right side: Weighted Shield + Reps — wraps together as a unit */}
          <div ref={statsContainerRef} style={{ display: 'flex', alignItems: 'center', gap: narrow ? '10px' : '14px' }}>
            {/* Weighted Shield Display */}
            {!useLightMode && shouldDisplayWeightedShield && shieldStatusAsync &&
              shieldStatusAsync.weightedKB !== null && shieldStatusAsync.weightedKB !== undefined && (
                <>
                  <WeightedShieldTooltip
                    kbValue={shieldStatusAsync.weightedKB}
                    docValue={shieldStatusAsync.weightedDoc}
                    allItems={shieldStatusAsync.jointKb}
                    isDuePredicate={(x: any) => x.due}
                    docItems={shieldStatusAsync.jointDoc}
                    itemLabel="Priority"
                    odds={{
                      kind: 'incRem',
                      allItems: allIncRems,
                      docItems: shieldStatusAsync.docIncRems,
                      isDuePredicate: (r: any) => Date.now() >= r.nextRepDate && (!shieldStatusAsync.seenRemIds.includes(r.remId) || r.remId === coreData?.rem?._id),
                    }}
                  />
                  {barSeparator}
                </>
              )
            }

            {/* Repetition History Stats and Icon */}
            <div
              role="button"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', padding: '1px 6px', margin: '0 -6px', borderRadius: '6px', transition: 'background-color 0.15s ease' }}
              onClick={() => plugin.widget.openPopup('repetition_history', { remId: ctx.remId })}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
              title="Repetition History"
            >
              <span style={{ whiteSpace: 'nowrap' }}>
                <strong>{historyStats.reps}</strong> {historyStats.reps === 1 ? 'rep' : 'reps'} · <strong>{historyStats.totalMinutes}</strong> min
              </span>
              <span style={{ color: 'var(--rn-clr-content-tertiary)', display: 'flex' }}>
                <HistoryIcon size={14} />
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

renderWidget(withHoverTips(AnswerButtons));
