import {
  renderWidget,
  usePlugin,
  useRunAsync,
  WidgetLocation,
  RNPlugin,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect, useRef } from 'react';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { getNextSpacingDateForRem, updateSRSDataForRem } from '../lib/scheduler';
import { powerupCode, prioritySlotCode, incremReviewStartTimeKey } from '../lib/consts';
import { IncrementalRep } from '../lib/incremental_rem';
import dayjs from 'dayjs';
import { findClosestIncrementalAncestor } from '../lib/priority_inheritance';
import { useAcceleratedKeyboardHandler } from '../lib/keyboard_utils';
import { PrioritySlider, PrioritySliderRef } from '../components';

async function handleRescheduleAndPriorityUpdate(
  plugin: RNPlugin,
  remId: string,
  intervalDays: number,
  newPriority: number,
  context: 'queue' | 'editor' = 'queue'
) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;

  const incRem = await getIncrementalRemFromRem(plugin, rem);
  if (!incRem) return;

  await rem.setPowerupProperty(powerupCode, prioritySlotCode, [newPriority.toString()]);

  const newNextRepDate = Date.now() + intervalDays * 1000 * 60 * 60 * 24;

  // Calculate early/late status
  const scheduledDate = incRem.nextRepDate;
  const actualDate = Date.now();
  const daysDifference = (actualDate - scheduledDate) / (1000 * 60 * 60 * 24);
  const wasEarly = daysDifference < 0;
  const daysEarlyOrLate = Math.round(daysDifference * 10) / 10;

  // Calculate review time only for queue context (editor reschedule doesn't imply actual review)
  let reviewTimeSeconds: number | undefined;
  if (context === 'queue') {
    const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
    reviewTimeSeconds = startTime ? Math.round((Date.now() - startTime) / 1000) : undefined;
  }

  // Determine event type based on context
  const eventType = context === 'queue' ? 'rescheduledInQueue' : 'rescheduledInEditor';

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
      eventType: eventType as 'rescheduledInQueue' | 'rescheduledInEditor',
    },
  ];

  await updateSRSDataForRem(plugin, remId, newNextRepDate, newHistory);

  const updatedIncRem = await getIncrementalRemFromRem(plugin, rem);
  if (updatedIncRem) {
    await updateIncrementalRemCache(plugin, updatedIncRem);
  }

  // Clear the start time (only relevant for queue context)
  if (context === 'queue') {
    await plugin.storage.setSession(incremReviewStartTimeKey, null);
    await plugin.queue.removeCurrentCardFromQueue();
  }

  await plugin.widget.closePopup();
}



