import {
  renderWidget,
  usePlugin,
  useRunAsync,
  WidgetLocation,
  RNPlugin,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect, useRef } from 'react';
import { getIncrementalRemInfo, processRepetition } from '../lib/incremental_rem';
import { getNextSpacingDateForRem } from '../lib/scheduler'; // Import the scheduler function
import { IncrementalRep } from '../lib/types';
import dayjs from 'dayjs';

// This is the core logic for rescheduling with a custom interval.
async function handleManualReschedule(plugin: RNPlugin, remId: string, intervalDays: number) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;

  const incRem = await getIncrementalRemInfo(plugin, rem);
  if (!incRem) return;

  const newNextRepDate = Date.now() + intervalDays * 1000 * 60 * 60 * 24;

  const newHistory: IncrementalRep[] = [
    ...(incRem.history || []),
    {
      date: Date.now(),
      scheduled: incRem.nextRepDate,
    },
  ];

  await processRepetition(plugin, incRem, newNextRepDate, newHistory);
  await plugin.widget.closePopup();
}

// --- INNER COMPONENT ---
const RescheduleInput: React.FC<{ plugin: RNPlugin; remId: string }> = ({ plugin, remId }) => {
  // Start with a null state to indicate loading
  const [days, setDays] = useState<number | null>(null);
  const [futureDate, setFutureDate] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch the recommended interval when the component mounts
  useEffect(() => {
    const fetchDefaultInterval = async () => {
      const inLookbackMode = !!(await plugin.queue.inLookbackMode());
      const data = await getNextSpacingDateForRem(plugin, remId, inLookbackMode);
      if (data?.newInterval) {
        setDays(data.newInterval);
      } else {
        setDays(1); // Fallback to 1 if something fails
      }
    };
    fetchDefaultInterval();
  }, [plugin, remId]);

  // Update the date feedback and focus the input once the value is loaded
  useEffect(() => {
    if (days !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
      const date = dayjs().add(days, 'day').format('MMMM D, YY');
      setFutureDate(`Next review: ${date}`);
    } else {
      setFutureDate('Calculating...');
    }
  }, [days]);

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="interval-days" className="font-semibold">
        Next repetition in (days):
      </label>
      <input
        ref={inputRef}
        id="interval-days"
        type="number"
        min="0"
        disabled={days === null} // Disable input while loading default value
        value={days === null ? '' : days} // Show empty string while loading
        onChange={(e) => {
          const num = parseInt(e.target.value);
          if (!isNaN(num)) {
            setDays(num);
          }
        }}
        onKeyDown={async (e) => {
          if (e.key === 'Enter' && days !== null) {
            await handleManualReschedule(plugin, remId, days);
          }
        }}
        className="priority-input"
      />
      <div className="rn-clr-content-secondary h-4">{futureDate}</div>
    </div>
  );
};

// --- MAIN WIDGET COMPONENT (Unchanged) ---
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
    <div className="flex flex-col p-4 gap-4 reschedule-popup">
      <div className="text-2xl font-bold">Reschedule</div>
      <RescheduleInput plugin={plugin} remId={remId} />
    </div>
  );
}

renderWidget(Reschedule);