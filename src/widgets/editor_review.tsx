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
import { safeRemTextToString, findPDFinRem, getIncrementalReadingPosition, addPageToHistory, getIncrementalPageRange, clearIncrementalPDFData, PageRangeContext } from '../lib/pdfUtils';
import { PageControls } from '../components/reader/ui';

async function handleEditorReview(
  plugin: RNPlugin,
  remId: string,
  intervalDays: number,
  newPriority: number,
  reviewTimeMinutes: number
) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return null;

  const incRem = await getIncrementalRemFromRem(plugin, rem);
  if (!incRem) return null;

  await rem.setPowerupProperty(powerupCode, prioritySlotCode, [newPriority.toString()]);

  const newNextRepDate = Date.now() + intervalDays * 1000 * 60 * 60 * 24;

  // Calculate early/late status
  const scheduledDate = incRem.nextRepDate;
  const actualDate = Date.now();
  const daysDifference = (actualDate - scheduledDate) / (1000 * 60 * 60 * 24);
  const wasEarly = daysDifference < 0;
  const daysEarlyOrLate = Math.round(daysDifference * 10) / 10;

  // Convert minutes to seconds
  const reviewTimeSeconds = Math.round(reviewTimeMinutes * 60);

  // Synchronize time spent reading directly to the PDF reading history tracker
  const pdfRem = await findPDFinRem(plugin, rem);
  if (pdfRem && reviewTimeSeconds > 0) {
    const currentPage = await getIncrementalReadingPosition(plugin, remId, pdfRem._id);
    await addPageToHistory(plugin, remId, pdfRem._id, currentPage || 1, reviewTimeSeconds);
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

  const updatedIncRem = await getIncrementalRemFromRem(plugin, rem);
  if (updatedIncRem) {
    await updateIncrementalRemCache(plugin, updatedIncRem);
  }

  return { rem, newNextRepDate };
}

const PrioritySlider: React.FC<{
  onChange: (value: number) => void;
  value: number;
  onSubmit: (e: React.KeyboardEvent) => void;
}> = ({ onChange, value, onSubmit }) => {
  return (
    <div className="flex flex-col gap-2">
      <div className="rn-clr-content-secondary priority-label">Lower = more important</div>
      <input
        type="range"
        className="priority-slider"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value))}
        tabIndex={-1}
      />
      <div className="rn-clr-content-secondary">
        Priority Value:{' '}
        <input
          type="number"
          min={0}
          max={100}
          value={value}
          onChange={(e) => {
            const num = parseInt(e.target.value);
            if (!isNaN(num)) {
              onChange(Math.min(100, Math.max(0, num)));
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onSubmit(e);
            }
          }}
          className="priority-input"
        />
      </div>
    </div>
  );
};

