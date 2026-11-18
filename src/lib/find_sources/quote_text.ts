/**
 * A Find Sources quote with its emphasis, the way /quote-exercises writes quotes: the
 * words the point turns on in bold, the single word or figure it hinges on in bold
 * italics. Emphasis only marks text; it never adds, drops or changes a word.
 */
import { RichElement } from './placement';

export interface QuoteSegment {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** Where `phrase` sits in `text`: exactly, else ignoring case; -1 when it is not there. */
function find(text: string, phrase: string, from = 0): number {
  const exact = text.indexOf(phrase, from);
  return exact !== -1 ? exact : text.toLowerCase().indexOf(phrase.toLowerCase(), from);
}

/**
 * The quote cut into plain, bold and bold-italic runs. Each `bold` phrase marks its
 * first occurrence; `key` marks an occurrence inside a bold run (else its first one).
 * Phrases that are not in the text are ignored.
 */
export function emphasisSegments(text: string, bold: string[] = [], key = ''): QuoteSegment[] {
  const b = new Array<boolean>(text.length).fill(false);
  const i = new Array<boolean>(text.length).fill(false);
  for (const phrase of bold) {
    const p = phrase.trim();
    const at = p ? find(text, p) : -1;
    if (at !== -1) b.fill(true, at, at + p.length);
  }
  const k = key.trim();
  if (k) {
    let at = find(text, k);
    let inBold = -1;
    while (at !== -1) {
      if (b.slice(at, at + k.length).every(Boolean)) {
        inBold = at;
        break;
      }
      at = find(text, k, at + 1);
    }
    const chosen = inBold !== -1 ? inBold : find(text, k);
    if (chosen !== -1) {
      b.fill(true, chosen, chosen + k.length);
      i.fill(true, chosen, chosen + k.length);
    }
  }
  const out: QuoteSegment[] = [];
  for (let c = 0; c < text.length; c++) {
    const last = out[out.length - 1];
    if (last && last.bold === b[c] && last.italic === i[c]) last.text += text[c];
    else out.push({ text: text[c], bold: b[c], italic: i[c] });
  }
  return out;
}

/** The segments as RemNote rich text: plain strings, and `{ i: 'm', b, l }` runs. */
export function segmentsToRichText(segments: QuoteSegment[]): RichElement[] {
  return segments.map((s) =>
    s.bold || s.italic ? { i: 'm', text: s.text, ...(s.bold ? { b: true } : {}), ...(s.italic ? { l: true } : {}) } : s.text
  );
}

/**
 * The attribution the skills use: (cite, §x.y, PDF p. N; fora do edital). The section
 * only when the book numbers it; "fora do edital" for a passage the exam does not ask for.
 */
export function attribution(p: {
  cite: string;
  sectionNumber?: string | null;
  page?: number | null;
  edital?: string | null;
}): string {
  const parts = [p.cite, p.sectionNumber ? `§${p.sectionNumber}` : '', p.page ? `PDF p. ${p.page}` : ''].filter(Boolean);
  const outside = p.edital && p.edital !== 'sim' ? '; fora do edital' : '';
  return `(${parts.join(', ')}${outside})`;
}
