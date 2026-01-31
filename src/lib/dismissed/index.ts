import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import {
    dismissedPowerupCode,
    dismissedHistorySlotCode,
    dismissedDateSlotCode,
} from '../consts';
import { IncrementalRep } from '../incremental_rem/types';
import { tryParseJson, getDailyDocReferenceForDate } from '../utils';

/**
 * Check if a Rem has the dismissed powerup.
 */
export async function hasDismissedHistory(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
    return await rem.hasPowerup(dismissedPowerupCode);
}

/**
 * Get dismissed history and date from a Rem.
 * 
 * @returns Object with history array and dismissedDate, or null if no dismissed powerup
 */
export async function getDismissedHistoryFromRem(
    plugin: RNPlugin,
    rem: PluginRem
): Promise<{ history: IncrementalRep[]; dismissedDate: number | null } | null> {
    const hasPowerup = await rem.hasPowerup(dismissedPowerupCode);
    if (!hasPowerup) {
        return null;
    }

    const historyRaw = await rem.getPowerupProperty(dismissedPowerupCode, dismissedHistorySlotCode);
    const history: IncrementalRep[] = tryParseJson(historyRaw) || [];

    // Get dismissed date - we need to parse it from the DATE property reference
    const dismissedDateRef = await rem.getPowerupProperty(dismissedPowerupCode, dismissedDateSlotCode);
    let dismissedDate: number | null = null;

    // The DATE property stores a reference to a daily doc, we need to extract the timestamp
    // For now, we'll store it as a JSON number in the slot content
    if (dismissedDateRef && typeof dismissedDateRef === 'number') {
        dismissedDate = dismissedDateRef;
    }

    return { history, dismissedDate };
}

/**
 * Transfer history from an Incremental Rem to the dismissed powerup.
 * This adds the dismissed powerup and stores the history + dismissed date.
 * A 'dismissed' marker is added to the history to indicate the end of the learning session.
 * 
 * @param plugin RNPlugin instance
 * @param rem The Rem to add dismissed powerup to
 * @param history The history array to store
 */
export async function transferToDismissed(
    plugin: RNPlugin,
    rem: PluginRem,
    history: IncrementalRep[]
): Promise<void> {
    if (!history || history.length === 0) {
        return;
    }

    // Create 'dismissed' marker to indicate the end of this learning session
    const dismissedMarker: IncrementalRep = {
        date: Date.now(),
        scheduled: Date.now(),
        eventType: 'dismissed',
    };

    // Add the dismissed marker to the history
    const historyWithMarker = [...history, dismissedMarker];

    // Check if already has dismissed powerup (avoid duplicates)
    const alreadyDismissed = await rem.hasPowerup(dismissedPowerupCode);

    if (alreadyDismissed) {
        // Merge histories: existing dismissed + new history with marker
        const existing = await getDismissedHistoryFromRem(plugin, rem);
        const mergedHistory = [...(existing?.history || []), ...historyWithMarker];
        await rem.setPowerupProperty(dismissedPowerupCode, dismissedHistorySlotCode, [JSON.stringify(mergedHistory)]);
    } else {
        // Add dismissed powerup with history
        await rem.addPowerup(dismissedPowerupCode);
        await rem.setPowerupProperty(dismissedPowerupCode, dismissedHistorySlotCode, [JSON.stringify(historyWithMarker)]);

        // Set dismissed date using daily doc reference
        const now = new Date();
        const dateRef = await getDailyDocReferenceForDate(plugin, now);
        if (dateRef) {
            await rem.setPowerupProperty(dismissedPowerupCode, dismissedDateSlotCode, dateRef);
        }
    }
}

/**
 * Merge history from dismissed powerup into a new Incremental Rem.
 * This reads the dismissed history, removes the dismissed powerup, and returns
 * the history array to be used when initializing the Incremental Rem.
 * 
 * @param plugin RNPlugin instance
 * @param rem The Rem to check for dismissed history
 * @returns The merged history array, or empty array if no dismissed history
 */
export async function mergeHistoryFromDismissed(
    plugin: RNPlugin,
    rem: PluginRem
): Promise<IncrementalRep[]> {
    const hasPowerup = await rem.hasPowerup(dismissedPowerupCode);
    if (!hasPowerup) {
        return [];
    }

    const dismissed = await getDismissedHistoryFromRem(plugin, rem);
    const history = dismissed?.history || [];

    // Remove the dismissed powerup since we're re-activating as Incremental
    await rem.removePowerup(dismissedPowerupCode);

    console.log(`[Dismissed] Merged ${history.length} history entries from dismissed powerup`);

    return history;
}
