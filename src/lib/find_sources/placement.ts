/**
 * Where Find Sources puts a pin in the Rem's own text (plans/implemented/SOURCE_FINDER_PLAN.md,
 * "Inline placement rule"): right after the sentence a passage supports, when the Rem
 * mixes what several passages say and that sentence can be found with certainty;
 * otherwise at the end. Pure functions over rich text, so they can be tested.
 */

/** A rich-text element, as RemNote stores it (a plain string, or an object with `i`). */
export type RichElement = string | { i: string; text?: string; _id?: string; pin?: boolean; [k: string]: unknown };

/** A pin: a reference shown as 📌. */
export const isPinElement = (el: RichElement): boolean =>
  typeof el === 'object' && el !== null && el.i === 'q' && !!el.pin;

/** Stands for an element whose text is unknown here (a reference, LaTeX, an image): never inside a match. */
const OPAQUE = '￼';

interface Span {
  index: number;
  start: number;
  end: number;
  /** Its text can be split (a plain string or a formatted text run). */
  splittable: boolean;
}

/** The text the elements show, with where each element sits in it. Pins take no room. */
function layout(rt: RichElement[]): { text: string; spans: Span[] } {
  let text = '';
  const spans: Span[] = [];
  rt.forEach((el, index) => {
    let piece: string;
    let splittable = false;
    if (typeof el === 'string') {
      piece = el;
      splittable = true;
    } else if (isPinElement(el)) {
      piece = '';
    } else if (el.i === 'm' && typeof el.text === 'string') {
      piece = el.text;
      splittable = true;
    } else {
      piece = OPAQUE;
    }
    spans.push({ index, start: text.length, end: text.length + piece.length, splittable });
    text += piece;
  });
  return { text, spans };
}

const WORD = /[\p{L}\p{N}]+/gu;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Closing punctuation a sentence can end with, past the last word. */
const CLOSERS = /^[.;:!?)\]”"'’»…]+/u;

/**
 * Where, in the text the elements show, the part `covers` of it ends — moved past its
 * closing punctuation — when it is one or more whole sentences: it starts the text or a
 * sentence, and ends the text or a sentence. Words must match in order; spacing,
 * punctuation and letter case between them may differ (the provider checks `covers`
 * the same lenient way). Null when it is not there, is there twice, or crosses a
 * reference or formula.
 */
export function sentenceEnd(rt: RichElement[], covers: string): number | null {
  const words = covers.match(WORD);
  if (!words?.length) return null;
  const { text } = layout(rt);
  const pattern = new RegExp(words.map(escape).join('[^\\p{L}\\p{N}\\uFFFC]+'), 'giu');
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const start = matches[0].index ?? 0;
  let end = start + matches[0][0].length;
  end += CLOSERS.exec(text.slice(end))?.[0].length ?? 0;

  const before = text.slice(0, start).trimEnd();
  const startsSentence = before === '' || /[.;:!?)\]”"'’»…]$/u.test(before);
  const after = text.slice(end);
  const endsSentence = after.trim() === '' || (/^\s/.test(after) && /[.;:!?)\]”"'’»…]$/u.test(text.slice(0, end)));
  return startsSentence && endsSentence ? end : null;
}

/**
 * The elements with pins to `ids` inserted at `offset` of the text they show. A
 * plain string or formatted run is split there, keeping its formatting on both sides.
 * Null when the offset falls inside an element that cannot be split.
 */
export function insertPinsAt(rt: RichElement[], offset: number, ids: string[]): RichElement[] | null {
  if (!ids.length) return rt;
  const pins: RichElement[] = ids.flatMap((id) => [' ', { i: 'q', _id: id, pin: true }]);
  const { spans } = layout(rt);
  // The last element that ends at the offset or contains it: pins go after it.
  const span = [...spans].reverse().find((s) => s.start < offset && s.end >= offset) ?? null;
  if (!span) return offset === 0 ? [...pins, ...rt] : null;
  const el = rt[span.index];
  if (span.end === offset) return [...rt.slice(0, span.index + 1), ...pins, ...rt.slice(span.index + 1)];
  if (!span.splittable) return null;
  const cut = offset - span.start;
  const [head, tail]: RichElement[] =
    typeof el === 'string'
      ? [el.slice(0, cut), el.slice(cut)]
      : [
          { ...el, text: (el.text as string).slice(0, cut) },
          { ...el, text: (el.text as string).slice(cut) },
        ];
  return [...rt.slice(0, span.index), head, ...pins, tail, ...rt.slice(span.index + 1)];
}

/** The ids of the pins already in the text. */
export const pinnedIds = (rt: RichElement[]): Set<string> =>
  new Set(rt.filter(isPinElement).map((el) => (el as { _id: string })._id));

/**
 * Put each passage's pins after the sentence it covers. Only when two or more
 * passages cover different parts of the text: one source for the whole Rem goes at
 * the end. A passage whose sentence cannot be placed with certainty is left out of the
 * result, for the caller to pin at the end.
 */
export function placeInline(
  rt: RichElement[],
  passages: { covers: string; pins: string[] }[]
): { text: RichElement[]; placed: number[] } {
  const candidates = passages
    .map((p, k) => ({ ...p, k }))
    .filter((p) => p.covers.trim() && p.pins.length);
  if (candidates.length < 2) return { text: rt, placed: [] };

  // Each covers must sit at its own place in the text; two passages on the same
  // sentence share it (both pins go there).
  let text = rt;
  const placed: number[] = [];
  const ends = candidates.map((p) => ({ p, end: sentenceEnd(text, p.covers) }));
  const distinct = new Set(ends.filter((e) => e.end !== null).map((e) => e.end));
  if (distinct.size < 2) return { text: rt, placed: [] };

  // Insert from the end backwards, so earlier offsets stay valid.
  for (const { p, end } of ends.filter((e) => e.end !== null).sort((a, b) => (b.end as number) - (a.end as number))) {
    const already = pinnedIds(text);
    const fresh = p.pins.filter((id) => !already.has(id));
    const next = insertPinsAt(text, end as number, fresh);
    if (!next) continue;
    text = next;
    placed.push(p.k);
  }
  return { text, placed: placed.sort((a, b) => a - b) };
}
