/**
 * Pure planning for source pins: given the words a quote occupies on a PDF page
 * and the highlights already on that page, decide which highlights to reuse and
 * which new ones to create, so highlights never overlap.
 *
 *   quote inside an existing highlight          → reuse it
 *   existing highlights cover most of the quote → reuse them
 *   partial overlap, or contains a short one    → reuse them, create highlights
 *                                                 only for uncovered stretches
 *                                                 of at least MIN_NEW_STRETCH_WORDS
 *   no overlap                                  → create one highlight
 *
 * All coordinates are PDF page points (y down), the units the helper returns.
 */
import type { HighlightRect, PdfHighlightPosition } from '../pdf_highlight_create';

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** One word of the located quote, in reading order. `line` groups words of a text line. */
export interface LocatedWord extends Box {
  i: number;
  line: string;
  text: string;
}

export interface PageHighlight {
  remId: string;
  rects: Box[];
}

export interface SourcePinPlan {
  reuse: string[];
  create: LocatedWord[][];
  coverage: number;
}

export const MIN_NEW_STRETCH_WORDS = 4;
export const MOSTLY_COVERED = 0.6;

/** A word belongs to a highlight when its centre lies inside one of its rects. */
const covers = (rect: Box, word: Box, tolerance = 1) => {
  const cx = (word.x1 + word.x2) / 2;
  const cy = (word.y1 + word.y2) / 2;
  return (
    cx >= rect.x1 - tolerance && cx <= rect.x2 + tolerance && cy >= rect.y1 - tolerance && cy <= rect.y2 + tolerance
  );
};

export function planSourcePins(
  words: LocatedWord[],
  existing: PageHighlight[],
  opts: { minStretch?: number; mostlyCovered?: number } = {}
): SourcePinPlan {
  const minStretch = opts.minStretch ?? MIN_NEW_STRETCH_WORDS;
  const mostlyCovered = opts.mostlyCovered ?? MOSTLY_COVERED;

  const owners = words.map((w) => existing.find((h) => h.rects.some((r) => covers(r, w)))?.remId ?? null);
  const covered = owners.filter((o) => o !== null).length;
  const coverage = words.length ? covered / words.length : 0;
  const reuse = [...new Set(owners.filter((o): o is string => o !== null))];

  if (covered === 0) return { reuse, create: words.length ? [words] : [], coverage };
  if (coverage >= mostlyCovered) return { reuse, create: [], coverage };

  const create: LocatedWord[][] = [];
  let run: LocatedWord[] = [];
  const flush = () => {
    if (run.length >= minStretch) create.push(run);
    run = [];
  };
  words.forEach((w, k) => {
    if (owners[k] === null) run.push(w);
    else flush();
  });
  flush();
  return { reuse, create, coverage };
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

export const wordsText = (words: LocatedWord[]) => words.map((w) => w.text).join(' ');
