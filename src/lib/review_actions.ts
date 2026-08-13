import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import { getActivePdfForIncRem, getIncrementalReadingPosition, addPageToHistory, safeRemTextToString } from './pdfUtils';
import { getIncrementalRemFromRem, updateReviewRemData } from './incremental_rem';
import { updateIncrementalRemCache } from './incremental_rem/cache';
import { IncrementalRep } from './incremental_rem/types';
import { updateSRSDataForRem } from './scheduler';
import { stampNoteAndContext } from './history_notes';
import { incremReviewStartTimeKey } from './consts';
import { determineIncRemType } from './incRemHelpers';
import { markIncRemTransition } from './queue_session';

/**
 * Move the queue's Incremental-review baseline forward by `seconds`.
 *
 * Used when the user records a review for a DIFFERENT rem (one opened in the
 * previewer) while an IncRem turn is on screen: those minutes were spent on
 * that other rem, so they must not also be credited to the item the queue is
 * showing. Shifting the baseline is enough — every consumer of the turn's
 * duration (Next, Dismiss, Reschedule) derives it from this key.
 *
 * @returns the number of seconds actually deducted (never more than elapsed).
 */
export async function deductFromQueueIncRemClock(
    plugin: RNPlugin,
    seconds: number
): Promise<number> {
    if (!(seconds > 0)) return 0;

    const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
    if (!startTime) return 0;

    const elapsedMs = Math.max(0, Date.now() - startTime);
    const deductMs = Math.min(Math.round(seconds * 1000), elapsedMs);
    if (deductMs <= 0) return 0;

    await plugin.storage.setSession(incremReviewStartTimeKey, startTime + deductMs);
    return Math.round(deductMs / 1000);
}

/** What happens to the schedule of an IncRem turn the user is walking away from. */
export type LeaveTurnMode = 'reschedule' | 'due';

/**
 * Close out the Incremental Rem turn the queue is showing, because the user is
 * leaving it to review a different rem in the editor.
 *
 * A repetition is recorded either way — the reading time already spent is real
 * — and `mode` decides the schedule: 'reschedule' applies the normal computed
 * interval (as the Next button does), 'due' keeps the item due today (as the
 * drag-down "Repeat today" gesture does).
 *
 * `carrySeconds` is time the user attributes to the rem they are jumping to; it
 * is deducted from the duration recorded here.
 *
 * The queue is deliberately NOT advanced: the caller navigates away to the
 * editor, and `removeCurrentCardFromQueue` from a dying sandbox is exactly the
 * race the Dismiss paths document.
 */
export async function finishQueueIncRemTurn(
    plugin: RNPlugin,
    incRemId: string,
    mode: LeaveTurnMode,
    carrySeconds = 0
): Promise<{ recordedSeconds: number; nextRepDate: number } | null> {
    const rem = await plugin.rem.findOne(incRemId);
    if (!rem) return null;

    const incRem = await getIncrementalRemFromRem(plugin, rem);
    if (!incRem) return null;

    // Carried time belongs to the other rem: take it off the baseline first, so
    // the reschedule path (which reads the same key) sees the corrected span.
    const carried = await deductFromQueueIncRemClock(plugin, carrySeconds);

    const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
    const recordedSeconds = startTime ? Math.max(0, Math.round((Date.now() - startTime) / 1000)) : 0;

    let nextRepDate: number;

    if (mode === 'reschedule') {
        const result = await updateReviewRemData(plugin, incRem);
        if (!result) return null;
        nextRepDate = result.newNextRepDate;
        await updateIncrementalRemCache(plugin, {
            ...incRem,
            nextRepDate,
            history: result.newHistory,
        });
    } else {
        // "Repeat today": start of today is in the past, so the item is due
        // again immediately — the same timestamp the drag-down gesture writes.
        nextRepDate = dayjs().startOf('day').valueOf();

        const entry: IncrementalRep = {
            date: Date.now(),
            scheduled: incRem.nextRepDate,
            interval: 0,
            reviewTimeSeconds: recordedSeconds,
            eventType: 'rep',
            // Same guard as the scheduler: a 'fallback' priority is a placeholder,
            // and stamping it would freeze a wrong value into history.
            ...(incRem.prioritySource === 'fallback' ? {} : { priority: incRem.priority }),
        };
        await stampNoteAndContext(plugin, rem, entry);

        const newHistory = [...(incRem.history || []), entry];
        await updateSRSDataForRem(plugin, incRemId, nextRepDate, newHistory);
        await updateIncrementalRemCache(plugin, {
            ...incRem,
            nextRepDate,
            history: newHistory,
        });
    }

    // The turn is over: nothing may inherit this clock (least of all the rem the
    // user is jumping to, whose own engagement starts now).
    await plugin.storage.setSession(incremReviewStartTimeKey, null);

    console.log(
        `[ReviewActions] Left IncRem turn ${incRemId} (${mode}): recorded ${recordedSeconds}s` +
        (carried ? `, carried ${carried}s to the target` : '')
    );

    return { recordedSeconds, nextRepDate };
}

