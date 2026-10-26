import { RNPlugin } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import { getIncrementalRemFromRem } from './incremental_rem';
import { getNextSpacingDateForRem } from './scheduler';
import {
  enqueueReviewJob,
  editorReviewNextRepDate,
  newReviewJobId,
  EditorReviewJob,
} from './incremental_rem/review_jobs';
import { currentSubQueueIdKey } from './consts';
import { openIncRemForReview } from './incRemHelpers';
import { forceSaveSession } from './queue_session';
import { safeRemTextToString } from './pdfUtils';
import { pullNativeVideoPosition } from './video_position';

dayjs.extend(duration);

/**
 * The Editor Review Timer's session (the `editor-review-timer-*` session keys)
 * and what its buttons do with it. Shared by the timer bar above the document
 * (widgets/editor_review_timer.tsx) and the floating bar over RemNote's video
 * page (widgets/video_review_bar.tsx), which can't host the first.
 */

export interface EditorTimerData {
  remId: string;
  startTime: number | undefined;
  interval: number | undefined;
  priority: number | undefined;
  remName: string;
  fromQueue: boolean | undefined;
  origin: string;
  queueList: string[];
  pausedAt: number | null;
  accumulatedMs: number;
}

/** The running review, or null when there is none. Reactive when given a tracker's plugin. */
export async function readEditorTimer(rp: RNPlugin): Promise<EditorTimerData | null> {
  const remId = await rp.storage.getSession<string>('editor-review-timer-rem-id');
  if (!remId) return null;

  const startTime = await rp.storage.getSession<number>('editor-review-timer-start');
  const interval = await rp.storage.getSession<number>('editor-review-timer-interval');
  const priority = await rp.storage.getSession<number>('editor-review-timer-priority');
  const remName = await rp.storage.getSession<string>('editor-review-timer-rem-name');
  const fromQueue = await rp.storage.getSession<boolean>('editor-review-timer-from-queue');
  const origin = await rp.storage.getSession<string>('editor-review-timer-origin');
  const queueList = await rp.storage.getSession<string[]>('editor-review-timer-queue-list');
  const pausedAt = await rp.storage.getSession<number>('editor-review-timer-paused-at');
  const accumulatedMs = await rp.storage.getSession<number>('editor-review-timer-accumulated-ms');

  return {
    remId,
    startTime,
    interval,
    priority,
    remName: remName || 'Unnamed Rem',
    fromQueue,
    origin: origin || (fromQueue ? 'queue' : 'editor'),
    queueList: queueList || [],
    pausedAt: pausedAt ?? null,
    accumulatedMs: accumulatedMs ?? 0,
  };
}

/** Time on the clock: frozen at the pause while paused, live otherwise. */
export function editorTimerElapsedMs(timer: EditorTimerData, now: number): number {
  if (timer.pausedAt) {
    return timer.accumulatedMs + (timer.pausedAt - (timer.startTime || timer.pausedAt));
  }
  return timer.startTime ? timer.accumulatedMs + (now - timer.startTime) : 0;
}

