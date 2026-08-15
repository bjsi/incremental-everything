import {
  renderWidget,
  usePlugin,
  useRunAsync,
  WidgetLocation,
  RNPlugin,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getIncrementalRemFromRem, setIncRemPriority } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { getNextSpacingDateForRem, updateSRSDataForRem } from '../lib/scheduler';
import { powerupCode, prioritySlotCode, pageRangeWidgetId } from '../lib/consts';
import { IncrementalRep } from '../lib/incremental_rem';
import dayjs from 'dayjs';
import { findClosestIncrementalAncestor } from '../lib/priority_inheritance';
import { safeRemTextToString, getActivePdfForIncRem, setActivePdfForIncRem, getAllPDFsInRem, findHTMLinRem, getIncrementalReadingPosition, addPageToHistory, getPageHistory, getIncrementalPageRange, clearIncrementalPDFData, PageRangeContext } from '../lib/pdfUtils';
import { addToIncrementalHistory } from '../lib/history_utils';
import { determineIncRemType } from '../lib/incRemHelpers';
import { openRemInNewPane } from '../lib/remHelpers';
import { PageControls } from '../components/reader/ui';
import { usePdfPageControls } from '../components/reader/usePdfPageControls';
import { recordIncRemRep } from '../lib/queue_session';
import { setPendingReviewNote, stampNoteAndContext, MAX_NOTE_LENGTH } from '../lib/history_notes';
import { PrioritySlider, PriorityBadge } from '../components';
import {
  deductFromQueueIncRemClock,
  deductFromEditorTimerClock,
  finishQueueIncRemTurn,
  finishEditorReviewTurn,
  readEditorTimerState,
  LeaveTurnMode,
} from '../lib/review_actions';
import {
  incremReviewStartTimeKey,
  editorReviewTimerAccumulatedMsKey,
  editorReviewTimerPausedAtKey,
} from '../lib/consts';

// ─── Core Review Handler ────────────────────────────────────────────────────

async function handleEditorReview(
  plugin: RNPlugin,
  remId: string,
  intervalDays: number,
  newPriority: number,
  reviewTimeMinutes: number,
  /** When set, the handler writes this timestamp as nextRepDate instead of the computed one. */
  overrideNextRepDate?: number,
  /** Optional user note stored on this repetition's history entry. */
  note?: string
) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return null;

  const incRem = await getIncrementalRemFromRem(plugin, rem);
  if (!incRem) return null;

  await setIncRemPriority(plugin, rem, newPriority);

  const computedNextRepDate = Date.now() + intervalDays * 1000 * 60 * 60 * 24;
  const newNextRepDate = overrideNextRepDate ?? computedNextRepDate;

  // The interval stored in history must reflect the EFFECTIVE interval used
  // for the next rep date, not the algorithm-calculated one. When the user
  // chooses "Keep Current Date" or "Custom Interval", overrideNextRepDate
  // differs from the computed value.
  const effectiveIntervalDays = overrideNextRepDate
    ? Math.round(((overrideNextRepDate - Date.now()) / (1000 * 60 * 60 * 24)) * 10) / 10
    : intervalDays;

  // Calculate early/late status
  const scheduledDate = incRem.nextRepDate;
  const actualDate = Date.now();
  const daysDifference = (actualDate - scheduledDate) / (1000 * 60 * 60 * 24);
  const wasEarly = daysDifference < 0;
  const daysEarlyOrLate = Math.round(daysDifference * 10) / 10;

  // Convert minutes to seconds
  const reviewTimeSeconds = Math.round(reviewTimeMinutes * 60);

  // Synchronize time spent reading directly to the PDF reading history tracker
  const pdfRem = await getActivePdfForIncRem(plugin, rem);
  if (pdfRem && reviewTimeSeconds > 0) {
    const activePage = await getIncrementalReadingPosition(plugin, remId, pdfRem._id);
    await addPageToHistory(plugin, remId, pdfRem._id, activePage || 1, reviewTimeSeconds);
  }

  const repEntry: IncrementalRep = {
    date: actualDate,
    scheduled: scheduledDate,
    interval: effectiveIntervalDays,
    wasEarly: wasEarly,
    daysEarlyOrLate: daysEarlyOrLate,
    reviewTimeSeconds: reviewTimeSeconds,
    priority: incRem.priority, // Record priority at time of rep
    eventType: 'executeRepetition' as const,
  };

  // Attach the user's note (if typed) + a reading-state snapshot to the entry.
  await stampNoteAndContext(plugin, rem, repEntry, note);

  const newHistory: IncrementalRep[] = [...(incRem.history || []), repEntry];

  await updateSRSDataForRem(plugin, remId, newNextRepDate, newHistory);
  await addToIncrementalHistory(plugin, remId);

  const updatedIncRem = await getIncrementalRemFromRem(plugin, rem);
  if (updatedIncRem) {
    await updateIncrementalRemCache(plugin, updatedIncRem);
  }

  return { rem, newNextRepDate };
}

// ─── Confirmation Dialog Types ──────────────────────────────────────────────

type ConfirmationAction = 'confirm' | 'timer';

interface RegressionInfo {
  currentNextRepDate: number;
  newNextRepDate: number;
  currentDaysAway: number;
  newDaysAway: number;
  daysDifference: number;
  action: ConfirmationAction;
}

// ─── Main Component ─────────────────────────────────────────────────────────

/**
 * A review of a DIFFERENT rem that is already running behind this popup, and
 * whose clock is therefore still counting while the user records time here.
 *
 * Two sources, one behaviour: an Incremental turn in the queue, or the Editor
 * Review Timer. They keep their elapsed time in different session keys, so the
 * `kind` decides which clock to deduct from and which recorder closes it out.
 */