const RescheduleInput: React.FC<{ plugin: RNPlugin; remId: string; context: 'queue' | 'editor' }> = ({ plugin, remId, context }) => {
  const [days, setDays] = useState<string | null>(null);
  const [priority, setPriority] = useState<number | null>(null);
  const [futureDate, setFutureDate] = useState('');
  const [ancestorInfo, setAncestorInfo] = useState<any>(null);
  const intervalInputRef = useRef<HTMLInputElement>(null);
  const prioritySliderRef = useRef<PrioritySliderRef>(null);

  // --- KEYBOARD HANDLERS ---
  const daysKeyboard = useAcceleratedKeyboardHandler(
    days ? parseInt(days) : 1,
    1,
    (val) => {
      // Min 0, no practical max but let's keep it sane
      const newVal = Math.max(0, val);
      setDays(newVal.toString());
    }
  );

  const priorityKeyboard = useAcceleratedKeyboardHandler(
    priority,
    priority ?? 10, // Default priority if null
    (val) => {
      // Priority 0-100
      setPriority(Math.max(0, Math.min(100, val)));
    }
  );

  const handleTabCycle = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();

    // Cycle between interval input and priority slider
    if (document.activeElement === intervalInputRef.current) {
      prioritySliderRef.current?.focus();
      prioritySliderRef.current?.select();
    } else {
      intervalInputRef.current?.focus();
      intervalInputRef.current?.select();
    }
  };

  useEffect(() => {
    const fetchInitialData = async () => {
      const inLookbackMode = !!(await plugin.queue.inLookbackMode());
      const scheduleData = await getNextSpacingDateForRem(plugin, remId, inLookbackMode);
      const incRemData = await getIncrementalRemFromRem(plugin, await plugin.rem.findOne(remId));

      setDays(String(scheduleData?.newInterval || 1));
      setPriority(incRemData?.priority ?? 10);

      // Fetch ancestor info
      const rem = await plugin.rem.findOne(remId);
      const ancestor = await findClosestIncrementalAncestor(plugin, rem);
      setAncestorInfo(ancestor);
    };
    fetchInitialData();
  }, [plugin, remId]);

  useEffect(() => {
    if (days !== null) {
      setTimeout(() => {
        intervalInputRef.current?.focus();
        intervalInputRef.current?.select();
      }, 0);
    }
  }, [days === null]);

  useEffect(() => {
    if (days !== null) {
      const numDays = parseInt(days);
      if (!isNaN(numDays)) {
        const date = dayjs().add(numDays, 'day').format('MMMM D, YY');
        setFutureDate(`Next review: ${date}`);
      } else {
        setFutureDate('Invalid number of days.');
      }
    } else {
      setFutureDate('Calculating...');
    }
  }, [days]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const numDays = parseInt(days || '');
    if (!isNaN(numDays) && priority !== null) {
      await handleRescheduleAndPriorityUpdate(plugin, remId, numDays, priority, context);
    }
  };

  if (days === null || priority === null) {
    return <div className="p-4">Loading...</div>;
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
      onKeyUp={() => {
        // Global keyup handler for the form to ensure hold state releases
        daysKeyboard.handleKeyUp();
        priorityKeyboard.handleKeyUp();
      }}
    >
      <div className="flex flex-col gap-1" data-section="days">
        <div className="flex justify-between text-xs font-semibold mb-1">
          <span className="flex items-center gap-1">
            <span>📅</span> Next repetition in (days)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={intervalInputRef}
            id="interval-days"
            type="number"
            min="0"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSubmit(e);
              } else if (e.key === 'Tab') {
                handleTabCycle(e);
              } else {
                daysKeyboard.handleKeyDown(e);
              }
            }}
            onKeyUp={daysKeyboard.handleKeyUp}
            className="text-sm font-bold tabular-nums px-2 py-1 rounded shrink-0 border-0 outline-none transition-shadow"
            style={{
              backgroundColor: '#F97316',
              color: 'white',
              width: '60px',
              textAlign: 'center',
              boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.15)',
            }}
            onFocus={(e) => {
              e.currentTarget.style.boxShadow = '0 0 0 3px rgba(249, 115, 22, 0.5), inset 0 1px 2px rgba(0,0,0,0.15)';
              e.currentTarget.style.border = '2px solid white';
            }}
            onBlur={(e) => {
              e.currentTarget.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.15)';
              e.currentTarget.style.border = 'none';
            }}
          />
          <span className="text-xs opacity-60 italic">{futureDate}</span>
        </div>
      </div>
      {/* Priority Section - styled like priority_light.tsx */}
      <div className="flex flex-col gap-1" data-section="priority">
        <div className="flex justify-between text-xs font-semibold mb-1">
          <span className="flex items-center gap-1">
            <span>📖</span> Priority
            <span className="text-[10px] font-normal opacity-70 italic">(Lower = more important)</span>
          </span>
        </div>
        <PrioritySlider
          ref={prioritySliderRef}
          value={priority}
          onChange={setPriority}
          useAbsoluteColoring={true}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              handleTabCycle(e);
            } else if (e.key === 'Enter') {
              handleSubmit(e);
            } else {
              priorityKeyboard.handleKeyDown(e);
            }
          }}
        />
      </div>
      {/* Show ancestor info if available */}
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
      {/* --- ACCEPT BUTTON --- */}
      <div className="flex flex-col items-end gap-1 mt-3">
        <button
          type="submit"
          className="px-3 py-1 text-sm font-bold rounded-lg transition-all hover:scale-105 active:scale-95"
          style={{
            background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)',
            color: 'white',
            border: 'none',
            boxShadow: '0 2px 8px rgba(59, 130, 246, 0.4)',
          }}
          title="Press Enter to accept"
        >
          ✓ Accept
        </button>
        <span className="text-[10px] opacity-50 italic">Press Enter to accept</span>
      </div>
    </form>
  );
};

export function Reschedule() {
  const plugin = usePlugin();
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Popup>(),
    []
  );

  const remId = ctx?.contextData?.remId;
  const context = (ctx?.contextData?.context as 'queue' | 'editor') || 'queue';

  if (!remId) {
    return null;
  }

  return (
    <div
      className="flex flex-col gap-3 p-4 relative"
      style={{
        backgroundColor: 'var(--rn-clr-background-primary)',
        color: 'var(--rn-clr-content-primary)',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          plugin.widget.closePopup();
        }
      }}
    >
      {/* Header with icon and close button */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <img
            src={plugin.rootURL + 'reschedule-icon.png'}
            alt="Reschedule"
            style={{ width: '24px', height: '24px' }}
          />
          <h3 className="text-lg font-bold">Reschedule</h3>
        </div>
        <button
          className="text-xs opacity-50 hover:opacity-100 px-2 transition-opacity"
          onClick={() => plugin.widget.closePopup()}
        >✕</button>
      </div>
      <RescheduleInput plugin={plugin} remId={remId} context={context} />
    </div>
  );
}

renderWidget(Reschedule);