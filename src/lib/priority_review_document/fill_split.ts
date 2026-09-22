/**
 * How a Priority Queue document's fill target divides between flashcard Rems
 * and IncRems — for the WHOLE document, not for one top-up.
 *
 * The split used to be computed on each top-up, and the fill loop starts every
 * cycle with an IncRem, so a refill of one or two slots after a short session
 * added an IncRem each time. IncRems leave only when reviewed, which the queue
 * does about once per `ratio` cards, so they piled up and pushed flashcards
 * out: 14 IncRems against 11 flashcard Rems at a 10:1 ratio, measured.
 *
 * IncRems get `ceil(target / (ratio + 1))` slots — enough for what one session
 * of the flashcard share injects at the ratio — and flashcards the rest.
 * Pure: no SDK, so it is unit-tested.
 */

export type FillRatio = number | 'no-cards' | 'no-rem';

export interface FillSlots {
  flashcards: number;
  incRems: number;
}

export function splitFillTarget(target: number, ratio: FillRatio): FillSlots {
  const total = Math.max(0, Math.floor(target));
  if (ratio === 'no-cards') return { flashcards: 0, incRems: total };
  if (ratio === 'no-rem') return { flashcards: total, incRems: 0 };
  const perIncRem = Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
  const incRems = Math.min(total, Math.ceil(total / (perIncRem + 1)));
  return { flashcards: total - incRems, incRems };
}
