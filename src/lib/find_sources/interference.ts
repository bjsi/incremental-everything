/**
 * Find Interference: what in the user's library a note could be confused with, the
 * "similar but distinct" statements that cause memory interference (Wozniak's 20 rules:
 * "probably the single greatest cause of forgetting"), plus those that contradict the note
 * or say the same. Find Sources' search in its own mode (`find-passages` with
 * `mode: "interference"`), then Claude (the AI helper's /run) reads the passages in full and
 * names each statement: what it is about, its value, the note's value, and its words.
 * Written under the note after review (lib/find_sources writeInterference).
 *
 * The pure parts (no SDK runtime import) are in ./interference_items, under node:test.
 */
import type { RNPlugin } from '@remnote/plugin-sdk';
import { helperPost } from '../helper_client';
import { NoteSetting, PromptPassage, passageLines, QUOTE_RULES, SETTING_RULES, settingLines } from './check';
import { InterferenceResult, MAX_ITEMS, parseInterferenceItems } from './interference_items';
export * from './interference_items';

export type InterferenceModel = 'opus' | 'sonnet';
const INTERFERENCE_TIMEOUT_MS = 300_000;

const SYSTEM = `You look for MEMORY INTERFERENCE around one STATEMENT from a student's study \
notes for a maritime pilotage exam (shiphandling, seamanship, hydrodynamics, IMO rules, \
Brazilian maritime law; English and Portuguese): the statements in the numbered PASSAGES that \
the student could confuse with it, and the ones that contradict it or say the same. \
Interference between similar items is the main cause of forgetting; your list shows the \
student exactly which statements to keep apart.

Judge ONLY from the passages, each given in full. Never add facts from your own knowledge.

Find the statements that share the STATEMENT's FRAME: the same kind of thing (a distance, a \
time, a speed, an angle, a count, a command or order, a step of a procedure, who acts, a \
condition, a definition, a term) in the same or a neighbouring situation. Classify each:
- "similar": about ANOTHER thing (another order, step, stage, condition, ship, equipment) in \
the same frame, with a different value or term; or the same value or term with another \
meaning. The two could be swapped in memory. E.g. for the STATEMENT "at 'Atenção para \
largar o ferro', given about 100 yd from the anchoring point, the boatswain opens the brake": \
"'Preparar para largar o ferro', given about 1,000 yd from the anchoring point" (another \
order, another distance); "the distances are reported every 100 yd" (the same number, another \
meaning); "stop the engines about three ship lengths from the chosen position" (another \
action, another distance before anchoring).
- "diverges": about the SAME thing, with a different value or an incompatible claim: the \
sources disagree.
- "converges": about the SAME thing, saying the same: another book, or another place in the \
same book, confirms it.
Whether both are about the same thing decides between "similar" and the other two: the \
"subject"s must make it visible.

Leave out: the sentence the STATEMENT itself comes from; statements outside the frame; \
background and explanations. The passage the statement comes from often holds the most \
confusable statements (the steps before and after it): take them. One passage may give \
several items; the same statement found in several passages is one item per passage only \
when they are different books.

Reply with ONE JSON object and nothing else:
{"source": 0, "items": [{"kind": "similar" | "diverges" | "converges", "frame": "...", \
"here": {"subject": "...", "value": "..."}, "there": {"subject": "...", "value": "..."}, \
"quote": { ... }}]}

- "source": the number of the passage the STATEMENT itself comes from (its sentence is \
there), or 0 when none is.
- At most ${MAX_ITEMS} items, the most confusable first. None when nothing qualifies: \
"items": [].
- "frame": the shared frame in 2 to 6 words, in the language given as LANGUAGE \
("Distância ao ponto de fundeio"). Items of the same frame get the SAME words, letter for \
letter: the student may turn them into one card that asks each value next to the others.
- "here": what the STATEMENT gives on the frame; "there": the same for the passage's \
statement. Each is {"subject": what it is about, at most 8 words ("Preparar para largar o \
ferro", "máquinas paradas"), "value": the deciding figure or term, at most 5 words, as the \
source gives it ("~1.000 jds", "três comprimentos do navio", "Mestre")}. The value will be \
hidden as a cloze, so it holds only what must be recalled, never the subject; "~" for \
"cerca de" / "about". A diverging pair has the same subject and different values. In \
LANGUAGE, with the sources' own terms and numbers.
- Subjects and values are objective: what and how much, nothing else. No judgment, advice or \
comparison words ("unlike", "note that", "attention", "cuidado").
- "quote": the passage's words that state it, as below, in ONE quote object. Only the words \
that carry what it is about and its value, cut short: the student reads the quote to see \
the contrast at a glance (the whole sentence is pinned in the PDF anyway). E.g. from "À voz \
de “PREPARAR PARA LARGAR O FERRO”, dada a cerca de 1.000 jds do ponto de fundeio, o Sr. \
Mestre inicia os procedimentos para deixar o ferro pronto para largar." quote only "À voz de \
“PREPARAR PARA LARGAR O FERRO”, dada a cerca de 1.000 jds do ponto de fundeio". Two short \
excerpts are better than one long one; never the whole passage.

${SETTING_RULES}

${QUOTE_RULES}`;

/** Ask Claude for the interference around one note, from the passages found for it. */
export async function findInterference(
  plugin: RNPlugin,
  statement: string,
  lang: 'pt' | 'en',
  passages: PromptPassage[],
  model: InterferenceModel,
  setting?: NoteSetting
): Promise<InterferenceResult> {
  const lines = [`LANGUAGE: ${lang === 'pt' ? 'Brazilian Portuguese' : 'English'}`, '', ...settingLines(setting)];
  lines.push('STATEMENT:', statement.trim(), '', 'PASSAGES:');
  passages.forEach((p, k) => lines.push(...passageLines(p, k)));
  const res = await helperPost<{ data?: any; model?: string }>(
    plugin,
    '/run',
    { task: 'find-interference', system: SYSTEM, text: lines.join('\n'), json: true, model },
    { timeoutMs: INTERFERENCE_TIMEOUT_MS }
  );
  const source = Number(res.data?.source);
  return {
    items: parseInterferenceItems(res.data?.items, passages.map((p) => p.context || p.quote)),
    sourceIndex: Number.isInteger(source) && source >= 1 && source <= passages.length ? source - 1 : undefined,
    model: res.model,
  };
}
