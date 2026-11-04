// Back-text handling for True/False cards (see src/register/true_false.ts).
// Pure, so it can be tested without RemNote: reference elements are resolved
// by the caller and handed in as plain strings.

export type Verdict = 'true' | 'false';

export const VERDICT_MARK: Record<Verdict, string> = {
  true: '✅',
  false: '❌',
};

/** Everything that states a verdict on a back. VERDICT_MARK is the one the plugin writes. */
const MARKS: Record<Verdict, RegExp> = {
  true: /[✅✔☑✓]\uFE0F?/g,
  false: /[❌✖]\uFE0F?/g,
};

const hasMark = (text: string, verdict: Verdict) => text.search(MARKS[verdict]) >= 0;
const withoutMarks = (text: string, verdict: Verdict) => text.replace(MARKS[verdict], '');
/** The text is that mark and nothing else, as in a Rem named "❌". */
const isOnlyMark = (text: string, verdict: Verdict) =>
  hasMark(text, verdict) && withoutMarks(text, verdict).trim() === '';

/** The same in words, as a whole word in any case. Only for judging: see verdictFromWords. */
const WORDS: Record<Verdict, string[]> = {
  true: ['true', 'verdadeiro', 'verdadeira'],
  false: ['false', 'falso', 'falsa'],
};
const wordPattern = (words: string[], flags: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])(${words.join('|')})(?=$|[^\\p{L}\\p{N}])`, flags);
const WORD_PATTERN: Record<Verdict, RegExp> = {
  true: wordPattern(WORDS.true, 'iu'),
  false: wordPattern(WORDS.false, 'iu'),
};
const allWordsPattern = () => wordPattern([...WORDS.true, ...WORDS.false], 'giu');

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
 *  - a right mark is already there (any of MARKS, typed, or a reference to a Rem
 *    named after it): nothing to do;
 *  - the opposite mark is there: it alone is swapped, in place;
 *  - no mark: one is put in front of whatever the back holds.
 */
export function backTextWithVerdict(
  back: any[] | undefined,
  verdict: Verdict,
  refText: Record<string, string> = {}
): any[] | null {
  const mark = VERDICT_MARK[verdict];
  const opposite = otherVerdict(verdict);
  const elements = back ?? [];
  const swapped = (text: string) => text.replace(MARKS[opposite], mark);

  if (elements.some((el) => hasMark(elementText(el, refText), verdict))) return null;

  if (elements.some((el) => hasMark(elementText(el, refText), opposite))) {
    return elements.map((el) => {
      if (typeof el === 'string') return swapped(el);
      if (isRemReference(el)) {
        // A reference that IS the mark (a Rem named "❌") becomes plain text; one
        // that merely mentions it is somebody's content and is left alone.
        return isOnlyMark(refText[el._id] ?? '', opposite) ? mark : el;
      }
      if (typeof el?.text === 'string' && hasMark(el.text, opposite)) {
        return { ...el, text: swapped(el.text) };
      }
      return el;
    });
  }

  return elements.length === 0 ? [mark] : [`${mark} `, ...elements];
}

type Stated = Verdict | 'both' | null;

const decide = (states: (verdict: Verdict) => boolean): Stated => {
  const isTrue = states('true');
  const isFalse = states('false');
  if (isTrue && isFalse) return 'both';
  return isTrue ? 'true' : isFalse ? 'false' : null;
};

/**
 * What the marks on a back state: the verdict, 'both' when they say both (no way
 * to tell which one is meant), or null with no mark. A reference counts only when
 * it IS the mark (a Rem named "❌"): one that merely mentions it is somebody's
 * content, as in backTextWithVerdict.
 */
export function verdictFromMarks(back: any[] | undefined, refText: Record<string, string> = {}): Stated {
  return decide((verdict) =>
    (back ?? []).some((el) =>
      isRemReference(el) ? isOnlyMark(refText[el._id] ?? '', verdict) : hasMark(elementText(el, refText), verdict)
    )
  );
}

/**
 * The same from the words on a back, for one with no mark at all. A word can sit
 * in an explanation ("a false premise"), so these judgments are the user's to
 * confirm. A reference counts only when the Rem's whole name is the word.
 */
export function verdictFromWords(back: any[] | undefined, refText: Record<string, string> = {}): Stated {
  return decide((verdict) =>
    (back ?? []).some((el) => {
      if (isRemReference(el)) return WORDS[verdict].includes((refText[el._id] ?? '').trim().toLowerCase());
      // Plain text only: a formula or a code element is not somebody saying "true".
      const text = typeof el === 'string' ? el : el?.i === 'm' && !el.code ? el.text : '';
      return typeof text === 'string' && WORD_PATTERN[verdict].test(text);
    })
  );
}

/** A text cut into its verdict words and what lies between them, to show the words. */
export function splitOnVerdictWords(text: string): { text: string; isWord: boolean }[] {
  const parts: { text: string; isWord: boolean }[] = [];
  let at = 0;
  for (const match of Array.from(text.matchAll(allWordsPattern()))) {
    const wordStart = match.index! + match[1].length;
    if (wordStart > at) parts.push({ text: text.slice(at, wordStart), isWord: false });
    parts.push({ text: match[2], isWord: true });
    at = wordStart + match[2].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), isWord: false });
  return parts;
}

/** The confirmation of "Judge by Emoji", and the session key its answer comes back on. */
export const JUDGE_CONFIRM_POPUP = 'true_false_judge_confirm';
export const judgeConfirmRequestKey = 'trueFalseJudgeConfirmRequest';

/** A card judged by a word on its back, for the user to accept or not. */
export interface JudgeWordItem {
  remId: string;
  verdict: Verdict;
  remText: string;
  backText: string;
}

export interface JudgeConfirmContext {
  id: number;
  scanned: number;
  /** Cards judged by their mark: nothing to check one by one. */
  trueByMark: number;
  falseByMark: number;
  byWord: JudgeWordItem[];
  /** Cards whose tag already matches their back: nothing to do. */
  alreadyMarked: number;
  /** Cards whose back states both true and false. */
  bothMarks: number;
}

export interface JudgeConfirmAnswer {
  id: number;
  /** The word-judged cards the user unticked. */
  rejectedRemIds: string[];
}

/**
 * Whether a back says nothing beyond the verdict mark. Anything not known to be
 * text (an image, an unresolved reference) counts as content.
 */
export function isBareVerdictBack(back: any[] | undefined, refText: Record<string, string> = {}): boolean {
  const onlyMarks = (text: string) => withoutMarks(withoutMarks(text, 'true'), 'false').replace(/\uFE0F/g, '').trim() === '';

  return (back ?? []).every((el) => {
    if (typeof el === 'string') return onlyMarks(el);
    if (isRemReference(el)) return el._id in refText && onlyMarks(refText[el._id]);
    return el?.i === 'm' && typeof el.text === 'string' && onlyMarks(el.text);
  });
}
