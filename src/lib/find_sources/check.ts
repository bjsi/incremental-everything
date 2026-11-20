/**
 * Check Statement: Find Sources' passages, then a verdict on the Rem's statement from
 * Claude (the AI helper's /run), based on those passages only. Plan:
 * plans/implemented/SOURCE_FINDER_PLAN.md (phase 3).
 */
import { RNPlugin } from '@remnote/plugin-sdk';
import { helperPost } from '../helper_client';
import { attribution, ChosenQuote, parseChosenQuotes } from './quote_text';

export type Verdict = 'consistent' | 'partly' | 'contradicts' | 'not-covered';

export interface StatementCheck {
  verdict: Verdict;
  /** 2–4 sentences in the Rem's language: what is right or wrong and why, which source says so. */
  observation: string;
  /** Indexes (in the Rem's passage list) of the passages the verdict rests on. */
  basis: number[];
  /** The evidence Claude chose: per passage, the verbatim excerpts the verdict rests on (checked). */
  quotes: ChosenQuote[];
  /** The model that answered. */
  model?: string;
}

/** The verdict is a judgment made once per Rem on a short input: the stronger model. */
const CHECK_MODEL = 'opus';
const CHECK_TIMEOUT_MS = 240_000;

export const VERDICTS: Record<Verdict, { icon: string; pt: string; en: string }> = {
  consistent: { icon: '✅', pt: 'Correta', en: 'Consistent' },
  partly: { icon: '⚠️', pt: 'Em parte', en: 'Partly' },
  contradicts: { icon: '❌', pt: 'Incorreta', en: 'Contradicted' },
  'not-covered': { icon: '❔', pt: 'Não coberta pelas fontes', en: 'Not covered by the sources' },
};

