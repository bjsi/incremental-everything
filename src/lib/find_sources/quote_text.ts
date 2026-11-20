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

/** **bold** in Claude's text as RemNote rich text (other markup stays as typed). */
export function boldToRichText(text: string): RichElement[] {
  const out: RichElement[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if ((m.index ?? 0) > last) out.push(text.slice(last, m.index));
    out.push({ i: 'm', text: m[1], b: true });
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.filter((el) => el !== '');
}

// --- Excerpts chosen by Claude (Check Statement, Ask Your Sources) ---------------------

/** For comparing copies: letters and digits only, lower case (spacing, hyphens and quotes from the PDF don't count). */
export const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** A quote Claude chose from one passage: its verbatim excerpts and what to emphasize. */
export interface ChosenQuote {
  /** Index of the passage in the Rem's passage list. */
  index: number;
  excerpts: string[];
  emphasis: string[];
  key: string;
}

/**
 * Claude's quote, checked against the passage's full text: the excerpts that are really
 * there (the AI never types a quote), in the order they appear, and the emphasis that falls
 * inside them. Null when no excerpt survives: the caller keeps the provider's own trim.
 */
export function checkedQuote(quote: ChosenQuote, context: string): ChosenQuote | null {
  const whole = plain(context);
  if (!whole) return null;
  const excerpts = [...new Set(quote.excerpts.map((e) => e.trim()).filter((e) => plain(e) && whole.includes(plain(e))))].sort(
    (a, b) => whole.indexOf(plain(a)) - whole.indexOf(plain(b))
  );
  if (!excerpts.length) return null;
  const inside = (t: string) => !!plain(t) && excerpts.some((e) => plain(e).includes(plain(t)));
  const emphasis = quote.emphasis.map((e) => e.trim()).filter(inside).slice(0, 4);
  const key = inside(quote.key) && emphasis.some((e) => plain(e).includes(plain(quote.key))) ? quote.key.trim() : '';
  return { index: quote.index, excerpts, emphasis, key };
}

/** Several quotes of one passage merged into one, excerpts in passage order (what the review shows). */
export function mergedQuote(quotes: ChosenQuote[], context: string): ChosenQuote | null {
  if (!quotes.length) return null;
  return checkedQuote(
    {
      index: quotes[0].index,
      excerpts: quotes.flatMap((q) => q.excerpts),
      emphasis: [...new Set(quotes.flatMap((q) => q.emphasis))],
      key: quotes.find((q) => q.key)?.key ?? '',
    },
    context
  );
}

/**
 * The quotes in Claude's JSON ({passage, excerpts, emphasis, key}), checked against the
 * passages' full texts (`contexts`, by passage number - 1). Malformed or unverifiable
 * quotes are dropped.
 */
export function parseChosenQuotes(raw: unknown, contexts: string[]): ChosenQuote[] {
  if (!Array.isArray(raw)) return [];
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const out: ChosenQuote[] = [];
  for (const q of raw) {
    const index = Number((q as { passage?: unknown })?.passage) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= contexts.length) continue;
    const checked = checkedQuote(
      {
        index,
        excerpts: strings((q as { excerpts?: unknown }).excerpts),
        emphasis: strings((q as { emphasis?: unknown }).emphasis),
        key: typeof (q as { key?: unknown }).key === 'string' ? ((q as { key: string }).key) : '',
      },
      contexts[index]
    );
    if (checked) out.push(checked);
  }
  return out;
}
