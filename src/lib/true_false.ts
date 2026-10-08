// Back-text handling for True/False cards (see src/register/true_false.ts).
// Pure, so it can be tested without RemNote: reference elements are resolved
// by the caller and handed in as plain strings.

export type Verdict = 'true' | 'false';

export const VERDICT_MARK: Record<Verdict, string> = {
  true: '✅',
  false: '❌',
};

const otherVerdict = (verdict: Verdict): Verdict => (verdict === 'true' ? 'false' : 'true');

const isRemReference = (el: any): boolean =>
  !!el && typeof el === 'object' && el.i === 'q' && typeof el._id === 'string';

/** The Rem ids referenced by a back text, for the caller to resolve to their text. */
export function referencedRemIds(back: any[] | undefined): string[] {
  return (back ?? []).filter(isRemReference).map((el) => el._id);
}

function elementText(el: any, refText: Record<string, string>): string {
  if (typeof el === 'string') return el;
  if (isRemReference(el)) return refText[el._id] ?? '';
  return typeof el?.text === 'string' ? el.text : '';
}

/**
 * The back text a card must have to state `verdict`, or null when it already
 * does. Everything other than the mark is kept as it is:
 *  - the right mark is already there (typed, or a reference to a Rem named
 *    after it): nothing to do;
 *  - the opposite mark is there: it alone is swapped, in place;
 *  - no mark: one is put in front of whatever the back holds.
 */
export function backTextWithVerdict(
  back: any[] | undefined,
  verdict: Verdict,
  refText: Record<string, string> = {}
): any[] | null {
  const mark = VERDICT_MARK[verdict];
  const opposite = VERDICT_MARK[otherVerdict(verdict)];
  const elements = back ?? [];

  if (elements.some((el) => elementText(el, refText).includes(mark))) return null;

  if (elements.some((el) => elementText(el, refText).includes(opposite))) {
    return elements.map((el) => {
      if (typeof el === 'string') return el.split(opposite).join(mark);
      if (isRemReference(el)) {
        // A reference that IS the mark (a Rem named "❌") becomes plain text; one
        // that merely mentions it is somebody's content and is left alone.
        return (refText[el._id] ?? '').trim() === opposite ? mark : el;
      }
      if (typeof el?.text === 'string' && el.text.includes(opposite)) {
        return { ...el, text: el.text.split(opposite).join(mark) };
      }
      return el;
    });
  }

  return elements.length === 0 ? [mark] : [`${mark} `, ...elements];
}
