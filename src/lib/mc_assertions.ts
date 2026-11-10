// lib/mc_assertions.ts
//
// Finds the assertions of a multiple-choice question of the "judge each
// sentence" kind: the question lists numbered statements on their own lines
//
//     I. In a 3D body, …
//     • II. On the parallel middle body …
//     III) At the stern …   (or "III- At the stern …")
//
// and the options say which are true or false ("Only II is false."). The
// answer sheet (widgets/mc_assertions.tsx) shows one T/F box per statement.
//
// Pure (no SDK): the controller in lib/mc_scissors.ts feeds it the question's
// front text and opens the sheet when it returns two or more labels.

/** A question that numbers more statements than this gets no sheet. */
export const MAX_ASSERTIONS = 10;

// A line opening with a roman numeral and ".", ")" or a dash ("I- ", "II – "),
// optionally after a bullet. A space must follow the mark.
const ASSERTION_LINE = /^[ \t]*(?:[•·▪◦\-–—*][ \t]*)?([IVX]{1,5})(?:[.)]|[ \t]*[-–—])[ \t]+\S/;

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10 };

/** The value of a roman numeral up to 39, or 0 for an invalid one ("IIII", "VX"). */
export function romanValue(numeral: string): number {
  let total = 0;
  for (let i = 0; i < numeral.length; i++) {
    const v = ROMAN[numeral[i]];
    const next = ROMAN[numeral[i + 1]] ?? 0;
    total += v < next ? -v : v;
  }
  return toRoman(total) === numeral ? total : 0;
}

function toRoman(n: number): string {
  const parts: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of parts) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}

/** Plain text of a rich-text value, with references and other non-text elements dropped. */
export function richTextPlain(richText: unknown): string {
  if (!Array.isArray(richText)) return '';
  return richText
    .map((el) => (typeof el === 'string' ? el : el && el.i === 'm' && typeof el.text === 'string' ? el.text : ''))
    .join('');
}

/**
 * The numerals of the question's assertions, in order ("I", "II", "III").
 * Only a run counting up from I is accepted, so a stray "V." or "I. …" in
 * prose does not raise a sheet; fewer than two assertions returns [].
 */
export function assertionLabels(text: string): string[] {
  const labels: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ASSERTION_LINE.exec(line);
    if (!m) continue;
    const value = romanValue(m[1]);
    if (value !== labels.length + 1) continue;
    labels.push(m[1]);
    if (labels.length === MAX_ASSERTIONS) break;
  }
  return labels.length >= 2 ? labels : [];
}
