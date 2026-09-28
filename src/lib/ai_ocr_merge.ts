import type { HighlightRect } from './pdf_highlight_create';

/**
 * Merging an area highlight into the text highlight next to it.
 *
 * Scanned PDFs often have passages the text layer does not cover (formulae pasted
 * in as pictures, OCR gaps), so a text selection stops short of them. The user
 * highlights what selects, draws an area highlight over the rest, and the area's
 * box becomes one more rect of the text highlight. The text highlight is kept (an
 * area highlight cannot be turned into one: RemNote deletes it once its imageUrl
 * goes, see ai_ocr.ts).
 */

/** Largest vertical gap between the two boxes, as a share of the page height (~50pt on A4). */
export const MAX_GAP = 0.06;
/** The boxes must share at least this much of the narrower one's width (same column). */
export const MIN_OVERLAP = 0.5;

/** Where the area sits relative to the text highlight it extends. */
export type MergeSide = 'below' | 'above';

type Box = { x1: number; y1: number; x2: number; y2: number };

const fraction = (r: HighlightRect): Box => ({
  x1: r.x1 / r.width,
  y1: r.y1 / r.height,
  x2: r.x2 / r.width,
  y2: r.y2 / r.height,
});

const union = (boxes: Box[]): Box => ({
  x1: Math.min(...boxes.map((b) => b.x1)),
  y1: Math.min(...boxes.map((b) => b.y1)),
  x2: Math.max(...boxes.map((b) => b.x2)),
  y2: Math.max(...boxes.map((b) => b.y2)),
});

const areaPage = (data: any): number | undefined =>
  data?.position?.pageNumber ?? data?.position?.boundingRect?.pageNumber;

/** The highlight's rects, falling back to its bounding rect, each tagged with its page. */
const rectsOf = (data: any): HighlightRect[] => {
  const pos = data?.position;
  const rects: HighlightRect[] = pos?.rects?.length ? pos.rects : pos?.boundingRect ? [pos.boundingRect] : [];
  return rects.map((r) => ({ ...r, pageNumber: r.pageNumber ?? pos.pageNumber }));
};

export const isAreaHighlight = (data: any) => !!data?.content?.imageUrl;

/**
 * The text highlight an area highlight extends: same page and column, directly above
 * or below it (overlap allowed). The closest wins; undefined when none is near.
 */
export function pickMergeTarget<T extends { data: any }>(
  area: any,
  candidates: T[]
): { target: T; side: MergeSide } | undefined {
  const page = areaPage(area);
  const areaRect = area?.position?.boundingRect;
  if (!page || !areaRect?.width || !areaRect?.height) return undefined;
  const a = fraction(areaRect);

  let best: { target: T; side: MergeSide; gap: number } | undefined;
  for (const candidate of candidates) {
    if (isAreaHighlight(candidate.data) || candidate.data?.temp) continue;
    const onPage = rectsOf(candidate.data).filter((r) => r.pageNumber === page && r.width && r.height);
    if (!onPage.length) continue;
    const t = union(onPage.map(fraction));

    const overlap = Math.min(a.x2, t.x2) - Math.max(a.x1, t.x1);
    if (overlap < MIN_OVERLAP * Math.min(a.x2 - a.x1, t.x2 - t.x1)) continue;

    const side: MergeSide = (a.y1 + a.y2) / 2 >= (t.y1 + t.y2) / 2 ? 'below' : 'above';
    const gap = side === 'below' ? a.y1 - t.y2 : t.y1 - a.y2;
    if (gap > MAX_GAP) continue;
    if (!best || gap < best.gap) best = { target: candidate, side, gap };
  }
  return best && { target: best.target, side: best.side };
}

/**
 * The text highlight's Data with the area's box added as one more rect. Rects keep
 * their own viewport size, so the area's goes in as stored; the bounding rect (on
 * the highlight's first page) grows to cover it, in the bounding rect's own scale.
 */
export function mergeAreaIntoText(text: any, area: any): any {
  const page = areaPage(area);
  const areaRect: HighlightRect = { ...area.position.boundingRect, pageNumber: page };
  const rects = [...rectsOf(text), areaRect];

  let boundingRect = text.position.boundingRect;
  const firstPage = text.position.pageNumber ?? boundingRect?.pageNumber;
  if (boundingRect?.width && boundingRect?.height && page === firstPage) {
    const box = union([fraction(boundingRect), fraction(areaRect)]);
    boundingRect = {
      ...boundingRect,
      x1: box.x1 * boundingRect.width,
      y1: box.y1 * boundingRect.height,
      x2: box.x2 * boundingRect.width,
      y2: box.y2 * boundingRect.height,
    };
  }
  return { ...text, position: { ...text.position, boundingRect, rects } };
}

/** Share of a highlight's area that must lie inside the larger one for it to count as contained. */
export const MIN_CONTAINED = 0.8;

const area = (b: Box) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
const intersection = (a: Box, b: Box): Box => ({
  x1: Math.max(a.x1, b.x1),
  y1: Math.max(a.y1, b.y1),
  x2: Math.min(a.x2, b.x2),
  y2: Math.min(a.y2, b.y2),
});

/** The pages a highlight's rects lie on. */
export const pagesOf = (data: any): number[] => [...new Set(rectsOf(data).map((r) => r.pageNumber))];

/** Share of `inner`'s rect area that `outer`'s rects cover, page by page (0..1). */
export function coveredShare(inner: any, outer: any): number {
  const outerBoxes = rectsOf(outer)
    .filter((r) => r.width && r.height)
    .map((r) => ({ page: r.pageNumber, box: fraction(r) }));
  let total = 0;
  let covered = 0;
  for (const r of rectsOf(inner)) {
    if (!r.width || !r.height) continue;
    const box = fraction(r);
    const a = area(box);
    if (!a) continue;
    total += a;
    const hit = outerBoxes
      .filter((o) => o.page === r.pageNumber)
      .reduce((sum, o) => sum + area(intersection(box, o.box)), 0);
    covered += Math.min(a, hit);
  }
  return total ? covered / total : 0;
}

/**
 * The text highlights lying inside `outer` (a larger highlight made later over the
 * same passage). Area highlights are never absorbed: their Rem holds an image.
 */
export function pickContainedHighlights<T extends { data: any }>(outer: any, candidates: T[]): T[] {
  return candidates.filter(
    (c) => !isAreaHighlight(c.data) && !c.data?.temp && coveredShare(c.data, outer) >= MIN_CONTAINED
  );
}
