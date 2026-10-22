// lib/incremental_rem/editor_review_job.ts
//
// Executing a repetition from the editor (the Ctrl+Shift+J popup → Confirm Review).
//
// WHY A JOB
//
// The popup used to run every write itself and close only when the last one
// returned: priority + band sync, PDF reading time, note/context snapshot, the
// two SRS slots, the synced history list, a second full IncRem read, and a
// read-modify-write of the entire IncRem session cache (~8MB on a large KB).
// That held the popup open for 4–15 seconds, longest when GlobalRemChanged in
// the index was pulling the same cache once per slot write.
//
// Now the popup appends a job to `pendingEditorReviewQueueKey` and closes; the
// tracker (register/tracker.ts) drains the queue in the persistent index
// widget, which survives the popup's teardown and runs the writes under
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
import { getActivePdfForIncRem, getIncrementalReadingPosition, addPageToHistory } from '../pdfUtils';
import { addToIncrementalHistory } from '../history_utils';
import { stampNoteAndContext } from '../history_notes';
import { recordIncRemRep } from '../queue_session';
import { pendingEditorReviewQueueKey } from '../consts';

export interface EditorReviewJob {
  /** Unique per confirm, so a job the drain sees twice is applied once. */
  id: string;
  remId: string;
  intervalDays: number;
  newPriority: number;
  reviewTimeMinutes: number;
  /** When set, written as nextRepDate instead of the computed one. */
  overrideNextRepDate?: number;
  /** Optional user note stored on this repetition's history entry. */
  note?: string;
  /** For the failure dialog only. */
  remName?: string;
  /** When the user confirmed — the repetition's date, not when the job ran. */
  confirmedAt: number;
}

/** The next-rep date a job will write — also what the popup's toast shows. */
export const editorReviewNextRepDate = (
  job: Pick<EditorReviewJob, 'intervalDays' | 'overrideNextRepDate' | 'confirmedAt'>
): number => job.overrideNextRepDate ?? job.confirmedAt + job.intervalDays * 1000 * 60 * 60 * 24;

/**
 * Appends a job for the tracker. A plain read-modify-write on a session key:
 * the writers are popups the user confirms one at a time, and an append would
 * have to land in the single round-trip between the drain's read and its clear
 * to be lost — the next popup cannot even open that fast.
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
 * since the popup that could have said so is already closed.
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
  const priorityChanged = job.newPriority !== incRem.priority || incRem.prioritySource !== 'slot';
  if (priorityChanged) {
    // recordHistory: false — the rep entry appended below carries this priority.
    await setIncRemPriority(plugin, rem, job.newPriority, { recordHistory: false });
  }

  const actualDate = job.confirmedAt;
  const newNextRepDate = editorReviewNextRepDate(job);

  // The interval stored in history must reflect the EFFECTIVE interval used
  // for the next rep date, not the algorithm-calculated one. When the user
  // chooses "Keep Current Date" or "Custom Interval", overrideNextRepDate
  // differs from the computed value.
  const effectiveIntervalDays = job.overrideNextRepDate
    ? Math.round(((job.overrideNextRepDate - actualDate) / (1000 * 60 * 60 * 24)) * 10) / 10
    : job.intervalDays;

  // Calculate early/late status
  const scheduledDate = incRem.nextRepDate;
  const daysDifference = (actualDate - scheduledDate) / (1000 * 60 * 60 * 24);

  const reviewTimeSeconds = Math.round(job.reviewTimeMinutes * 60);

  // Synchronize time spent reading directly to the PDF reading history tracker
  const pdfRem = await getActivePdfForIncRem(plugin, rem);
  if (pdfRem && reviewTimeSeconds > 0) {
    const activePage = await getIncrementalReadingPosition(plugin, remId, pdfRem._id);
    await addPageToHistory(plugin, remId, pdfRem._id, activePage || 1, reviewTimeSeconds);
  }

  const repEntry: IncrementalRep = {
    date: actualDate,
    scheduled: scheduledDate,
    interval: effectiveIntervalDays,
    wasEarly: daysDifference < 0,
    daysEarlyOrLate: Math.round(daysDifference * 10) / 10,
    reviewTimeSeconds,
    priority: incRem.priority, // Record priority at time of rep
    eventType: 'executeRepetition' as const,
    // updateSRSDataForRem stamps this too; set here so the cache entry below
    // carries the same history the slot does.
    nextRepMs: newNextRepDate,
  };

  // Attach the user's note (if typed) + a reading-state snapshot to the entry.
  await stampNoteAndContext(plugin, rem, repEntry, job.note);

  const newHistory: IncrementalRep[] = [...(incRem.history || []), repEntry];

  await updateSRSDataForRem(plugin, remId, newNextRepDate, newHistory, rem);
  await addToIncrementalHistory(plugin, remId);

  // Built from what was just written instead of re-reading the rem. The
  // nextRepDate is day-aligned because that is what a re-read resolves from the
  // Daily Doc reference — a raw epoch would make the item due at the time of
  // day it was reviewed rather than at midnight.
  await updateIncrementalRemCache(plugin, {
    ...incRem,
    priority: job.newPriority,
    prioritySource: 'slot',
    nextRepDate: dayjs(newNextRepDate).startOf('day').valueOf(),
    history: newHistory,
  });

  await recordIncRemRep(plugin, remId, Math.round(job.reviewTimeMinutes * 60 * 1000));

  return { priorityChanged };
}
