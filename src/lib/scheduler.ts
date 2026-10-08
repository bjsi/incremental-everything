import { RNPlugin } from '@remnote/plugin-sdk';
import { nextRepDateSlotCode, powerupCode, repHistorySlotCode } from './consts';
import { IncrementalRep } from './incremental_rem';
import { repCountsForScheduling } from './incremental_rem/types';
import * as _ from 'remeda';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getIncrementalRemFromRem } from './incremental_rem';
import { getDailyDocReferenceForDate } from './utils';
import { getRemSchedulerInfo } from './scheduler_choice';
import {
  computeNextInterval,
  getCurrentInterval,
  ResolvedScheduler,
  SchedulerChoice,
} from './scheduler_core';
dayjs.extend(relativeTime);

function removeResponsesBeforeEarlyResponses(history: IncrementalRep[]) {
  const cleansedHistory = [];
  for (let i = 0; i < history.length; i++) {
    // Always preserve event markers - they should never be filtered by early response logic
    const eventType = history[i].eventType;
    if (eventType === 'madeIncremental' ||
      eventType === 'dismissed' ||
      eventType === 'rescheduledInEditor' ||
      eventType === 'manualDateReset') {
      cleansedHistory.push(history[i]);
      continue;
    }

    const scheduledTime = timeWhenCardAppearsInQueueFromScheduled(history, i + 1)?.getTime();
    if (
      history[i + 1]?.date != undefined &&
      scheduledTime != undefined &&
      new Date(history[i + 1]?.date).getTime() < scheduledTime
    ) {
      // Skip - this rep was followed by an early response
    } else {
      cleansedHistory.push(history[i]);
    }
  }
  return cleansedHistory;
}

/**
 * Get only the repetitions since the last 'madeIncremental' event.
 * This is used for interval calculation so that after re-activating a dismissed Rem,
 * the interval calculation starts fresh rather than using the full historical count.
 * 
 * Only events that represent actual reviews are counted:
 * - undefined or 'rep': Normal queue review
 * - 'rescheduledInQueue': Reschedule during queue review
 * - 'executeRepetition': Execute repetition command in editor
 * 
 * Events that do NOT count:
 * - 'rescheduledInEditor': Reschedule from editor (no review confirmed)
 * - 'manualDateReset': Manual date change (no review)
 * - 'madeIncremental', 'dismissed': Session markers
 * - 'importedRep': Review imported from a removed flashcard — counts for stats
 *   but never for this rem's own scheduling.
 *
 * The exact predicate lives in repCountsForScheduling (types.ts) so it can't
 * drift from the Study Dashboard's stats predicate.
 *
 * @param history Full cleansed history array (after early-response filtering)
 * @returns Only the events that count for interval after the last 'madeIncremental' marker
 */
function getRepsSinceLastMadeIncremental(history: IncrementalRep[]): IncrementalRep[] {
  // Find the index of the last 'madeIncremental' marker
  let lastSessionStartIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].eventType === 'madeIncremental') {
      lastSessionStartIndex = i;
      break;
    }
  }

  // Get entries after the last session start (or all if no marker found)
  const entriesAfterSessionStart = lastSessionStartIndex >= 0
    ? history.slice(lastSessionStartIndex + 1)
    : history;

  return entriesAfterSessionStart.filter(entry => repCountsForScheduling(entry.eventType));
}

export function timeWhenCardAppearsInQueueFromScheduled(
  history: IncrementalRep[],
  index: number
): Date | null {
  const scheduled = history[index]?.scheduled;
  if (!scheduled) return null;

  const prevInteraction = history[index - 1];

  const interactionOnSameDay =
    scheduled && prevInteraction?.date && new Date(scheduled) == new Date(prevInteraction.date);

  const useRealScheduledTime = !prevInteraction || interactionOnSameDay;

  return useRealScheduledTime ? new Date(scheduled) : dayjs(scheduled).startOf('day').toDate();
}

export const removeLastInteraction = (history: IncrementalRep[]): IncrementalRep[] => {
  if (history.length === 0) {
    return history;
  }
  return history.slice(0, -1);
};

/**
 * Project what a repetition of this rem would schedule, without writing anything.
 *
 * @param schedulerOverride Compute with this scheduler instead of the rem's own —
 *   the popups use it to preview a switch before it is saved.
 */
