import { z } from 'zod';
import { PluginRem } from '@remnote/plugin-sdk';

export type ActionItemType =
  | 'pdf'
  | 'html'
  | 'youtube'
  | 'youtube-highlight'
  | 'video'
  | 'rem'
  | 'pdf-highlight'
  | 'html-highlight'
  | 'pdf-note'
  | 'unknown';

export type PDFActionItem = { type: 'pdf'; rem: PluginRem };
export type HTMLActionItem = { type: 'html'; rem: PluginRem };
export type YoutubeActionItem = { type: 'youtube'; rem: PluginRem; url: string };
export type VideoActionItem = { type: 'video'; rem: PluginRem };
export type RemActionItem = { type: 'rem'; rem: PluginRem };
export type PDFHighlightActionItem = { type: 'pdf-highlight'; rem: PluginRem; extract: PluginRem };
export type HTMLHighlightActionItem = { type: 'html-highlight'; rem: PluginRem; extract: PluginRem };
export type YoutubeHighlightActionItem = {
  type: 'youtube-highlight';
  rem: PluginRem;       // parent YouTube video Rem
  extract: PluginRem;   // child extract Rem
  url: string;
  startTime: number;    // seconds
  endTime: number;      // seconds
};

export type RemAndType =
  | PDFActionItem
  | HTMLActionItem
  | YoutubeActionItem
  | YoutubeHighlightActionItem
  | VideoActionItem
  | RemActionItem
  | PDFHighlightActionItem
  | HTMLHighlightActionItem;

export const IncrementalRep = z.object({
  /**
   * Date of the repetition (when actually reviewed)
   */
  date: z.number(),
  /**
   * The scheduled time of the repetition
   * This is the time when the repetition should have happened
   */
  scheduled: z.number(),
  /**
   * The interval in days that was set for the next review
   */
  interval: z.number().optional(),
  /**
   * Time spent reviewing in seconds
   */
  reviewTimeSeconds: z.number().optional(),
  /**
   * Whether this review was done before the scheduled date
   */
  wasEarly: z.boolean().optional(),
  /**
   * How many days early (negative) or late (positive) the review was
   * Negative = early, Positive = late, 0 = on time
   */
  daysEarlyOrLate: z.number().optional(),
  /**
   * Event type for this history entry:
   * - undefined or 'rep': A regular repetition/review (Next button)
   * - 'rescheduledInQueue': Rescheduled during queue review (Ctrl+J in queue) - counts for interval
   * - 'rescheduledInEditor': Rescheduled from editor (Ctrl+J in editor) - doesn't count for interval
   * - 'manualDateReset': User manually changed the date slot - doesn't count for interval
   * - 'executeRepetition': Execute Repetition command in editor - counts for interval
   * - 'madeIncremental': Marker for when the Rem was made Incremental
   * - 'dismissed': Marker for when the Rem was dismissed
   * - 'importedRep': A review imported from a flashcard whose rem was removed by
   *   'Preserve history & remove'. COUNTS for study-time/rep statistics (the
   *   Study Dashboard) but is intentionally IGNORED by the scheduler for
   *   next-interval computation, since it never belonged to this rem's own
   *   incremental schedule. See context.flashcardName / context.flashcardScore.
   * - 'externalRep': A study session recorded after the fact by the user from the
   *   Repetition History popup ("Add session") — reading done away from RemNote.
   *   It is a genuine repetition of this rem, so it counts for BOTH statistics and
   *   the scheduler's rep count, exactly like 'executeRepetition'.
   *
   * The scheduler uses this to count only review events since the last 'madeIncremental' event.
   */
  eventType: z.enum([
    'rep',
    'rescheduledInQueue',
    'rescheduledInEditor',
    'manualDateReset',
    'executeRepetition',
    'madeIncremental',
    'dismissed',
    'importedRep',
    'externalRep'
  ]).optional(),
  /**
   * The absolute priority (0-100) at the time of this repetition
   */
  priority: z.number().min(0).max(100).optional(),
  /**
   * The next-repetition timestamp (ms) scheduled at this point. Stamped on the
   * most-recent entry at every scheduling write. Used as a reliable read-time
   * fallback for the next-rep date when the Daily Doc reference in nextRepDateSlotCode
   * can't be resolved (some daily-doc rems expose an empty 'Date' property). The Daily
   * Doc reference stays authoritative on read so manual date edits still win — this is
   * only consulted when that reference fails to round-trip.
   */
  nextRepMs: z.number().optional(),
  /**
   * Free-form USER-authored notes/observations attached to this history entry
   * (e.g. why the rem was rescheduled or dismissed, context for the review).
   * Machine-generated metadata goes in `context`, never here.
   * Persisted in both the Incremental 'History' slot and the Dismissed 'History' slot.
   */
  notes: z.string().optional(),
  /**
   * MACHINE-generated snapshot of the reading-session state at the time of this
   * history entry. Unlike the live synced-storage keys (current page, page range,
   * bookmarks — see lib/pdfUtils.ts), this is stored inside the rem's powerup slot,
   * so it survives synced-storage loss and records the historical trajectory
   * (what page the user was on at EACH rep, not just now). All fields optional;
   * omit the whole object when there is nothing meaningful to snapshot.
   */
  context: z
    .object({
      /** Current page at the time of this entry (PDF reader). */
      page: z.number().optional(),
      /** Active page range at the time of this entry. end 0/undefined = unbounded. */
      rangeStart: z.number().optional(),
      rangeEnd: z.number().optional(),
      /** Name of the active PDF source (ranges/pages are per-PDF). */
      pdfName: z.string().optional(),
      /** Text of the last bookmark/highlight rem from this session, if any. */
      bookmark: z.string().optional(),
      /** Playback position in seconds (YouTube / video extracts). */
      videoTime: z.number().optional(),
      /**
       * Name of the source flashcard, when this rep was imported from a card
       * removed by 'Preserve history & remove' (eventType 'importedRep').
       */
      flashcardName: z.string().optional(),
      /**
       * The flashcard review's QueueInteractionScore (AGAIN/HARD/GOOD/EASY…),
       * preserved so the imported rep can show how the card was graded.
       */
      flashcardScore: z.number().optional(),
    })
    .optional(),
});