export const handleReviewInEditorRem = async (
    plugin: RNPlugin,
    rem: PluginRem | undefined,
    remType: string | null | undefined,
    // Optional: navigate to a DIFFERENT rem at the end (e.g. a read-point
    // descendant) while the review/timer still target `rem` (the IncRem). Used
    // by the queue's read-point button to jump into the outline at the bookmark.
    //
    // `queueHandoff: false` says this rem was NOT the one the queue was
    // reviewing (it was picked from a selection / the previewer), so the editor
    // engagement that starts now is a new one rather than the continuation of a
    // queue turn.
    options?: { navigateToRemId?: string; queueHandoff?: boolean }
) => {
    if (!rem) return;

    if (remType === 'pdf') {
        const pdfRem = await getActivePdfForIncRem(plugin, rem);
        if (pdfRem) {
            const currentPage = await getIncrementalReadingPosition(plugin, rem._id, pdfRem._id);

            if (currentPage) {
                await addPageToHistory(plugin, rem._id, pdfRem._id, currentPage);
            }
        }
    }

    const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
    await updateReviewRemData(plugin, incRemInfo ?? undefined);

    // Tell PracticedQueues this is a queue→editor handoff for the same rem,
    // so the editor timer's startIncRemEngagement doesn't double-count it.
    // Skipped when this rem was not the one on screen: nothing to continue, and
    // suppressing the count would lose the rep entirely.
    if (options?.queueHandoff !== false) {
        markIncRemTransition(plugin, rem._id);
    }

    // Start the timer
    const remName = await safeRemTextToString(plugin, rem.text);
    const existingStartTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
    await plugin.storage.setSession('editor-review-timer-rem-id', rem._id);
    await plugin.storage.setSession('editor-review-timer-start', existingStartTime || Date.now());
    // We do not set an interval since the repetition was already recorded above
    await plugin.storage.setSession('editor-review-timer-interval', null);
    await plugin.storage.setSession('editor-review-timer-priority', incRemInfo?.priority ?? 10);
    await plugin.storage.setSession('editor-review-timer-rem-name', remName || 'Unnamed Rem');
    await plugin.storage.setSession('editor-review-timer-from-queue', true);
    await plugin.storage.setSession('editor-review-timer-origin', 'queue');

    await plugin.app.toast(`⏱️ Timer started for: ${remName}`);

    // Navigate to an explicit target rem (read point) when requested — always
    // via openRem, since the target is a normal outline rem (not a PDF page).
    const navId = options?.navigateToRemId;
    if (navId && navId !== rem._id) {
        const target = await plugin.rem.findOne(navId);
        if (target) {
            await plugin.window.openRem(target);
            return;
        }
        // Target missing (deleted?) — fall through to the default navigation.
    }

    const incRemType = await determineIncRemType(plugin, rem);

    if (incRemType === 'pdf-note') {
        await rem.openRemAsPage();
    } else {
        await plugin.window.openRem(rem);
    }
};

