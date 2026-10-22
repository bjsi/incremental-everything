// lib/incremental_rem/review_jobs.ts
//
// Writing the outcome of an IncRem review — from the queue (Next, Cmd+→, the
// Today/Tomorrow drag, Dismiss, Ctrl+D), Reschedule (Ctrl+J, queue or editor),
// the Execute Repetition popup
// (Ctrl+Shift+J) and the Editor Review Timer (End Review, Next Review,
// Dismiss).
//
// WHY JOBS
//
// Every one of these used to run its writes itself and let the user move on
// only when the last one returned: priority + band sync, reading time,
// note/context snapshot, the SRS slots, the synced history list, a re-read of
// the IncRem, and a read-modify-write of the entire IncRem session cache (~8MB
// on a large KB). That held the card, popup or timer bar for seconds — up to
// 15 when GlobalRemChanged in the index was pulling the same cache once per
// slot write.
//
// Now the surface captures what only it knows at the moment of the click (the
// review's duration, the page on screen, the lookback state), appends a job to
// `pendingReviewJobQueueKey`, and moves on. The tracker (register/tracker.ts)
// drains the queue in the persistent index widget, which survives the
// surface's teardown, runs the writes under `plugin_operation_active` so
// GlobalRemChanged stands down for them, and patches the IncRem cache once per
// drain however many jobs it ran.
//
// The queue can advance before the writes land because queue_prefetch keeps
// every IncRem it served this session in `seen`: the rem just reviewed is not
// offered again even while the cache still lists it as due.
//
// This file must stay free of widget imports: the tracker imports it
// statically (see the import.meta note at the top of tracker.ts). Nor is it
// re-exported from ./index: it imports the scheduler, which imports ./index.

import { RNPlugin } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import {
  getIncrementalRemFromRem,
  setIncRemPriority,
  updateReviewRemData,
  requestQueueDashboardRefocus,
} from './index';
import { IncrementalRem, IncrementalRep } from './types';
import { updateSRSDataForRem } from '../scheduler';
import {
  getActivePdfForIncRem,
  getIncrementalReadingPosition,
  addPageToHistory,
  resolveSessionBookmarkCarry,
} from '../pdfUtils';
import { addToIncrementalHistory, addDismissalToIncrementalHistory } from '../history_utils';
import { stampNoteAndContext, consumePendingReviewNote, buildRepContext } from '../history_notes';
import { recordIncRemRep } from '../queue_session';
import { transferToDismissed } from '../dismissed';
import { handleCardPriorityInheritance } from '../card_priority/card_priority_inheritance';
import { applySchedulerChoice } from '../scheduler_choice';
import { SchedulerChoice } from '../scheduler_core';
import { pendingReviewJobQueueKey, incremReviewStartTimeKey, powerupCode } from '../consts';

interface ReviewJobBase {
  /** Unique per click, so a job the drain sees twice is applied once. */
  id: string;
  remId: string;
  /** For the failure dialog only. */
  remName?: string;
  /** When the user clicked — the date written into history, not when the job ran. */
  confirmedAt: number;
}

/** A reading host to log time against, as the surface shows it right now. */
export type ReviewHost = { remId: string; page: number | null };

/** Execute Repetition popup, and the Editor Review Timer's End/Next Review. */
export interface EditorReviewJob extends ReviewJobBase {
  /**
   * 'new' appends an executeRepetition entry and schedules the next rep.
   * 'amendLast' is the timer after a queue handoff: the handoff already wrote
   * the repetition, so only its duration, note and context are filled in and
   * the date stays where it is.
   */
  kind: 'new' | 'amendLast';
  /** 'new' only. */
  intervalDays?: number;
  /** 'new' only. When set, written as nextRepDate instead of the computed one. */
  overrideNextRepDate?: number;
  /** Left unset to keep the priority as it is. */
  newPriority?: number;
  reviewTimeSeconds: number;
  /** Optional explicit note; a note parked for the rem is consumed either way. */
  note?: string;
  /**
   * The timer's host and page. Unset: the rem's active PDF at its saved
   * position, and only when time was recorded — the popup's behaviour.
   */
  host?: ReviewHost;
  /**
   * Count the rep for Practiced Queues. The popup does; the timer does not,
   * because its own engagement tracking already counts the item.
   */
  recordRep: boolean;
}

