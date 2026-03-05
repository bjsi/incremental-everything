import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { getNextSpacingDateForRem, updateSRSDataForRem } from '../lib/scheduler';
import { powerupCode, prioritySlotCode, currentSubQueueIdKey, remnoteEnvironmentId, pageRangeWidgetId } from '../lib/consts';
import { addToIncrementalHistory } from '../lib/history_utils';
import { IncrementalRep } from '../lib/incremental_rem';
import { determineIncRemType } from '../lib/incRemHelpers';
import { findPDFinRem, clearIncrementalPDFData, PageRangeContext, addPageToHistory, safeRemTextToString } from '../lib/pdfUtils';
import { PageControls } from '../components/reader/ui';
import { usePdfPageControls } from '../components/reader/usePdfPageControls';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';

dayjs.extend(duration);

function EditorReviewTimer() {
  const plugin = usePlugin();
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [pdfRemId, setPdfRemId] = useState<string | null>(null);
  const [isPdfNote, setIsPdfNote] = useState(false);

  const timerData = useTrackerPlugin(
    async (rp) => {
      const remId = await rp.storage.getSession<string>('editor-review-timer-rem-id');
      if (!remId) return null;

      const startTime = await rp.storage.getSession<number>('editor-review-timer-start');
      const interval = await rp.storage.getSession<number>('editor-review-timer-interval');
      const priority = await rp.storage.getSession<number>('editor-review-timer-priority');
      const remName = await rp.storage.getSession<string>('editor-review-timer-rem-name');
      const fromQueue = await rp.storage.getSession<boolean>('editor-review-timer-from-queue');
      const origin = await rp.storage.getSession<string>('editor-review-timer-origin');
      const queueList = await rp.storage.getSession<string[]>('editor-review-timer-queue-list');

      return {
        remId,
        startTime,
        interval,
        priority,
        remName: remName || 'Unnamed Rem',
        fromQueue,
        origin: origin || (fromQueue ? 'queue' : 'editor'),
        queueList: queueList || [],
      };
    },
    []
  );

  // Update current time every second
  useEffect(() => {
    const intervalId = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

  const pdfControls = usePdfPageControls(plugin, timerData?.remId, pdfRemId, 0);

  // Load PDF info if the rem is a pdf or has a pdf source
  useEffect(() => {
    if (!timerData?.remId) return;

    const loadPdfData = async () => {
      const rem = await plugin.rem.findOne(timerData.remId);
      if (!rem) return;

      const pdfRem = await findPDFinRem(plugin, rem);
      if (pdfRem) {
        setIsPdfNote(true);
        setPdfRemId(pdfRem._id);
      } else {
        setIsPdfNote(false);
      }
    };
    loadPdfData();
  }, [timerData?.remId, plugin]);

  const elapsedMs = currentTime - (timerData?.startTime || currentTime);
  const elapsedDuration = dayjs.duration(elapsedMs);
  const hours = Math.floor(elapsedDuration.asHours());
  const minutes = elapsedDuration.minutes();
  const seconds = elapsedDuration.seconds();

  const timeDisplay = hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;

  const handleEndReview = async (navigateBack: boolean = true) => {
    if (!timerData) return;

    const rem = await plugin.rem.findOne(timerData.remId);
    if (!rem) {
      await plugin.app.toast('Error: Rem not found');
      return;
    }

    const incRem = await getIncrementalRemFromRem(plugin, rem);
    if (!incRem) {
      await plugin.app.toast('Error: Not an Incremental Rem');
      return;
    }

    // Update priority if changed
    if (timerData.priority !== undefined && timerData.priority !== null) {
      await rem.setPowerupProperty(powerupCode, prioritySlotCode, [timerData.priority.toString()]);
    }

    // Calculate review time in seconds
    const reviewTimeSeconds = Math.round(elapsedMs / 1000);

    // Synchronize time spent reading directly to the PDF reading history tracker
    if (isPdfNote && pdfRemId) {
      await addPageToHistory(plugin, timerData.remId, pdfRemId, pdfControls.currentPage, reviewTimeSeconds);
    }

    if (timerData.origin === 'queue') {
      // Mode 1: Started from queue "Review in Editor". Repetition was already created.
      // We just update the reviewTimeSeconds of the last history entry.
      const updatedHistory = [...(incRem.history || [])];
      if (updatedHistory.length > 0) {
        updatedHistory[updatedHistory.length - 1].reviewTimeSeconds = reviewTimeSeconds;
      }

      await updateSRSDataForRem(plugin, timerData.remId, incRem.nextRepDate, updatedHistory);
      await addToIncrementalHistory(plugin, timerData.remId);
      await plugin.app.toast(`✓ ${timerData.remName}: Repetition updated (${timeDisplay})`);
    } else {
      // Mode 2: Started from Editor command. We need to create the repetition right now.
      const newNextRepDate = Date.now() + (timerData.interval || 0) * 1000 * 60 * 60 * 24;

      // Calculate early/late status
      const scheduledDate = incRem.nextRepDate;
      const actualDate = Date.now();
      const daysDifference = (actualDate - scheduledDate) / (1000 * 60 * 60 * 24);
      const wasEarly = daysDifference < 0;
      const daysEarlyOrLate = Math.round(daysDifference * 10) / 10;

      const newHistory: IncrementalRep[] = [
        ...(incRem.history || []),
        {
          date: actualDate,
          scheduled: scheduledDate,
          interval: timerData.interval || 0,
          wasEarly: wasEarly,
          daysEarlyOrLate: daysEarlyOrLate,
          reviewTimeSeconds: reviewTimeSeconds,
          priority: incRem.priority, // Record priority at time of rep
          eventType: 'executeRepetition' as const,
        },
      ];

      await updateSRSDataForRem(plugin, timerData.remId, newNextRepDate, newHistory);
      await addToIncrementalHistory(plugin, timerData.remId);
      const dateStr = dayjs(newNextRepDate).format('MMMM D, YYYY');
      await plugin.app.toast(`✓ ${timerData.remName}: Repetition stored (${timeDisplay}), next review: ${dateStr}`);
    }

    const updatedIncRem = await getIncrementalRemFromRem(plugin, rem);
    if (updatedIncRem) {
      await updateIncrementalRemCache(plugin, updatedIncRem);
    }

    // Clear timer data FIRST (to prevent navigation from interrupting cleanup)
    await plugin.storage.setSession('editor-review-timer-rem-id', undefined);
    await plugin.storage.setSession('editor-review-timer-start', undefined);
    await plugin.storage.setSession('editor-review-timer-interval', undefined);
    await plugin.storage.setSession('editor-review-timer-priority', undefined);
    await plugin.storage.setSession('editor-review-timer-rem-name', undefined);
    await plugin.storage.setSession('editor-review-timer-from-queue', undefined);
    await plugin.storage.setSession('editor-review-timer-origin', undefined);

    // Perform navigation at the very end — only if requested
    if (navigateBack) {
      if (timerData.origin === 'queue') {
        // Return to the queue
        const subQueueId = await plugin.storage.getSession<string>(currentSubQueueIdKey);
        if (subQueueId) {
          const subQueueRem = await plugin.rem.findOne(subQueueId);
          if (subQueueRem) {
            await subQueueRem.openRemAsPage();
            await plugin.app.toast('Hit Cmd+Shift+P to resume your Queue!');
          } else {
            await plugin.app.toast('Could not find the queue document.');
          }
        } else {
          await plugin.app.toast("Please click 'Flashcards' on the sidebar to resume the Global Queue!");
        }
      } else if (timerData.origin === 'inc-rem-list') {
        // Return to the IncRem List popup (state was already stored in session by inc_rem_list.tsx)
        await plugin.widget.openPopup('inc_rem_list');
      } else if (timerData.origin === 'inc-rem-main-view') {
        // Return to the Main View popup (state was already stored in session by inc_rem_main_view.tsx)
        await plugin.widget.openPopup('inc_rem_main_view');
      }
    }
  };

  const handleNextReview = async () => {
    if (!timerData || timerData.queueList.length === 0) return;

    // 1. First, save the repetition for the CURRENT item (matching handleEndReview Mode 2 logic)
    const currentRem = await plugin.rem.findOne(timerData.remId);
    if (!currentRem) {
      await plugin.app.toast('Error: Current Rem not found');
      return;
    }

    const currentIncRem = await getIncrementalRemFromRem(plugin, currentRem);
    if (!currentIncRem) {
      await plugin.app.toast('Error: Not an Incremental Rem');
      return;
    }

    // Update priority if changed
    if (timerData.priority !== undefined && timerData.priority !== null) {
      await currentRem.setPowerupProperty(powerupCode, prioritySlotCode, [timerData.priority.toString()]);
    }

    // Calculate review time and sync PDF page
    const reviewTimeSeconds = Math.round(elapsedMs / 1000);
    if (isPdfNote && pdfRemId) {
      await addPageToHistory(plugin, timerData.remId, pdfRemId, pdfControls.currentPage, reviewTimeSeconds);
    }

    // Always create a new repetition, just like Mode 2
    const newNextRepDate = Date.now() + (timerData.interval || 0) * 1000 * 60 * 60 * 24;
    const scheduledDate = currentIncRem.nextRepDate;
    const actualDate = Date.now();
    const daysDifference = (actualDate - scheduledDate) / (1000 * 60 * 60 * 24);
    const wasEarly = daysDifference < 0;
    const daysEarlyOrLate = Math.round(daysDifference * 10) / 10;

    const newHistory: IncrementalRep[] = [
      ...(currentIncRem.history || []),
      {
        date: actualDate,
        scheduled: scheduledDate,
        interval: timerData.interval || 0,
        wasEarly: wasEarly,
        daysEarlyOrLate: daysEarlyOrLate,
        reviewTimeSeconds: reviewTimeSeconds,
        priority: currentIncRem.priority,
        eventType: 'executeRepetition' as const,
      },
    ];

    await updateSRSDataForRem(plugin, timerData.remId, newNextRepDate, newHistory);
    await addToIncrementalHistory(plugin, timerData.remId);

    // Update cache
    const updatedIncRem = await getIncrementalRemFromRem(plugin, currentRem);
    if (updatedIncRem) {
      await updateIncrementalRemCache(plugin, updatedIncRem);
    }

    // 2. Setup next item in queue
    const nextRemId = timerData.queueList[0];
    const newQueueList = timerData.queueList.slice(1);

    const nextRem = await plugin.rem.findOne(nextRemId);
    if (!nextRem) {
      await plugin.app.toast(`Next Rem not found. Queue has ${newQueueList.length} items left.`);
      // Update queue list so we can try the next one if the user clicks again
      await plugin.storage.setSession('editor-review-timer-queue-list', newQueueList);
      return;
    }

    // Calculate interval for the next rem
    const nextIncRemInfo = await getIncrementalRemFromRem(plugin, nextRem);
    const inLookbackMode = !!(await plugin.queue.inLookbackMode());
    const scheduleData = await getNextSpacingDateForRem(plugin, nextRemId, inLookbackMode);
    const nextInterval = scheduleData?.newInterval || 1;
    const nextRemName = await safeRemTextToString(plugin, nextRem.text);

    // 3. Update all session storage keys
    await plugin.storage.setSession('editor-review-timer-rem-id', nextRemId);
    await plugin.storage.setSession('editor-review-timer-start', Date.now()); // Reset start time
    await plugin.storage.setSession('editor-review-timer-interval', nextInterval);
    await plugin.storage.setSession('editor-review-timer-priority', nextIncRemInfo?.priority ?? 10);
    await plugin.storage.setSession('editor-review-timer-rem-name', nextRemName || 'Unnamed Rem');
    await plugin.storage.setSession('editor-review-timer-queue-list', newQueueList);

    await plugin.app.toast(`✓ Saved: ${timerData.remName}. Starting: ${nextRemName}`);

    // 4. Open the next rem
    const nextIncRemType = await determineIncRemType(plugin, nextRem);
    if (nextIncRemType === 'pdf-note') {
      await nextRem.openRemAsPage();
    } else {
      await plugin.window.openRem(nextRem);
    }

    // The widget will automatically refresh due to useTrackerPlugin dependency changes
  };

  const handleGoToRem = async () => {
    if (!timerData) return;

    const rem = await plugin.rem.findOne(timerData.remId);
    if (!rem) {
      await plugin.app.toast('Error: Rem not found');
      return;
    }

    // Check if it's a PDF note to open it properly without invoking the PDF viewer
    const incRemType = await determineIncRemType(plugin, rem);
    if (incRemType === 'pdf-note') {
      await rem.openRemAsPage();
    } else {
      await plugin.window.openRem(rem);
    }
  };

  const handleCancel = async () => {
    await plugin.storage.setSession('editor-review-timer-rem-id', undefined);
    await plugin.storage.setSession('editor-review-timer-start', undefined);
    await plugin.storage.setSession('editor-review-timer-interval', undefined);
    await plugin.storage.setSession('editor-review-timer-priority', undefined);
    await plugin.storage.setSession('editor-review-timer-rem-name', undefined);
    await plugin.storage.setSession('editor-review-timer-from-queue', undefined);
    await plugin.storage.setSession('editor-review-timer-origin', undefined);
    // Clear stored list state if cancelling
    await plugin.storage.setSession('inc-rem-list-state', undefined);
    await plugin.storage.setSession('inc-rem-main-view-state', undefined);
    await plugin.storage.setSession('inc-rem-main-view-doc-filter', undefined);
    await plugin.storage.setSession('editor-review-timer-queue-list', undefined);

    await plugin.app.toast('Timer cancelled');
  };

  if (!timerData || !timerData.startTime) {
    return null;
  }

  // Truncate rem name if too long
  const displayName = timerData.remName.length > 40
    ? timerData.remName.substring(0, 37) + '...'
    : timerData.remName;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '8px 16px',
        backgroundColor: '#dbeafe',
        borderRadius: '6px',
        border: '1px solid #3b82f6',
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
        maxWidth: '100%',
      }}
    >
      <span style={{ fontSize: '18px' }}>⏱️</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '13px',
          fontWeight: 600,
          color: '#1e40af',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          Reviewing: {displayName}
        </div>
        <div style={{
          fontSize: '16px',
          color: '#1e3a8a',
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 700,
        }}>
          {timeDisplay}
        </div>
      </div>

      {isPdfNote && pdfRemId && (
        <div style={{ marginRight: '8px', paddingRight: '12px', borderRight: '1px solid #93c5fd' }}>
          <PageControls
            incrementalRemId={timerData.remId as any}
            {...pdfControls}
            totalPages={0}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px' }}>
        {/* "Next" button — shown sequentially when queue list has items */}
        {timerData.queueList && timerData.queueList.length > 0 && (
          <button
            onClick={handleNextReview}
            style={{
              padding: '6px 14px',
              fontSize: '13px',
              backgroundColor: '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#059669';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#10b981';
            }}
            title={`Save & move to next item (${timerData.queueList.length} left)`}
            autoFocus
          >
            Next ({timerData.queueList.length}) →
          </button>
        )}

        {/* "Back to..." button — shown when origin is queue or inc-rem-list/main-view */}
        {(timerData.origin === 'queue' || timerData.origin === 'inc-rem-list' || timerData.origin === 'inc-rem-main-view') && (
          <button
            onClick={() => handleEndReview(true)}
            style={{
              padding: '6px 14px',
              fontSize: '13px',
              backgroundColor: timerData.queueList && timerData.queueList.length > 0 ? '#6b7280' : '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = timerData.queueList && timerData.queueList.length > 0 ? '#4b5563' : '#059669';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = timerData.queueList && timerData.queueList.length > 0 ? '#6b7280' : '#10b981';
            }}
          >
            ✓ {timerData.origin === 'queue'
              ? 'End Review and Back to Queue'
              : 'End Review and Back to IncRem List'}
          </button>
        )}

        {/* Plain "End Review" button — always shown */}
        <button
          onClick={() => handleEndReview(false)}
          style={{
            padding: '6px 14px',
            fontSize: '13px',
            backgroundColor: (timerData.origin === 'queue' || timerData.origin === 'inc-rem-list' || timerData.origin === 'inc-rem-main-view')
              ? '#6b7280' : '#10b981',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = (timerData.origin === 'queue' || timerData.origin === 'inc-rem-list' || timerData.origin === 'inc-rem-main-view')
              ? '#4b5563' : '#059669';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = (timerData.origin === 'queue' || timerData.origin === 'inc-rem-list' || timerData.origin === 'inc-rem-main-view')
              ? '#6b7280' : '#10b981';
          }}
        >
          ✓ End Review
        </button>
        <button
          onClick={handleGoToRem}
          style={{
            padding: '6px 14px',
            fontSize: '13px',
            backgroundColor: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#2563eb';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#3b82f6';
          }}
        >
          ↗ Go to Rem
        </button>
        <button
          onClick={handleCancel}
          style={{
            padding: '6px 12px',
            fontSize: '13px',
            backgroundColor: '#ef4444',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 500,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#dc2626';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#ef4444';
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

renderWidget(EditorReviewTimer);
