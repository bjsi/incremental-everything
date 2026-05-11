import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { getActivePdfForIncRem, getCurrentPageKey, addPageToHistory, safeRemTextToString } from './pdfUtils';
import { getIncrementalRemFromRem, updateReviewRemData } from './incremental_rem';
import { incremReviewStartTimeKey } from './consts';
import { determineIncRemType } from './incRemHelpers';
import { markIncRemTransition } from './queue_session';

export const handleReviewInEditorRem = async (
    plugin: RNPlugin,
    rem: PluginRem | undefined,
    remType: string | null | undefined
) => {
    if (!rem) return;

    if (remType === 'pdf') {
        const pdfRem = await getActivePdfForIncRem(plugin, rem);
        if (pdfRem) {
            const pageKey = getCurrentPageKey(rem._id, pdfRem._id);
            const currentPage = await plugin.storage.getSynced<number>(pageKey);

            if (currentPage) {
                await addPageToHistory(plugin, rem._id, pdfRem._id, currentPage);
            }
        }
    }

    const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
    await updateReviewRemData(plugin, incRemInfo ?? undefined);

    // Tell PracticedQueues this is a queue→editor handoff for the same rem,
    // so the editor timer's startIncRemEngagement doesn't double-count it.
    markIncRemTransition(plugin, rem._id);

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

    const incRemType = await determineIncRemType(plugin, rem);

    if (incRemType === 'pdf-note') {
        await rem.openRemAsPage();
    } else {
        await plugin.window.openRem(rem);
    }
};

