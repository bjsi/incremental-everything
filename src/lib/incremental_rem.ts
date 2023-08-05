import { Rem } from '@remnote/plugin-sdk';
import { powerupCode, nextRepDateSlotCode, prioritySlotCode, repHistorySlotCode } from './consts';
import { IncrementalRem } from './types';
import { tryParseJson } from './utils';

export const getIncrementalRemInfo = async (r: Rem) => {
  const rawData = {
    remId: r._id,
    nextRepDate: tryParseJson(await r.getPowerupProperty(powerupCode, nextRepDateSlotCode)),
    priority: tryParseJson(await r.getPowerupProperty(powerupCode, prioritySlotCode)),
    history: tryParseJson(await r.getPowerupProperty(powerupCode, repHistorySlotCode)),
  };
  const parsed = IncrementalRem.safeParse(rawData);
  if (parsed.success) {
    return parsed.data;
  } else {
    console.log(
      'Failed to parse incremental rem info for Rem with id: ' +
        r._id +
        'with error: ' +
        parsed.error
    );
    return null;
  }
};
