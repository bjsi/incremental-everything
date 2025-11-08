import {
  BuiltInPowerupCodes,
  PluginRem,
  RichTextElementRemInterface,
  RNPlugin,
} from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import {
  powerupCode,
  nextRepDateSlotCode,
  prioritySlotCode,
  repHistorySlotCode,
} from './consts';
import { getNextSpacingDateForRem, updateSRSDataForRem } from './scheduler';
import { IncrementalRem } from './types';
import { tryParseJson } from './utils';

// --- NEW CORE FUNCTION ---
/**
 * This is the new, fundamental function that only handles reviewing/rescheduling.
 * It does NOT advance the queue, making it reusable for different buttons.
 */
export async function reviewRem(plugin: RNPlugin, incRem: IncrementalRem | undefined) {
  if (!incRem) {
    return null;
  }
  const inLookbackMode = !!(await plugin.queue.inLookbackMode());
  const nextSpacing = await getNextSpacingDateForRem(plugin, incRem.remId, inLookbackMode);
  if (!nextSpacing) {
    return null;
  }
  await updateSRSDataForRem(plugin, incRem.remId, nextSpacing.newNextRepDate, nextSpacing.newHistory);
  return nextSpacing;
}

// --- REFACTORED ORIGINAL FUNCTION ---
/**
 * This function now uses the core `reviewRem` function and then performs
 * the specific action for the "Next" button: advancing the queue.
 */
export async function handleHextRepetitionClick(plugin: RNPlugin, incRem: IncrementalRem | undefined) {
  // Step 1: Call the core review logic
  await reviewRem(plugin, incRem);
  // Step 2: Perform the action specific to the "Next" button
  await plugin.queue.removeCurrentCardFromQueue();
}

// --- UNCHANGED ORIGINAL FUNCTION ---
/**
 * This function is essential and remains unchanged. It reads the raw
 * powerup data from a Rem and converts it into a structured object.
 */
export const getIncrementalRemInfo = async (
  plugin: RNPlugin,
  r: PluginRem | undefined
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