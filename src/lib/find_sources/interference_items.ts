/**
 * Find Interference (./interference): the pure parts, with no SDK runtime import, so they run
 * under node:test: the item types and labels, Claude's items checked against the passages,
 * the sentence to pin around an excerpt, and the user's own Rem that states it.
 */
import { ChosenQuote, parseChosenQuotes, plain } from './quote_text';

export type InterferenceKind = 'similar' | 'diverges' | 'converges';

/** One statement the note could be confused with (or that contradicts or confirms it). */
export interface InterferenceItem {
  kind: InterferenceKind;
  /** The frame both statements share, 2–6 words ("Distância ao ponto de fundeio"). */
  axis: string;
  /** What the note gives on the axis: what it is about and its value. */
  here: string;
  /** The same for the passage's statement. */
  there: string;
  /** Its words in the passage (checked against it). */
  quote: ChosenQuote;
}

export interface InterferenceResult {
  items: InterferenceItem[];
  model?: string;
}

/** What a review row carries on top of its passage (lib/find_sources ReviewPassage.interference). */
export interface InterferenceInfo {
  kind: InterferenceKind;
  axis: string;
  here: string;
  there: string;
  /** The user's own Rem that already states it (a card pinned to the same highlight). */
  notesRemId?: string;
  notesText?: string;
}

/** More than this is a list nobody reviews; the most confusable come first. */
export const MAX_ITEMS = 12;

export const KIND_LABELS: Record<InterferenceKind, { icon: string; pt: string; en: string }> = {
  similar: { icon: '≈', pt: 'Semelhantes, mas distintos', en: 'Similar but distinct' },
  diverges: { icon: '≠', pt: 'Divergências', en: 'Divergences' },
  converges: { icon: '=', pt: 'Convergências', en: 'Convergences' },
};

/** The order the groups are written and reviewed in. */
export const KIND_ORDER: InterferenceKind[] = ['similar', 'diverges', 'converges'];

/** "Interferências (23/11/2026)": the header, dated so runs never overwrite each other. */
export function interferenceHeader(lang: 'pt' | 'en', when = new Date()): string {
  const date = when.toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${lang === 'pt' ? 'Interferências' : 'Interference'} (${date})`;
}

/**
 * The item's line, objective: "**axis**: here × there" (a convergence: "**axis**: there").
 * Claude's own **bold** inside is kept.
 */
export function itemLine(info: Pick<InterferenceInfo, 'kind' | 'axis' | 'here' | 'there'>): string {
  const axis = info.axis.trim().replace(/\*\*/g, '');
  const body = info.kind === 'converges' || !info.here.trim() ? info.there.trim() : `${info.here.trim()} × ${info.there.trim()}`;
  return axis ? `**${axis}**: ${body}` : body;
}

const KINDS: InterferenceKind[] = ['similar', 'diverges', 'converges'];

/**
 * Claude's items, each with its quote checked against its passage's full text (`contexts`,
 * by passage number - 1). An item whose quote is not really there, or without a frame, is
 * dropped; so is a second item with the same words.
 */
export function parseInterferenceItems(raw: unknown, contexts: string[]): InterferenceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: InterferenceItem[] = [];
  const seen = new Set<string>();
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  for (const it of raw) {
    const kind = KINDS.includes((it as any)?.kind) ? ((it as any).kind as InterferenceKind) : null;
    const there = text((it as any)?.there);
    if (!kind || !there) continue;
    const [quote] = parseChosenQuotes([(it as any)?.quote], contexts);
    if (!quote) continue;
    const id = `${quote.index}:${quote.excerpts.map(plain).join('|')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind, axis: text((it as any)?.axis), here: text((it as any)?.here), there, quote });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// --- Pin the sentence, quote the words -------------------------------------------------

/** Above this, a "sentence" is a run-on list or a garbled stretch: pin the excerpt itself. */
const MAX_SENTENCE_CHARS = 600;

/** `text` reduced to letters and digits (as `plain`), with where each kept character came from. */
function plainWithMap(text: string): { flat: string; at: number[] } {
  let flat = '';
  const at: number[] = [];
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (/[\p{L}\p{N}]/u.test(ch)) {
      const low = ch.toLowerCase();
      flat += low;
      for (let n = 0; n < low.length; n++) at.push(k);
    }
  }
  return { flat, at };
}

/** A line that starts a list item: "(9)", "2.", "b)", "-", "•". */
const LIST_ITEM_START = /^[ \t]*(?:\(\w{1,3}\)|\w{1,3}[.)]|[-\u2022\u2013])\s/u;