export async function getNextSpacingDateForRem(
  plugin: RNPlugin,
  remId: string,
  inLookbackMode: boolean,
  schedulerOverride?: SchedulerChoice
) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) {
    return;
  }
  const incrementalRemInfo = await getIncrementalRemFromRem(plugin, rem);
  if (!incrementalRemInfo) {
    return;
  }

  const rawHistory = incrementalRemInfo.history || [];
  // In lookback mode the last interaction is the one being redone, so neither
  // scheduler may see it.
  const effectiveHistory = inLookbackMode ? removeLastInteraction(rawHistory) : rawHistory;
  const cleansedHistory = _.pipe(
    rawHistory,
    removeResponsesBeforeEarlyResponses,
    inLookbackMode ? removeLastInteraction : _.identity
  );

  // Get only the reps since the last 'madeIncremental' marker for interval calculation
  // This ensures interval calculation restarts after re-activating a dismissed Rem
  const sessionHistory = getRepsSinceLastMadeIncremental(cleansedHistory);

  const schedulerInfo = await getRemSchedulerInfo(plugin, rem);
  const scheduler: ResolvedScheduler = schedulerOverride
    ? { ...schedulerOverride, source: 'item' }
    : schedulerInfo.scheduler;
  const newInterval = computeNextInterval({
    scheduler,
    reviewNumber: sessionHistory.length + 1,
    // The multiplier scheduler works from the interval the item is on, read off
    // the unfiltered history: an editor reschedule or a manual date edit counts
    // here even though it never counts as a review.
    currentInterval: getCurrentInterval(effectiveHistory),
    curveFirstInterval: schedulerInfo.settings.curveFirstInterval,
    curveMaxInterval: schedulerInfo.settings.curveMaxInterval,
  });
  const newNextRepDate = Date.now() + newInterval * 1000 * 60 * 60 * 24;

  // Calculate if review was early/late and by how many days
  const scheduledDate = inLookbackMode
    ? dayjs().startOf('day').valueOf()
    : incrementalRemInfo.nextRepDate;
  const actualDate = Date.now();
  const daysDifference = (actualDate - scheduledDate) / (1000 * 60 * 60 * 24);
  const wasEarly = daysDifference < 0;
  const daysEarlyOrLate = Math.round(daysDifference * 10) / 10; // Round to 1 decimal

  const newHistory: IncrementalRep[] = [
    // if lookback mode, remove the last interaction but keep responsesBeforeEarlyResponses
    ...(inLookbackMode ? removeLastInteraction(rawHistory) : rawHistory),
    {
      date: actualDate,
      // TODO: wrong in lookbackMode, but no way to compute because the old nextRepDate has been overwritten
      scheduled: scheduledDate,
      interval: newInterval,
      wasEarly: wasEarly,
      daysEarlyOrLate: daysEarlyOrLate,
      // Record priority at time of rep — but only when it is a real value.
      // `prioritySource: 'fallback'` means neither the slot nor the existing
      // history could supply one, so the number is a placeholder. Stamping it
      // here would turn an unreadable slot into a permanent wrong priority, and
      // would overwrite the very history entries the value can be recovered from.
      ...(incrementalRemInfo.prioritySource === 'fallback'
        ? {}
        : { priority: incrementalRemInfo.priority }),
      // reviewTimeSeconds will be added by reviewRem()
    },
  ];
  return {
    newNextRepDate,
    newHistory,
    remId,
    newInterval,
    /** The scheduler this projection used, and what the settings alone would give. */
    scheduler,
    inheritedScheduler: schedulerInfo.inherited,
  };
}

export async function updateSRSDataForRem(
  plugin: RNPlugin,
  remId: string,
  newNextRepDate: number,
  newHistory: IncrementalRep[]
) {
  const rem = await plugin.rem.findOne(remId);
  console.log('updating srs data for rem', remId, newNextRepDate, newHistory);
  console.log('next rep due in ', dayjs(newNextRepDate).fromNow());
  const date = new Date(newNextRepDate);
  const dateReference = await getDailyDocReferenceForDate(plugin, date);
  if (!dateReference) {
    console.log('failed to create date reference for date', date);
    return;
  }

  // Stamp the authoritative scheduling date onto the most-recent history entry. The
  // Daily Doc reference above stays the source of truth on read (so manual date edits
  // win), but some daily-doc rems expose an empty 'Date' property and don't round-trip;
  // this gives the read a reliable fallback without adding a user-visible slot.
  const stampedHistory = newHistory.length > 0
    ? newHistory.map((entry, i) =>
        i === newHistory.length - 1 ? { ...entry, nextRepMs: newNextRepDate } : entry
      )
    : newHistory;

  // Set flag to indicate plugin is making the update (prevents manual date reset detection)
  await plugin.storage.setSession('plugin_updating_srs_data', true);

  await rem?.setPowerupProperty(powerupCode, nextRepDateSlotCode, dateReference);
  await rem?.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(stampedHistory)]);

  // Clear flag after a delay longer than the GlobalRemChanged debounce (1000ms)
  // to prevent false-positive manual date reset detection
  setTimeout(async () => {
    await plugin.storage.setSession('plugin_updating_srs_data', false);
  }, 3000);
}
