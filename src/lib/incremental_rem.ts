import {
  BuiltInPowerupCodes,
  Rem,
  RichTextElementRemInterface,
  RNPlugin,
} from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import {
  powerupCode,
  nextRepDateSlotCode,
  prioritySlotCode,
  repHistorySlotCode,
  allIncrementalRemKey,
} from './consts';
import { getNextSpacingDateForRem, updateSRSDataForRem } from './scheduler';
import { IncrementalRem } from './types';
import { tryParseJson } from './utils';

export async function handleHextRepetitionClick(
  plugin: RNPlugin,
  incRem: IncrementalRem | null | undefined
) {
  if (incRem) {
    // get next rep date
    const inLookbackMode = !!(await plugin.queue.inLookbackMode());
    const data = await getNextSpacingDateForRem(plugin, incRem.remId, inLookbackMode);
    if (!data) {
      return;
    }
    const { newHistory, newNextRepDate } = data;
    // update allIncrementalRem in storage to get around reactivity issues
    const oldAllRem: IncrementalRem[] =
      (await plugin.storage.getSession(allIncrementalRemKey)) || [];
    const oldRem = oldAllRem.find((r) => r.remId === incRem.remId);
    if (!oldRem) {
      return;
    }
    await plugin.storage.setSession(
      allIncrementalRemKey,
      oldAllRem
        .filter((r) => r.remId !== incRem.remId)
        .concat({
          ...oldRem,
          nextRepDate: newNextRepDate,
          history: newHistory,
        })
    );
    // actually update the rem
    await updateSRSDataForRem(plugin, incRem.remId, newNextRepDate, newHistory);
    // move to next card
    await plugin.queue.removeCurrentCardFromQueue();
  }
}

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
