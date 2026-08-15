import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import { getActivePdfForIncRem, getIncrementalReadingPosition, addPageToHistory, safeRemTextToString } from './pdfUtils';
import { getIncrementalRemFromRem, updateReviewRemData } from './incremental_rem';
import { updateIncrementalRemCache } from './incremental_rem/cache';
import { IncrementalRep } from './incremental_rem/types';
import { updateSRSDataForRem } from './scheduler';
import { stampNoteAndContext } from './history_notes';
import {
    incremReviewStartTimeKey,
    editorReviewTimerRemIdKey,
    editorReviewTimerStartKey,
    editorReviewTimerIntervalKey,
    editorReviewTimerPriorityKey,
    editorReviewTimerRemNameKey,
    editorReviewTimerAccumulatedMsKey,
    editorReviewTimerPausedAtKey,
    editorReviewTimerOriginKey,
    editorReviewTimerDateOverrideKey,
} from './consts';
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

/** The Editor Review Timer's clock, read as one value. */
export interface EditorTimerState {
    remId: string;
    name: string;
    /** accumulated + the running (or frozen) segment, in seconds. */
    elapsedSeconds: number;
    /** Interval the timer was started with — what End Review would schedule. */
    interval: number | null;
    /** 'queue' means the repetition already exists (written at the handoff). */
    origin: string | null;
    isPaused: boolean;
}

/** Read the Editor Review Timer's session state, or null when none is running. */
export async function readEditorTimerState(plugin: RNPlugin): Promise<EditorTimerState | null> {
    const remId = await plugin.storage.getSession<string>(editorReviewTimerRemIdKey);
    if (!remId) return null;

    const start = await plugin.storage.getSession<number>(editorReviewTimerStartKey);
    const accumulatedMs = (await plugin.storage.getSession<number>(editorReviewTimerAccumulatedMsKey)) ?? 0;
    const pausedAt = await plugin.storage.getSession<number>(editorReviewTimerPausedAtKey);
    const interval = await plugin.storage.getSession<number>(editorReviewTimerIntervalKey);
    const origin = await plugin.storage.getSession<string>(editorReviewTimerOriginKey);
    const name = await plugin.storage.getSession<string>(editorReviewTimerRemNameKey);

    // Same formula the timer widget displays: when paused, the segment is
    // frozen at pausedAt instead of running to now.
    const until = pausedAt ?? Date.now();
    const elapsedMs = Math.max(0, accumulatedMs + (start ? until - start : 0));

    return {
        remId,
        name: name || 'Unnamed Rem',
        elapsedSeconds: Math.round(elapsedMs / 1000),
        interval: typeof interval === 'number' ? interval : null,
        origin: origin ?? null,
        isPaused: !!pausedAt,
    };
}

/**
 * Take `seconds` off the Editor Review Timer — the editor-side counterpart of
 * `deductFromQueueIncRemClock`, for time the user spent on a DIFFERENT rem
 * while this review was running.
 *
 * The queue keeps one baseline; this clock is a pair, so the deduction is done
 * by normalising: the remaining time becomes the whole accumulated value and
 * the segment restarts from now (or from `pausedAt`, leaving a paused timer
 * frozen where it was). Both states then read back exactly `elapsed − seconds`.
 *
 * @returns the number of seconds actually deducted (never more than elapsed).
 */
export async function deductFromEditorTimerClock(
    plugin: RNPlugin,
    seconds: number
): Promise<number> {
    if (!(seconds > 0)) return 0;

    const remId = await plugin.storage.getSession<string>(editorReviewTimerRemIdKey);
    if (!remId) return 0;

    const start = await plugin.storage.getSession<number>(editorReviewTimerStartKey);
    const accumulatedMs = (await plugin.storage.getSession<number>(editorReviewTimerAccumulatedMsKey)) ?? 0;
    const pausedAt = await plugin.storage.getSession<number>(editorReviewTimerPausedAtKey);

    const until = pausedAt ?? Date.now();
    const elapsedMs = Math.max(0, accumulatedMs + (start ? until - start : 0));
    const deductMs = Math.min(Math.round(seconds * 1000), elapsedMs);
    if (deductMs <= 0) return 0;

    await plugin.storage.setSession(editorReviewTimerAccumulatedMsKey, elapsedMs - deductMs);
    await plugin.storage.setSession(editorReviewTimerStartKey, until);

    return Math.round(deductMs / 1000);
}

