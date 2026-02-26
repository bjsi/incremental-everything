import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useEffect, useState } from 'react';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { updateSRSDataForRem } from '../lib/scheduler';
import { powerupCode, prioritySlotCode, currentSubQueueIdKey, remnoteEnvironmentId } from '../lib/consts';
import { IncrementalRep } from '../lib/incremental_rem';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';

dayjs.extend(duration);

function EditorReviewTimer() {
  const plugin = usePlugin();
  const [currentTime, setCurrentTime] = useState(Date.now());

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

  if (!timerData || !timerData.startTime) {
    return null;
  }

  const elapsedMs = currentTime - timerData.startTime;
  const elapsedDuration = dayjs.duration(elapsedMs);
  const hours = Math.floor(elapsedDuration.asHours());
  const minutes = elapsedDuration.minutes();
  const seconds = elapsedDuration.seconds();

  const timeDisplay = hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;

  const handleEndReview = async () => {
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