/** The queue's Next button and Cmd+→: the scheduler picks the next date. */
export interface QueueNextJob extends ReviewJobBase {
  kind: 'queueNext';
  /** null when the queue recorded no start time for this item. */
  reviewTimeSeconds: number | null;
  inLookbackMode: boolean;
  /** A PDF IncRem: log the reading time against its active PDF's current page. */
  syncPdfPage: boolean;
}

/** The queue's drag to Today / Tomorrow: a fixed day, interval kept. */
export interface ManualOffsetJob extends ReviewJobBase {
  kind: 'manualOffset';
  offsetDays: number;
}

/** Dismiss from the queue, Ctrl+D (queue or editor), or the timer. */
export interface DismissJob extends ReviewJobBase {
  kind: 'dismiss';
  /** Set when a review is ending with the dismissal: appends a 'rep' entry. */
  rep?: { reviewTimeSeconds: number };
  /** Hand the IncRem's priority to its own cards first (queue and timer do). */
  cardPriorityInheritance: boolean;
  /** The timer logs its reading time against the host before dismissing. */
  host?: ReviewHost;
}

/** Reschedule (button or Ctrl+J): a chosen interval and priority, not a review. */
export interface RescheduleJob extends ReviewJobBase {
  kind: 'reschedule';
  intervalDays: number;
  newPriority: number;
  /** 'queue' records a rescheduledInQueue entry with the turn's duration. */
  context: 'queue' | 'editor';
  /** Queue only; null when the queue recorded no start time for this item. */
  reviewTimeSeconds: number | null;
  note?: string;
  /** Only set when the user changed the scheduler in the popup. */
  schedulerChoice?: SchedulerChoice;
}

export type ReviewJob = EditorReviewJob | QueueNextJob | ManualOffsetJob | DismissJob | RescheduleJob;

/** IncRem cache changes collected over a drain: an entry to upsert, or null to remove. */
export type IncRemCacheChanges = Map<string, IncrementalRem | null>;

/** The next-rep date a 'new' job will write — also what the toasts show. */
export const editorReviewNextRepDate = (
  job: Pick<EditorReviewJob, 'intervalDays' | 'overrideNextRepDate' | 'confirmedAt'>
): number => job.overrideNextRepDate ?? job.confirmedAt + (job.intervalDays ?? 0) * 1000 * 60 * 60 * 24;

