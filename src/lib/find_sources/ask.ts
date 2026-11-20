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
import { NoteSetting, passageLines, PromptPassage, QUOTE_RULES, SETTING_RULES, settingLines } from './check';
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

/** Asked again from the review: what to improve or add, and the answer it rewrites. */
export interface FollowUp {
  instruction: string;
  previous?: SourcesAnswer;
}

/** The previous answer as plain text for the follow-up prompt (its passage numbers are stale). */
function previousText(a: SourcesAnswer): string {
  return [
    a.answer,
    ...a.sections.map((s) => `- ${s.text}`),
    ...a.divergences.map((s) => `- (divergence) ${s.text}`),
  ].join('\n');
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
- Say each fact once, as briefly as the question allows. The answer sentence gives the \
conclusion; the sections only add what it does not (the definition, the reasons, the \
conditions), never restate it or each other. A narrow factual question usually needs 1 or 2 \
sections.
- When the sources disagree (a different number, condition or definition), do not pick one \
silently: say which source says what, once, where the point comes up. When the disagreement \
IS the answer, the answer sentence and the sections already show it: leave "divergences" \
empty.
- Name sources through the quotes; the text itself names a book only when contrasting \
sources ("Arte Naval dá 45°; Clark, 35–37°"). Never write "passages", "trechos" or their \
numbers in the text.
- Write in the language given as LANGUAGE. Use **bold** for the key terms and figures; no \
other markup, no headings, no lists inside a text.

When a FOLLOW-UP REQUEST is given (with the PREVIOUS ANSWER it asks to change), write the \
whole answer again: keep what the previous answer got right, and change, correct, add or \
cut what the request asks for (another aspect, more detail, a shorter answer, a point it \
missed). The request never relaxes the rules above: everything still comes from the \
passages, and when they do not cover what it asks, say so in the answer.

Reply with ONE JSON object and nothing else:
{"answer": "the direct answer in one sentence",
 "covered": "full" | "partial" | "none",
 "sections": [{"text": "1 to 3 sentences on one point", "quotes": [ ... ]}],
 "divergences": [{"text": "where the sources disagree and how", "quotes": [ ... ]}]}

- "sections": 1 to 4, in teaching order. A topic (no question mark) gets the explanation it \
needs; a narrow question may need a single section.
- Each section's "quotes": the evidence for THAT section, most important first, showing \
exactly what supports each of its claims, so the student can check every sentence against \
its quote. Two sections may quote the same passage with different excerpts.
- "divergences": only a disagreement the answer and the sections have NOT already shown \
(usually none); quote only what no section has quoted. Empty when the sources agree.
- "covered": full = the passages answer it; partial = they answer part of it; none = they \
do not.

${SETTING_RULES}

${QUOTE_RULES}`;

/** Ask Claude for the answer to one Rem's question or topic, from the passages found for it. */
export async function askSources(
  plugin: RNPlugin,
  question: string,
  lang: 'pt' | 'en',
  passages: PromptPassage[],
  followUp?: FollowUp,
  setting?: NoteSetting
): Promise<SourcesAnswer> {
  const lines = [`LANGUAGE: ${lang === 'pt' ? 'Brazilian Portuguese' : 'English'}`, '', ...settingLines(setting)];
  lines.push('QUESTION OR TOPIC:', question.trim(), '');
  if (followUp?.instruction.trim()) {
    if (followUp.previous) lines.push('PREVIOUS ANSWER:', previousText(followUp.previous), '');
    lines.push('FOLLOW-UP REQUEST:', followUp.instruction.trim(), '');
  }
  lines.push('PASSAGES:');
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
