import { Rem } from '@remnote/plugin-sdk';

export interface IncrementalRep {
  date: number;
}

export type ActionItemType =
  | 'pdf'
  | 'html'
  | 'youtube'
  | 'rem'
  | 'pdf-highlight'
  | 'html-highlight';
export type PDFActionItem = { type: 'pdf'; rem: Rem };
export type HTMLActionItem = { type: 'html'; rem: Rem };
export type YoutubeActionItem = { type: 'youtube'; rem: Rem };
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