/** Clear every session key belonging to a finished Editor Review Timer. */
async function clearEditorTimerSession(plugin: RNPlugin): Promise<void> {
    await plugin.storage.setSession(editorReviewTimerRemIdKey, undefined);
    await plugin.storage.setSession(editorReviewTimerStartKey, undefined);
    await plugin.storage.setSession(editorReviewTimerIntervalKey, undefined);
    await plugin.storage.setSession(editorReviewTimerPriorityKey, undefined);
    await plugin.storage.setSession(editorReviewTimerRemNameKey, undefined);
    await plugin.storage.setSession('editor-review-timer-from-queue', undefined);
    await plugin.storage.setSession(editorReviewTimerOriginKey, undefined);
    await plugin.storage.setSession(editorReviewTimerPausedAtKey, undefined);
    await plugin.storage.setSession(editorReviewTimerAccumulatedMsKey, undefined);
    await plugin.storage.setSession(editorReviewTimerDateOverrideKey, undefined);
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

/**
 * Close out the Editor Review Timer because the user is starting a review of a
 * DIFFERENT rem — the editor counterpart of `finishQueueIncRemTurn`.
 *
 * Recording mirrors End Review exactly, including its two modes: a review that
 * came from the queue handoff already HAS its repetition (written when the
 * handoff ran), so only the duration is stamped onto that entry; a review
 * started in the editor creates its `executeRepetition` entry here.
 *
 * `mode` decides the schedule — 'reschedule' keeps what End Review would have
 * scheduled, 'due' brings the item back today. `carrySeconds` is time the user
 * attributes to the rem they are switching to, deducted from what is recorded.
 *
 * The timer session is cleared either way: the review is over.
 */
export async function finishEditorReviewTurn(
    plugin: RNPlugin,
    mode: LeaveTurnMode,
    carrySeconds = 0
): Promise<{ recordedSeconds: number; nextRepDate: number } | null> {
    const timer = await readEditorTimerState(plugin);
    if (!timer) return null;

    const rem = await plugin.rem.findOne(timer.remId);
    const incRem = rem ? await getIncrementalRemFromRem(plugin, rem) : null;
    if (!rem || !incRem) {
        await clearEditorTimerSession(plugin);
        return null;
    }

    const carried = await deductFromEditorTimerClock(plugin, carrySeconds);
    const after = await readEditorTimerState(plugin);
    const recordedSeconds = after?.elapsedSeconds ?? 0;

    await plugin.storage.setSession('plugin_operation_active', true);
    try {
        // Reading time belongs to the PDF/HTML host too — same sync End Review does.
        try {
            const pdfRem = await getActivePdfForIncRem(plugin, rem);
            if (pdfRem && recordedSeconds > 0) {
                const page = await getIncrementalReadingPosition(plugin, timer.remId, pdfRem._id);
                await addPageToHistory(plugin, timer.remId, pdfRem._id, page || 1, recordedSeconds);
            }
        } catch (err) {
            console.warn('[ReviewActions] Could not sync reading time to the PDF host', err);
        }

        const today = dayjs().startOf('day').valueOf();
        let history: IncrementalRep[];
        let nextRepDate: number;

        if (timer.origin === 'queue') {
            // The handoff already wrote the repetition; End Review only fills in
            // the duration. Do the same, and let `mode` choose the date.
            history = [...(incRem.history || [])];
            const last = history[history.length - 1];
            if (last) {
                last.reviewTimeSeconds = recordedSeconds;
                await stampNoteAndContext(plugin, rem, last);
            }
            nextRepDate = mode === 'due' ? today : incRem.nextRepDate;
        } else {
            const dateOverride = await plugin.storage.getSession<number>(editorReviewTimerDateOverrideKey);
            const intervalDays = timer.interval ?? 0;
            const scheduled = incRem.nextRepDate;
            const daysDifference = (Date.now() - scheduled) / (1000 * 60 * 60 * 24);

            const entry: IncrementalRep = {
                date: Date.now(),
                scheduled,
                interval: mode === 'due' ? 0 : intervalDays,
                wasEarly: daysDifference < 0,
                daysEarlyOrLate: Math.round(daysDifference * 10) / 10,
                reviewTimeSeconds: recordedSeconds,
                eventType: 'executeRepetition',
                ...(incRem.prioritySource === 'fallback' ? {} : { priority: incRem.priority }),
            };
            await stampNoteAndContext(plugin, rem, entry);

            history = [...(incRem.history || []), entry];
            nextRepDate =
                mode === 'due'
                    ? today
                    : dateOverride ?? Date.now() + intervalDays * 24 * 60 * 60 * 1000;
        }

        await updateSRSDataForRem(plugin, timer.remId, nextRepDate, history);
        await updateIncrementalRemCache(plugin, { ...incRem, nextRepDate, history });

        console.log(
            `[ReviewActions] Left editor review of ${timer.remId} (${mode}, origin ${timer.origin}): ` +
            `recorded ${recordedSeconds}s` + (carried ? `, carried ${carried}s to the target` : '')
        );

        return { recordedSeconds, nextRepDate };
    } finally {
        await plugin.storage.setSession('plugin_operation_active', false);
        // Unmounting the timer widget ends the PracticedQueues engagement, so the
        // session time is accounted for without recording a second rep here.
        await clearEditorTimerSession(plugin);
    }
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
    // THE HANDOFF CARRY: the timer starts back-dated to when the queue began
    // showing this rem, so the reading you already did counts. That carry lives
    // in `start` alone — which is why the two keys below must be cleared and
    // never confused with it.
    await plugin.storage.setSession('editor-review-timer-start', existingStartTime || Date.now());
    // A previous review that was replaced rather than ended can leave its
    // accumulated segment (and a pause) behind; inheriting either would add a
    // stranger's minutes to this timer on top of the carry above.
    await plugin.storage.setSession(editorReviewTimerAccumulatedMsKey, undefined);
    await plugin.storage.setSession(editorReviewTimerPausedAtKey, undefined);
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