export function formatEditorTimer(elapsedMs: number): string {
  const elapsed = dayjs.duration(Math.max(0, elapsedMs));
  const hours = Math.floor(elapsed.asHours());
  const minutes = elapsed.minutes();
  const seconds = elapsed.seconds();
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Whether "End Review" can also go back to where the review came from. */
export const hasReturnOrigin = (timer: EditorTimerData) =>
  timer.origin === 'queue' || timer.origin === 'inc-rem-list' || timer.origin === 'inc-rem-main-view';

export async function pauseEditorTimer(plugin: RNPlugin, timer: EditorTimerData) {
  if (timer.pausedAt) return;
  await plugin.storage.setSession('editor-review-timer-paused-at', Date.now());
}

export async function resumeEditorTimer(plugin: RNPlugin, timer: EditorTimerData) {
  if (!timer.pausedAt) return;
  // accumulatedMs grows by the segment we just completed before pausing
  const segmentMs = timer.pausedAt - (timer.startTime || timer.pausedAt);
  await plugin.storage.setSession('editor-review-timer-accumulated-ms', timer.accumulatedMs + segmentMs);
  await plugin.storage.setSession('editor-review-timer-start', Date.now());
  await plugin.storage.setSession('editor-review-timer-paused-at', undefined);
}

/** What a button press closes out: the time on the clock and where the reading happened. */
export interface EditorReviewClose {
  elapsedMs: number;
  /** The reading host and page, what the repetition's reading time is logged against. */
  host: EditorReviewJob['host'];
  /** The rem name to show and to name in toasts. */
  reviewName: string;
}

/** Leaving a RemNote video Rem: keep where its player got to for the plugin's player. */
async function leaveReviewedRem(plugin: RNPlugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (rem) await pullNativeVideoPosition(plugin, rem);
}

export async function endEditorReview(
  plugin: RNPlugin,
  timer: EditorTimerData,
  { elapsedMs, host, reviewName }: EditorReviewClose,
  navigateBack: boolean
) {
  await leaveReviewedRem(plugin, timer.remId);

  // The writes run in the tracker (lib/incremental_rem/review_jobs.ts),
  // so the bar goes away now instead of after them; a failure there opens a
  // dialog. Everything the job needs is captured here, before the session
  // keys it would otherwise read are cleared below.
  const reviewTimeSeconds = Math.round(elapsedMs / 1000);
  const fromQueue = timer.origin === 'queue';
  // If the user chose "Keep Current Date" in the regression dialog before
  // starting the timer, the override is in session storage.
  const dateOverride = fromQueue
    ? undefined
    : await plugin.storage.getSession<number>('editor-review-timer-date-override');
  const job: EditorReviewJob = {
    id: newReviewJobId(timer.remId),
    remId: timer.remId,
    // A queue handoff already wrote the repetition; End Review fills in its time.
    kind: fromQueue ? 'amendLast' : 'new',
    intervalDays: timer.interval || 0,
    overrideNextRepDate: dateOverride,
    newPriority: timer.priority ?? undefined,
    reviewTimeSeconds,
    host,
    recordRep: false,
    remName: reviewName,
    confirmedAt: Date.now(),
  };
  await enqueueReviewJob(plugin, job);

  const timeDisplay = formatEditorTimer(elapsedMs);
  void plugin.app.toast(
    fromQueue
      ? `✓ ${reviewName}: Repetition updated (${timeDisplay})`
      : `✓ ${reviewName}: Repetition stored (${timeDisplay}), next review: ${dayjs(editorReviewNextRepDate(job)).format('MMMM D, YYYY')}`
  );

  // Clear timer data FIRST (to prevent navigation from interrupting cleanup)
  await Promise.all(
    [
      'editor-review-timer-rem-id',
      'editor-review-timer-start',
      'editor-review-timer-interval',
      'editor-review-timer-priority',
      'editor-review-timer-rem-name',
      'editor-review-timer-from-queue',
      'editor-review-timer-origin',
      'editor-review-timer-paused-at',
      'editor-review-timer-accumulated-ms',
      'editor-review-timer-date-override',
    ].map((key) => plugin.storage.setSession(key, undefined))
  );

  // Explicitly end the active session when Ending Review
  await forceSaveSession(plugin);

  // Perform navigation at the very end — only if requested
  if (navigateBack) {
    if (timer.origin === 'queue') {
      // Straight back into the queue, through the route RemNote's own Practice
      // button takes (see practicePriorityQueue in lib/priority_review_document/queue_doc.ts).
      // Leaving the queue for the editor fires no QueueExit, so the queue's
      // document id is still in session here.
      const subQueueId = await plugin.storage.getSession<string>(currentSubQueueIdKey);
      if (subQueueId) {
        const subQueueRem = await plugin.rem.findOne(subQueueId);
        if (subQueueRem) {
          await plugin.window.setURL(`/flashcards/${subQueueId}`);
        } else {
          await plugin.app.toast('Could not find the queue document.');
        }
      } else {
        // No document: the review came from the Global Queue.
        await plugin.window.setURL('/flashcards');
      }
    } else if (timer.origin === 'inc-rem-list') {
      // Return to the IncRem List popup (state was already stored in session by inc_rem_list.tsx)
      await plugin.widget.openPopup('inc_rem_list');
    } else if (timer.origin === 'inc-rem-main-view') {
      // Return to the Main View popup (state was already stored in session by inc_rem_main_view.tsx)
      await plugin.widget.openPopup('inc_rem_main_view');
    }
  }
}

/**
 * Makes the queue list's next Rem the one under review, toasts `message` with
 * its name and opens it. When it no longer exists, it is dropped from the list
 * instead, so another press tries the one after.
 */
async function startNextInList(
  plugin: RNPlugin,
  timer: EditorTimerData,
  message: (nextRemName: string) => string
) {
  const nextRemId = timer.queueList[0];
  const newQueueList = timer.queueList.slice(1);

  const nextRem = await plugin.rem.findOne(nextRemId);
  if (!nextRem) {
    await plugin.app.toast(`Next Rem not found. Queue has ${newQueueList.length} items left.`);
    // Update queue list so we can try the next one if the user clicks again
    await plugin.storage.setSession('editor-review-timer-queue-list', newQueueList);
    return;
  }

  // Calculate interval for the next rem
  const nextIncRemInfo = await getIncrementalRemFromRem(plugin, nextRem);
  const inLookbackMode = !!(await plugin.queue.inLookbackMode());
  const scheduleData = await getNextSpacingDateForRem(plugin, nextRemId, inLookbackMode);
  const nextInterval = scheduleData?.newInterval || 1;
  const nextRemName = await safeRemTextToString(plugin, nextRem.text);

  await plugin.storage.setSession('editor-review-timer-rem-id', nextRemId);
  await plugin.storage.setSession('editor-review-timer-start', Date.now()); // Reset start time
  await plugin.storage.setSession('editor-review-timer-interval', nextInterval);
  await plugin.storage.setSession('editor-review-timer-priority', nextIncRemInfo?.priority ?? 10);
  await plugin.storage.setSession('editor-review-timer-rem-name', nextRemName || 'Unnamed Rem');
  await plugin.storage.setSession('editor-review-timer-queue-list', newQueueList);
  // Reset pause state for the next item — otherwise a pause taken on this item
  // would carry its time (or the paused state) over.
  await plugin.storage.setSession('editor-review-timer-paused-at', undefined);
  await plugin.storage.setSession('editor-review-timer-accumulated-ms', undefined);

  await plugin.app.toast(message(nextRemName));
  await openIncRemForReview(plugin, nextRem);
}

export async function nextEditorReview(
  plugin: RNPlugin,
  timer: EditorTimerData,
  { elapsedMs, host, reviewName }: EditorReviewClose
) {
  if (timer.queueList.length === 0) return;
  await leaveReviewedRem(plugin, timer.remId);

  // Save the repetition for the CURRENT item — a new one, as End Review does
  // for a review started in the editor. Handed to the tracker like End Review,
  // so moving on does not wait for the writes.
  await enqueueReviewJob(plugin, {
    id: newReviewJobId(timer.remId),
    remId: timer.remId,
    kind: 'new',
    intervalDays: timer.interval || 0,
    newPriority: timer.priority ?? undefined,
    reviewTimeSeconds: Math.round(elapsedMs / 1000),
    host,
    recordRep: false,
    remName: reviewName,
    confirmedAt: Date.now(),
  });

  await startNextInList(plugin, timer, (next) => `✓ Saved: ${reviewName}. Starting: ${next}`);
}

export async function dismissEditorReview(
  plugin: RNPlugin,
  timer: EditorTimerData,
  { elapsedMs, host, reviewName }: EditorReviewClose
) {
  await leaveReviewedRem(plugin, timer.remId);

  // The writes (card priority, reading time, the move to Dismissed, the
  // powerup removal) run in the tracker, so the timer moves on now.
  await enqueueReviewJob(plugin, {
    id: newReviewJobId(timer.remId),
    kind: 'dismiss',
    remId: timer.remId,
    rep: { reviewTimeSeconds: Math.round(elapsedMs / 1000) },
    cardPriorityInheritance: true,
    host,
    remName: reviewName,
    confirmedAt: Date.now(),
  });

  void plugin.app.toast(`✓ Dismissed: ${reviewName}`);

  if (timer.queueList.length === 0) {
    // No queueList → end the timer in place (mirrors endEditorReview's teardown
    // without recording another repetition, since dismissal already finalized it).
    await Promise.all(
      [
        'editor-review-timer-rem-id',
        'editor-review-timer-start',
        'editor-review-timer-interval',
        'editor-review-timer-priority',
        'editor-review-timer-rem-name',
        'editor-review-timer-from-queue',
        'editor-review-timer-origin',
        'editor-review-timer-paused-at',
        'editor-review-timer-accumulated-ms',
        'editor-review-timer-queue-list',
        'editor-review-timer-date-override',
      ].map((key) => plugin.storage.setSession(key, undefined))
    );
    await forceSaveSession(plugin);
    return;
  }

  await startNextInList(plugin, timer, (next) => `Starting: ${next}`);
}