const EditorReviewInput: React.FC<{ plugin: RNPlugin; remId: string }> = ({ plugin, remId }) => {
  const [days, setDays] = useState<string>('1');
  const [priority, setPriority] = useState<number>(10);
  const [reviewTimeMinutes, setReviewTimeMinutes] = useState<string>('');
  const [futureDate, setFutureDate] = useState('');
  const [ancestorInfo, setAncestorInfo] = useState<any>(null);
  const [remName, setRemName] = useState<string>('');

  // PDF States
  const [pdfRemId, setPdfRemId] = useState<string | null>(null);
  const [isPdfNote, setIsPdfNote] = useState(false);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageRangeStart, setPageRangeStart] = useState<number>(1);
  const [pageRangeEnd, setPageRangeEnd] = useState<number>(0);
  const [pageInputValue, setPageInputValue] = useState<string>('1');
  const [isInputFocused, setIsInputFocused] = useState<boolean>(false);

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

        const pdfRem = await findPDFinRem(plugin, rem);
        if (pdfRem) {
          setIsPdfNote(true);
          setPdfRemId(pdfRem._id);

          const range = await getIncrementalPageRange(plugin, remId, pdfRem._id);
          const savedPage = await getIncrementalReadingPosition(plugin, remId, pdfRem._id);

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
      }

      // Set the calculated interval from the scheduling algorithm
      setDays(String(scheduleData?.newInterval || 1));
      setPriority(incRemData?.priority ?? 10);

      // Fetch ancestor info
      const ancestor = await findClosestIncrementalAncestor(plugin, rem);
      setAncestorInfo(ancestor);
    };
    fetchInitialData();
  }, [plugin, remId]);

  // Poller for page range changes from page-range widget
  useEffect(() => {
    if (!remId || !pdfRemId) return;

    const checkForChanges = async () => {
      const range = await getIncrementalPageRange(plugin, remId, pdfRemId);
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
            if (remId && pdfRemId) {
              plugin.storage.setSynced(`incremental_current_page_${remId}_${pdfRemId}`, correctedPage);
            }
            return correctedPage;
          }
          return currentVal;
        });
      }
    };

    const interval = setInterval(checkForChanges, 2000);
    return () => clearInterval(interval);
  }, [plugin, remId, pdfRemId, pageRangeStart, pageRangeEnd]);

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

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    const numDays = parseInt(days);
    const numMinutes = parseFloat(reviewTimeMinutes) || 0;

    if (!isNaN(numDays)) {
      const result = await handleEditorReview(plugin, remId, numDays, priority, numMinutes);
      if (result) {
        const dateStr = dayjs(result.newNextRepDate).format('MMMM D, YYYY');
        await plugin.app.toast(`✓ ${remName}: Repetition stored, next review: ${dateStr}`);
        await plugin.widget.closePopup();
      }
    }
  };

  const handleStartTimer = async () => {
    // Store timer info in session
    await plugin.storage.setSession('editor-review-timer-rem-id', remId);
    await plugin.storage.setSession('editor-review-timer-start', Date.now());
    await plugin.storage.setSession('editor-review-timer-interval', parseInt(days));
    await plugin.storage.setSession('editor-review-timer-priority', priority);
    await plugin.storage.setSession('editor-review-timer-rem-name', remName);

    await plugin.app.toast(`⏱️ Timer started for: ${remName}`);
    await plugin.widget.closePopup();
  };

  const saveCurrentPage = useCallback(async (page: number) => {
    if (!remId || !pdfRemId) return;
    const pageKey = `incremental_current_page_${remId}_${pdfRemId}`;
    await plugin.storage.setSynced(pageKey, page);
  }, [remId, pdfRemId, plugin]);

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
    if (!remId || !pdfRemId) return;

    const context: PageRangeContext = {
      incrementalRemId: remId as any,
      pdfRemId,
      totalPages: 0,
      currentPage: currentPage
    };

    await plugin.storage.setSession('pageRangeContext', context);
    await plugin.storage.setSession('pageRangePopupOpen', true);

    await plugin.widget.openPopup(pageRangeWidgetId);
  }, [remId, pdfRemId, currentPage, plugin]);

  const handleClearPageRange = useCallback(async () => {
    if (!remId || !pdfRemId) return;

    await clearIncrementalPDFData(
      plugin,
      remId,
      pdfRemId
    );
    setPageRangeStart(1);
    setPageRangeEnd(0);
    setCurrentPage(1);
    setPageInputValue('1');
  }, [remId, pdfRemId, plugin]);

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

  return (
    <form onSubmit={handleConfirm} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="interval-days" className="font-semibold">
          Next repetition in (days):
        </label>
        <input
          ref={intervalInputRef}
          id="interval-days"
          type="number"
          min="0"
          step="0.1"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              handleConfirm(e);
            }
          }}
          className="priority-input"
        />
        <div className="rn-clr-content-secondary h-4">{futureDate}</div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="review-time" className="font-semibold">
          Review time (minutes):
        </label>
        <input
          id="review-time"
          type="number"
          min="0"
          step="0.5"
          value={reviewTimeMinutes}
          onChange={(e) => setReviewTimeMinutes(e.target.value)}
          placeholder="Optional - leave empty if using timer"
          className="priority-input"
        />
        <div className="rn-clr-content-secondary text-xs">
          Leave empty if you'll use the timer below
        </div>
      </div>

      <hr />

      <div>
        <label className="font-semibold">Priority</label>
        <PrioritySlider value={priority} onChange={setPriority} onSubmit={handleConfirm} />
      </div>

      {ancestorInfo && (
        <div className="p-3 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <div className="text-sm font-semibold text-blue-700 dark:text-blue-300">
            Closest Ancestor Priority: {ancestorInfo.priority}
          </div>
          <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">
            {ancestorInfo.ancestorName}
          </div>
        </div>
      )}

      {isPdfNote && pdfRemId && (
        <div className="flex justify-center my-2 p-2 border rounded shadow-sm bg-gray-50 dark:bg-gray-800 dark:border-gray-700">
          <PageControls
            incrementalRemId={remId as any}
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

      {/* Button Row */}
      <div className="flex gap-3 mt-2">
        <button
          type="submit"
          className="flex-1 px-4 py-2 font-semibold rounded"
          style={{
            backgroundColor: '#3B82F6',
            color: 'white',
            border: 'none',
          }}
        >
          Confirm Review
        </button>
        <button
          type="button"
          onClick={handleStartTimer}
          className="flex-1 px-4 py-2 font-semibold rounded"
          style={{
            backgroundColor: '#10B981',
            color: 'white',
            border: 'none',
          }}
        >
          ⏱️ Start Timer
        </button>
      </div>
    </form>
  );
};

export function EditorReview() {
  const plugin = usePlugin();
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Popup>(),
    []
  );

  const remId = ctx?.contextData?.remId;

  const remName = useRunAsync(async () => {
    if (!remId) return '';
    const rem = await plugin.rem.findOne(remId);
    if (!rem) return 'Untitled';
    return await safeRemTextToString(plugin, rem.text);
  }, [remId]);

  if (!remId) {
    return null;
  }

  return (
    <div className="flex flex-col p-4 gap-4">
      <div>
        <div className="text-2xl font-bold">Execute IncRem Repetition <br></br> (Review in Editor) </div>
        {remName && (
          <div className="text-sm text-gray-600 dark:text-gray-400 mt-1 italic">
            {remName}
          </div>
        )}
      </div>
      <EditorReviewInput plugin={plugin} remId={remId} />
    </div>
  );
}

renderWidget(EditorReview);
