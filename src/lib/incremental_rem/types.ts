import { z } from 'zod';
import { PluginRem } from '@remnote/plugin-sdk';

export type ActionItemType =
  | 'pdf'
  | 'html'
  | 'youtube'
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

export type RemAndType =
  | PDFActionItem
  | HTMLActionItem
  | YoutubeActionItem
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
    'dismissed'
  ]).optional(),
  /**
   * The absolute priority (0-100) at the time of this repetition
   */
  priority: z.number().min(0).max(100).optional(),
});

export type IncrementalRep = z.infer<typeof IncrementalRep>;

export const IncrementalRem = z.object({
  remId: z.string(),
  nextRepDate: z.number(),
  priority: z.number().min(0).max(100),
  history: z.array(IncrementalRep).optional(),
});

export type IncrementalRem = z.infer<typeof IncrementalRem>;
