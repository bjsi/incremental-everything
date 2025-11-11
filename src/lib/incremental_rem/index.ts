import {
  BuiltInPowerupCodes,
  PluginRem,
  RichTextElementRemInterface,
  RNPlugin,
  ReactRNPlugin,
} from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import {
  powerupCode,
  nextRepDateSlotCode,
  prioritySlotCode,
  repHistorySlotCode,
  initialIntervalId,
  defaultPriorityId,
} from '../consts';
import { getNextSpacingDateForRem, updateSRSDataForRem } from '../scheduler';
import { IncrementalRem } from './types';
import { tryParseJson, getDailyDocReferenceForDate } from '../utils';
import { getInitialPriority } from '../priority_inheritance';
import { updateIncrementalRemCache } from './cache';

/**
 * Processes the review of an Incremental Rem and reschedules it for the next repetition.
 *
 * This function:
 * 1. Calculates how long the user spent reviewing the rem
 * 2. Determines the next review date based on the SRS algorithm
 * 3. Updates the repetition history with the review time
 * 4. Persists the new scheduling data to the rem
 *
 * NOTE: This function does NOT advance the queue - that's the caller's responsibility.
 * This design allows different UI buttons to reuse this logic and control queue advancement independently.
 *
 * @param plugin - RemNote plugin instance
 * @param incRem - The incremental rem being reviewed
 * @param queueMode - Current queue mode (affects scheduling algorithm)
 * @returns The updated spacing data with new history, or null if review cannot be processed
 */
export async function reviewRem(
  plugin: RNPlugin,
  incRem: IncrementalRem | undefined,
  queueMode?: 'srs' | 'practice-all' | 'in-order' | 'editor'
) {
  if (!incRem) {
    return null;
  }

  const startTime = await plugin.storage.getSession<number>('increm-review-start-time');
  const reviewTimeSeconds = startTime ? Math.round((Date.now() - startTime) / 1000) : undefined;

  const inLookbackMode = !!(await plugin.queue.inLookbackMode());
  const nextSpacing = await getNextSpacingDateForRem(plugin, incRem.remId, inLookbackMode, queueMode);
  if (!nextSpacing) {
    return null;
  }

  const newHistory = [...nextSpacing.newHistory];
  const lastEntry = newHistory[newHistory.length - 1];
  if (lastEntry && reviewTimeSeconds !== undefined) {
    lastEntry.reviewTimeSeconds = reviewTimeSeconds;
  }

  await updateSRSDataForRem(plugin, incRem.remId, nextSpacing.newNextRepDate, newHistory);

  await plugin.storage.setSession('increm-review-start-time', null);

  return { ...nextSpacing, newHistory };
}

export async function handleHextRepetitionClick(
  plugin: RNPlugin,
  incRem: IncrementalRem | undefined,
  queueMode?: 'srs' | 'practice-all' | 'in-order'
) {
  await reviewRem(plugin, incRem, queueMode);
  await plugin.queue.removeCurrentCardFromQueue();
}

/**
 * Constructs an IncrementalRem object from a PluginRem by reading and parsing its powerup properties.
 *
 * This function acts as a factory/constructor that:
 * 1. Reads the raw powerup data (next rep date, priority, history) from the rem
 * 2. Parses and validates the data
 * 3. Returns a structured IncrementalRem object
 *
 * @param plugin - RemNote plugin instance
 * @param r - The PluginRem to convert into an IncrementalRem
 * @returns The constructed IncrementalRem object, or null if the rem is not incremental or data is invalid
 */
export const getIncrementalRemFromRem = async (
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

/**
 * Ensures the provided Rem is initialized as an Incremental Rem with defaults.
 *
 * @param plugin ReactRNPlugin used for settings/storage access.
 * @param rem PluginRem to initialize.
 * @returns Promise that resolves after the Rem is initialized or skipped if already incremental.
 */
export async function initIncrementalRem(plugin: ReactRNPlugin, rem: PluginRem) {
  const isAlreadyIncremental = await rem.hasPowerup(powerupCode);

  if (!isAlreadyIncremental) {
    const initialInterval = (await plugin.settings.getSetting<number>(initialIntervalId)) || 0;

    const defaultPrioritySetting = (await plugin.settings.getSetting<number>(defaultPriorityId)) || 10;
    const defaultPriority = Math.min(100, Math.max(0, defaultPrioritySetting));

    const initialPriority = await getInitialPriority(plugin, rem, defaultPriority);

    await rem.addPowerup(powerupCode);

    const nextRepDate = new Date(Date.now() + (initialInterval * 24 * 60 * 60 * 1000));
    const dateRef = await getDailyDocReferenceForDate(plugin, nextRepDate);
    if (!dateRef) {
      return;
    }

    await rem.setPowerupProperty(powerupCode, nextRepDateSlotCode, dateRef);
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [initialPriority.toString()]);
    await rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify([])]);

    const newIncRem = await getIncrementalRemFromRem(plugin, rem);
    if (!newIncRem) {
      return;
    }

    await updateIncrementalRemCache(plugin, newIncRem);
  }
}

export * from './types';
export * from './cache';
export * from './action_items';
