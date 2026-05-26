import {
  renderWidget,
  usePlugin,
  useRunAsync,
  WidgetLocation,
  RNPlugin,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { getNextSpacingDateForRem, updateSRSDataForRem } from '../lib/scheduler';
import { powerupCode, prioritySlotCode, pageRangeWidgetId } from '../lib/consts';
import { IncrementalRep } from '../lib/incremental_rem';
import dayjs from 'dayjs';
import { findClosestIncrementalAncestor } from '../lib/priority_inheritance';
import { safeRemTextToString, getActivePdfForIncRem, setActivePdfForIncRem, getAllPDFsInRem, findHTMLinRem, getIncrementalReadingPosition, addPageToHistory, getPageHistory, getIncrementalPageRange, clearIncrementalPDFData, PageRangeContext } from '../lib/pdfUtils';
import { addToIncrementalHistory } from '../lib/history_utils';
import { determineIncRemType } from '../lib/incRemHelpers';
import { openRemInNewPane, openAndScrollToHighlight } from '../lib/remHelpers';
import { PageControls } from '../components/reader/ui';
import { usePdfPageControls } from '../components/reader/usePdfPageControls';
import { recordIncRemRep } from '../lib/queue_session';
import { PrioritySlider, PriorityBadge } from '../components';

// ─── Core Review Handler ────────────────────────────────────────────────────

async function handleEditorReview(
  plugin: RNPlugin,
  remId: string,
  intervalDays: number,
  newPriority: number,
  reviewTimeMinutes: number,
  /** When set, the handler writes this timestamp as nextRepDate instead of the computed one. */
  overrideNextRepDate?: number
) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return null;

  const incRem = await getIncrementalRemFromRem(plugin, rem);
  if (!incRem) return null;

  await rem.setPowerupProperty(powerupCode, prioritySlotCode, [newPriority.toString()]);

  const computedNextRepDate = Date.now() + intervalDays * 1000 * 60 * 60 * 24;
  const newNextRepDate = overrideNextRepDate ?? computedNextRepDate;

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

  const newHistory: IncrementalRep[] = [
    ...(incRem.history || []),
    {
      date: actualDate,
      scheduled: scheduledDate,
      interval: intervalDays,
      wasEarly: wasEarly,
      daysEarlyOrLate: daysEarlyOrLate,
      reviewTimeSeconds: reviewTimeSeconds,
      priority: incRem.priority, // Record priority at time of rep
      eventType: 'executeRepetition' as const,
    },
  ];

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

const EditorReviewInput: React.FC<{ plugin: RNPlugin; remId: string }> = ({ plugin, remId }) => {
  const [days, setDays] = useState<string>('1');
  const [priority, setPriority] = useState<number>(10);
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
        const result = await handleEditorReview(plugin, remId, numDays, priority, numMinutes, dateOverride);
        if (result) {
          await recordIncRemRep(plugin, remId, Math.round(numMinutes * 60 * 1000));
          const dateStr = dayjs(result.newNextRepDate).format('MMMM D, YYYY');
          await plugin.app.toast(`✓ ${remName}: Repetition stored, next review: ${dateStr}`);
          await plugin.widget.closePopup();
        }
      }
    },
    [days, reviewTimeMinutes, plugin, remId, priority, remName]
  );

  const executeStartTimer = useCallback(
    async (intervalOverride?: number, dateOverride?: number) => {
      const resolvedInterval = intervalOverride ?? parseInt(days);

      // Store timer info in session
      await plugin.storage.setSession('editor-review-timer-rem-id', remId);
      await plugin.storage.setSession('editor-review-timer-start', Date.now());
      await plugin.storage.setSession('editor-review-timer-interval', resolvedInterval);
      await plugin.storage.setSession('editor-review-timer-priority', priority);
      await plugin.storage.setSession('editor-review-timer-rem-name', remName);

      // If a date override is set (Keep Current Date), store it so the timer handler uses it
      if (dateOverride !== undefined) {
        await plugin.storage.setSession('editor-review-timer-date-override', dateOverride);
      }

      await plugin.app.toast(`⏱️ Timer started for: ${remName}`);

      // Open the host doc (PDF or HTML article) and resume at the last bookmarked
      // highlight if any.
      try {
        const rem = await plugin.rem.findOne(remId);
        if (!rem) {
          await plugin.widget.closePopup();
          return;
        }

        const pdfRem = await getActivePdfForIncRem(plugin, rem);
        const hostRem = pdfRem ?? (await findHTMLinRem(plugin, rem));
        const incRemType = await determineIncRemType(plugin, rem);

        if (hostRem) {
          const history = await getPageHistory(plugin, remId, hostRem._id);
          const lastEntry = history[history.length - 1];
          const bookmarkHighlightId = lastEntry?.highlightId;
          if (bookmarkHighlightId) {
            await openAndScrollToHighlight(plugin, hostRem._id, bookmarkHighlightId);
          } else {
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
    [days, plugin, remId, priority, remName]
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
  handleConfirmRef.current = handleConfirm;
  handleStartTimerRef.current = handleStartTimer;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // When regression dialog is open, Enter confirms the dialog actions
      if (regressionInfo) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setRegressionInfo(null);
          setCustomIntervalMode(false);
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
  }, [regressionInfo, plugin]);

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
              </button>
              <button
                className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#3B82F6', color: 'white' }}
                onClick={handleUseNewDate}
              >
                Use New Date ({regressionInfo.newDaysAway}d → {dayjs(regressionInfo.newNextRepDate).format('MMM D')})
              </button>

              {!customIntervalMode ? (
                <button
                  className="px-3 py-2 rounded text-xs font-semibold transition-opacity hover:opacity-80"
                  style={{ backgroundColor: '#10B981', color: 'white' }}
                  onClick={() => setCustomIntervalMode(true)}
                >
                  Custom Interval…
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
                    ✓
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
              Go Back
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

  if (!remId) {
    return null;
  }

  return (
    <div style={{ backgroundColor: 'var(--rn-clr-background-primary)' }}>
      <EditorReviewInput plugin={plugin} remId={remId} />
    </div>
  );
}

renderWidget(EditorReview);
