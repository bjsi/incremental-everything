// lib/incremental_rem/editor_review_job.ts
//
// Recording a repetition from the editor: the Execute Repetition popup
// (Ctrl+Shift+J → Confirm Review) and the Editor Review Timer (End Review,
// Next Review).
//
// WHY A JOB
//
// Both surfaces used to run every write themselves and go away only when the
// last one returned: priority + band sync, reading time, note/context
// snapshot, the two SRS slots, the synced history list, a second full IncRem
// read, and a read-modify-write of the entire IncRem session cache (~8MB on a
// large KB). That held them open for 4–15 seconds, longest when
// GlobalRemChanged in the index was pulling the same cache once per slot write.
//
// Now they append a job to `pendingEditorReviewQueueKey` and move on; the
// tracker (register/tracker.ts) drains the queue in the persistent index
// widget, which survives their teardown and runs the writes under
// `plugin_operation_active` so GlobalRemChanged stands down for them.
//
// This file must stay free of widget imports: the tracker imports it
// statically (see the import.meta note at the top of tracker.ts). Nor is it
// re-exported from ./index: it imports the scheduler, which imports ./index.

import { RNPlugin } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import { getIncrementalRemFromRem, setIncRemPriority } from './index';
import { updateIncrementalRemCache } from './cache';
import { IncrementalRep } from './types';
import { updateSRSDataForRem } from '../scheduler';
import {
  getActivePdfForIncRem,
  getIncrementalReadingPosition,
  addPageToHistory,
  resolveSessionBookmarkCarry,
} from '../pdfUtils';
import { addToIncrementalHistory } from '../history_utils';
import { stampNoteAndContext, consumePendingReviewNote, buildRepContext } from '../history_notes';
import { recordIncRemRep } from '../queue_session';
import { pendingEditorReviewQueueKey } from '../consts';

export interface EditorReviewJob {
  /** Unique per confirm, so a job the drain sees twice is applied once. */
  id: string;
  remId: string;
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
   * The reading host to log the time against, as the timer shows it (its PDF
   * page, or null for HTML / Text Reader). Unset: the rem's active PDF at its
   * saved position, and only when time was recorded — the popup's behaviour.
   */
  host?: { remId: string; page: number | null };
  /**
   * Count the rep for Practiced Queues. The popup does; the timer does not,
   * because its own engagement tracking already counts the item.
   */
  recordRep: boolean;
  /** For the failure dialog only. */
  remName?: string;
  /** When the user confirmed — the repetition's date, not when the job ran. */
  confirmedAt: number;
}

/** The next-rep date a 'new' job will write — also what the toasts show. */
export const editorReviewNextRepDate = (
  job: Pick<EditorReviewJob, 'intervalDays' | 'overrideNextRepDate' | 'confirmedAt'>
): number => job.overrideNextRepDate ?? job.confirmedAt + (job.intervalDays ?? 0) * 1000 * 60 * 60 * 24;

/** A job id unique per confirm. */
export const newEditorReviewJobId = (remId: string): string =>
  `${remId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Appends a job for the tracker. A plain read-modify-write on a session key:
 * the writers are user clicks confirmed one at a time, and an append would
 * have to land in the single round-trip between the drain's read and its clear
 * to be lost.
 */
export async function enqueueEditorReview(plugin: RNPlugin, job: EditorReviewJob): Promise<void> {
  const queue = (await plugin.storage.getSession<EditorReviewJob[]>(pendingEditorReviewQueueKey)) || [];
  await plugin.storage.setSession(pendingEditorReviewQueueKey, [...queue, job]);
}

/**
 * Records the repetition. Runs in the tracker; returns whether the priority
 * changed, so the caller can schedule the inheritance cascade.
 *
 * Throws when the rem is gone or no longer incremental — the caller reports it,
 * since the surface that could have said so is already gone.
 */
export async function runEditorReview(
  plugin: RNPlugin,
  job: EditorReviewJob
): Promise<{ priorityChanged: boolean }> {
  const { remId } = job;
  const rem = await plugin.rem.findOne(remId);
  if (!rem) throw new Error('The Rem no longer exists.');

  const incRem = await getIncrementalRemFromRem(plugin, rem);
  if (!incRem) throw new Error('The Rem is no longer an Incremental Rem.');

  // Skip the write (and its band sync, which looks up source highlights) when
  // nothing changes. A priority that was only recovered from history or
  // defaulted is written anyway, so the slot holds it from now on.
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
    // Carry a session bookmark forward so this reading-time entry does not
    // bury it and make the timer's Scroll button appear stale.
    const carryHighlightId = await resolveSessionBookmarkCarry(plugin, remId, job.host.remId, job.host.page);
    await addPageToHistory(plugin, remId, job.host.remId, job.host.page, reviewTimeSeconds, carryHighlightId);
  } else if (reviewTimeSeconds > 0) {
    const pdfRem = await getActivePdfForIncRem(plugin, rem);
    if (pdfRem) {
      const activePage = await getIncrementalReadingPosition(plugin, remId, pdfRem._id);
      await addPageToHistory(plugin, remId, pdfRem._id, activePage || 1, reviewTimeSeconds);
    }
  }

  let newHistory: IncrementalRep[];
  let newNextRepDate: number;

  if (job.kind === 'amendLast') {
    newHistory = [...(incRem.history || [])];
    const lastEntry = newHistory[newHistory.length - 1];
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
    newNextRepDate = incRem.nextRepDate;
  } else {
    const actualDate = job.confirmedAt;
    newNextRepDate = editorReviewNextRepDate(job);

    // The interval stored in history must reflect the EFFECTIVE interval used
    // for the next rep date, not the algorithm-calculated one. When the user
    // chooses "Keep Current Date" or "Custom Interval", overrideNextRepDate
    // differs from the computed value.
    const effectiveIntervalDays = job.overrideNextRepDate
      ? Math.round(((job.overrideNextRepDate - actualDate) / (1000 * 60 * 60 * 24)) * 10) / 10
      : job.intervalDays ?? 0;

    // Calculate early/late status
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

    newHistory = [...(incRem.history || []), repEntry];
  }

  // updateSRSDataForRem stamps nextRepMs on the last entry of the slot it
  // writes; stamp the copy too so the cache entry below matches the slot.
  if (newHistory.length > 0) {
    newHistory[newHistory.length - 1] = { ...newHistory[newHistory.length - 1], nextRepMs: newNextRepDate };
  }

  await updateSRSDataForRem(plugin, remId, newNextRepDate, newHistory, rem);
  await addToIncrementalHistory(plugin, remId);

  // Built from what was just written instead of re-reading the rem. The
  // nextRepDate is day-aligned because that is what a re-read resolves from the
  // Daily Doc reference — a raw epoch would make the item due at the time of
  // day it was reviewed rather than at midnight.
  await updateIncrementalRemCache(plugin, {
    ...incRem,
    ...(priorityChanged ? { priority: job.newPriority!, prioritySource: 'slot' as const } : {}),
    nextRepDate: dayjs(newNextRepDate).startOf('day').valueOf(),
    history: newHistory,
  });

  if (job.recordRep) {
    await recordIncRemRep(plugin, remId, reviewTimeSeconds * 1000);
  }

  return { priorityChanged };
}
