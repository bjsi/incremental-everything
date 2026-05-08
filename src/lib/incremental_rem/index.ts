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
  originalIncrementalDateSlotCode,
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
import { mergeHistoryFromDismissed } from '../dismissed';
import { registerRemsAsPdfKnown, registerRemsAsHtmlKnown, isHtmlSource } from '../pdfUtils';

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
  if (!incRem) return;

  try {
    await plugin.storage.setSession('plugin_operation_active', true);

    // 1. Capture the exact new data calculated by the review
    const reviewResult = await updateReviewRemData(plugin, incRem);

    if (reviewResult) {
      // 2. Manually patch the object using the new data
      const updatedIncRem: IncrementalRem = {
        ...incRem,
        nextRepDate: reviewResult.newNextRepDate,
        history: reviewResult.newHistory,
      };

      // 3. Update the cache with guaranteed fresh data
      await updateIncrementalRemCache(plugin as any, updatedIncRem);
    }

    // Keep the sleep to be safe
    await sleep(150);

    await plugin.queue.removeCurrentCardFromQueue();
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
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

  try {
    await plugin.storage.setSession('plugin_operation_active', true);

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

    // MANUALLY CONSTRUCT THE UPDATED OBJECT
    const updatedIncRem: IncrementalRem = {
      ...incRem,
      nextRepDate: targetDay,
      history: newHistory,
    };

    await updateIncrementalRemCache(plugin as any, updatedIncRem);

    await plugin.queue.removeCurrentCardFromQueue();
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
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

  // Read the original incremental date slot (Daily Document reference)
  let createdAt: number | undefined;
  const createdAtRichText = (await r.getPowerupPropertyAsRichText(
    powerupCode,
    originalIncrementalDateSlotCode
  )) as RichTextElementRemInterface[];
  if (createdAtRichText && createdAtRichText.length > 0 && createdAtRichText[0]?._id) {
    const createdAtDoc = await plugin.rem.findOne(createdAtRichText[0]._id);
    if (createdAtDoc) {
      const createdAtYYYYMMDD = await createdAtDoc.getPowerupProperty<BuiltInPowerupCodes.DailyDocument>(
        BuiltInPowerupCodes.DailyDocument,
        'Date'
      );
      if (createdAtYYYYMMDD) {
        createdAt = dayjs(createdAtYYYYMMDD, 'YYYY-MM-DD').valueOf();
      }
    }
  }

  const rawData = {
    remId: r._id,
    nextRepDate: date.valueOf(),
    priority: priority,
    history: tryParseJson(await r.getPowerupProperty(powerupCode, repHistorySlotCode)),
    createdAt,
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
export async function initIncrementalRem(plugin: ReactRNPlugin, rem: PluginRem, options?: { skipFlagManagement?: boolean, explicitParentId?: string, skipInitialCascade?: boolean }) {
  const isAlreadyIncremental = await rem.hasPowerup(powerupCode);

  if (!isAlreadyIncremental) {
    // Suppress GlobalRemChanged (skip if caller already holds the flag)
    if (!options?.skipFlagManagement) {
      await plugin.storage.setSession('plugin_operation_active', true);
    }

    let triggeredCascade = false;
    try {
      // Check for dismissed history to import (merge from previous learning sessions)
      const dismissedHistory = await mergeHistoryFromDismissed(plugin, rem);
      const hasExistingHistory = dismissedHistory && dismissedHistory.length > 0;

      const initialInterval = (await plugin.settings.getSetting<number>(initialIntervalId)) || 0;

      const defaultPrioritySetting = (await plugin.settings.getSetting<number>(defaultPriorityId)) || 10;
      const defaultPriority = Math.min(100, Math.max(0, defaultPrioritySetting));

      // Pass explicitParentId to override stale SDK cache when creating a new Rem and moving it
      const initialPriority = await getInitialPriority(plugin, rem, defaultPriority, options?.explicitParentId);

      await rem.addPowerup(powerupCode);

      const nextRepDate = new Date(Date.now() + (initialInterval * 24 * 60 * 60 * 1000));
      const dateRef = await getDailyDocReferenceForDate(plugin, nextRepDate);
      if (!dateRef) {
        return;
      }

      await rem.setPowerupProperty(powerupCode, nextRepDateSlotCode, dateRef);
      await rem.setPowerupProperty(powerupCode, prioritySlotCode, [initialPriority.toString()]);

      // Create 'madeIncremental' marker to indicate the start of a new learning session
      // This is used by the scheduler to count only reps since this marker
      const madeIncrementalMarker = {
        date: Date.now(),
        scheduled: Date.now(),
        eventType: 'madeIncremental' as const,
        priority: Number(initialPriority), // Record priority at time of creation
      };

      // Build history: dismissed history (if any) + madeIncremental marker
      const historyWithMarker = [
        ...(dismissedHistory || []),
        madeIncrementalMarker,
      ];

      await rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(historyWithMarker)]);

      // Set originalIncrementalDate only if no dismissed history (truly new Incremental Rem)
      if (!hasExistingHistory) {
        const todayRef = await getDailyDocReferenceForDate(plugin, new Date());
        if (todayRef) {
          await rem.setPowerupProperty(powerupCode, originalIncrementalDateSlotCode, todayRef);
        }
        // Record creation event in incremental history (fire and forget)
        addCreationToIncrementalHistory(plugin, rem._id).catch(console.error);
      }

      const newIncRem = await getIncrementalRemFromRem(plugin, rem);
      if (!newIncRem) {
        return;
      }

      await updateIncrementalRemCache(plugin, newIncRem);

      // Register in the known_pdf_rems_ / known_html_rems_ synced indexes so
      // the parent selector and bookmark popup can discover this IncRem
      // instantly (PART 2 of findAllRemsFor*), even when the session cache
      // (allIncrementalRemKey) is not yet loaded (e.g., WebBrowser / Light Mode).
      try {
        const sources = await rem.getSources();
        const allSources = [rem, ...sources];
        for (const candidate of allSources) {
          const isPdf = await candidate.hasPowerup(BuiltInPowerupCodes.UploadedFile);
          if (isPdf) {
            try {
              const url = await candidate.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL');
              if (typeof url === 'string' && url.toLowerCase().endsWith('.pdf')) {
                await registerRemsAsPdfKnown(plugin as any, candidate._id, [rem._id]);
              }
            } catch {
              // Skip candidates where URL can't be read
            }
            continue;
          }
          if (await isHtmlSource(candidate)) {
            try {
              await registerRemsAsHtmlKnown(plugin as any, candidate._id, [rem._id]);
            } catch {
              // Skip candidates that fail registration
            }
          }
        }
      } catch (e) {
        console.error('[initIncrementalRem] Error registering in known host indexes:', e);
      }

      // The targeted updateIncrementalRemCache call above already inserts the new
      // IncRem into the in-session cache, so no global reload trigger is needed.
      if (!options?.skipInitialCascade) {
        plugin.storage.setSession('pendingInheritanceCascade', rem._id).catch(console.error);
        triggeredCascade = true;
      }
    } finally {
      // Only clear the flag if no cascade was triggered.
      // If cascade IS pending, leave the flag up — the cascade tracker will clear it.
      // (Matches the correct pattern from batch_priority.tsx)
      if (!options?.skipFlagManagement && !triggeredCascade) {
        await plugin.storage.setSession('plugin_operation_active', false);
      }
    }
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

import { addToIncrementalHistory, addCreationToIncrementalHistory } from '../history_utils';

/**
 * Sets the current Incremental Rem in session storage.
 *
 * @param plugin - RemNote plugin instance
 * @param remId - The rem ID to set as current, or undefined to clear
 */
export const setCurrentIncrementalRem = async (plugin: RNPlugin, remId: string | undefined) => {
  if (remId) {
    // Fire and forget history update
    addToIncrementalHistory(plugin, remId).catch(console.error);
  }
  return await plugin.storage.setSession(currentIncRemKey, remId);
};

export * from './types';
export * from './cache';
export * from './action_items';