interface ActiveReviewInfo {
  kind: 'queue' | 'editor';
  remId: string;
  name: string;
  elapsedSeconds: number;
  interval?: number;
  nextRepDate?: number;
}

/** Start Timer arguments, parked while the leave overlay is answered. */
interface PendingTimerStart {
  intervalOverride?: number;
  dateOverride?: number;
}

function formatSpan(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

const EditorReviewInput: React.FC<{
  plugin: RNPlugin;
  remId: string;
  /**
   * The Incremental Rem the queue is reviewing right now, when this popup was
   * opened from the queue on a different rem. Its clock is still running, so
   * time recorded here is deducted from it, and leaving for the timer has to
   * close its turn out first.
   */
  queueIncRemId?: string;
  /**
   * Same situation, one surface over: the Editor Review Timer is running for a
   * different rem. Mutually exclusive with `queueIncRemId` in practice — the
   * queue handoff sets both, and the queue turn is the one that owns the clock.
   */
  editorTimerRemId?: string;
}> = ({ plugin, remId, queueIncRemId, editorTimerRemId }) => {
  // One concept, whichever surface it came from. The queue wins if both are
  // set: a handoff timer is the same review continued, not a second one.
  const activeReviewKind: ActiveReviewInfo['kind'] | null = queueIncRemId
    ? 'queue'
    : editorTimerRemId
    ? 'editor'
    : null;
  const activeReviewRemId = queueIncRemId ?? editorTimerRemId;
  const [days, setDays] = useState<string>('1');
  const [priority, setPriority] = useState<number>(10);
  const [note, setNote] = useState<string>('');
  const [reviewTimeMinutes, setReviewTimeMinutes] = useState<string>('');
  const [futureDate, setFutureDate] = useState('');
  const [ancestorInfo, setAncestorInfo] = useState<any>(null);
  const [remName, setRemName] = useState<string>('');

  // Ahead-of-schedule banner state
  const [earlyReviewInfo, setEarlyReviewInfo] = useState<{
    daysEarly: number;
    dueDate: string;
  } | null>(null);

  // Stored nextRepDate for regression check
  const currentNextRepDateRef = useRef<number>(0);

  // Regression warning state
  const [regressionInfo, setRegressionInfo] = useState<RegressionInfo | null>(null);

  // "You are leaving a review in progress" overlay state.
  const [activeReview, setActiveReview] = useState<ActiveReviewInfo | null>(null);
  const [leavePrompt, setLeavePrompt] = useState<PendingTimerStart | null>(null);
  const [carryMinutes, setCarryMinutes] = useState<string>('0');
  const leaveResolvedRef = useRef(false);
  const carryToTargetMsRef = useRef(0);
  const [customIntervalMode, setCustomIntervalMode] = useState(false);
  const [customInterval, setCustomInterval] = useState<string>('');
  const customIntervalInputRef = useRef<HTMLInputElement>(null);

  // PDF States
  const [pdfRemId, setPdfRemId] = useState<string | null>(null);
  const [isPdfNote, setIsPdfNote] = useState(false);
  const [pdfOptions, setPdfOptions] = useState<Array<{ remId: string; name: string; isPreferred: boolean }>>([]);

  const pdfControls = usePdfPageControls(plugin, remId, pdfRemId, 0);

  const intervalInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fetchInitialData = async () => {
      const inLookbackMode = !!(await plugin.queue.inLookbackMode());
      const scheduleData = await getNextSpacingDateForRem(plugin, remId, inLookbackMode);
      const incRemData = await getIncrementalRemFromRem(plugin, await plugin.rem.findOne(remId));

      const rem = await plugin.rem.findOne(remId);
      if (rem) {
        const name = await safeRemTextToString(plugin, rem.text);
        setRemName(name);

        const pdfRem = await getActivePdfForIncRem(plugin, rem);
        if (pdfRem) {
          setIsPdfNote(true);
          setPdfRemId(pdfRem._id);
        } else {
          setIsPdfNote(false);
        }

        try {
          const pdfs = await getAllPDFsInRem(plugin, rem);
          const options = await Promise.all(
            pdfs.map(async (p) => ({
              remId: p.rem._id,
              name: await safeRemTextToString(plugin, p.rem.text),
              isPreferred: p.isPreferred,
            }))
          );
          setPdfOptions(options);
        } catch (e) {
          console.error('[editor_review] Failed to load PDF options:', e);
          setPdfOptions([]);
        }
      }

      // Set the calculated interval from the scheduling algorithm
      setDays(String(scheduleData?.newInterval || 1));
      setPriority(incRemData?.priority ?? 10);

      // Store the current nextRepDate for regression checks
      if (incRemData) {
        currentNextRepDateRef.current = incRemData.nextRepDate;

        // Check if reviewing ahead of schedule
        const now = Date.now();
        if (incRemData.nextRepDate > now) {
          const daysEarly = Math.round(((incRemData.nextRepDate - now) / (1000 * 60 * 60 * 24)) * 10) / 10;
          const dueDate = dayjs(incRemData.nextRepDate).format('MMMM D, YYYY');
          setEarlyReviewInfo({ daysEarly, dueDate });
        }
      }

      // Fetch ancestor info
      const ancestor = await findClosestIncrementalAncestor(plugin, rem);
      setAncestorInfo(ancestor);
    };
    fetchInitialData();
  }, [plugin, remId]);

  useEffect(() => {
    setTimeout(() => {
      intervalInputRef.current?.focus();
      intervalInputRef.current?.select();
    }, 0);
  }, []);

  // Snapshot of the review still running behind this popup. Read-only —
  // getNextSpacingDateForRem only projects what a repetition WOULD schedule.
  const readActiveReview = useCallback(async (): Promise<ActiveReviewInfo | null> => {
    if (!activeReviewKind || !activeReviewRemId) return null;

    const otherRem = await plugin.rem.findOne(activeReviewRemId);
    if (!otherRem) return null;

    let elapsedSeconds = 0;
    let interval: number | undefined;
    let nextRepDate: number | undefined;

    if (activeReviewKind === 'queue') {
      const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
      elapsedSeconds = startTime ? Math.max(0, Math.round((Date.now() - startTime) / 1000)) : 0;
      const inLookbackMode = !!(await plugin.queue.inLookbackMode());
      const spacing = await getNextSpacingDateForRem(plugin, activeReviewRemId, inLookbackMode);
      interval = spacing?.newInterval;
      nextRepDate = spacing?.newNextRepDate;
    } else {
      const timer = await readEditorTimerState(plugin);
      if (!timer) return null;
      elapsedSeconds = timer.elapsedSeconds;
      // The timer already fixed its own interval when it started; that is what
      // End Review would schedule, so it is what "Reschedule" here means. A
      // queue-handoff timer carries none — its repetition is already dated.
      interval = timer.interval ?? undefined;
      if (typeof timer.interval === 'number') {
        nextRepDate = Date.now() + timer.interval * 24 * 60 * 60 * 1000;
      } else {
        const info = await getIncrementalRemFromRem(plugin, otherRem);
        nextRepDate = info?.nextRepDate;
      }
    }

    return {
      kind: activeReviewKind,
      remId: activeReviewRemId,
      name: (await safeRemTextToString(plugin, otherRem.text)) || 'Unnamed Rem',
      elapsedSeconds,
      interval,
      nextRepDate,
    };
  }, [plugin, activeReviewKind, activeReviewRemId]);

  useEffect(() => {
    if (!activeReviewKind) return;
    readActiveReview().then((info) => info && setActiveReview(info));
  }, [activeReviewKind, readActiveReview]);

  useEffect(() => {
    const numDays = parseInt(days);
    if (!isNaN(numDays)) {
      const date = dayjs().add(numDays, 'day').format('MMMM D, YY');
      setFutureDate(`Next review: ${date}`);
    } else {
      setFutureDate('Invalid number of days.');
    }
  }, [days]);

  // Focus custom interval input when it appears
  useEffect(() => {
    if (customIntervalMode) {
      setTimeout(() => {
        customIntervalInputRef.current?.focus();
        customIntervalInputRef.current?.select();
      }, 50);
    }
  }, [customIntervalMode]);

  // ─── Regression Check Helper ────────────────────────────────────────────

  const checkForRegression = useCallback(
    (action: ConfirmationAction): boolean => {
      const numDays = parseInt(days);
      if (isNaN(numDays)) return false;

      const newNextRepDate = Date.now() + numDays * 1000 * 60 * 60 * 24;
      const storedNextRepDate = currentNextRepDateRef.current;

      if (storedNextRepDate > 0 && newNextRepDate < storedNextRepDate) {
        const currentDaysAway = Math.round(((storedNextRepDate - Date.now()) / (1000 * 60 * 60 * 24)) * 10) / 10;
        const newDaysAway = numDays;
        const daysDifference = Math.round((currentDaysAway - newDaysAway) * 10) / 10;

        setRegressionInfo({
          currentNextRepDate: storedNextRepDate,
          newNextRepDate,
          currentDaysAway: Math.max(0, currentDaysAway),
          newDaysAway,
          daysDifference: Math.max(0, daysDifference),
          action,
        });
        setCustomIntervalMode(false);
        setCustomInterval('');
        return true; // Regression detected — dialog shown
      }
      return false; // No regression
    },
    [days]
  );

  // ─── Core Confirm & Timer Handlers ──────────────────────────────────────

  const executeConfirm = useCallback(
    async (intervalOverride?: number, dateOverride?: number) => {
      const numDays = intervalOverride ?? parseInt(days);
      const numMinutes = parseFloat(reviewTimeMinutes) || 0;

      if (!isNaN(numDays)) {
        const result = await handleEditorReview(plugin, remId, numDays, priority, numMinutes, dateOverride, note);
        if (result) {
          await recordIncRemRep(plugin, remId, Math.round(numMinutes * 60 * 1000));

          // Another review is running on a different rem: these minutes were
          // spent HERE, inside its clock, so they must come off that clock
          // instead of being counted twice. That review itself continues.
          let deducted = 0;
          if (activeReviewKind && numMinutes > 0) {
            deducted =
              activeReviewKind === 'queue'
                ? await deductFromQueueIncRemClock(plugin, numMinutes * 60)
                : await deductFromEditorTimerClock(plugin, numMinutes * 60);
          }

          const dateStr = dayjs(result.newNextRepDate).format('MMMM D, YYYY');
          await plugin.app.toast(
            `✓ ${remName}: Repetition stored, next review: ${dateStr}` +
            (deducted > 0 ? ` · ${formatSpan(deducted)} deducted from ${activeReview?.name ?? 'the running review'}` : '')
          );
          await plugin.widget.closePopup();
        }
      }
    },
    [days, reviewTimeMinutes, plugin, remId, priority, remName, note, activeReviewKind, activeReview]
  );

  const executeStartTimer = useCallback(
    async (intervalOverride?: number, dateOverride?: number) => {
      // Starting the timer abandons the review in progress — by navigating away
      // from the queue, or by taking the timer over from the rem that had it.
      // Ask what happens to it first, parking the arguments so the answer
      // resumes exactly this call.
      if (activeReviewKind && !leaveResolvedRef.current) {
        const fresh = await readActiveReview();
        if (fresh) setActiveReview(fresh);
        setCarryMinutes('0');
        setLeavePrompt({ intervalOverride, dateOverride });
        return;
      }

      const resolvedInterval = intervalOverride ?? parseInt(days);

      // Resolve the host (PDF/HTML) and last bookmark, and stash the
      // pending-scroll flag, BEFORE writing the timer rem-id below. Writing
      // rem-id mounts the persistent timer widget, whose autoscroll effect
      // reads this flag immediately on mount — if we stashed it afterward
      // (after the slow findOne/getActivePdfForIncRem/getPageHistory calls),
      // the effect would already have run, found nothing, and skipped (race).
      let rem: Awaited<ReturnType<typeof plugin.rem.findOne>> = undefined;
      let hostRem: Awaited<ReturnType<typeof getActivePdfForIncRem>> = null;
      let incRemType: Awaited<ReturnType<typeof determineIncRemType>> | undefined;
      let bookmarkHighlightId: string | undefined;
      try {
        rem = await plugin.rem.findOne(remId);
        if (rem) {
          const pdfRem = await getActivePdfForIncRem(plugin, rem);
          hostRem = pdfRem ?? (await findHTMLinRem(plugin, rem));
          incRemType = await determineIncRemType(plugin, rem);

          if (hostRem) {
            const history = await getPageHistory(plugin, remId, hostRem._id);
            const lastEntry = history[history.length - 1];
            bookmarkHighlightId = lastEntry?.highlightId;
            if (bookmarkHighlightId) {
              // Delegate the open+scroll to the persistent timer widget rather
              // than doing it here: this popup calls closePopup() below, which
              // tears down this iframe. The warm path (host already open) relies
              // on an inline setTimeout that dies with the iframe — and closing
              // the popup bounces focus off the reader pane — so the scroll
              // silently fails. The timer widget survives, so it can run
              // openAndScrollToHighlight reliably (warm or cold) once it mounts.
              await plugin.storage.setSession('editor-review-timer-pending-scroll', {
                hostRemId: hostRem._id,
                highlightId: bookmarkHighlightId,
                remId,
                requestedAt: Date.now(),
              });
            }
          }
        }
      } catch (e) {
        console.error('[executeStartTimer] host/bookmark resolution failed', e);
      }

      // Park the typed note so the timer's end-of-review write picks it up
      // (the rep entry doesn't exist yet — the timer creates it on End/Next).
      if (note.trim()) {
        await setPendingReviewNote(plugin, remId, note);
      }

      // Store timer info in session (writing rem-id mounts the timer widget).
      // The start is back-dated by any time the user carried over from the queue
      // turn they just left — those minutes were spent reading THIS rem in the
      // previewer, so the timer picks up where that reading stopped.
      await plugin.storage.setSession('editor-review-timer-rem-id', remId);
      await plugin.storage.setSession('editor-review-timer-start', Date.now() - carryToTargetMsRef.current);
      // Start this rem's clock from zero (plus any carry-over back-dated
      // above). Without this, a timer taken over from another rem hands its
      // accumulated segment — and any pause — to the new review.
      await plugin.storage.setSession(editorReviewTimerAccumulatedMsKey, undefined);
      await plugin.storage.setSession(editorReviewTimerPausedAtKey, undefined);
      await plugin.storage.setSession('editor-review-timer-interval', resolvedInterval);
      await plugin.storage.setSession('editor-review-timer-priority', priority);
      await plugin.storage.setSession('editor-review-timer-rem-name', remName);

      // If a date override is set (Keep Current Date), store it so the timer handler uses it
      if (dateOverride !== undefined) {
        await plugin.storage.setSession('editor-review-timer-date-override', dateOverride);
      }

      await plugin.app.toast(`⏱️ Timer started for: ${remName}`);

      // Open the host doc for the non-bookmark cases. When there IS a bookmark,
      // the timer widget's autoscroll effect opens + scrolls via the stashed
      // flag, so we skip opening here to avoid a redundant open.
      try {
        if (!rem) {
          await plugin.widget.closePopup();
          return;
        }

        if (hostRem) {
          if (!bookmarkHighlightId) {
            await openRemInNewPane(plugin, hostRem._id);
          }
        } else if (incRemType === 'pdf-note') {
          await rem.openRemAsPage();
        } else {
          await plugin.window.openRem(rem);
        }
      } catch (e) {
        console.error('[EditorReview.handleStartTimer] Failed to open & scroll', e);
      }

      await plugin.widget.closePopup();
    },
    [days, plugin, remId, priority, remName, note, activeReviewKind, readActiveReview]
  );

  // ─── Leaving the Queue Turn ─────────────────────────────────────────────

  /**
   * Answer to the leave overlay. The abandoned item always gets its repetition
   * (the reading time is real); `mode` only decides whether it is rescheduled
   * or stays due today. Whatever the user carries over is deducted here and
   * back-dates the timer that starts next.
   */
  const resolveLeave = useCallback(
    async (mode: LeaveTurnMode) => {
      if (!activeReviewKind) return;

      const carry = Math.max(0, parseFloat(carryMinutes) || 0);
      const carrySeconds = Math.round(carry * 60);
      carryToTargetMsRef.current = carrySeconds * 1000;

      const result =
        activeReviewKind === 'queue'
          ? await finishQueueIncRemTurn(plugin, activeReviewRemId!, mode, carrySeconds)
          : await finishEditorReviewTurn(plugin, mode, carrySeconds);
      if (result) {
        const where =
          mode === 'due'
            ? 'stays due today'
            : `next on ${dayjs(result.nextRepDate).format('MMM D, YYYY')}`;
        await plugin.app.toast(
          `↩ ${activeReview?.name ?? 'Previous item'}: ${formatSpan(result.recordedSeconds)} recorded, ${where}`
        );
      }

      // Resume the Start Timer call this overlay interrupted.
      leaveResolvedRef.current = true;
      const pending = leavePrompt;
      setLeavePrompt(null);
      await executeStartTimer(pending?.intervalOverride, pending?.dateOverride);
    },
    [plugin, activeReviewKind, activeReviewRemId, activeReview, carryMinutes, leavePrompt, executeStartTimer]
  );

  // ─── User-facing Handlers (with regression gate) ────────────────────────

  const handleConfirm = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!checkForRegression('confirm')) {
        await executeConfirm();
      }
    },
    [checkForRegression, executeConfirm]
  );

  const handleStartTimer = useCallback(async () => {
    if (!checkForRegression('timer')) {
      await executeStartTimer();
    }
  }, [checkForRegression, executeStartTimer]);

  // ─── Regression Dialog Resolution Handlers ─────────────────────────────

  const handleKeepCurrentDate = useCallback(async () => {
    if (!regressionInfo) return;
    const dateOverride = regressionInfo.currentNextRepDate;
    setRegressionInfo(null);
    if (regressionInfo.action === 'confirm') {
      await executeConfirm(undefined, dateOverride);
    } else {
      await executeStartTimer(undefined, dateOverride);
    }
  }, [regressionInfo, executeConfirm, executeStartTimer]);

  const handleUseNewDate = useCallback(async () => {
    if (!regressionInfo) return;
    setRegressionInfo(null);
    if (regressionInfo.action === 'confirm') {
      await executeConfirm();
    } else {
      await executeStartTimer();
    }
  }, [regressionInfo, executeConfirm, executeStartTimer]);

  const handleCustomIntervalConfirm = useCallback(async () => {
    if (!regressionInfo) return;
    const customDays = parseInt(customInterval);
    if (isNaN(customDays) || customDays < 0) return;
    setRegressionInfo(null);
    if (regressionInfo.action === 'confirm') {
      await executeConfirm(customDays);
    } else {
      await executeStartTimer(customDays);
    }
  }, [regressionInfo, customInterval, executeConfirm, executeStartTimer]);

  const handlePdfSwitch = async (newPdfId: string) => {
    if (newPdfId === pdfRemId) return;
    await setActivePdfForIncRem(plugin, remId, newPdfId);
    setPdfRemId(newPdfId);
    setIsPdfNote(true);
  };

  // ─── Keyboard Shortcuts ─────────────────────────────────────────────────

  const handleConfirmRef = useRef(handleConfirm);
  const handleStartTimerRef = useRef(handleStartTimer);
  const handleKeepCurrentDateRef = useRef(handleKeepCurrentDate);
  const handleUseNewDateRef = useRef(handleUseNewDate);
  const handleCustomIntervalConfirmRef = useRef(handleCustomIntervalConfirm);
  handleConfirmRef.current = handleConfirm;
  handleStartTimerRef.current = handleStartTimer;
  handleKeepCurrentDateRef.current = handleKeepCurrentDate;
  handleUseNewDateRef.current = handleUseNewDate;
  handleCustomIntervalConfirmRef.current = handleCustomIntervalConfirm;

  const resolveLeaveRef = useRef(resolveLeave);
  resolveLeaveRef.current = resolveLeave;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // The leave overlay owns the keyboard while it is up: Enter takes the
      // non-destructive option (item stays due), Esc backs out entirely.
      if (leavePrompt) {
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
        if (e.key === 'Escape') {
          e.preventDefault();
          setLeavePrompt(null);
        } else if (e.key === 'Enter' && tag !== 'button') {
          e.preventDefault();
          resolveLeaveRef.current('due');
        }
        return;
      }

      // When regression dialog is open, handle dialog-specific shortcuts
      if (regressionInfo) {
        if (e.key === 'Escape' || e.key === 'ArrowLeft') {
          e.preventDefault();
          setRegressionInfo(null);
          setCustomIntervalMode(false);
        } else if (!customIntervalMode && (e.key === 'Enter' || e.key === '1')) {
          e.preventDefault();
          handleKeepCurrentDateRef.current();
        } else if (e.key === '2') {
          e.preventDefault();
          handleUseNewDateRef.current();
        } else if (e.key === '3') {
          e.preventDefault();
          if (customIntervalMode) {
            handleCustomIntervalConfirmRef.current();
          } else {
            setCustomIntervalMode(true);
          }
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        plugin.widget.closePopup();
        return;
      }

      if (e.key !== 'Enter') return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'button' || tag === 'select') return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        handleStartTimerRef.current();
      } else {
        handleConfirmRef.current(e as any);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [regressionInfo, leavePrompt, plugin]);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col"
      style={{
        minWidth: '420px',
        maxWidth: '560px',
        backgroundColor: 'var(--rn-clr-background-primary)',
        color: 'var(--rn-clr-content-primary)',
        position: 'relative',
      }}
    >
      {/* ─── Leaving the Queue Turn Overlay ─── */}
      {leavePrompt && (
        <div
          className="absolute inset-0 flex items-center justify-center z-20 p-4"
          style={{ backgroundColor: 'var(--rn-clr-background-primary)', opacity: 0.98, borderRadius: '8px' }}
        >
          <div
            className="p-5 rounded-lg flex flex-col gap-3 max-w-sm"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
              boxShadow: 'var(--rn-box-shadow-modal)',
            }}
          >
            <h3
              className="font-semibold text-base flex items-center justify-center gap-2 text-center"
              style={{ color: '#d97706' }}
            >
              <span>⏸</span> Leaving the item you are reviewing
            </h3>

            <div className="text-xs flex flex-col gap-1.5" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              <p>
                {activeReview?.kind === 'editor' ? 'The timer is running for' : 'The queue is reviewing'}{' '}
                <strong title={activeReview?.name}>{activeReview?.name ?? '…'}</strong> —{' '}
                {activeReview?.kind === 'editor' ? 'counting' : 'on screen for'}{' '}
                <strong>{formatSpan(activeReview?.elapsedSeconds ?? 0)}</strong>.
              </p>
              <p>
                That time is recorded as a repetition either way. Choose what happens to its
                schedule.
              </p>
            </div>

            {/* Time the user actually spent on the rem being opened, taken out
                of the span above and given to the timer that starts next. */}
            <div className="flex items-center gap-2 text-xs">
              <label htmlFor="carry-minutes" className="shrink-0" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                Carry to this Rem:
              </label>
              <input
                id="carry-minutes"
                type="number"
                min="0"
                step="0.5"
                value={carryMinutes}
                onChange={(e) => setCarryMinutes(e.target.value)}
                className="px-2 py-1 rounded text-xs text-center"
                style={{
                  width: '70px',
                  border: '1px solid var(--rn-clr-border-primary)',
                  backgroundColor: 'var(--rn-clr-background-primary)',
                  color: 'var(--rn-clr-content-primary)',
                }}
              />
              <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>min</span>
            </div>

            <div className="flex flex-col gap-2 mt-1">
              <button
                className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#3B82F6', color: 'white' }}
                onClick={() => resolveLeave('due')}
                title="Records the repetition and keeps the item due today, like dragging Next down"
              >
                Leave it due today
                <span style={{ opacity: 0.65, fontWeight: 'normal', fontSize: '0.85em', marginLeft: '6px' }}>[Enter]</span>
              </button>
              <button
                className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#6B7280', color: 'white' }}
                onClick={() => resolveLeave('reschedule')}
                title="Records the repetition and applies the normal computed interval, like the Next button"
              >
                Reschedule
                {activeReview?.interval !== undefined && ` → ${activeReview.interval}d`}
                {activeReview?.nextRepDate !== undefined &&
                  ` (${dayjs(activeReview.nextRepDate).format('MMM D')})`}
              </button>
            </div>

            <button
              className="text-xs mt-1 transition-opacity hover:opacity-70"
              style={{ color: 'var(--rn-clr-content-tertiary)' }}
              onClick={() => setLeavePrompt(null)}
            >
              Go Back <span style={{ opacity: 0.65, fontSize: '0.85em' }}>[Esc]</span>
            </button>
          </div>
        </div>
      )}

      {/* ─── Regression Warning Overlay ─── */}
      {regressionInfo && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10 p-4"
          style={{ backgroundColor: 'var(--rn-clr-background-primary)', opacity: 0.98, borderRadius: '8px' }}
        >
          <div
            className="p-5 rounded-lg flex flex-col gap-3 text-center max-w-sm"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
              boxShadow: 'var(--rn-box-shadow-modal)',
            }}
          >
            <h3
              className="font-semibold text-base flex items-center justify-center gap-2"
              style={{ color: '#d97706' }}
            >
              <span>⚠️</span> Scheduling Conflict
            </h3>

            <div className="text-xs text-left flex flex-col gap-1.5" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              <p>
                The currently scheduled date is{' '}
                <strong>{dayjs(regressionInfo.currentNextRepDate).format('MMM D, YYYY')}</strong>
                {regressionInfo.currentDaysAway > 0 && (
                  <span> (in {regressionInfo.currentDaysAway} days)</span>
                )}
                .
              </p>
              <p>
                Confirming will reschedule to{' '}
                <strong>{dayjs(regressionInfo.newNextRepDate).format('MMM D, YYYY')}</strong>
                {' '}(in {regressionInfo.newDaysAway} days),
                which is <strong style={{ color: '#dc2626' }}>{regressionInfo.daysDifference} days earlier</strong>.
              </p>
            </div>

            <div className="flex flex-col gap-2 mt-2">
              <button
                className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#6B7280', color: 'white' }}
                onClick={handleKeepCurrentDate}
              >
                Keep Current Date ({dayjs(regressionInfo.currentNextRepDate).format('MMM D')})
                {!customIntervalMode && (
                  <span style={{ opacity: 0.65, fontWeight: 'normal', fontSize: '0.85em', marginLeft: '6px' }}>[Enter/1]</span>
                )}
                {customIntervalMode && (
                  <span style={{ opacity: 0.65, fontWeight: 'normal', fontSize: '0.85em', marginLeft: '6px' }}>[1]</span>
                )}
              </button>
              <button
                className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#3B82F6', color: 'white' }}
                onClick={handleUseNewDate}
              >
                Use New Date ({regressionInfo.newDaysAway}d → {dayjs(regressionInfo.newNextRepDate).format('MMM D')})
                <span style={{ opacity: 0.65, fontWeight: 'normal', fontSize: '0.85em', marginLeft: '6px' }}>[2]</span>
              </button>

              {!customIntervalMode ? (
                <button
                  className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                  style={{ backgroundColor: '#10B981', color: 'white' }}
                  onClick={() => setCustomIntervalMode(true)}
                >
                  Custom Interval…
                  <span style={{ opacity: 0.65, fontWeight: 'normal', fontSize: '0.85em', marginLeft: '6px' }}>[3]</span>
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    ref={customIntervalInputRef}
                    type="number"
                    min="0"
                    value={customInterval}
                    onChange={(e) => setCustomInterval(e.target.value)}
                    placeholder="days"
                    className="flex-1 px-2 py-1.5 rounded text-xs text-center"
                    style={{
                      border: '1px solid var(--rn-clr-border-primary)',
                      backgroundColor: 'var(--rn-clr-background-primary)',
                      color: 'var(--rn-clr-content-primary)',
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        handleCustomIntervalConfirm();
                      }
                    }}
                  />
                  <button
                    className="px-2 py-1.5 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                    style={{ backgroundColor: '#10B981', color: 'white' }}
                    onClick={handleCustomIntervalConfirm}
                    disabled={!customInterval || isNaN(parseInt(customInterval))}
                  >
                    ✓ <span style={{ opacity: 0.65, fontWeight: 'normal', fontSize: '0.85em' }}>[Enter/3]</span>
                  </button>
                </div>
              )}
            </div>

            <button
              className="text-xs mt-1 transition-opacity hover:opacity-70"
              style={{ color: 'var(--rn-clr-content-tertiary)' }}
              onClick={() => {
                setRegressionInfo(null);
                setCustomIntervalMode(false);
              }}
            >
              Go Back <span style={{ opacity: 0.65, fontSize: '0.85em' }}>[← / Esc]</span>
            </button>
          </div>
        </div>
      )}

      {/* ─── Header ─── */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{
          borderBottom: '1px solid var(--rn-clr-border-primary)',
          backgroundColor: 'var(--rn-clr-background-secondary)',
        }}
      >
        <div className="flex items-center gap-2 overflow-hidden mr-2">
          <span className="text-lg">📝</span>
          <span className="font-semibold text-sm" style={{ color: 'var(--rn-clr-content-primary)' }}>
            Execute Repetition
          </span>
          {remName && (
            <span
              className="text-xs truncate"
              style={{ color: 'var(--rn-clr-content-tertiary)' }}
              title={remName}
            >
              · {remName.length > 40 ? remName.substring(0, 40) + '...' : remName}
            </span>
          )}
        </div>
        <button
          onClick={() => plugin.widget.closePopup()}
          className="p-1 rounded transition-colors text-sm self-start shrink-0"
          style={{ color: 'var(--rn-clr-content-tertiary)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          ✕
        </button>
      </div>

      {/* ─── Body ─── */}
      <div className="px-4 py-3">
        <form onSubmit={handleConfirm} className="flex flex-col gap-3">

          {/* ─── Running Review Banner ─── */}
          {/* Another rem's review is being timed right now: say so up front, so
              the deduction on Confirm Review is never a surprise. */}
          {activeReviewKind && (
            <div
              className="p-2.5 rounded-lg flex items-start gap-2"
              style={{
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                border: '1px solid rgba(59, 130, 246, 0.35)',
              }}
            >
              <span className="text-sm shrink-0 mt-0.5">⏱️</span>
              <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                {activeReviewKind === 'editor' ? 'The Editor Review Timer is running for' : 'The queue is reviewing'}{' '}
                <strong title={activeReview?.name}>{activeReview?.name ?? 'another item'}</strong>. Time
                recorded here is <strong>deducted</strong> from it — Start Timer will ask what to do
                with that review before taking over.
              </div>
            </div>
          )}

          {/* ─── Ahead-of-Schedule Banner ─── */}
          {earlyReviewInfo && (
            <div
              className="p-2.5 rounded-lg flex items-start gap-2"
              style={{
                backgroundColor: '#fffbeb',
                border: '1px solid #fcd34d',
              }}
            >
              <span className="text-sm shrink-0 mt-0.5">⏩</span>
              <div className="text-xs" style={{ color: '#92400e' }}>
                <strong>Reviewing ahead of schedule</strong> — this IncRem is not due for{' '}
                <strong>{earlyReviewInfo.daysEarly}</strong> day{earlyReviewInfo.daysEarly !== 1 ? 's' : ''}{' '}
                (due: {earlyReviewInfo.dueDate}).
              </div>
            </div>
          )}

          {/* ─── Interval Section ─── */}
          <div
            className="p-3 rounded-lg flex flex-col gap-2"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
            }}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm">📅</span>
              <label htmlFor="interval-days" className="text-sm font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                Next repetition in (days)
              </label>
            </div>
            <input
              ref={intervalInputRef}
              id="interval-days"
              type="number"
              min="0"
              step="0.1"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-full px-3 py-1.5 rounded text-sm"
              style={{
                border: '1px solid var(--rn-clr-border-primary)',
                backgroundColor: 'var(--rn-clr-background-primary)',
                color: 'var(--rn-clr-content-primary)',
              }}
            />
            <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              {futureDate}
            </div>
          </div>

          {/* ─── Review Time Section ─── */}
          <div
            className="p-3 rounded-lg flex flex-col gap-2"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
            }}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm">⏱️</span>
              <label htmlFor="review-time" className="text-sm font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                Review time (minutes)
              </label>
            </div>
            <input
              id="review-time"
              type="number"
              min="0"
              step="0.5"
              value={reviewTimeMinutes}
              onChange={(e) => setReviewTimeMinutes(e.target.value)}
              placeholder="Optional — leave empty if using timer"
              className="w-full px-3 py-1.5 rounded text-sm"
              style={{
                border: '1px solid var(--rn-clr-border-primary)',
                backgroundColor: 'var(--rn-clr-background-primary)',
                color: 'var(--rn-clr-content-primary)',
              }}
            />
            <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              Leave empty if you'll use the timer below
            </div>
          </div>

          {/* ─── Note Section ─── */}
          <div
            className="p-3 rounded-lg flex flex-col gap-2"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
            }}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm">📝</span>
              <label htmlFor="review-note" className="text-sm font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                Note
              </label>
            </div>
            <input
              id="review-note"
              type="text"
              value={note}
              maxLength={MAX_NOTE_LENGTH}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional observation — saved in this repetition's history"
              className="w-full px-3 py-1.5 rounded text-sm"
              style={{
                border: '1px solid var(--rn-clr-border-primary)',
                backgroundColor: 'var(--rn-clr-background-primary)',
                color: 'var(--rn-clr-content-primary)',
              }}
            />
          </div>

          {/* ─── Priority Section ─── */}
          <div
            className="p-3 rounded-lg flex flex-col gap-3"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
            }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm">📊</span>
                <h3 className="text-sm font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                  Priority
                </h3>
              </div>
              <PriorityBadge priority={priority} useAbsoluteColoring />
            </div>

            <PrioritySlider
              value={priority}
              onChange={setPriority}
              useAbsoluteColoring
            />

            <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              Lower = more important
            </div>
          </div>

          {/* ─── Ancestor Info ─── */}
          {ancestorInfo && (
            <div
              className="p-2 rounded-lg flex items-center gap-3"
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
            >
              <PriorityBadge priority={ancestorInfo.priority} compact useAbsoluteColoring />
              <div className="flex-1 min-w-0">
                <div className="text-xs truncate" style={{ color: 'var(--rn-clr-content-primary)' }}>
                  {ancestorInfo.ancestorName}
                </div>
                <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                  Closest ancestor priority
                </div>
              </div>
            </div>
          )}

          {/* ─── PDF Switcher ─── */}
          {pdfOptions.length > 1 && pdfRemId && (
            <div
              className="p-2.5 rounded-lg flex items-center gap-2"
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
            >
              <label className="text-xs font-semibold shrink-0" htmlFor="pdf-switch">📄 PDF:</label>
              <select
                id="pdf-switch"
                value={pdfRemId}
                onChange={(e) => handlePdfSwitch(e.target.value)}
                className="text-xs px-2 py-1 rounded flex-1"
                style={{
                  border: '1px solid var(--rn-clr-border-primary)',
                  backgroundColor: 'var(--rn-clr-background-primary)',
                  color: 'var(--rn-clr-content-primary)',
                  maxWidth: '320px',
                }}
                title="Switch active PDF for this IncRem"
              >
                {pdfOptions.map((opt) => (
                  <option key={opt.remId} value={opt.remId}>
                    {opt.name}{opt.isPreferred ? ' ★' : ''}
                  </option>
                ))}
              </select>
              <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                ★ = #preferthispdf
              </span>
            </div>
          )}

          {/* ─── PDF Page Controls ─── */}
          {isPdfNote && pdfRemId && (
            <div
              className="flex justify-center p-2.5 rounded-lg"
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
            >
              <PageControls
                incrementalRemId={remId as any}
                {...pdfControls}
                totalPages={0}
              />
            </div>
          )}

          {/* ─── Action Buttons ─── */}
          <div className="flex gap-2 mt-1">
            <button
              type="submit"
              className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg transition-opacity hover:opacity-85"
              style={{ backgroundColor: '#3B82F6', color: 'white', border: 'none' }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2563eb'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#3B82F6'; }}
            >
              Confirm Review
            </button>
            <button
              type="button"
              onClick={handleStartTimer}
              className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg transition-opacity hover:opacity-85"
              style={{ backgroundColor: '#10B981', color: 'white', border: 'none' }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#059669'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#10B981'; }}
            >
              ⏱️ Start Timer
            </button>
          </div>
        </form>
      </div>

      {/* ─── Footer ─── */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{
          borderTop: '1px solid var(--rn-clr-border-primary)',
          backgroundColor: 'var(--rn-clr-background-secondary)',
        }}
      >
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
          <kbd
            className="px-1.5 py-0.5 rounded font-mono"
            style={{
              backgroundColor: 'var(--rn-clr-background-tertiary)',
              border: '1px solid var(--rn-clr-border-primary)',
              fontSize: '10px',
            }}
          >
            Enter
          </kbd>
          <span>confirm</span>
          <kbd
            className="px-1.5 py-0.5 rounded font-mono"
            style={{
              backgroundColor: 'var(--rn-clr-background-tertiary)',
              border: '1px solid var(--rn-clr-border-primary)',
              fontSize: '10px',
            }}
          >
            ⌘+Enter
          </kbd>
          <span>timer</span>
          <kbd
            className="px-1.5 py-0.5 rounded font-mono"
            style={{
              backgroundColor: 'var(--rn-clr-background-tertiary)',
              border: '1px solid var(--rn-clr-border-primary)',
              fontSize: '10px',
            }}
          >
            Esc
          </kbd>
          <span>close</span>
        </div>
      </div>
    </div>
  );
};

// ─── Outer Widget Shell ─────────────────────────────────────────────────────

export function EditorReview() {
  const plugin = usePlugin();
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Popup>(),
    []
  );

  const remId = ctx?.contextData?.remId;
  // Set only when opened from the queue on a rem other than the one being
  // reviewed there (previewer selection) — see the Ctrl+Shift+J command.
  const queueIncRemId = ctx?.contextData?.queueIncRemId as string | undefined;
  // Set by the editor branch of Ctrl+Shift+J when the Editor Review Timer is
  // already running for a different rem.
  const editorTimerRemId = ctx?.contextData?.editorTimerRemId as string | undefined;

  if (!remId) {
    return null;
  }

  return (
    <div style={{ backgroundColor: 'var(--rn-clr-background-primary)' }}>
      <EditorReviewInput
        plugin={plugin}
        remId={remId}
        queueIncRemId={queueIncRemId}
        editorTimerRemId={editorTimerRemId}
      />
    </div>
  );
}

renderWidget(EditorReview);