export type IncrementalRep = z.infer<typeof IncrementalRep>;

/**
 * Whether a history entry counts as a real review for STATISTICS — the Study
 * Dashboard's time/rep totals. Includes imported flashcard reps ('importedRep').
 * Excludes slot-edit events ('rescheduledInEditor', 'manualDateReset') and
 * lifecycle markers ('madeIncremental', 'dismissed').
 *
 * Single source of truth: authoritative_aggregates and the history-transfer
 * collector both use this so the definition can't drift.
 */
export function repCountsForStats(eventType: IncrementalRep['eventType']): boolean {
  return (
    eventType === undefined ||
    eventType === 'rep' ||
    eventType === 'executeRepetition' ||
    eventType === 'rescheduledInQueue' ||
    eventType === 'importedRep' ||
    eventType === 'externalRep'
  );
}

/**
 * Whether a history entry counts for the SCHEDULER's next-interval computation.
 * Identical to {@link repCountsForStats} MINUS 'importedRep': imported flashcard
 * reps never belonged to this rem's own incremental schedule, so they must never
 * influence its intervals (even if the rem is later re-incrementalized).
 * 'externalRep' DOES count — a session studied away from RemNote is still a
 * repetition of this rem's own material.
 */
export function repCountsForScheduling(eventType: IncrementalRep['eventType']): boolean {
  return (
    eventType === undefined ||
    eventType === 'rep' ||
    eventType === 'executeRepetition' ||
    eventType === 'rescheduledInQueue' ||
    eventType === 'externalRep'
  );
}

export const IncrementalRem = z.object({
  remId: z.string(),
  nextRepDate: z.number(),
  priority: z.number().min(0).max(100),
  history: z.array(IncrementalRep).optional(),
  /**
   * Timestamp (ms) when the Rem was first made Incremental.
   * Corresponds to the `originalIncrementalDateSlotCode` powerup slot.
   * Not set for rems that were re-incrementalized from a dismissed state.
   */
  createdAt: z.number().optional(),
});

export type IncrementalRem = z.infer<typeof IncrementalRem>;
