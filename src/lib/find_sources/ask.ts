/**
 * Ask Your Sources: a question or a topic in a Rem, answered from the passages Find Sources
 * finds for it (provider mode "answer"), by Claude through the AI helper's /run, in the
 * manner of the /explain-with-quotes skill: a direct answer, then short sections working up
 * from the core idea, each resting on numbered passages whose quotes are written under it,
 * then where the sources diverge. Written under the Rem after review (lib/find_sources).
 */
import { RNPlugin } from '@remnote/plugin-sdk';
import { helperPost } from '../helper_client';
import { ChosenQuote, parseChosenQuotes } from './quote_text';
import { passageLines, PromptPassage, QUOTE_RULES } from './check';
export { boldToRichText } from './quote_text';

export interface AnswerSection {
  /** 1–3 sentences on one point, in the Rem's language; **bold** marks key terms. */
  text: string;
  /** Indexes (in the Rem's passage list) of the passages this section rests on. */
  basis: number[];
  /** What Claude quotes for this section: per passage, the verbatim excerpts it rests on (checked). */
  quotes: ChosenQuote[];
}

export interface SourcesAnswer {
  /** The direct answer in one sentence ("not covered" said plainly when it is). */
  answer: string;
  covered: 'full' | 'partial' | 'none';
  sections: AnswerSection[];
  divergences: AnswerSection[];
  /** Every passage the answer uses. */
  basis: number[];
  model?: string;
}

/** Same reasoning as Check Statement's verdict: once per Rem, the stronger model. */
const ASK_MODEL = 'opus';
const ASK_TIMEOUT_MS = 300_000;

/** "Resposta (18/11/2026): …" — the answer's header, dated so runs never overwrite each other. */
export function answerHeader(answer: SourcesAnswer, lang: 'pt' | 'en', when = new Date()): string {
  const date = when.toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const label = lang === 'pt' ? 'Resposta' : 'Answer';
  const none = lang === 'pt' ? 'não coberta pelas fontes' : 'not covered by the sources';
  return `${label} (${date}): ${answer.covered === 'none' && !answer.answer ? none : answer.answer}`;
}

const SYSTEM = `You answer a student's question, or explain a topic, for a maritime pilotage \
exam (shiphandling, hydrodynamics, IMO rules, Brazilian maritime law; English and \
Portuguese), using ONLY numbered passages from the bibliography, each given in full.

Rules:
- Every claim must come from the passages. Never add facts, numbers or rules from your own \
knowledge. When the passages do not settle the question, say so plainly; you may say what \
they do establish. Never say a passage does not state something its text states.
- Numbers, units, conditions and definitions exactly as the passages give them.
- Start with the core idea, then work up to the details and conditions.
- When passages disagree (a different number, condition or definition), do not pick one \
silently: say which source says what.
- Name sources through the quotes; the text itself names a book only when contrasting \
sources ("Arte Naval dá 45°; Clark, 35–37°").
- Write in the language given as LANGUAGE. Use **bold** for the key terms and figures; no \
other markup, no headings, no lists inside a text.

Reply with ONE JSON object and nothing else:
{"answer": "the direct answer in one sentence",
 "covered": "full" | "partial" | "none",
 "sections": [{"text": "1 to 3 sentences on one point", "quotes": [ ... ]}],
 "divergences": [{"text": "where the sources disagree and how", "quotes": [ ... ]}]}

- "sections": 1 to 5, in teaching order. A topic (no question mark) gets the explanation it \
needs; a narrow question may need a single section.
- Each section's "quotes": the evidence for THAT section, most important first, showing \
exactly what supports each of its claims, so the student can check every sentence against \
its quote. Two sections may quote the same passage with different excerpts.
- "divergences": empty when the sources agree; each quotes every side.
- "covered": full = the passages answer it; partial = they answer part of it; none = they \
do not.

${QUOTE_RULES}`;

/** Ask Claude for the answer to one Rem's question or topic, from the passages found for it. */
export async function askSources(
  plugin: RNPlugin,
  question: string,
  lang: 'pt' | 'en',
  passages: PromptPassage[]
): Promise<SourcesAnswer> {
  const lines = [`LANGUAGE: ${lang === 'pt' ? 'Brazilian Portuguese' : 'English'}`, '', 'QUESTION OR TOPIC:', question.trim(), '', 'PASSAGES:'];
  passages.forEach((p, k) => lines.push(...passageLines(p, k)));
  const res = await helperPost<{ data?: any; model?: string }>(
    plugin,
    '/run',
    { task: 'ask-sources', system: SYSTEM, text: lines.join('\n'), json: true, model: ASK_MODEL },
    { timeoutMs: ASK_TIMEOUT_MS }
  );
  const data = res.data ?? {};
  const contexts = passages.map((p) => p.context || p.quote);
  const sections = (list: unknown): AnswerSection[] =>
    Array.isArray(list)
      ? list
          .map((s: any) => {
            const quotes = parseChosenQuotes(s?.quotes, contexts);
            return { text: String(s?.text ?? '').trim(), quotes, basis: [...new Set(quotes.map((q) => q.index))] };
          })
          .filter((s) => s.text)
      : [];
  const covered = ['full', 'partial', 'none'].includes(data.covered) ? data.covered : 'partial';
  const all = [...sections(data.sections), ...sections(data.divergences)];
  const answer = {
    answer: String(data.answer ?? '').trim(),
    covered,
    sections: sections(data.sections),
    divergences: sections(data.divergences),
    basis: [...new Set(all.flatMap((s) => s.basis))],
    model: res.model,
  };
  return answer;
}
