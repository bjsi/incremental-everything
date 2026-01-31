import { RNPlugin } from '@remnote/plugin-sdk';
import { multiplierId, nextRepDateSlotCode, powerupCode, repHistorySlotCode } from './consts';
import { IncrementalRep } from './incremental_rem';
import * as _ from 'remeda';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getIncrementalRemFromRem } from './incremental_rem';
import { getDailyDocReferenceForDate } from './utils';
dayjs.extend(relativeTime);

function removeResponsesBeforeEarlyResponses(history: IncrementalRep[]) {
  const cleansedHistory = [];
  for (let i = 0; i < history.length; i++) {
    const scheduledTime = timeWhenCardAppearsInQueueFromScheduled(history, i + 1)?.getTime();
    if (
      history[i + 1]?.date != undefined &&
      scheduledTime != undefined &&
      new Date(history[i + 1]?.date).getTime() < scheduledTime
    ) {
      // Skip
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
 * @param history Full cleansed history array
 * @returns Only the reps (eventType undefined or 'rep') after the last 'madeIncremental' marker
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

  // Filter to only actual repetitions (eventType undefined or 'rep')
  return entriesAfterSessionStart.filter(
    entry => entry.eventType === undefined || entry.eventType === 'rep'
  );
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

export const getMultiplier = async (plugin: RNPlugin) => {
  const multiplier = (await plugin.settings.getSetting<number>(multiplierId)) || 1.5;
  return multiplier;
};

export const removeLastInteraction = (history: IncrementalRep[]): IncrementalRep[] => {
  if (history.length === 0) {
    return history;
  }
  return history.slice(0, -1);
};

export async function getNextSpacingDateForRem(
  plugin: RNPlugin,
  remId: string,
  inLookbackMode: boolean
) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) {
    return;
  }
  const incrementalRemInfo = await getIncrementalRemFromRem(plugin, rem);
  if (!incrementalRemInfo) {
    return;
  }
  const multiplier = await getMultiplier(plugin);

  const rawHistory = incrementalRemInfo.history || [];
  const cleansedHistory = _.pipe(
    rawHistory,
    removeResponsesBeforeEarlyResponses,
    // remove the last repetition if we're in lookback mode
    inLookbackMode ? removeLastInteraction : _.identity
  );

  // Get only the reps since the last 'madeIncremental' marker for interval calculation
  // This ensures interval calculation restarts after re-activating a dismissed Rem
  const sessionHistory = getRepsSinceLastMadeIncremental(cleansedHistory);

  // NOTE: if you change to use nextRepDate, you'll need to handle lookback mode
  // it's a simple exponential, but shouldn't explode if you do a bunch of practice-all
  const newInterval = Math.ceil(multiplier ** Math.max(sessionHistory.length + 1, 1));
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
      // should fix if algo changes to use nextRepDate / scheduled / actual interval
      scheduled: scheduledDate,
      interval: newInterval,
      wasEarly: wasEarly,
      daysEarlyOrLate: daysEarlyOrLate,
      priority: incrementalRemInfo.priority, // Record priority at time of rep
      // reviewTimeSeconds will be added by reviewRem()
    },
  ];
  return {
    newNextRepDate,
    newHistory,
    remId,
    newInterval,
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
  await rem?.setPowerupProperty(powerupCode, nextRepDateSlotCode, dateReference);
  await rem?.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(newHistory)]);
}
