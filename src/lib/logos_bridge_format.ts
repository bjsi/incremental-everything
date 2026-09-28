/**
 * Pure helpers for the Logos bridge (see logos_bridge.ts). No SDK imports, so
 * logos_bridge_format.test.ts runs under plain ts-node.
 */

/** A run of passage text as the helper read it from Logos's clipboard. */
export interface LogosSegment {
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  sup?: boolean;
  sub?: boolean;
}

/** Wire format of scripts/logos_bridge/LogosBridge.swift → `Capture`. */
export interface LogosCapture {
  segments: LogosSegment[];
  plain: string;
  citation?: string;
  /** The book title (italic part of Logos's citation). */
  title?: string;
  /** ref.ly deep link to the start of the selection. */
  link?: string;
  /** "Short title, p. 35" — the text of the link back to Logos. */
  label?: string;
  resourceId?: string;
  range?: string;
}

export interface LogosJob {
  id: string;
  type: 'context' | 'lookupBook' | 'extract' | 'bookmark' | 'newBook';
  createdAt: number;
  targetId?: string;
  capture?: LogosCapture;
  priority?: number;
  interval?: number;
  /** false = a plain child Rem (⌘↩ in the helper's panel). */
  incremental?: boolean;
  link?: string;
  label?: string;
  /** newBook: the book's catalog title and Logos resource id. */
  title?: string;
  resourceId?: string;
}

/** Name of the tag every book IncRem made from Logos (⌃⌥N) carries. */
export const LOGOS_TAG_NAME = 'Logos';

/**
 * The tag's property holding each book's Logos resource id (e.g. LLS:42.110.133):
 * the book's unique key, which catches a second import even after a rename.
 */
export const LOGOS_RESOURCE_PROPERTY_NAME = 'Resource ID';

/** Marks the child Rem that holds an IncRem's Logos reading position. */
export const LOGOS_BOOKMARK_PREFIX = '📍 Logos: ';

/**
 * Clipboard runs → RemNote rich text. Formatting keys are RemNote's
 * RICH_TEXT_FORMATTING values (b, l = italic, u, sup, sub), written literally
 * to keep this file free of the SDK.
 */
export function segmentsToRichText(segments: LogosSegment[]): Array<string | Record<string, unknown>> {
  const out: Array<string | Record<string, unknown>> = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const formats: Record<string, true> = {};
    if (segment.b) formats.b = true;
    if (segment.i) formats.l = true;
    if (segment.u) formats.u = true;
    if (segment.sup) formats.sup = true;
    if (segment.sub) formats.sub = true;

    if (Object.keys(formats).length === 0) {
      const last = out[out.length - 1];
      if (typeof last === 'string') out[out.length - 1] = last + segment.text;
      else out.push(segment.text);
    } else {
      out.push({ i: 'm', text: segment.text, ...formats });
    }
  }
  return out;
}

/** True for a Logos deep link in either form (web redirect or native scheme). */
export function isLogosLink(url: string | undefined | null): boolean {
  return !!url && (url.startsWith('https://ref.ly/logosres/') || url.startsWith('logosres:'));
}
