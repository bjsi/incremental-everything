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

async function handleRescheduleAndPriorityUpdate(
  plugin: RNPlugin,
  remId: string,
  intervalDays: number,
  newPriority: number
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

  // Calculate review time (same as Next button does)
  const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
  const reviewTimeSeconds = startTime ? Math.round((Date.now() - startTime) / 1000) : undefined;

  const newHistory: IncrementalRep[] = [
    ...(incRem.history || []),
    {
      date: actualDate,
      scheduled: scheduledDate,
      interval: intervalDays,
      wasEarly: wasEarly,
      daysEarlyOrLate: daysEarlyOrLate,
      reviewTimeSeconds: reviewTimeSeconds, // Track review time
    },
  ];

  await updateSRSDataForRem(plugin, remId, newNextRepDate, newHistory);

  const updatedIncRem = await getIncrementalRemFromRem(plugin, rem);
  if (updatedIncRem) {
    await updateIncrementalRemCache(plugin, updatedIncRem);
  }

  // Clear the start time (same as Next button does)
  await plugin.storage.setSession(incremReviewStartTimeKey, null);

  await plugin.queue.removeCurrentCardFromQueue();
  await plugin.widget.closePopup();
}

const PrioritySlider: React.FC<{
  onChange: (value: number) => void;
  value: number;
  onSubmit: (e: React.KeyboardEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  inputRef?: React.RefObject<HTMLInputElement>;
}> = ({ onChange, value, onSubmit, onKeyDown, inputRef }) => {
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
        onKeyDown={onKeyDown}
      />
      <div className="rn-clr-content-secondary">
        Priority Value:{' '}
        <input
          ref={inputRef}
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
            } else if (onKeyDown) {
              onKeyDown(e);
            }
          }}
          className="priority-input"
        />
      </div>
    </div>
  );
};

const RescheduleInput: React.FC<{ plugin: RNPlugin; remId: string }> = ({ plugin, remId }) => {
  const [days, setDays] = useState<string | null>(null);
  const [priority, setPriority] = useState<number | null>(null);
  const [futureDate, setFutureDate] = useState('');
  const [ancestorInfo, setAncestorInfo] = useState<any>(null);
  const intervalInputRef = useRef<HTMLInputElement>(null);
  const priorityInputRef = useRef<HTMLInputElement>(null);

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

    // Cycle between interval input and priority input
    if (document.activeElement === intervalInputRef.current) {
      priorityInputRef.current?.focus();
      priorityInputRef.current?.select();
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
      await handleRescheduleAndPriorityUpdate(plugin, remId, numDays, priority);
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
      <div className="flex flex-col gap-2">
        <label htmlFor="interval-days" className="font-semibold">
          Next repetition in (days):
        </label>
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
          className="priority-input"
        />
        <div className="rn-clr-content-secondary h-4">{futureDate}</div>
      </div>
      <hr />
      <div>
        <label className="font-semibold">Priority</label>
        <PrioritySlider
          value={priority}
          onChange={setPriority}
          onSubmit={handleSubmit}
          inputRef={priorityInputRef}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              handleTabCycle(e);
            } else {
              priorityKeyboard.handleKeyDown(e);
            }
          }}
        />
        {/* We need global keyup listener or bind it to container/inputs? 
            Since focus is on inputs, we can bind onKeyUp to inputs alongside onKeyDown 
            Wait, `PrioritySlider` passes `onKeyDown` to both inputs but we need `onKeyUp` too 
            for the hold state to clear. 
        */}
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
      <div className="flex justify-end mt-2">
        <button
          type="submit"
          className="px-4 py-2 font-semibold rounded" // Using basic layout classes
          style={{
            backgroundColor: '#3B82F6', // Equivalent to Tailwind's 'bg-blue-500'
            color: 'white',
            border: 'none',
          }}
        >
          Accept
        </button>
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

  if (!remId) {
    return null;
  }

  return (
    <div
      className="flex flex-col p-4 gap-4 reschedule-popup"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          plugin.widget.closePopup();
        }
      }}
    >
      <div className="text-2xl font-bold">Reschedule & Set Priority</div>
      <RescheduleInput plugin={plugin} remId={remId} />
    </div>
  );
}

renderWidget(Reschedule);