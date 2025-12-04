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
  currentIncRemKey,
  incremReviewStartTimeKey,
} from '../consts';
import { getNextSpacingDateForRem, updateSRSDataForRem } from '../scheduler';
import { IncrementalRem } from './types';
import { tryParseJson, getDailyDocReferenceForDate, sleep } from '../utils';
import { getInitialPriority } from '../priority_inheritance';
import { updateIncrementalRemCache } from './cache';

type ReviewOverrideOptions = {
  /**
   * If provided, force the next repetition to this timestamp (ms).
   */
  overrideNextRepDate?: number;
  /**
   * If provided, override the interval stored in history (in days).
   * Use together with overrideNextRepDate to keep metadata consistent.
   */
  overrideIntervalDays?: number;
};

/**
 * Persists the results of reviewing an incremental rem.
 *
 * Steps performed:
 * 1. Reads the session start time to calculate how long the review took (rounded seconds).
 * 2. Runs the scheduler to obtain the next repetition date plus a provisional history entry.
 * 3. Annotates that history entry with the measured review time and any manual overrides.
 * 4. Writes the updated next repetition reference + history back to the rem powerup slots.
 *
 * The session start time is intentionally left untouched so that other features (e.g. pdfUtils)
 * can still inspect it after this helper runs. Queue advancement is also left to the caller so
 * that different UI buttons can reuse this logic.
 *
 * @param plugin RNPlugin instance used for storage, queue, and rem updates.
 * @param incRem Incremental rem being reviewed; if undefined the function logs and returns null.
 * @param overrideOptions Allows UI gestures (drag-to-today/tomorrow) to force either the interval
 *                        stored in history or the exact next repetition timestamp.
 * @returns Next-spacing payload + final history array, or null when the rem could not be processed.
 */
export async function updateReviewRemData(
  plugin: RNPlugin,
  incRem: IncrementalRem | undefined,
  overrideOptions?: ReviewOverrideOptions
) {
  if (!incRem) {
    console.log("❌ [reviewRem] No incRem provided!");
    return null;
  }

  // 1. Calculate review time
  const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
  const reviewTimeSeconds = startTime ? dayjs().diff(dayjs(startTime), 'second') : undefined;

  // DEBUG LOGS
  console.log(`🔍 [reviewRem] ID: ${incRem.remId}`);
  console.log(`🔍 [reviewRem] Start Time: ${startTime}`);
  console.log(`🔍 [reviewRem] Calculated Duration: ${reviewTimeSeconds}`);

  const inLookbackMode = !!(await plugin.queue.inLookbackMode());
  const nextSpacing = await getNextSpacingDateForRem(plugin, incRem.remId, inLookbackMode);
  if (!nextSpacing) {
    return null;
  }

  const newHistory = [...nextSpacing.newHistory];
  const lastEntry = newHistory[newHistory.length - 1];
  if (lastEntry && reviewTimeSeconds !== undefined) {
    lastEntry.reviewTimeSeconds = reviewTimeSeconds;
  }

  // Apply manual overrides when provided (used by drag-to-next/today UX)
  if (overrideOptions?.overrideIntervalDays !== undefined && lastEntry) {
    lastEntry.interval = overrideOptions.overrideIntervalDays;
  }
  const nextRepDateToUse =
    overrideOptions?.overrideNextRepDate !== undefined
      ? overrideOptions.overrideNextRepDate
      : nextSpacing.newNextRepDate;

  await updateSRSDataForRem(plugin, incRem.remId, nextRepDateToUse, newHistory);

  return { ...nextSpacing, newHistory };
}

export async function handleNextRepetitionClick(
  plugin: RNPlugin,
  incRem: IncrementalRem | undefined
) {
  await updateReviewRemData(plugin, incRem);
    
  // Keep the sleep to be safe, but it's less critical now
  await sleep(150); 
  
  await plugin.queue.removeCurrentCardFromQueue();
}

/**
 * Same as handleNextRepetitionClick but allows forcing the next repetition
 * to a specific day offset (e.g., Today or Tomorrow) for the drag gesture UX.
 */
export async function handleNextRepetitionManualOffset(
  plugin: RNPlugin,
  incRem: IncrementalRem | undefined,
  offsetDays: number
) {
  if (!incRem) {
    console.log('[handleNextRepetitionManualOffset] No incRem provided');
    return;
  }

  // Simple: set next rep date to today or tomorrow without multiplier math
  const targetDay = dayjs().startOf('day').add(Math.max(offsetDays, 0), 'day').valueOf();

  const newHistory = [
    ...(incRem.history || []),
    {
      date: Date.now(),
      scheduled: targetDay,
      interval: Math.max(offsetDays, 0),
    },
  ];

  await updateSRSDataForRem(plugin, incRem.remId, targetDay, newHistory);
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

/**
 * Gets the current Incremental Rem from session storage.
 *
 * @param plugin - RemNote plugin instance
 * @returns The current PluginRem, or undefined if not found or not set
 */
export const getCurrentIncrementalRem = async (plugin: RNPlugin) => {
  const remId = await plugin.storage.getSession<string>(currentIncRemKey);
  const rem = await plugin.rem.findOne(remId);
  return rem;
};

/**
 * Sets the current Incremental Rem in session storage.
 *
 * @param plugin - RemNote plugin instance
 * @param remId - The rem ID to set as current, or undefined to clear
 */
export const setCurrentIncrementalRem = async (plugin: RNPlugin, remId: string | undefined) => {
  return await plugin.storage.setSession(currentIncRemKey, remId);
};

export * from './types';
export * from './cache';
export * from './action_items';
