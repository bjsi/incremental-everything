import { RNPlugin } from '@remnote/plugin-sdk';
import { multiplierId, nextRepDateSlotCode, powerupCode, repHistorySlotCode } from './consts';
import { IncrementalRep } from './types';
import * as _ from 'remeda';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getIncrementalRemInfo } from './incremental_rem';
import { getDailyDocReferenceForDate } from './date';
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
  const incrementalRemInfo = await getIncrementalRemInfo(plugin, rem);
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

  // NOTE: if you change to use nextRepDate, you'll need to handle lookback mode
  // it's a simple exponential, but shouldn't explode if you do a bunch of practice-all
  const newInterval = Math.ceil(multiplier ** Math.max(cleansedHistory.length, 1));
  const newNextRepDate = Date.now() + newInterval * 1000 * 60 * 60 * 24;
  const newHistory: IncrementalRep[] = [
    // if lookback mode, remove the last interaction but keep responsesBeforeEarlyResponses
    ...(inLookbackMode ? removeLastInteraction(rawHistory) : rawHistory),
    {
      date: Date.now(),
      // TODO: wrong in lookbackMode, but no way to compute because the old nextRepDate has been overwritten
      // should fix if algo changes to use nextRepDate / scheduled / actual interval
      scheduled: inLookbackMode ? dayjs().startOf('day').valueOf() : incrementalRemInfo.nextRepDate,
    },
  ];
  return {
    newNextRepDate,
    newHistory,
    remId,
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
