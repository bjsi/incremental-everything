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
  allIncrementalRemKey,
} from './consts';
import { getNextSpacingDateForRem, updateSRSDataForRem } from './scheduler';
import { IncrementalRem } from './types';
import { tryParseJson } from './utils';
import { getDailyDocReferenceForDate } from './date';
import { getInitialPriority } from './priority_inheritance';

// --- NEW CORE FUNCTION ---
/**
 * This is the new, fundamental function that only handles reviewing/rescheduling.
 * It does NOT advance the queue, making it reusable for different buttons.
 */
export async function reviewRem(
  plugin: RNPlugin, 
  incRem: IncrementalRem | undefined,
  queueMode?: 'srs' | 'practice-all' | 'in-order' | 'editor'
) {
  if (!incRem) {
    return null;
  }
  
  // Calculate review time
  const startTime = await plugin.storage.getSession<number>('increm-review-start-time');
  const reviewTimeSeconds = startTime ? Math.round((Date.now() - startTime) / 1000) : undefined;
  
  const inLookbackMode = !!(await plugin.queue.inLookbackMode());
  const nextSpacing = await getNextSpacingDateForRem(plugin, incRem.remId, inLookbackMode, queueMode);
  if (!nextSpacing) {
    return null;
  }
  
  // Add review time to the last history entry
  const newHistory = [...nextSpacing.newHistory];
  const lastEntry = newHistory[newHistory.length - 1];
  if (lastEntry && reviewTimeSeconds !== undefined) {
    lastEntry.reviewTimeSeconds = reviewTimeSeconds;
  }
  
  await updateSRSDataForRem(plugin, incRem.remId, nextSpacing.newNextRepDate, newHistory);
  
  // Clear the start time
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

    const newIncRem = await getIncrementalRemInfo(plugin, rem);
    if (!newIncRem) {
      return;
    }

    const allIncrementalRem: IncrementalRem[] =
      (await plugin.storage.getSession(allIncrementalRemKey)) || [];
    const updatedAllRem = allIncrementalRem
      .filter((x) => x.remId !== newIncRem.remId)
      .concat(newIncRem);
    await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
  }
}

/**
 * Loads all Rems tagged with the Incremental powerup and caches them in session storage.
 *
 * Processes rems in batches to avoid overwhelming the API. Invalid rems are filtered out.
 *
 * @param plugin Plugin instance with powerup/rem/storage access
 * @param batchSize Number of rems to process per batch (default: 500)
 * @param batchDelayMs Delay in milliseconds between batches (default: 100)
 * @returns Array of successfully loaded IncrementalRem objects
 */
export async function loadAllIncrementalRems(
  plugin: ReactRNPlugin,
  batchSize: number = 500,
  batchDelayMs: number = 100
): Promise<IncrementalRem[]> {
  console.log('TRACKER: Incremental Rem tracker starting...');

  const powerup = await plugin.powerup.getPowerupByCode(powerupCode);
  const taggedRem = (await powerup?.taggedRem()) || [];
  console.log(`TRACKER: Found ${taggedRem.length} Incremental Rems. Starting batch processing...`);

  const updatedAllRem: IncrementalRem[] = [];
  const numBatches = Math.ceil(taggedRem.length / batchSize);

  for (let i = 0; i < taggedRem.length; i += batchSize) {
    const batch = taggedRem.slice(i, i + batchSize);
    console.log(`TRACKER: Processing IncRem batch ${Math.floor(i / batchSize) + 1} of ${numBatches}...`);

    const batchInfos = (
      await Promise.all(batch.map((rem) => getIncrementalRemInfo(plugin, rem)))
    ).filter(Boolean) as IncrementalRem[];

    updatedAllRem.push(...batchInfos);

    await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
  }

  console.log(`TRACKER: Processing complete. Final IncRem cache size is ${updatedAllRem.length}.`);
  await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
  console.log('TRACKER: Incremental Rem cache has been saved.');

  return updatedAllRem;
}