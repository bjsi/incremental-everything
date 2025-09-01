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
import { IncrementalRem, IncrementalRep } from './types'; // Import IncrementalRep
import { tryParseJson } from './utils';

// --- NEW SHARED HELPER FUNCTION ---
// This function contains the logic common to both "Next" and the new "Reschedule" button.
export async function processRepetition(
  plugin: RNPlugin,
  incRem: IncrementalRem,
  newNextRepDate: number,
  newHistory: IncrementalRep[]
) {
  // 1. Update the session cache with the new date and history
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

  // 2. Update the Rem's powerup properties in RemNote
  await updateSRSDataForRem(plugin, incRem.remId, newNextRepDate, newHistory);

  // 3. Remove the current card from the queue
  await plugin.queue.removeCurrentCardFromQueue();
}

// --- REFACTORED ORIGINAL FUNCTION ---
// Now simplified to just calculate the date and then call the shared function.
export async function handleHextRepetitionClick(
  plugin: RNPlugin,
  incRem: IncrementalRem | null | undefined
) {
  if (incRem) {
    const inLookbackMode = !!(await plugin.queue.inLookbackMode());
    const data = await getNextSpacingDateForRem(plugin, incRem.remId, inLookbackMode);
    if (!data) {
      return;
    }
    const { newHistory, newNextRepDate } = data;
    // Call the shared processing logic
    await processRepetition(plugin, incRem, newNextRepDate, newHistory);
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
  if (!nextRepDateRichText || nextRepDateRichText.length === 0 || !nextRepDateRichText[0]?._id) {
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

  const priorityRichText = await r.getPowerupPropertyAsRichText(powerupCode, prioritySlotCode);
  let priority = 10;
  if (priorityRichText && priorityRichText.length > 0) {
    const priorityString = await plugin.richText.toString(priorityRichText);
    const parsedPriority = parseInt(priorityString, 10);
    if (!isNaN(parsedPriority)) {
      priority = parsedPriority;
    }
  }

  const rawData = {
    remId: r._id,
    nextRepDate: date.valueOf(),
    priority: priority,
    history: tryParseJson(await r.getPowerupProperty(powerupCode, repHistorySlotCode)),
  };

  const parsed = IncrementalRem.safeParse(rawData);
  if (parsed.success) {
    return parsed.data;
  } else {
    console.error(
      'Failed to parse incremental rem info for Rem with id: ' +
        r._id +
        'with error: ',
      parsed.error
    );
    return null;
  }
};