import { PluginRem } from '@remnote/plugin-sdk';
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
  | 'video'
  | 'rem'
  | 'pdf-highlight'
  | 'html-highlight';

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

export const IncrementalRem = z.object({
  remId: z.string(),
  nextRepDate: z.number(),
  priority: z.number().min(0).max(100),
  history: z.array(IncrementalRep).optional(),
});

export type IncrementalRem = z.infer<typeof IncrementalRem>;