/**
 * Whether the character at `k` ends a sentence (or a clause that stands on its own, for
 * pinning): . ! ? followed by a space or the end, not after an abbreviation ("Sr.", "p.",
 * "Fig."), a list number at a line start ("1."), and not followed by a lower-case word;
 * ; and : followed by a space; a blank line; a line break before a list item ("(9) …") or
 * after a line that ends in punctuation; a line break after a short heading-like line.
 */
function endsSentence(text: string, k: number): boolean {
  const ch = text[k];
  if (ch === '\n') {
    const rest = text.slice(k + 1);
    if (/^[ \t]*\n/.test(rest) || LIST_ITEM_START.test(rest)) return true;
    const line = text.slice(text.lastIndexOf('\n', k - 1) + 1, k).trim();
    return /[.;:!?]$/.test(line) || (line.length > 0 && line.length <= 40 && !/[,]$/.test(line) && /^\p{Lu}/u.test(rest.trim()));
  }
  if (k + 1 < text.length && !/\s/.test(text[k + 1])) return false;
  if (ch === ';' || ch === ':') return true;
  if (!'.!?'.includes(ch)) return false;
  if (ch === '.') {
    const word = /([\p{L}\p{N}]+)$/u.exec(text.slice(Math.max(0, k - 12), k))?.[1] ?? '';
    if (/^\p{Lu}\p{Ll}{0,2}$/u.test(word) || /^\p{Ll}$/u.test(word)) return false;
    if (/^\d{1,2}$/.test(word) && /(^|\n)\s*$/.test(text.slice(Math.max(0, k - word.length - 4), k - word.length))) return false;
  }
  const next = /\S/.exec(text.slice(k + 1));
  return !next || !/\p{Ll}/u.test(next[0]);
}

/**
 * The whole sentence of `context` that holds `excerpt`, verbatim, for pinning: a highlight
 * over the full sentence is found reliably in the PDF and reads well there, while the quote
 * Rem shows only the excerpt. The excerpt itself when it is not found, spans several
 * sentences that run too long, or the sentence is too long.
 */
export function sentenceAround(context: string, excerpt: string): string {
  const { flat, at } = plainWithMap(context);
  const needle = plain(excerpt);
  const pos = needle ? flat.indexOf(needle) : -1;
  if (pos === -1) return excerpt;
  let start = at[pos];
  let end = at[pos + needle.length - 1] + 1;
  while (start > 0 && !endsSentence(context, start - 1)) start--;
  while (end < context.length && !endsSentence(context, end - 1)) end++;
  const sentence = context.slice(start, end).trim();
  return sentence.length > MAX_SENTENCE_CHARS ? excerpt : sentence;
}

// --- The user's own note on it ---------------------------------------------------------

const STOPWORDS = new Set(
  (
    'que para com uma uns umas dos das nos nas pelo pela pelos pelas por sua seu suas seus ser são sao foi ' +
    'deve devem como mais isso este esta esse essa entre sobre quando onde também tambem até ate ' +
    'the and for with from that this these those are was were its into onto than then which when where ' +
    'will shall should must have has been being not'
  ).split(' ')
);

/** The words that identify a statement: accents off, lower case, numbers kept whole (1.000 → 1000). */
export function noteTokens(text: string): Set<string> {
  const flat = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(\d)[.,](?=\d{3}\b)/g, '$1');
  return new Set(
    flat
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w && !STOPWORDS.has(w) && (w.length >= 3 || /\d/.test(w)))
  );
}

/**
 * How well a Rem's text states the excerpt: the F1 of their shared words (how much of the
 * Rem the excerpt explains, how much of the excerpt the Rem holds). 0 below three shared words.
 */
export function noteMatchScore(remText: string, excerpt: string): number {
  const a = noteTokens(remText);
  const b = noteTokens(excerpt);
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  if (shared < 3) return 0;
  const p = shared / a.size;
  const r = shared / b.size;
  return (2 * p * r) / (p + r);
}

/** Below this, no Rem is said to state the excerpt. */
export const NOTE_MATCH_MIN = 0.4;

/** The best of `candidates` for the excerpt, when one is good enough. */
export function bestNoteMatch<T extends { text: string }>(candidates: T[], excerpt: string): T | undefined {
  let best: T | undefined;
  let bestScore = NOTE_MATCH_MIN;
  for (const c of candidates) {
    const s = noteMatchScore(c.text, excerpt);
    if (s >= bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}
