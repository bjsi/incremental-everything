import { Rem } from '@remnote/plugin-sdk';
import { z } from 'zod';

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
   * The queue mode when this review was done
   */
  queueMode: z.enum(['srs', 'practice-all', 'in-order', 'editor']).optional(),
});

export type IncrementalRep = z.infer<typeof IncrementalRep>;

export type ActionItemType =
  | 'pdf'
  | 'html'
  | 'youtube'
  | 'video'
  | 'rem'
  | 'pdf-highlight'
  | 'html-highlight';

export type PDFActionItem = { type: 'pdf'; rem: Rem };
export type HTMLActionItem = { type: 'html'; rem: Rem };
export type YoutubeActionItem = { type: 'youtube'; rem: Rem; url: string };
export type VideoActionItem = { type: 'video'; rem: Rem };
export type RemActionItem = { type: 'rem'; rem: Rem };
export type PDFHighlightActionItem = { type: 'pdf-highlight'; rem: Rem; extract: Rem };
export type HTMLHighlightActionItem = { type: 'html-highlight'; rem: Rem; extract: Rem };

export type RemAndType =
  | PDFActionItem
  | HTMLActionItem
  | YoutubeActionItem
  | VideoActionItem
  | RemActionItem
  | PDFHighlightActionItem
  | HTMLHighlightActionItem;

export const IncrementalRem = z.object({
  remId: z.string(),
  nextRepDate: z.number(),
  priority: z.number().min(0).max(100),
  history: z.array(IncrementalRep).optional(),
});

export type IncrementalRem = z.infer<typeof IncrementalRem>;