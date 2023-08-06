import { Rem } from '@remnote/plugin-sdk';
import { z } from 'zod';

export const IncrementalRep = z.object({
  /**
   * Date of the repetition
   */
  date: z.number(),
  /**
   * The scheduled time of the repetition
   * This is the time when the repetition should have happened
   */
  scheduled: z.number(),
});

export type IncrementalRep = z.infer<typeof IncrementalRep>;

export type ActionItemType =
  | 'pdf'
  | 'html'
  | 'youtube'
  | 'rem'
  | 'pdf-highlight'
  | 'html-highlight';
export type PDFActionItem = { type: 'pdf'; rem: Rem };
export type HTMLActionItem = { type: 'html'; rem: Rem };
export type YoutubeActionItem = { type: 'youtube'; rem: Rem; url: string };
export type RemActionItem = { type: 'rem'; rem: Rem };
export type PDFHighlightActionItem = { type: 'pdf-highlight'; rem: Rem; extract: Rem };
export type HTMLHighlightActionItem = { type: 'html-highlight'; rem: Rem; extract: Rem };
export type RemAndType =
  | PDFActionItem
  | HTMLActionItem
  | YoutubeActionItem
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
