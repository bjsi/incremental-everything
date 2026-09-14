/**
 * Pure planning for source pins: given the words a quote occupies in a source
 * and the highlights already there, decide which highlights to reuse and which
 * new ones to create, so highlights never overlap.
 *
 *   quote inside an existing highlight          → reuse it
 *   existing highlights cover most of the quote → reuse them
 *   partial overlap, or contains a short one    → reuse them, create highlights
 *                                                 only for uncovered stretches
 *                                                 of at least MIN_NEW_STRETCH_WORDS
 *   no overlap                                  → create one highlight
 *
 * The rule only needs to know which highlight owns each word. PDF sources work
 * that out from page geometry (PDF points, y down, the units the helper returns);
 * HTML articles from character spans in the article's text.
 */
import type { HighlightRect, PdfHighlightPosition } from '../pdf_highlight_create';

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** One word of a quote located in a PDF, in reading order. `line` groups words of a text line. */
export interface LocatedWord extends Box {
  i: number;
  line: string;
  text: string;
}

export interface PageHighlight {
  remId: string;
  rects: Box[];
}

/** A character range in a source's flattened text, end exclusive. */
export interface TextSpan {
  start: number;
  end: number;
}

export interface TextHighlight {
  remId: string;
  intervals: TextSpan[];
}

export interface SourcePinPlan<W> {
  /** For each word, the id of the existing highlight that covers it, or null. */
  owners: (string | null)[];
  reuse: string[];
  create: W[][];
  coverage: number;
}

export const MIN_NEW_STRETCH_WORDS = 4;
export const MOSTLY_COVERED = 0.6;

/** A word belongs to a highlight when its centre lies inside one of its rects. */
const coversBox = (rect: Box, word: Box, tolerance = 1) => {
  const cx = (word.x1 + word.x2) / 2;
  const cy = (word.y1 + word.y2) / 2;
  return (
    cx >= rect.x1 - tolerance && cx <= rect.x2 + tolerance && cy >= rect.y1 - tolerance && cy <= rect.y2 + tolerance
  );
};

export const ownersByBox = (words: Box[], existing: PageHighlight[]) =>
  words.map((w) => existing.find((h) => h.rects.some((r) => coversBox(r, w)))?.remId ?? null);

/** A word belongs to a highlight when its middle character falls inside one of its spans. */
export const ownersByInterval = (words: TextSpan[], existing: TextHighlight[]) =>
  words.map((w) => {
    const mid = (w.start + w.end) / 2;
    return existing.find((h) => h.intervals.some((s) => mid >= s.start && mid < s.end))?.remId ?? null;
  });

export function planFromOwners<W>(
  words: W[],
  owners: (string | null)[],
  opts: { minStretch?: number; mostlyCovered?: number } = {}
): SourcePinPlan<W> {
  const minStretch = opts.minStretch ?? MIN_NEW_STRETCH_WORDS;
  const mostlyCovered = opts.mostlyCovered ?? MOSTLY_COVERED;

  const covered = owners.filter((o) => o !== null).length;
  const coverage = words.length ? covered / words.length : 0;
  const reuse = [...new Set(owners.filter((o): o is string => o !== null))];

  if (covered === 0) return { owners, reuse, create: words.length ? [words] : [], coverage };
  if (coverage >= mostlyCovered) return { owners, reuse, create: [], coverage };

  const create: W[][] = [];
  let run: W[] = [];
  const flush = () => {
    if (run.length >= minStretch) create.push(run);
    run = [];
  };
  words.forEach((w, k) => {
    if (owners[k] === null) run.push(w);
    else flush();
  });
  flush();
  return { owners, reuse, create, coverage };
}

export function planSourcePins(
  words: LocatedWord[],
  existing: PageHighlight[],
  opts: { minStretch?: number; mostlyCovered?: number } = {}
): SourcePinPlan<LocatedWord> {
  return planFromOwners(words, ownersByBox(words, existing), opts);
}

/**
 * Pins in the passage's reading order: each highlight at the first word it
 * covers, reused and newly created ones alike.
 */
export function orderedPins(owners: (string | null)[], created: { id: string; firstWord: number }[]) {
  const first = new Map<string, number>();
  owners.forEach((o, k) => {
    if (o !== null && !first.has(o)) first.set(o, k);
  });
  for (const c of created) first.set(c.id, c.firstWord);
  return [...first.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/** Build a highlight position: one rect per text line, in RemNote's Data shape. */
export function positionFromWords(
  words: LocatedWord[],
  pageWidth: number,
  pageHeight: number,
  pageNumber: number
): PdfHighlightPosition {
  const toRect = (group: Box[]): HighlightRect => ({
    x1: Math.min(...group.map((w) => w.x1)),
    y1: Math.min(...group.map((w) => w.y1)),
    x2: Math.max(...group.map((w) => w.x2)),
    y2: Math.max(...group.map((w) => w.y2)),
    width: pageWidth,
    height: pageHeight,
    pageNumber,
  });

  const lines: LocatedWord[][] = [];
  for (const w of words) {
    const current = lines[lines.length - 1];
    if (current && current[0].line === w.line) current.push(w);
    else lines.push([w]);
  }
  return { boundingRect: toRect(words), rects: lines.map(toRect), pageNumber };
}

/** An existing highlight's rects on `page`, converted from its viewport units to page points. */
export function rectsOnPage(data: any, page: number, pageWidth: number, pageHeight: number): Box[] {
  const position = data?.position;
  if (!position) return [];
  const source: any[] = position.rects?.length ? position.rects : position.boundingRect ? [position.boundingRect] : [];
  return source
    .filter((r) => r && (r.pageNumber ?? position.pageNumber) === page && r.width && r.height)
    .map((r) => {
      const sx = pageWidth / r.width;
      const sy = pageHeight / r.height;
      return { x1: r.x1 * sx, y1: r.y1 * sy, x2: r.x2 * sx, y2: r.y2 * sy };
    });
}

export const wordsText = (words: { text: string }[]) => words.map((w) => w.text).join(' ');
