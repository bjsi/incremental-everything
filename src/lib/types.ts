import { PluginRem } from '@remnote/plugin-sdk';

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