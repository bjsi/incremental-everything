import {
  BuiltInPowerupCodes,
  Rem,
  RichTextElementRemInterface,
  RNPlugin,
} from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import { powerupCode, nextRepDateSlotCode, prioritySlotCode, repHistorySlotCode } from './consts';
import { IncrementalRem } from './types';
import { tryParseJson } from './utils';

export const getIncrementalRemInfo = async (
  plugin: RNPlugin,
  r: Rem | undefined
): Promise<IncrementalRem | null> => {
  if (!r) {
    return null;
  }
  const nextRepDateRichText = (await r.getPowerupPropertyAsRichText(
    powerupCode,
    nextRepDateSlotCode
  )) as RichTextElementRemInterface[];
  if (!nextRepDateRichText || nextRepDateRichText.length === 0 || !nextRepDateRichText[0]._id) {
    return null;
  }

  const nextRepDateDoc = await plugin.rem.findOne(nextRepDateRichText[0]._id);
  if (!nextRepDateDoc) {
    return null;
  }

  const yyyymmdd = await nextRepDateDoc.getPowerupProperty<BuiltInPowerupCodes.DailyDocument>(
    BuiltInPowerupCodes.DailyDocument,
    'Date'
  );

  if (!yyyymmdd) {
    return null;
  }

  const date = dayjs(yyyymmdd, 'YYYY-MM-DD');

  const rawData = {
    remId: r._id,
    nextRepDate: date.valueOf(),
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
