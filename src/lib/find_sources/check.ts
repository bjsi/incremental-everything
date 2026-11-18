/**
 * Check Statement: Find Sources' passages, then a verdict on the Rem's statement from
 * Claude (the AI helper's /run), based on those passages only. Plan:
 * plans/SOURCE_FINDER_PLAN.md (phase 3).
 */
import { RNPlugin } from '@remnote/plugin-sdk';
import { helperPost } from '../helper_client';
import { attribution } from './quote_text';

export type Verdict = 'consistent' | 'partly' | 'contradicts' | 'not-covered';

export interface StatementCheck {
  verdict: Verdict;
  /** 2–4 sentences in the Rem's language: what is right or wrong and why, which source says so. */
  observation: string;
  /** Indexes (in the Rem's passage list) of the passages the verdict rests on. */
  basis: number[];
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

const SYSTEM = `You check a statement from a student's study notes against passages from the \
bibliography of a maritime pilotage exam (shiphandling, hydrodynamics, IMO rules, Brazilian \
maritime law; English and Portuguese). The passages are verbatim quotes; parts left out are \
marked […].

Judge ONLY from the passages, never from your own knowledge. A point no passage settles is \
"not covered", even if you believe it is true.

Reply with ONE JSON object and nothing else:
{"verdict": "consistent" | "partly" | "contradicts" | "not-covered",
 "observation": "...",
 "basis": [passage numbers]}

- "verdict": consistent = every claim of the statement is supported; partly = some claims are \
supported and others are missing, imprecise or wrong; contradicts = a central claim is \
contradicted; not-covered = the passages do not settle the statement.
- "observation": 2 to 4 sentences, in the language given as LANGUAGE, for the student: what is \
right, what is wrong or imprecise and what the source says instead (the number, condition, \
term), and where the sources diverge from each other. Name the source as given in its header \
(e.g. "PIANC 121, p. 30"). No preamble, no restating the verdict word.
- "basis": the numbers of the passages the verdict rests on, most important first.`;

/** Ask Claude for the verdict on one Rem's statement, from the passages found for it. */
export async function checkStatement(
  plugin: RNPlugin,
  statement: string,
  lang: 'pt' | 'en',
  passages: {
    quote: string;
    book: { cite?: string; title: string };
    pdfPage?: number;
    page?: number | null;
    sectionNumber?: string | null;
    edital?: string | null;
  }[]
): Promise<StatementCheck> {
  const lines = [`LANGUAGE: ${lang === 'pt' ? 'Brazilian Portuguese' : 'English'}`, '', 'STATEMENT:', statement.trim(), '', 'PASSAGES:'];
  passages.forEach((p, k) => {
    const where = attribution({
      cite: p.book.cite || p.book.title,
      sectionNumber: p.sectionNumber,
      page: p.pdfPage ?? p.page,
      edital: p.edital,
    });
    lines.push('', `[${k + 1}] ${where}`, `“${p.quote}”`);
  });
  const res = await helperPost<{ data?: any; model?: string }>(
    plugin,
    '/run',
    { task: 'check-statement', system: SYSTEM, text: lines.join('\n'), json: true, model: CHECK_MODEL },
    { timeoutMs: CHECK_TIMEOUT_MS }
  );
  const data = res.data ?? {};
  const verdict: Verdict = (Object.keys(VERDICTS) as Verdict[]).includes(data.verdict) ? data.verdict : 'not-covered';
  const basis = Array.isArray(data.basis)
    ? [...new Set<number>(data.basis.map((n: unknown) => Number(n) - 1))].filter(
        (k) => Number.isInteger(k) && k >= 0 && k < passages.length
      )
    : [];
  return { verdict, observation: String(data.observation ?? '').trim(), basis, model: res.model };
}