/** "Verificação: ⚠️ Em parte (18/11/2026)" — the header of the Check Rem, dated so runs never overwrite each other. */
export function checkHeader(verdict: Verdict, lang: 'pt' | 'en', when = new Date()): string {
  const v = VERDICTS[verdict];
  const date = when.toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${lang === 'pt' ? 'Verificação' : 'Check'}: ${v.icon} ${v[lang]} (${date})`;
}

/**
 * How Claude picks the words to quote from a passage, shared by Check Statement and Ask Your
 * Sources (./ask): the /quote-exercises and /explain-with-quotes rules.
 */
export const QUOTE_RULES = `Each quote is {"passage": its number, "excerpts": [...], "emphasis": [...], "key": "..."}:
- "excerpts": the words of that passage that support your text, each COPIED CHARACTER FOR \
CHARACTER from the passage (same words, spelling, punctuation and order; never translated, \
paraphrased or shortened inside; you may only rejoin a word split across a line). Only \
what the claim needs: a sentence, a clause or a phrase; leave out cross-references, asides, \
examples and other points. When the support sits in separate places, give each as its own \
item, in passage order (they are shown joined with "[\u2026]"). Each item must make sense on \
its own: keep what "these values", "it" or "such" refer to.
- "emphasis": up to 4 short phrases (at most 6 words each) inside the excerpts that carry the \
point (the term, number, condition), copied exactly; shown in bold.
- "key": optionally the single word or figure the point turns on most, inside one \
"emphasis"; shown in bold italics. "" when none stands out.`;

/**
 * Where the note sits, for Claude only (the search gets the descriptor chain alone,
 * lib/find_sources enqueueStatements): `context` = a descriptor's concept and the
 * descriptors above it, which complete the note; `outline` = a few Rems above that, up to
 * the document, as background.
 */
export interface NoteSetting {
  context?: string;
  outline?: string;
}

export const SETTING_RULES = `Where the note sits in the student's outline may be given:
- OUTLINE PATH: the Rems above the note, outermost first, up to its document. Background \
only, to tell what the note is about (a question under "Tug assistance in ice" is about ice \
even when it does not say so); never a claim to check or a question to answer.
- CONTEXT: the topic the note is a descriptor of (e.g. "Rebocadores com tubulão" above \
"Não pode rebocar em que método?"). The note means nothing without it: read the note as \
being about that topic.`;

/** The OUTLINE PATH and CONTEXT lines of a prompt, outermost first; none when not given. */
export function settingLines(s: NoteSetting | undefined): string[] {
  const out: string[] = [];
  if (s?.outline?.trim()) out.push('OUTLINE PATH:', s.outline.trim(), '');
  if (s?.context?.trim()) out.push('CONTEXT:', s.context.trim(), '');
  return out;
}

const SYSTEM = `You check a statement from a student's study notes against passages from the \
bibliography of a maritime pilotage exam (shiphandling, hydrodynamics, IMO rules, Brazilian \
maritime law; English and Portuguese). Each passage is given in full.

Judge ONLY from the passages, never from your own knowledge. A point no passage settles is \
"not covered", even if you believe it is true. Never say a passage does not state something \
its text states.

Reply with ONE JSON object and nothing else:
{"verdict": "consistent" | "partly" | "contradicts" | "not-covered",
 "observation": "...",
 "quotes": [ ... ]}

- "verdict": consistent = every claim of the statement is supported; partly = some claims are \
supported and others are missing, imprecise or wrong; contradicts = a central claim is \
contradicted; not-covered = the passages do not settle the statement.
- "observation": 2 to 4 sentences, in the language given as LANGUAGE, for the student: what is \
right, what is wrong or imprecise and what the source says instead (the number, condition, \
term), and where the sources diverge from each other. Name the source as given in its header \
(e.g. "PIANC 121, p. 30"). No preamble, no restating the verdict word.
- "quotes": the evidence for the verdict, most important first: one quote per passage the \
verdict rests on, showing exactly what supports or contradicts the statement.

${SETTING_RULES}

${QUOTE_RULES}`;

/** One passage in a prompt: its number, attribution and full text (the provider's trim when there is none). */
export function passageLines(
  p: {
    quote: string;
    book: { cite?: string; title: string };
    pdfPage?: number;
    page?: number | null;
    sectionNumber?: string | null;
    edital?: string | null;
    context?: string;
  },
  k: number
): string[] {
  const where = attribution({
    cite: p.book.cite || p.book.title,
    sectionNumber: p.sectionNumber,
    page: p.pdfPage ?? p.page,
    edital: p.edital,
  });
  return ['', `[${k + 1}] ${where}`, p.context?.trim() || `\u201c${p.quote}\u201d`];
}

export type PromptPassage = Parameters<typeof passageLines>[0];

/** Ask Claude for the verdict on one Rem's statement, from the passages found for it. */
export async function checkStatement(
  plugin: RNPlugin,
  statement: string,
  lang: 'pt' | 'en',
  passages: PromptPassage[],
  setting?: NoteSetting
): Promise<StatementCheck> {
  const lines = [`LANGUAGE: ${lang === 'pt' ? 'Brazilian Portuguese' : 'English'}`, '', ...settingLines(setting)];
  lines.push('STATEMENT:', statement.trim(), '', 'PASSAGES:');
  passages.forEach((p, k) => lines.push(...passageLines(p, k)));
  const res = await helperPost<{ data?: any; model?: string }>(
    plugin,
    '/run',
    { task: 'check-statement', system: SYSTEM, text: lines.join('\n'), json: true, model: CHECK_MODEL },
    { timeoutMs: CHECK_TIMEOUT_MS }
  );
  const data = res.data ?? {};
  const verdict: Verdict = (Object.keys(VERDICTS) as Verdict[]).includes(data.verdict) ? data.verdict : 'not-covered';
  const quotes = parseChosenQuotes(data.quotes, passages.map((p) => p.context || p.quote));
  return {
    verdict,
    observation: String(data.observation ?? '').trim(),
    basis: [...new Set(quotes.map((q) => q.index))],
    quotes,
    model: res.model,
  };
}
