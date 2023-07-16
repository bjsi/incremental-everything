import { RNPlugin } from '@remnote/plugin-sdk';
import { nextRepDateSlotCode, powerupCode, repHistorySlotCode } from './consts';
import { IncrementalRep } from './types';
import { tryParseJson } from './utils';
import * as _ from 'remeda';

export async function scheduleRem(plugin: RNPlugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  const history =
    tryParseJson(await rem?.getPowerupProperty(powerupCode, repHistorySlotCode)) || [];
  const prevRep = _.last(history) as IncrementalRep;
  const interval = prevRep ? (Date.now() - prevRep.date) / (1000 * 60 * 60 * 24) : 1;
  const newInterval = Math.round(interval * 2);
  const newNextRepDate = Date.now() + newInterval * 1000 * 60 * 60 * 24;
  const newHistory = [...(history || []), { date: Date.now() }];
  await rem?.setPowerupProperty(powerupCode, nextRepDateSlotCode, [newNextRepDate.toString()]);
  await rem?.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(newHistory)]);
}
