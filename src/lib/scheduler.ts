import { RNPlugin } from '@remnote/plugin-sdk';
import { nextRepDateSlotCode, powerupCode, repHistorySlotCode } from './consts';
import { IncrementalRep } from './types';
import { tryParseJson } from './utils';
import * as _ from 'remeda';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
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

export async function getNextSpacingDateForRem(plugin: RNPlugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  const history =
    tryParseJson(await rem?.getPowerupProperty(powerupCode, repHistorySlotCode)) || [];
  const cleansedHistory = removeResponsesBeforeEarlyResponses(history);
  const prevRep = _.last(cleansedHistory) as IncrementalRep;
  const interval = Math.max(prevRep ? (Date.now() - prevRep.date) / (1000 * 60 * 60 * 24) : 1, 1);
  const newInterval = Math.round(interval * 2);
  const newNextRepDate = Date.now() + newInterval * 1000 * 60 * 60 * 24;
  const newHistory = [...(history || []), { date: Date.now() }];
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
  await rem?.setPowerupProperty(powerupCode, nextRepDateSlotCode, [newNextRepDate.toString()]);
  await rem?.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(newHistory)]);
}
