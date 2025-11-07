import {
  renderWidget,
  usePlugin,
  useRunAsync,
  WidgetLocation,
  RNPlugin,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect, useRef } from 'react';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { getNextSpacingDateForRem, updateSRSDataForRem } from '../lib/scheduler';
import { allIncrementalRemKey, powerupCode, prioritySlotCode } from '../lib/consts';
import { IncrementalRem, IncrementalRep } from '../lib/types';
import dayjs from 'dayjs';
import { findClosestIncrementalAncestor } from '../lib/priority_inheritance';
import { safeRemTextToString } from '../lib/pdfUtils';

async function handleEditorReview(
  plugin: RNPlugin,
  remId: string,
  intervalDays: number,
  newPriority: number,
  reviewTimeMinutes: number
) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return null;

  const incRem = await getIncrementalRemInfo(plugin, rem);
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
  
  const newHistory: IncrementalRep[] = [
    ...(incRem.history || []),
    {
      date: actualDate,
      scheduled: scheduledDate,
      interval: intervalDays,
      wasEarly: wasEarly,
      daysEarlyOrLate: daysEarlyOrLate,
      queueMode: 'editor', // Editor-based review
      reviewTimeSeconds: reviewTimeSeconds,
    },
  ];
  
  await updateSRSDataForRem(plugin, remId, newNextRepDate, newHistory);

  const updatedIncRem = await getIncrementalRemInfo(plugin, rem);
  if (updatedIncRem) {
    const allRem: IncrementalRem[] =
      (await plugin.storage.getSession(allIncrementalRemKey)) || [];
    const updatedAllRem = allRem
      .filter((r) => r.remId !== updatedIncRem.remId)
      .concat(updatedIncRem);
    await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
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
  const intervalInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fetchInitialData = async () => {
      const inLookbackMode = !!(await plugin.queue.inLookbackMode());
      const scheduleData = await getNextSpacingDateForRem(plugin, remId, inLookbackMode);
      const incRemData = await getIncrementalRemInfo(plugin, await plugin.rem.findOne(remId));
      
      const rem = await plugin.rem.findOne(remId);      
      if (rem) {
        const name = await safeRemTextToString(plugin, rem.text);
        setRemName(name);
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
