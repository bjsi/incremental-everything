import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { updateSRSDataForRem } from '../lib/scheduler';
import { powerupCode, prioritySlotCode, currentSubQueueIdKey, remnoteEnvironmentId, pageRangeWidgetId } from '../lib/consts';
import { IncrementalRep } from '../lib/incremental_rem';
import { determineIncRemType } from '../lib/incRemHelpers';
import { findPDFinRem, getIncrementalPageRange, getIncrementalReadingPosition, clearIncrementalPDFData, PageRangeContext, addPageToHistory } from '../lib/pdfUtils';
import { PageControls } from '../components/reader/ui';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';

dayjs.extend(duration);

function EditorReviewTimer() {
  const plugin = usePlugin();
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [pdfRemId, setPdfRemId] = useState<string | null>(null);
  const [isPdfNote, setIsPdfNote] = useState(false);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageRangeStart, setPageRangeStart] = useState<number>(1);
  const [pageRangeEnd, setPageRangeEnd] = useState<number>(0);
  const [pageInputValue, setPageInputValue] = useState<string>('1');
  const [isInputFocused, setIsInputFocused] = useState<boolean>(false);

  const timerData = useTrackerPlugin(
    async (rp) => {
      const remId = await rp.storage.getSession<string>('editor-review-timer-rem-id');
      if (!remId) return null;

      const startTime = await rp.storage.getSession<number>('editor-review-timer-start');
      const interval = await rp.storage.getSession<number>('editor-review-timer-interval');
      const priority = await rp.storage.getSession<number>('editor-review-timer-priority');
      const remName = await rp.storage.getSession<string>('editor-review-timer-rem-name');
      const fromQueue = await rp.storage.getSession<boolean>('editor-review-timer-from-queue');

      return {
        remId,
        startTime,
        interval,
        priority,
        remName: remName || 'Unnamed Rem',
        fromQueue,
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

        const range = await getIncrementalPageRange(plugin, timerData.remId, pdfRem._id);
        const savedPage = await getIncrementalReadingPosition(plugin, timerData.remId, pdfRem._id);

        const startRange = range?.start || 1;
        const endRange = range?.end || 0;

        setPageRangeStart(startRange);
        setPageRangeEnd(endRange);

        let initialPage = savedPage && savedPage > 0 ? savedPage : startRange;
        const minPage = Math.max(1, startRange);
        if (initialPage < minPage) { initialPage = minPage; }
        if (endRange > 0 && initialPage > endRange) { initialPage = endRange; }

        setCurrentPage(initialPage);
        setPageInputValue(initialPage.toString());
      } else {
        setIsPdfNote(false);
      }
    };
    loadPdfData();
  }, [timerData?.remId, plugin]);

  // Poller for page range changes from page-range widget
  useEffect(() => {
    if (!timerData?.remId || !pdfRemId) return;

    const checkForChanges = async () => {
      const range = await getIncrementalPageRange(plugin, timerData.remId, pdfRemId);
      const newStart = range?.start || 1;
      const newEnd = range?.end || 0;

      if (newStart !== pageRangeStart || newEnd !== pageRangeEnd) {
        setPageRangeStart(newStart);
        setPageRangeEnd(newEnd);

        const minPage = Math.max(1, newStart);
        const maxPage = newEnd > 0 ? newEnd : Infinity;

        setCurrentPage(currentVal => {
          let correctedPage = currentVal;
          if (currentVal < minPage) { correctedPage = minPage; }
          else if (currentVal > maxPage) { correctedPage = maxPage; }

          if (correctedPage !== currentVal) {
            setPageInputValue(correctedPage.toString());
            if (timerData?.remId && pdfRemId) {
              plugin.storage.setSynced(`incremental_current_page_${timerData.remId}_${pdfRemId}`, correctedPage);
            }
            return correctedPage;
          }
          return currentVal;
        });
      }
    };

    const interval = setInterval(checkForChanges, 2000);
    return () => clearInterval(interval);
  }, [timerData?.remId, pdfRemId, pageRangeStart, pageRangeEnd]);

  const elapsedMs = currentTime - (timerData?.startTime || currentTime);
  const elapsedDuration = dayjs.duration(elapsedMs);
  const hours = Math.floor(elapsedDuration.asHours());
  const minutes = elapsedDuration.minutes();
  const seconds = elapsedDuration.seconds();

  const timeDisplay = hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;

  const handleEndReview = async () => {
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
      await addPageToHistory(plugin, timerData.remId, pdfRemId, currentPage, reviewTimeSeconds);
    }

    if (timerData.fromQueue) {
      // Mode 1: Started from queue "Review & Open". Repetition was already created.
      // We just update the reviewTimeSeconds of the last history entry.
      const updatedHistory = [...(incRem.history || [])];
      if (updatedHistory.length > 0) {
        updatedHistory[updatedHistory.length - 1].reviewTimeSeconds = reviewTimeSeconds;
      }

      await updateSRSDataForRem(plugin, timerData.remId, incRem.nextRepDate, updatedHistory);
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

    // Perform navigation at the very end
    if (timerData.fromQueue) {
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
    }
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

  const saveCurrentPage = useCallback(async (page: number) => {
    if (!timerData?.remId || !pdfRemId) return;
    const pageKey = `incremental_current_page_${timerData.remId}_${pdfRemId}`;
    await plugin.storage.setSynced(pageKey, page);
  }, [timerData?.remId, pdfRemId, plugin]);

  const incrementPage = useCallback(() => {
    const newPage = currentPage + 1;
    const maxPage = pageRangeEnd > 0 ? pageRangeEnd : Infinity;

    if (newPage <= maxPage) {
      setCurrentPage(newPage);
      setPageInputValue(newPage.toString());
      saveCurrentPage(newPage);
    }
  }, [currentPage, pageRangeEnd, saveCurrentPage]);

  const decrementPage = useCallback(() => {
    const minPage = Math.max(1, pageRangeStart);
    const newPage = Math.max(minPage, currentPage - 1);

    setCurrentPage(newPage);
    setPageInputValue(newPage.toString());
    saveCurrentPage(newPage);
  }, [currentPage, pageRangeStart, saveCurrentPage]);

  const handlePageInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setPageInputValue(value);

    const page = parseInt(value);
    if (!isNaN(page) && page >= 1) {
      const minPage = Math.max(1, pageRangeStart);
      const maxPage = pageRangeEnd > 0 ? pageRangeEnd : Infinity;

      if (page >= minPage && page <= maxPage) {
        setCurrentPage(page);
        saveCurrentPage(page);
      }
    }
  }, [pageRangeStart, pageRangeEnd, saveCurrentPage]);

  const handlePageInputBlur = useCallback(() => {
    setIsInputFocused(false);
    const page = parseInt(pageInputValue);

    if (isNaN(page) || page < 1) {
      setPageInputValue(currentPage.toString());
    } else {
      const minPage = Math.max(1, pageRangeStart);
      const maxPage = pageRangeEnd > 0 ? pageRangeEnd : Infinity;

      if (page < minPage || page > maxPage) {
        const message = pageRangeEnd > 0
          ? `Page must be between ${minPage} and ${maxPage}`
          : `Page must be ${minPage} or higher`;

        plugin.app.toast(message);
        setPageInputValue(currentPage.toString());
      } else if (page !== currentPage) {
        setCurrentPage(page);
        saveCurrentPage(page);
      }
    }
  }, [pageInputValue, currentPage, pageRangeStart, pageRangeEnd, saveCurrentPage, plugin]);

  const handlePageInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  const handleSetPageRange = useCallback(async () => {
    if (!timerData?.remId || !pdfRemId) return;

    const context: PageRangeContext = {
      incrementalRemId: timerData.remId,
      pdfRemId,
      totalPages: 0,
      currentPage: currentPage
    };

    await plugin.storage.setSession('pageRangeContext', context);
    await plugin.storage.setSession('pageRangePopupOpen', true);

    await plugin.widget.openPopup(pageRangeWidgetId);
  }, [timerData?.remId, pdfRemId, currentPage, plugin]);

  const handleClearPageRange = useCallback(async () => {
    if (!timerData?.remId || !pdfRemId) return;

    await clearIncrementalPDFData(
      plugin,
      timerData.remId,
      pdfRemId
    );
    setPageRangeStart(1);
    setPageRangeEnd(0);
    setCurrentPage(1);
    setPageInputValue('1');
  }, [timerData?.remId, pdfRemId, plugin]);

  const metadataBarStyles = useMemo(() => ({
    pageButton: {
      padding: '4px 8px',
      fontSize: '12px',
      borderRadius: '6px',
      border: '1px solid var(--rn-clr-border-primary)',
      backgroundColor: 'var(--rn-clr-background-primary)',
      color: 'var(--rn-clr-content-primary)',
      cursor: 'pointer',
      transition: 'all 0.15s ease',
      fontWeight: 500
    },
    pageInput: {
      width: '50px',
      padding: '4px 6px',
      fontSize: '12px',
      borderRadius: '6px',
      border: '1px solid var(--rn-clr-border-primary)',
      textAlign: 'center' as const,
      backgroundColor: 'var(--rn-clr-background-primary)',
      color: 'var(--rn-clr-content-primary)',
    },
    pageLabel: {
      fontSize: '11px',
      color: '#1e3a8a'
    },
    rangeButton: {
      padding: '4px 10px',
      fontSize: '11px',
      borderRadius: '6px',
      border: '1px solid var(--rn-clr-border-primary)',
      backgroundColor: 'var(--rn-clr-background-primary)',
      color: 'var(--rn-clr-content-secondary)',
      cursor: 'pointer',
      transition: 'all 0.15s ease',
      fontWeight: 500,
      display: 'flex',
      alignItems: 'center',
      gap: '4px'
    },
    clearButton: {
      padding: '4px 8px',
      fontSize: '11px',
      color: 'var(--rn-clr-red, #dc2626)',
      cursor: 'pointer',
      transition: 'opacity 0.15s ease',
      opacity: 0.7,
      border: 'none',
      background: 'none'
    },
    activeRangeButton: {
      backgroundColor: 'var(--rn-clr-blue-light, #eff6ff)',
      borderColor: 'var(--rn-clr-blue, #3b82f6)',
      color: 'var(--rn-clr-blue, #1e40af)',
    },
    dividerColor: 'var(--rn-clr-border-primary)',
  }), []);

  const handleCancel = async () => {
    // Clear timer data without saving
    await plugin.storage.setSession('editor-review-timer-rem-id', undefined);
    await plugin.storage.setSession('editor-review-timer-start', undefined);
    await plugin.storage.setSession('editor-review-timer-interval', undefined);
    await plugin.storage.setSession('editor-review-timer-priority', undefined);
    await plugin.storage.setSession('editor-review-timer-rem-name', undefined);
    await plugin.storage.setSession('editor-review-timer-from-queue', undefined);

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
            currentPage={currentPage}
            pageRangeStart={pageRangeStart}
            pageRangeEnd={pageRangeEnd}
            totalPages={0}
            pageInputValue={pageInputValue}
            metadataBarStyles={metadataBarStyles as any}
            onDecrement={decrementPage}
            onIncrement={incrementPage}
            onInputChange={handlePageInputChange}
            onInputBlur={handlePageInputBlur}
            onInputFocus={() => setIsInputFocused(true)}
            onInputKeyDown={handlePageInputKeyDown}
            onSetRange={handleSetPageRange}
            onClearRange={handleClearPageRange}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={handleEndReview}
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
        >
          ✓ {timerData.fromQueue ? 'End Review and Back to Queue' : 'End Review'}
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