/** A job id unique per click. */
export const newReviewJobId = (remId: string): string =>
  `${remId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Appends jobs for the tracker. A plain read-modify-write on a session key:
 * the writers are user clicks, and an append would have to land in the single
 * round-trip between the drain's read and its clear to be lost.
 */
export async function enqueueReviewJobs(plugin: RNPlugin, jobs: ReviewJob[]): Promise<void> {
  if (jobs.length === 0) return;
  const queue = (await plugin.storage.getSession<ReviewJob[]>(pendingReviewJobQueueKey)) || [];
  await plugin.storage.setSession(pendingReviewJobQueueKey, [...queue, ...jobs]);
}

export const enqueueReviewJob = (plugin: RNPlugin, job: ReviewJob) => enqueueReviewJobs(plugin, [job]);

// ─── Click side ─────────────────────────────────────────────────────────────

/**
 * Seconds since the queue started showing the current IncRem, or null when no
 * start was recorded. Read at the click: the key is restamped as soon as the
 * next item loads.
 */
export async function captureQueueReviewSeconds(plugin: RNPlugin): Promise<number | null> {
  const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
  return startTime ? dayjs().diff(dayjs(startTime), 'second') : null;
}

/**
 * Next (button or Cmd+→): queue the review and advance at once.
 *
 * The dashboard refocus is flagged BEFORE advancing: removeCurrentCardFromQueue
 * tears down the calling widget's sandbox, so the refocus itself is done by the
 * persistent QueueLoadCard listener in register/events.ts.
 */
export async function queueNextRepetition(
  plugin: RNPlugin,
  remId: string,
  options: { syncPdfPage: boolean }
): Promise<void> {
  const [reviewTimeSeconds, inLookbackMode] = await Promise.all([
    captureQueueReviewSeconds(plugin),
    plugin.queue.inLookbackMode().then((v) => !!v),
  ]);
  await enqueueReviewJob(plugin, {
    id: newReviewJobId(remId),
    kind: 'queueNext',
    remId,
    reviewTimeSeconds,
    inLookbackMode,
    syncPdfPage: options.syncPdfPage,
    confirmedAt: Date.now(),
  });
  await requestQueueDashboardRefocus(plugin, 'handleNextRepetitionClick');
  await plugin.queue.removeCurrentCardFromQueue();
}

/** The Today / Tomorrow drag: queue the reschedule and advance at once. */
export async function queueManualOffset(plugin: RNPlugin, remId: string, offsetDays: number): Promise<void> {
  await enqueueReviewJob(plugin, {
    id: newReviewJobId(remId),
    kind: 'manualOffset',
    remId,
    offsetDays,
    confirmedAt: Date.now(),
  });
  await requestQueueDashboardRefocus(plugin, 'handleNextRepetitionManualOffset');
  await plugin.queue.removeCurrentCardFromQueue();
}

// ─── Tracker side ───────────────────────────────────────────────────────────

/** Logs reading time against a host the surface named, carrying its bookmark. */
async function logHostReadingTime(plugin: RNPlugin, remId: string, host: ReviewHost, seconds: number) {
  // Carry a session bookmark forward so this reading-time entry does not bury
  // it and make the Scroll button appear stale.
  const carryHighlightId = await resolveSessionBookmarkCarry(plugin, remId, host.remId, host.page);
  await addPageToHistory(plugin, remId, host.remId, host.page, seconds, carryHighlightId);
}

/** Stamps the next-rep date on the last entry, as updateSRSDataForRem does on the slot. */
const withNextRepStamp = (history: IncrementalRep[], nextRepMs: number): IncrementalRep[] =>
  history.length === 0
    ? history
    : [...history.slice(0, -1), { ...history[history.length - 1], nextRepMs }];

/**
 * The cache entry after a review, built from what was just written instead of
 * re-reading the rem. The nextRepDate is day-aligned because that is what a
 * re-read resolves from the Daily Doc reference — a raw epoch would make the
 * item due at the time of day it was reviewed rather than at midnight.
 */
const reviewedEntry = (
  incRem: IncrementalRem,
  nextRepDate: number,
  history: IncrementalRep[],
  priority?: number
): IncrementalRem => ({
  ...incRem,
  ...(priority !== undefined ? { priority, prioritySource: 'slot' as const } : {}),
  nextRepDate: dayjs(nextRepDate).startOf('day').valueOf(),
  history: withNextRepStamp(history, nextRepDate),
});

/**
 * Runs one job. Cache changes go into `cache` for the caller to write once;
 * the returned `cascadeRemId` asks for the inheritance cascade (priority changed).
 *
 * Throws when the rem is gone or no longer incremental — the caller reports it,
 * since the surface that could have said so is already gone. A dismissal of a
 * rem that is no longer incremental is not an error: it was dismissed already.
 */
export async function runReviewJob(
  plugin: RNPlugin,
  job: ReviewJob,
  cache: IncRemCacheChanges
): Promise<{ cascadeRemId?: string }> {
  const { remId } = job;
  const rem = await plugin.rem.findOne(remId);
  if (!rem) throw new Error('The Rem no longer exists.');

  const incRem = await getIncrementalRemFromRem(plugin, rem);
  if (!incRem) {
    if (job.kind === 'dismiss') return {};
    throw new Error('The Rem is no longer an Incremental Rem.');
  }

  switch (job.kind) {
    case 'queueNext': {
      if (job.syncPdfPage) {
        const pdfRem = await getActivePdfForIncRem(plugin, rem);
        if (pdfRem) {
          const page = await getIncrementalReadingPosition(plugin, remId, pdfRem._id);
          if (page) {
            const carryHighlightId = await resolveSessionBookmarkCarry(plugin, remId, pdfRem._id, page);
            await addPageToHistory(plugin, remId, pdfRem._id, page, job.reviewTimeSeconds ?? undefined, carryHighlightId);
          }
        }
      }
      const result = await updateReviewRemData(plugin, incRem, undefined, {
        reviewTimeSeconds: job.reviewTimeSeconds,
        inLookbackMode: job.inLookbackMode,
      });
      if (!result) throw new Error('The scheduler could not compute the next repetition.');
      cache.set(remId, reviewedEntry(incRem, result.newNextRepDate, result.newHistory));
      return {};
    }

    case 'manualOffset': {
      const offset = Math.max(job.offsetDays, 0);
      const targetDay = dayjs(job.confirmedAt).startOf('day').add(offset, 'day').valueOf();
      const manualEntry: IncrementalRep = {
        date: job.confirmedAt,
        scheduled: targetDay,
        interval: offset,
        // A "carry on today / tomorrow" gesture, not a new rhythm for the item.
        keepsInterval: true,
      };
      // Same note/context stamping as the regular review funnel.
      await stampNoteAndContext(plugin, rem, manualEntry);
      const history = [...(incRem.history || []), manualEntry];
      await updateSRSDataForRem(plugin, remId, targetDay, history, rem);
      cache.set(remId, reviewedEntry(incRem, targetDay, history));
      return {};
    }

    case 'dismiss': {
      if (job.cardPriorityInheritance) {
        await handleCardPriorityInheritance(plugin, rem, incRem);
      }
      if (job.host) {
        await logHostReadingTime(plugin, remId, job.host, job.rep?.reviewTimeSeconds ?? 0);
      }
      const history = [...(incRem.history || [])];
      if (job.rep) {
        history.push({
          date: job.confirmedAt,
          scheduled: incRem.nextRepDate,
          reviewTimeSeconds: job.rep.reviewTimeSeconds,
          eventType: 'rep',
          priority: incRem.priority,
        });
      }
      // The history goes to the Dismissed powerup BEFORE the Incremental one
      // is removed, which takes its slots with it.
      await transferToDismissed(plugin, rem, history);
      if (job.rep) {
        await addToIncrementalHistory(plugin, remId, { dismissed: true });
      } else {
        await addDismissalToIncrementalHistory(plugin, remId);
      }
      await rem.removePowerup(powerupCode);
      cache.set(remId, null);
      return {};
    }

    case 'reschedule': {
      const priorityChanged = job.newPriority !== incRem.priority || incRem.prioritySource !== 'slot';
      if (priorityChanged) {
        // recordHistory: false — the reschedule entry below carries this priority.
        await setIncRemPriority(plugin, rem, job.newPriority, { recordHistory: false });
      }
      if (job.schedulerChoice) {
        await applySchedulerChoice(plugin, rem, job.schedulerChoice);
      }

      const nextRepDate = job.confirmedAt + job.intervalDays * 1000 * 60 * 60 * 24;
      const scheduledDate = incRem.nextRepDate;
      const daysDifference = (job.confirmedAt - scheduledDate) / (1000 * 60 * 60 * 24);

      const rescheduleEntry: IncrementalRep = {
        date: job.confirmedAt,
        scheduled: scheduledDate,
        interval: job.intervalDays,
        wasEarly: daysDifference < 0,
        daysEarlyOrLate: Math.round(daysDifference * 10) / 10,
        // An editor reschedule does not imply the item was read.
        reviewTimeSeconds: job.context === 'queue' ? job.reviewTimeSeconds ?? undefined : undefined,
        priority: job.newPriority, // the NEW priority set during reschedule
        eventType: job.context === 'queue' ? 'rescheduledInQueue' : 'rescheduledInEditor',
      };

      // Attach the user's reason (if typed) + a reading-state snapshot to the entry.
      await stampNoteAndContext(plugin, rem, rescheduleEntry, job.note);

      const history = [...(incRem.history || []), rescheduleEntry];
      await updateSRSDataForRem(plugin, remId, nextRepDate, history, rem);
      cache.set(remId, reviewedEntry(incRem, nextRepDate, history, priorityChanged ? job.newPriority : undefined));

      // The cascade only matters when a priority changed; it used to run on
      // every reschedule, costing seconds of background work to update nothing.
      return priorityChanged ? { cascadeRemId: remId } : {};
    }

    case 'new':
    case 'amendLast': {
      // Skip the write (and its band sync, which looks up source highlights)
      // when nothing changes. A priority that was only recovered from history
      // or defaulted is written anyway, so the slot holds it from now on.
      const priorityChanged =
        job.newPriority !== undefined &&
        (job.newPriority !== incRem.priority || incRem.prioritySource !== 'slot');
      if (priorityChanged) {
        // recordHistory: false — the rep entry written below carries this priority.
        await setIncRemPriority(plugin, rem, job.newPriority!, { recordHistory: false });
      }

      const reviewTimeSeconds = job.reviewTimeSeconds;

      // Reading time belongs to the PDF/HTML host too.
      if (job.host) {
        await logHostReadingTime(plugin, remId, job.host, reviewTimeSeconds);
      } else if (reviewTimeSeconds > 0) {
        const pdfRem = await getActivePdfForIncRem(plugin, rem);
        if (pdfRem) {
          const activePage = await getIncrementalReadingPosition(plugin, remId, pdfRem._id);
          await addPageToHistory(plugin, remId, pdfRem._id, activePage || 1, reviewTimeSeconds);
        }
      }

      let history: IncrementalRep[];
      let nextRepDate: number;

      if (job.kind === 'amendLast') {
        history = [...(incRem.history || [])];
        const lastEntry = history[history.length - 1];
        if (lastEntry) {
          lastEntry.reviewTimeSeconds = reviewTimeSeconds;
          // Append a note typed during this session to the one the handoff may
          // already have stamped, and refresh the snapshot to end-of-session values.
          const sessionNote = await consumePendingReviewNote(plugin, remId);
          if (sessionNote && sessionNote !== lastEntry.notes) {
            lastEntry.notes = lastEntry.notes ? `${lastEntry.notes}\n${sessionNote}` : sessionNote;
          }
          const context = await buildRepContext(plugin, rem);
          if (context) lastEntry.context = context;
        }
        nextRepDate = incRem.nextRepDate;
      } else {
        const actualDate = job.confirmedAt;
        nextRepDate = editorReviewNextRepDate(job);

        // The interval stored in history must reflect the EFFECTIVE interval
        // used for the next rep date, not the algorithm-calculated one. When
        // the user chooses "Keep Current Date" or "Custom Interval",
        // overrideNextRepDate differs from the computed value.
        const effectiveIntervalDays = job.overrideNextRepDate
          ? Math.round(((job.overrideNextRepDate - actualDate) / (1000 * 60 * 60 * 24)) * 10) / 10
          : job.intervalDays ?? 0;

        const scheduledDate = incRem.nextRepDate;
        const daysDifference = (actualDate - scheduledDate) / (1000 * 60 * 60 * 24);

        const repEntry: IncrementalRep = {
          date: actualDate,
          scheduled: scheduledDate,
          interval: effectiveIntervalDays,
          wasEarly: daysDifference < 0,
          daysEarlyOrLate: Math.round(daysDifference * 10) / 10,
          reviewTimeSeconds,
          priority: incRem.priority, // Record priority at time of rep
          eventType: 'executeRepetition' as const,
        };

        // Attach the user's note (if typed) + a reading-state snapshot to the entry.
        await stampNoteAndContext(plugin, rem, repEntry, job.note);

        history = [...(incRem.history || []), repEntry];
      }

      await updateSRSDataForRem(plugin, remId, nextRepDate, history, rem);
      await addToIncrementalHistory(plugin, remId);
      cache.set(remId, reviewedEntry(incRem, nextRepDate, history, priorityChanged ? job.newPriority : undefined));

      if (job.recordRep) {
        await recordIncRemRep(plugin, remId, reviewTimeSeconds * 1000);
      }

      return priorityChanged ? { cascadeRemId: remId } : {};
    }
  }
}
