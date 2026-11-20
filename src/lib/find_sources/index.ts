/**
 * Find Sources: the passages of the user's library that SAY what a note says (a
 * summary, a translation, a paraphrase), found by meaning, checked in the RemNote PDF,
 * reviewed, then pinned. Plan: plans/implemented/SOURCE_FINDER_PLAN.md (phase 2).
 *
 * The flow, all in the background so nothing waits on the ~25 s search per Rem:
 * 1. The command (or "Search by meaning" in Pin Source Quote's dialog) queues a
 *    FindSourcesJob in session storage and returns.
 * 2. The tracker (register/tracker.ts) runs it: the corpus provider's `find-passages`
 *    (docs/Corpus-Provider.md) per Rem, then a dry run of each passage's quote in its
 *    book's RemNote PDFs (the real page; whether it can be pinned at all). It posts a
 *    notice whose Review button opens the popup (widgets/find_sources_popup).
 * 3. The popup hands the accepted passages back (pendingFindSourcesWritesKey); the
 *    tracker pins them (a popup's teardown would cut a long write short) and dismisses
 *    the notice.
 */
import { BuiltInPowerupCodes, PluginRem, ReactRNPlugin, RichTextInterface, RNPlugin } from '@remnote/plugin-sdk';
import {
  aiNotePowerupCode,
  FIND_SOURCES_POPUP,
  pendingFindSourcesJobsKey,
  pendingFindSourcesWritesKey,
} from '../consts';
import { CorpusUnavailableError, corpusRequest, getCorpusStatus } from '../corpus';
import { HelperUnreachableError } from '../helper_client';
import { showMessageDialog } from '../message_dialog';
import { dismissNotices, showNotice } from '../notice';
import {
  appendPins,
  ensureSourcePins,
  isPin,
  openSourceRemId,
  selectedOrFocusedRems,
  sourceViews,
} from '../pdf_source_pins';
import { guessLang } from '../read_aloud_script';
import { noteSurroundings as surroundings } from './surroundings';
import { placeInline, pinnedIds, RichElement } from './placement';
import { attribution, ChosenQuote, emphasisSegments, mergedQuote, segmentsToRichText } from './quote_text';
import { checkHeader, checkStatement, NoteSetting, StatementCheck, VERDICTS } from './check';
import { AnswerSection, answerHeader, askSources, boldToRichText, FollowUp, SourcesAnswer } from './ask';
import { groupOf, OutlineNode, pinTarget, Statement, StatementMember, statementsInOutline } from './outline';

export const SEMANTIC_SEARCH = 'semantic-search';
/** The provider's answer for one Rem can take ~25 s (two Gemini calls); allow for a slow one. */
const FIND_TIMEOUT_MS = 180_000;

// --- what the provider answers (docs/Corpus-Provider.md, find-passages) --------------

export type PassageRole = 'source' | 'related' | 'diverges';

export interface FoundPassage {
  book: { id?: string; title: string; cite?: string; pdfRemIds: string[] };
  /** Page in the provider's copy of the book: a starting point for the search. */
  page?: number | null;
  section?: string | null;
  /** Verbatim from the source (checked by the provider): the excerpts joined with "[…]". */
  quote: string;
  /** Each verbatim part of the quote, pinned on its own; absent from older providers (then [quote]). */
  excerpts?: string[];
  /** Words to bold inside the quote: what the point turns on. */
  emphasis?: string[];
  /** The one word or figure to bold-italicize. */
  key?: string;
  /** The numbered section the passage sits in ("2.5.4"), for the attribution. */
  sectionNumber?: string | null;
  /**
   * The whole chunk the quote was cut from. Never quoted or written: it lets Check Statement
   * and Ask Your Sources read a trimmed quote in context ("these two values" → which ones).
   */
  context?: string;
  /** The part of the Rem's text this passage supports; empty for all of it. */
  covers: string;
  score: number;
  why: string;
  role: PassageRole;
  diverges?: boolean;
  edital?: string | null;
}

// --- what the job carries -------------------------------------------------------------

export interface FindSourcesItem {
  /** The Rem the statement belongs to: a list group's lead-in, or the Rem itself. */
  remId: string;
  title: string;
  texts: string[];
  ancestors: string[];
  /**
   * A descriptor's concept and the descriptors above it ("Rebocadores com tubulão"), which
   * the note means nothing without: searched with it, and given to Claude as its CONTEXT.
   */
  context?: string;
  /** Ask Your Sources / Check Statement: the Rems above (noteSurroundings), for Claude only. */
  outline?: string;
  /** A list group's items (./outline), where a passage that supports one item is pinned. */
  members?: StatementMember[];
  /**
   * Ask Your Sources, asked again from the review: what to improve or add. It joins the
   * search texts (more passages for a new aspect), and Claude rewrites `previousAnswer`
   * with it. `previousPassages` stay in the list, so the first answer's evidence is kept.
   */
  followUp?: string;
  previousAnswer?: SourcesAnswer;
  previousPassages?: ReviewPassage[];
}

export interface FindSourcesJob {
  /** Unique per run, so a job the tracker reads twice runs once. */
  id: string;
  items: FindSourcesItem[];
  openSourceRemId: string | null;
  queuedAt: number;
  /** Check Statement: also ask Claude for a verdict on each Rem's statement (./check). */
  check?: boolean;
  /** Ask Your Sources: the Rem is a question or topic; Claude answers it from the passages (./ask). */
  ask?: boolean;
}

/** A passage as the review shows it: where it was found in RemNote, if it was. */
export interface ReviewPassage extends FoundPassage {
  /** The RemNote PDF holding the quote, with the page it was found on. Absent: not pinnable. */
  pdfRemId?: string;
  pdfName?: string;
  pdfPage?: number;
  /** Why it cannot be pinned (no PDF in RemNote, not found in it, …). */
  unpinnable?: string;
  /** Check Statement / Ask Your Sources: the verdict or answer rests on this passage. */
  basis?: boolean;
  /** Its place in the Rem's passage list, which the answer's sections refer to. */
  index?: number;
}

export interface ReviewRem {
  remId: string;
  title: string;
  /** Rem text language, for the headers' wording. */
  lang: 'pt' | 'en';
  passages: ReviewPassage[];
  /** Set when the search failed for this Rem. */
  error?: string;
  /** Check Statement: the verdict on the Rem's statement. */
  check?: StatementCheck;
  /** A list group's items (see FindSourcesItem.members). */
  members?: StatementMember[];
  /** Ask Your Sources: the answer to the Rem's question or topic. */
  answer?: SourcesAnswer;
  /** A descriptor's concept (FindSourcesItem.context), shown above the review. */
  context?: string;
  /** The Rems above the note sent to Claude (FindSourcesItem.outline), shown above the review. */
  outline?: string;
  /** Ask Your Sources: the question or topic as asked (the review's follow-up asks it again). */
  question?: string;
  /** Ask Your Sources: the follow-up this answer was rewritten with. */
  followUp?: string;
  /** Ask Your Sources: why there is no answer (the helper or Claude failed). */
  answerError?: string;
  /** Check Statement: why there is no verdict (the helper or Claude failed). */
  checkError?: string;
}

export interface FindSourcesReview {
  jobId: string;
  noticeId: string;
  rems: ReviewRem[];
  /** The source open when the run started, which a follow-up searches with again. */
  openSourceRemId?: string | null;
}

/**
 * What gets written besides the pins on the Rem: nothing, the quote Rems (under
 * Sources / Related material), or the quote Rems with the AI's reason for each
 * passage as an AI Note under it.
 */
export type FindSourcesExtras = 'pins' | 'quotes' | 'notes';

/** What the popup hands back: per Rem, the passages to pin, and what to write besides the pins. */
export interface FindSourcesWrite {
  id: string;
  noticeId: string;
  extras: FindSourcesExtras;
  rems: {
    remId: string;
    lang: 'pt' | 'en';
    passages: ReviewPassage[];
    check?: StatementCheck;
    members?: StatementMember[];
    answer?: SourcesAnswer;
  }[];
}

/** The verbatim parts of a passage's quote (one, from a provider without `excerpts`). */
export const excerptsOf = (p: FoundPassage): string[] => (p.excerpts?.length ? p.excerpts : [p.quote]);

/**
 * A quote Rem's text, in the skills' format: ⚠️ for a diverging passage, “quote” with its
 * emphasis (bold; the key word bold italic), then (cite, §x.y, PDF p. N; fora do edital).
 */
export function quoteRichText(p: ReviewPassage): RichElement[] {
  const text: RichElement[] = [
    `${p.role === 'diverges' || p.diverges ? '\u26a0\ufe0f ' : ''}\u201c`,
    ...segmentsToRichText(emphasisSegments(p.quote, p.emphasis, p.key)),
    `\u201d ${attribution({
      cite: p.book.cite || p.book.title,
      sectionNumber: p.sectionNumber,
      page: p.pdfPage ?? p.page,
      edital: p.edital,
    })}`,
  ];
  // Adjacent plain strings merged: RemNote stores them as one.
  return text.reduce<RichElement[]>((out, el) => {
    const last = out[out.length - 1];
    if (typeof el === 'string' && typeof last === 'string') out[out.length - 1] = last + el;
    else if (el !== '') out.push(el);
    return out;
  }, []);
}

// --- 1. queue ---------------------------------------------------------------------------

/**
 * The text a Rem's rich text shows, without pins. Only text runs, references and formulas
 * go to RemNote's toString: other elements (an image, an audio) carry no words, and some
 * are stored in shapes its validator rejects (an image with `percent: 0` made toString
 * throw "Invalid input"). If it refuses anyway, the text is taken from the runs directly.
 */
async function plainOf(plugin: RNPlugin, rt: RichTextInterface | undefined): Promise<string> {
  const textual = ((rt ?? []) as RichTextInterface).filter(
    (el) => !isPin(el) && (typeof el === 'string' || ['m', 'q', 'x'].includes((el as { i?: string }).i ?? ''))
  );
  if (!textual.length) return '';
  try {
    return await plugin.richText.toString(textual);
  } catch (e) {
    console.warn('[FindSources] richText.toString refused a Rem text; reading its runs directly', e);
    return textual
      .map((el) => (typeof el === 'string' ? el : typeof (el as { text?: unknown }).text === 'string' ? (el as { text: string }).text : ''))
      .join('');
  }
}

const shortTitle = (text: string) => (text.length > 90 ? `${text.slice(0, 89)}…` : text);

/**
 * Why Find Sources cannot run here, or undefined when it can: it needs the AI helper and
 * a corpus provider offering semantic search.
 */
export async function findSourcesUnavailable(plugin: RNPlugin): Promise<string | undefined> {
  const status = await getCorpusStatus(plugin);
  if (!status.available) return status.reason ?? 'No corpus provider is set up.';
  if (!status.capabilities.includes(SEMANTIC_SEARCH)) {
    return `Your corpus provider (${status.name ?? 'unnamed'}) does not offer semantic search ("${SEMANTIC_SEARCH}").`;
  }
  return undefined;
}

// --- outline: Rems → statements (./outline) ------------------------------------------

/** Text of a Rem as a statement reads it: front, then back, without pins. */
const statementText = async (plugin: RNPlugin, rem: PluginRem) =>
  [await plainOf(plugin, rem.text), await plainOf(plugin, rem.backText)].map((t) => t.trim()).filter(Boolean).join(' ');


/** Rems in their order among siblings (getChildrenRem and getDescendants promise none). */
async function ordered(rems: PluginRem[]): Promise<PluginRem[]> {
  const at = await Promise.all(rems.map((r) => r.positionAmongstSiblings().catch(() => 0)));
  return rems.map((r, k) => ({ r, k: at[k] ?? 0 })).sort((x, y) => x.k - y.k).map((x) => x.r);
}

/**
 * A Rem as an outline node, its children read by `childrenOf` down to `depth`. Null for
 * what is never a statement and is skipped with its subtree: quotes, slots, AI Notes, and
 * what Find Sources / Check Statement wrote (their Fontes, Material relacionado and
 * Verificação headers).
 */
async function nodeOf(
  plugin: RNPlugin,
  rem: PluginRem,
  childrenOf: (rem: PluginRem) => Promise<PluginRem[]>,
  depth: number
): Promise<OutlineNode | null> {
  const text = await statementText(plugin, rem);
  const ours = Object.values(HEADERS).flatMap((h) => [h.sources, h.related]);
  if (ours.includes(text) || /^(Verificação|Check):/.test(text)) return null;
  if ((await rem.isQuote()) || (await rem.isSlot()) || (await rem.hasPowerup(aiNotePowerupCode))) return null;
  const children: OutlineNode[] = [];
  if (depth > 0) {
    for (const child of await ordered(await childrenOf(rem))) {
      const n = await nodeOf(plugin, child, childrenOf, depth - 1);
      if (n) children.push(n);
    }
  }
  return { id: rem._id, text, children, heading: !!(await rem.getFontSize()) };
}

/** List groups are read this deep: a lead-in, its items, and one nested list. */
const LIST_DEPTH = 3;

/**
 * The statements a command on these Rems judges: a lead-in with its list as one group; a
 * list item, as the group it belongs to; any other Rem on its own.
 */
async function statementsForRems(plugin: RNPlugin, rems: PluginRem[]): Promise<Statement[]> {
  const out: Statement[] = [];
  const children = (r: PluginRem) => r.getChildrenRem();
  for (const rem of rems) {
    let statement: Statement | null = null;
    try {
      const node = await nodeOf(plugin, rem, children, LIST_DEPTH);
      if (!node) continue;
      statement = groupOf(node);
      if (!statement) {
        const parent = await rem.getParentRem();
        const parentNode = parent ? await nodeOf(plugin, parent, children, LIST_DEPTH) : null;
        const group = parentNode ? groupOf(parentNode) : null;
        if (group?.members.some((m) => m.remId === rem._id)) statement = group;
      }
      statement ??= node.text ? { headId: rem._id, text: node.text, members: [] } : null;
    } catch (e) {
      // The outline around it could not be read: the Rem on its own.
      console.warn('[FindSources] could not read the outline around', rem._id, e);
      const text = await statementText(plugin, rem).catch(() => '');
      statement = text ? { headId: rem._id, text, members: [] } : null;
    }
    if (statement && !out.some((s) => s.headId === statement!.headId)) out.push(statement);
  }
  return out;
}

/** Queue a Find Sources (or Check Statement) run for these statements; the tracker picks it up. */
async function enqueueStatements(
  plugin: RNPlugin,
  statements: Statement[],
  openSource: string | null | undefined,
  mode: { check?: boolean; ask?: boolean }
): Promise<number> {
  const items: FindSourcesItem[] = [];
  for (const st of statements) {
    const head = await plugin.rem.findOne(st.headId);
    if (!head || !st.text.trim()) continue;
    items.push({
      remId: st.headId,
      title: shortTitle(st.text),
      texts: [st.text],
      ...(await surroundings(head, (r) => plainOf(plugin, r.text), !!(mode.check || mode.ask))),
      members: st.members,
    });
  }
  if (!items.length) return 0;
  const job: FindSourcesJob = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    items,
    openSourceRemId: openSource ?? null,
    queuedAt: Date.now(),
    check: !!mode.check,
    ask: !!mode.ask,
  };
  const queued = (await plugin.storage.getSession<FindSourcesJob[]>(pendingFindSourcesJobsKey)) || [];
  await plugin.storage.setSession(pendingFindSourcesJobsKey, [...queued, job]);
  return items.length;
}

/** Queue a run for these Rems, read as statements (a list item joins its group). Returns how many were queued. */
export async function enqueueFindSources(
  plugin: RNPlugin,
  remIds: string[],
  openSource?: string | null,
  options: { check?: boolean; ask?: boolean } = {}
): Promise<number> {
  const rems = (await plugin.rem.findMany(remIds)) || [];
  return enqueueStatements(plugin, await statementsForRems(plugin, rems), openSource, options);
}

type Mode = 'find' | 'check' | 'ask';
const MODE_NAMES: Record<Mode, string> = { find: 'Find Sources', check: 'Check Statement', ask: 'Ask Your Sources' };

const runningToast = (n: number, mode: Mode = 'find') => {
  const doing = { find: 'Finding the sources of', check: 'Checking', ask: 'Asking your sources about' }[mode];
  const how = { find: 'by meaning', check: 'against your library', ask: 'in your library' }[mode];
  const secs = { find: 25, check: 45, ask: 60 }[mode];
  return (
    `\ud83d\udd0e ${doing} ${n === 1 ? 'this Rem' : `${n} Rems`} ${how}, in the background (about ${secs} s` +
    `${n === 1 ? '' : ' each'}). A notice will say when ${n === 1 ? 'it is' : 'they are'} ready to review.`
  );
};

/** The commands: Find Sources, Check Statement or Ask Your Sources for the selected Rems, else the focused one. */
async function startFromCommand(plugin: ReactRNPlugin, mode: Mode) {
  const what = MODE_NAMES[mode];
  const why = await findSourcesUnavailable(plugin);
  if (why) {
    await showMessageDialog(plugin, {
      tone: 'info',
      title: `${what} is not available`,
      message: why,
      detail:
        `${what} asks your corpus provider (through the AI helper) for the passages of your library ` +
        'that bear on a note. See Corpus Provider in the docs.',
    });
    return;
  }
  const rems = await selectedOrFocusedRems(plugin);
  if (!rems.length) {
    const target = { find: 'whose sources you want to find', check: 'to check', ask: 'holding your question or topic' }[mode];
    await plugin.app.toast(`Focus or select the Rems ${target}.`);
    return;
  }
  const n = await enqueueFindSources(plugin, rems.map((r) => r._id), await openSourceRemId(plugin), {
    check: mode === 'check',
    ask: mode === 'ask',
  });
  await plugin.app.toast(n ? runningToast(n, mode) : 'The selected Rems have no text to look for.');
}

/** Rems searched at once in a tree run: each waits ~20 s on the provider (two Gemini calls). */
const IN_FLIGHT = 3;
/** A tree run stops collecting here: a summary that long is better run section by section. */
const MAX_TREE_REMS = 120;
/** Fewer words than this is a heading or a label, not a statement. */
const MIN_WORDS = 6;

/**
 * The statements of the roots' subtrees (./outline): list groups as one, headings and
 * labels left out, our own output skipped. With `skipPinned`, a statement any of whose
 * Rems already has a pin is left out (it has its source).
 */
async function statementsInTree(
  plugin: ReactRNPlugin,
  roots: PluginRem[],
  skipPinned: boolean
): Promise<{ statements: Statement[]; skipped: number }> {
  const byId = new Map<string, PluginRem>();
  const byParent = new Map<string, PluginRem[]>();
  for (const root of roots) {
    for (const rem of [root, ...(await root.getDescendants())]) {
      if (byId.has(rem._id)) continue;
      byId.set(rem._id, rem);
      if (rem.parent) byParent.set(rem.parent, [...(byParent.get(rem.parent) ?? []), rem]);
    }
  }
  const children = async (r: PluginRem) => byParent.get(r._id) ?? [];
  const nodes: OutlineNode[] = [];
  for (const root of roots) {
    const n = await nodeOf(plugin, root, children, Number.MAX_SAFE_INTEGER);
    if (n) nodes.push(n);
  }
  const statements: Statement[] = [];
  let skipped = 0;
  for (const st of statementsInOutline(nodes, MIN_WORDS)) {
    const rems = [st.headId, ...st.members.map((m) => m.remId)].map((id) => byId.get(id)).filter(Boolean) as PluginRem[];
    const pinned = rems.some((r) => pinnedIds([...((r.text ?? []) as RichElement[]), ...((r.backText ?? []) as RichElement[])]).size);
    if (skipPinned && pinned) skipped++;
    else statements.push(st);
  }
  return { statements, skipped };
}

/** The tree commands: Find Sources (or Check Statement) for every statement under the focused or selected Rems. */
async function startTreeFromCommand(plugin: ReactRNPlugin, check: boolean) {
  const what = check ? 'Check Statements' : 'Find Sources';
  const why = await findSourcesUnavailable(plugin);
  if (why) {
    await showMessageDialog(plugin, { tone: 'info', title: `${what} is not available`, message: why });
    return;
  }
  const roots = await selectedOrFocusedRems(plugin);
  if (!roots.length) {
    await plugin.app.toast('Focus or select the Rem whose descendants hold the notes.');
    return;
  }
  // Find Sources leaves out Rems that already have their source pinned; a check reads them all.
  const { statements, skipped } = await statementsInTree(plugin, roots, !check);
  if (!statements.length) {
    await plugin.app.toast(
      skipped ? `All ${skipped} statements there already have a pin.` : 'No statements there (headings and short labels are left out).'
    );
    return;
  }
  const taken = statements.slice(0, MAX_TREE_REMS);
  const n = await enqueueStatements(plugin, taken, await openSourceRemId(plugin), { check });
  const minutes = Math.max(1, Math.round((n * (check ? 30 : 20)) / IN_FLIGHT / 60));
  await plugin.app.toast(
    `\ud83d\udd0e ${what}: ${n} Rem${n === 1 ? '' : 's'} in the background, about ${minutes} min` +
      (skipped ? `; ${skipped} already pinned left out` : '') +
      (statements.length > taken.length ? `; only the first ${MAX_TREE_REMS} of ${statements.length}` : '') +
      '. A notice follows the progress.'
  );
}

export const findSourcesInTree = (plugin: ReactRNPlugin) => startTreeFromCommand(plugin, false);
export const checkStatementsInTree = (plugin: ReactRNPlugin) => startTreeFromCommand(plugin, true);

/** Command: Find Sources for the selected Rems, else the focused one (as Pin Source Quote resolves them). */
export const findSources = (plugin: ReactRNPlugin) => startFromCommand(plugin, 'find');

/**
 * Command: Check Statement — Find Sources, then Claude's verdict on each Rem's statement
 * from the passages found (./check); written as a Check Rem under the Rem after review.
 */
export const checkStatementCommand = (plugin: ReactRNPlugin) => startFromCommand(plugin, 'check');

/**
 * Command: Ask Your Sources — the Rem holds a question or a topic; Find Sources looks for
 * the passages that answer it, then Claude answers from them (./ask), and the answer is
 * written under the Rem with its quotes after review.
 */
export const askYourSourcesCommand = (plugin: ReactRNPlugin) => startFromCommand(plugin, 'ask');

/**
 * Ask Your Sources, from the review: ask one Rem's question again with a follow-up (what to
 * improve, correct or add). Runs in the background like the first run; a new notice opens
 * a new review.
 */
export async function enqueueAskFollowUp(
  plugin: RNPlugin,
  rem: ReviewRem,
  followUp: string,
  openSource: string | null | undefined
): Promise<boolean> {
  const head = await plugin.rem.findOne(rem.remId);
  const question = rem.question?.trim() || (head ? await plainOf(plugin, head.text as RichTextInterface) : '');
  if (!head || !question) return false;
  const job: FindSourcesJob = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    items: [
      {
        remId: rem.remId,
        title: rem.title,
        texts: [question],
        ...(await surroundings(head, (r) => plainOf(plugin, r.text), true)),
        members: rem.members,
        followUp: followUp.trim(),
        previousAnswer: rem.answer,
        previousPassages: rem.passages,
      },
    ],
    openSourceRemId: openSource ?? null,
    queuedAt: Date.now(),
    ask: true,
  };
  const queued = (await plugin.storage.getSession<FindSourcesJob[]>(pendingFindSourcesJobsKey)) || [];
  await plugin.storage.setSession(pendingFindSourcesJobsKey, [...queued, job]);
  return true;
}

/**
 * A follow-up's passages: the new search's, then the earlier ones it did not find again
 * (same book, and the earlier quote inside a new passage's chunk or quote). The earlier
 * ones have lost their chunk, so Claude reads them as quoted.
 */
function withPreviousPassages(found: ReviewPassage[], previous: ReviewPassage[] | undefined): ReviewPassage[] {
  const bookOf = (p: FoundPassage) => p.book.id || p.book.title;
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  const kept = (previous ?? []).filter((old) => {
    const first = norm(excerptsOf(old)[0] ?? '').slice(0, 80);
    return !found.some(
      (p) => bookOf(p) === bookOf(old) && !!first && (norm(p.context ?? '').includes(first) || norm(p.quote).includes(first))
    );
  });
  return [...found, ...kept.map((p) => ({ ...p, basis: false, index: undefined }))];
}

/** For "Search by meaning" in Pin Source Quote's dialog: queue and say so. */
export async function findSourcesFromDialog(plugin: RNPlugin, remIds: string[], openSource?: string | null) {
  const n = await enqueueFindSources(plugin, remIds, openSource);
  await plugin.app.toast(n ? runningToast(n, 'find') : 'Those Rems have no text to look for.');
}

// --- 2. run -----------------------------------------------------------------------------

/**
 * Where a passage's quote is in RemNote: the first of its book's PDFs holding it, on
 * which page. Dry run: nothing is written.
 */
async function locateInRemNote(plugin: ReactRNPlugin, passage: FoundPassage): Promise<ReviewPassage> {
  if (!passage.book.pdfRemIds?.length) return { ...passage, unpinnable: 'no PDF of this book in RemNote' };
  let reason = 'not found in its PDF';
  for (const pdfRemId of passage.book.pdfRemIds) {
    const pdf = await plugin.rem.findOne(pdfRemId);
    if (!pdf || !(await sourceViews(pdf)).includes('pdf')) {
      reason = 'its PDF is not in this knowledge base';
      continue;
    }
    try {
      // Each excerpt on its own: a quote cut with […] is not one run of text in the PDF.
      const hits = await ensureSourcePins(
        plugin,
        pdfRemId,
        excerptsOf(passage).map((quote) => ({ quote, page: passage.page ?? undefined })),
        ['pdf'],
        { dryRun: true }
      );
      const first = hits.find((h) => h.found);
      if (first) {
        const name = await plainOf(plugin, pdf.text as RichTextInterface);
        return { ...passage, pdfRemId, pdfName: name, pdfPage: first.page };
      }
    } catch (e) {
      if (e instanceof HelperUnreachableError) throw e;
      reason = (e as Error).message;
    }
  }
  return { ...passage, unpinnable: reason };
}

export async function runFindSourcesJob(plugin: ReactRNPlugin, job: FindSourcesJob): Promise<void> {
  const noticeId = `${job.id}-notice`;
  const what = job.ask ? 'Ask Your Sources' : job.check ? 'Check Statement' : 'Find Sources';
  const slots: (ReviewRem | undefined)[] = new Array(job.items.length);
  let stopped: string | undefined;
  let done = 0;

  const one = async (item: FindSourcesItem): Promise<ReviewRem> => {
    const lang = guessLang(item.texts.join(' ')) === 'en' ? 'en' : 'pt';
    if (stopped) return { remId: item.remId, title: item.title, lang, passages: [], error: stopped };
    try {
      const res = await corpusRequest<{ items?: { remId: string; passages?: FoundPassage[] }[] }>(
        plugin,
        'find-passages',
        {
          items: [
            {
              remId: item.remId,
              // The provider joins the texts into one query: the concept first, as in the outline.
              texts: [...(item.context ? [item.context] : []), ...item.texts, ...(item.followUp ? [item.followUp] : [])],
              ancestors: item.ancestors,
              openSourceRemId: job.openSourceRemId,
              ...(job.ask ? { mode: 'answer' } : {}),
            },
          ],
        },
        { timeoutMs: FIND_TIMEOUT_MS, capability: SEMANTIC_SEARCH }
      );
      const found = res.items?.find((it) => it.remId === item.remId)?.passages ?? [];
      const located: ReviewPassage[] = [];
      for (const p of found) located.push(await locateInRemNote(plugin, p));
      const passages = item.followUp ? withPreviousPassages(located, item.previousPassages) : located;
      console.log(`[FindSources] ${item.title}: ${passages.length} passage(s)`, passages);
      const rem: ReviewRem = { remId: item.remId, title: item.title, lang, passages, members: item.members, context: item.context, outline: item.outline };
      passages.forEach((p, k) => (p.index = k));
      const setting: NoteSetting = { context: item.context, outline: item.outline };
      if (job.check) await addCheck(plugin, rem, item.texts.join('\n'), setting);
      if (job.ask) {
        rem.question = item.texts.join('\n');
        rem.followUp = item.followUp;
        await addAnswer(
          plugin,
          rem,
          rem.question,
          item.followUp ? { instruction: item.followUp, previous: item.previousAnswer } : undefined,
          setting
        );
      }
      // The full chunks served the verdict or answer; the review and the write do not need them.
      passages.forEach((p) => delete p.context);
      return rem;
    } catch (e) {
      console.error('[FindSources] search failed for', item.remId, e);
      const message =
        e instanceof CorpusUnavailableError || e instanceof HelperUnreachableError
          ? (e as Error).message
          : `the search failed: ${(e as Error).message}`;
      // Every other Rem would fail the same way.
      if (e instanceof HelperUnreachableError) stopped = message;
      return { remId: item.remId, title: item.title, lang, passages: [], error: message };
    }
  };

  // A few Rems at a time, in their order; a progress notice for a batch.
  let next = 0;
  const worker = async () => {
    while (next < job.items.length) {
      const k = next++;
      slots[k] = await one(job.items[k]);
      done++;
      if (job.items.length > IN_FLIGHT && done < job.items.length) {
        await showNotice(plugin, {
          id: noticeId,
          tone: 'info',
          title: `${what}: searching\u2026`,
          message: `${done} of ${job.items.length} Rems done. The review opens from here when all are.`,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, job.items.length) }, worker));
  const rems = slots.filter((r): r is ReviewRem => !!r);

  const count = (role: PassageRole) => rems.reduce((n, r) => n + r.passages.filter((p) => p.role === role).length, 0);
  const total = rems.reduce((n, r) => n + r.passages.length, 0);
  const failed = rems.filter((r) => r.error);
  const subject = rems.length === 1 ? `\u201c${rems[0].title}\u201d` : `${rems.length} Rems`;
  const checked = rems.filter((r) => r.check);
  if (!total && !checked.length && !rems.some((r) => r.answer)) {
    await showNotice(plugin, {
      id: noticeId,
      tone: failed.length ? 'error' : 'info',
      title: `${what}: nothing found`,
      message: failed.length
        ? `${subject}: ${failed[0].error}`
        : `${subject}: no passage of your library says this.`,
      openRemId: rems[0]?.remId,
    });
    return;
  }
  const parts = [
    count('source') ? `${count('source')} source${count('source') === 1 ? '' : 's'}` : '',
    count('related') ? `${count('related')} related` : '',
    count('diverges') ? `${count('diverges')} diverge${count('diverges') === 1 ? 's' : ''}` : '',
    failed.length ? `${failed.length} failed` : '',
  ].filter(Boolean);
  const review: FindSourcesReview = { jobId: job.id, noticeId, rems, openSourceRemId: job.openSourceRemId };
  const verdicts = job.check
    ? rems.length === 1 && rems[0].check
      ? `${VERDICTS[rems[0].check.verdict].icon} ${VERDICTS[rems[0].check.verdict][rems[0].lang]}. `
      : checked.length
      ? `${(Object.keys(VERDICTS) as (keyof typeof VERDICTS)[])
          .map((v) => [v, checked.filter((r) => r.check!.verdict === v).length] as const)
          .filter(([, n]) => n)
          .map(([v, n]) => `${VERDICTS[v].icon} ${n}`)
          .join(' ')}. `
      : ''
    : '';
  const worst = checked.some((r) => r.check!.verdict === 'contradicts')
    ? 'error'
    : checked.some((r) => r.check!.verdict !== 'consistent')
    ? 'info'
    : 'success';
  // Ask Your Sources: one question's answer in the notice itself.
  const answered = job.ask && rems.length === 1 && rems[0].answer ? `${rems[0].answer.answer} ` : '';
  await showNotice(plugin, {
    id: noticeId,
    tone: job.check ? worst : job.ask ? (rems.some((r) => r.answerError) ? 'error' : 'success') : count('source') ? 'success' : 'info',
    title: `${what}: ${job.items.some((it) => it.followUp) ? 'follow-up ' : ''}ready to review`,
    message: `${subject}: ${verdicts}${answered}${parts.join(' \u00b7 ')}. Nothing is written until you accept it.`,
    action: { label: 'Review', popup: FIND_SOURCES_POPUP, data: review },
  });
}

/**
 * Check Statement: Claude's verdict on the Rem's statement from the passages found
 * (all of them, pinnable or not), and which of them it rests on.
 */
async function addCheck(plugin: ReactRNPlugin, rem: ReviewRem, statement: string, setting?: NoteSetting) {
  if (!rem.passages.length) {
    rem.check = {
      verdict: 'not-covered',
      observation:
        rem.lang === 'pt'
          ? 'Nenhuma passagem da bibliografia trata desta afirmação.'
          : 'No passage of the bibliography deals with this statement.',
      basis: [],
      quotes: [],
    };
    return;
  }
  try {
    rem.check = await checkStatement(plugin, statement, rem.lang, rem.passages, setting);
    rem.check.basis.forEach((k) => (rem.passages[k].basis = true));
    takeChosenQuotes(rem, rem.check.quotes);
    console.log('[CheckStatement]', rem.title, rem.check);
  } catch (e) {
    console.error('[CheckStatement] verdict failed for', rem.remId, e);
    rem.checkError = (e as Error).message;
  }
}

/** Ask Your Sources: Claude's answer from the passages found, and which of them it uses. */
async function addAnswer(
  plugin: ReactRNPlugin,
  rem: ReviewRem,
  question: string,
  followUp?: FollowUp,
  setting?: NoteSetting
) {
  if (!rem.passages.length) {
    rem.answer = {
      answer: rem.lang === 'pt' ? 'Nenhuma passagem da bibliografia trata disto.' : 'No passage of the bibliography deals with this.',
      covered: 'none',
      sections: [],
      divergences: [],
      basis: [],
    };
    return;
  }
  try {
    rem.answer = await askSources(plugin, question, rem.lang, rem.passages, followUp, setting);
    rem.answer.basis.forEach((k) => (rem.passages[k].basis = true));
    takeChosenQuotes(rem, [...rem.answer.sections, ...rem.answer.divergences].flatMap((sec) => sec.quotes));
    console.log('[AskSources]', rem.title, rem.answer);
  } catch (e) {
    console.error('[AskSources] answer failed for', rem.remId, e);
    rem.answerError = (e as Error).message;
  }
}

/**
 * Claude's quotes become the passages' own: each passage Claude quoted shows Claude's
 * excerpts and emphasis (merged across sections, in passage order) in the review, and its
 * pins are made for exactly those words. A passage Claude did not quote keeps the provider's
 * trim. Needs the full texts (`context`), so it runs before they are dropped.
 */
function takeChosenQuotes(rem: ReviewRem, quotes: ChosenQuote[]) {
  const byPassage = new Map<number, ChosenQuote[]>();
  for (const q of quotes) byPassage.set(q.index, [...(byPassage.get(q.index) ?? []), q]);
  for (const [index, list] of byPassage) {
    const p = rem.passages[index];
    const merged = p ? mergedQuote(list, p.context || p.quote) : null;
    if (!p || !merged) continue;
    p.excerpts = merged.excerpts;
    p.emphasis = merged.emphasis;
    p.key = merged.key;
    p.quote = merged.excerpts.join(' [\u2026] ');
  }
}

/** An accepted passage after its highlights are made: its pins, and per excerpt (for a section's own quote). */
interface Pinned {
  passage: ReviewPassage;
  pins: string[];
  byExcerpt?: Map<string, string[]>;
}

// --- 3. write ---------------------------------------------------------------------------

/**
 * Make `rem` the LAST child of `parentId`: setParent without a position puts it first
 * (findings/PLUGIN_BRIDGE_AND_SDK.md), which wrote quotes and sections in reverse order.
 */
async function appendAsLastChild(plugin: RNPlugin, rem: PluginRem, parentId: string) {
  const parent = await plugin.rem.findOne(parentId);
  const count = parent ? ((await parent.getChildrenRem()) ?? []).filter((c) => c._id !== rem._id).length : 0;
  await rem.setParent(parentId, count);
}

const HEADERS = {
  pt: { sources: 'Fontes', related: 'Material relacionado' },
  en: { sources: 'Sources', related: 'Related material' },
};

/** A child of `parent` whose text is one of `names`, or a new one (Extra Card Detail) named `names[0]`. */
async function headerRem(plugin: ReactRNPlugin, parent: PluginRem, names: string[]): Promise<PluginRem | undefined> {
  for (const child of await parent.getChildrenRem()) {
    const text = (await plainOf(plugin, child.text as RichTextInterface)).trim();
    if (names.includes(text)) return child;
  }
  const rem = await plugin.rem.createRem();
  if (!rem) return undefined;
  await rem.setText([names[0]]);
  await appendAsLastChild(plugin, rem, parent._id);
  await rem.addPowerup(BuiltInPowerupCodes.ExtraCardDetail);
  return rem;
}

/**
 * One quote Rem under `header`: “quote” (cite, PDF p. N) and its pins, in the Quote
 * format; with `note`, the AI's reason for the passage under it, as an AI Note. Re-running
 * adds nothing twice: a quote already pinned to these highlights is reused, and gets its
 * note only if it has none.
 */
async function addQuoteRem(
  plugin: ReactRNPlugin,
  header: PluginRem,
  passage: ReviewPassage,
  pins: string[],
  note: boolean
): Promise<{ quote: boolean; note: boolean }> {
  let quoteRem: PluginRem | undefined;
  for (const child of await header.getChildrenRem()) {
    const has = pinnedIds((child.text ?? []) as RichElement[]);
    if (pins.length && pins.every((id) => has.has(id))) quoteRem = child;
  }
  const added = { quote: false, note: false };
  if (!quoteRem) {
    quoteRem = await plugin.rem.createRem();
    if (!quoteRem) return added;
    await quoteRem.setText([
      ...quoteRichText(passage),
      ...pins.flatMap((id) => [' ', { i: 'q' as const, _id: id, pin: true }]),
    ] as RichTextInterface);
    await appendAsLastChild(plugin, quoteRem, header._id);
    await quoteRem.setIsQuote(true);
    added.quote = true;
  }
  if (!note || !passage.why?.trim()) return added;
  for (const child of await quoteRem.getChildrenRem()) {
    if (await child.hasPowerup(aiNotePowerupCode)) return added;
  }
  const noteRem = await plugin.rem.createRem();
  if (!noteRem) return added;
  await noteRem.setText([passage.why.trim()]);
  await appendAsLastChild(plugin, noteRem, quoteRem._id);
  await noteRem.addPowerup(aiNotePowerupCode);
  added.note = true;
  return added;
}

/**
 * Pin the accepted passages: create or reuse their highlights, put the pins inline
 * after the sentence each one covers when the Rem mixes several passages (see
 * ./placement), else at the end; with `extras`, add the quote Rems under the
 * Sources / Related material headers, and the AI's reasons under them as AI Notes. Reports in a toast and dismisses the notice.
 */
export async function runFindSourcesWrite(plugin: ReactRNPlugin, write: FindSourcesWrite): Promise<void> {
  let pinCount = 0;
  let quoteCount = 0;
  let noteCount = 0;
  let checkCount = 0;
  let answerCount = 0;
  const problems: string[] = [];
  for (const entry of write.rems) {
    const rem = await plugin.rem.findOne(entry.remId);
    if (!rem) {
      problems.push('a Rem was deleted');
      continue;
    }
    // Highlights first: reused or created in the PDF, per passage.
    const pinned: Pinned[] = [];
    for (const passage of entry.passages) {
      if (!passage.pdfRemId) {
        pinned.push({ passage, pins: [] });
        continue;
      }
      try {
        // One pin set per excerpt, in order: each part of a quote cut with […] has its own highlight.
        const results = await ensureSourcePins(
          plugin,
          passage.pdfRemId,
          excerptsOf(passage).map((quote) => ({ quote, page: passage.pdfPage ?? passage.page ?? undefined })),
          ['pdf']
        );
        const pins = [...new Set(results.filter((r) => r.found).flatMap((r) => r.pins))];
        const byExcerpt = new Map(excerptsOf(passage).map((e, k) => [e, results[k]?.found ? results[k].pins : []]));
        pinned.push({ passage, pins, byExcerpt });
        if (!pins.length) problems.push(`not found again in ${passage.pdfName ?? 'its PDF'}`);
      } catch (e) {
        problems.push((e as Error).message);
        pinned.push({ passage, pins: [] });
      }
    }

    // Ask Your Sources: the answer under the question; the question itself gets no pins.
    if (entry.answer) {
      const counts = await writeAnswer(plugin, rem, entry.answer, entry.lang, pinned, write.extras);
      quoteCount += counts.quotes;
      noteCount += counts.notes;
      pinCount += counts.pins;
      answerCount++;
      continue;
    }

    // The Rem's own pins: sources only (related and diverging passages go under the Rem, as quotes).
    // In a list group, a passage that supports one item is pinned on that item (./outline).
    const sources = pinned.filter((p) => p.passage.role === 'source' && p.pins.length);
    const group = { headId: entry.remId, text: '', members: entry.members ?? [] };
    const onItem = sources.filter((p) => pinTarget(group, p.passage.covers) !== entry.remId);
    for (const p of onItem) {
      const item = await plugin.rem.findOne(pinTarget(group, p.passage.covers));
      if (item) await appendPins(item, p.pins);
    }
    const onRem = sources.filter((p) => !onItem.includes(p));
    pinCount += onItem.reduce((n, p) => n + p.pins.length, 0);
    const fresh = await plugin.rem.findOne(entry.remId);
    const sides: ('text' | 'backText')[] = ['text', 'backText'];
    const atEnd = new Set(onRem.map((_, k) => k));
    for (const side of sides) {
      const current = ((fresh?.[side] ?? []) as RichElement[]);
      if (!current.length) continue;
      const pending = [...atEnd];
      const { text, placed } = placeInline(
        current,
        pending.map((k) => ({ covers: onRem[k].passage.covers, pins: onRem[k].pins }))
      );
      if (!placed.length) continue;
      if (side === 'text') await rem.setText(text as RichTextInterface);
      else await rem.setBackText(text as RichTextInterface);
      for (const k of placed) atEnd.delete(pending[k]);
    }
    const endPins = [...atEnd].flatMap((k) => onRem[k].pins);
    if (endPins.length) {
      const latest = await plugin.rem.findOne(entry.remId);
      if (latest) await appendPins(latest, endPins);
    }
    pinCount += onRem.reduce((n, p) => n + p.pins.length, 0);

    // Check Statement: the verdict first among the Rem's children, the observation under
    // it, and (with quotes) the passages it rests on under the observation.
    let underCheck = new Set<ReviewPassage>();
    if (entry.check) {
      const header = await plugin.rem.createRem();
      if (header) {
        await header.setText([checkHeader(entry.check.verdict, entry.lang)]);
        await header.setParent(rem._id, 0);
        await header.addPowerup(BuiltInPowerupCodes.ExtraCardDetail);
        let parentOfQuotes: PluginRem = header;
        if (entry.check.observation) {
          const observation = await plugin.rem.createRem();
          if (observation) {
            await observation.setText([entry.check.observation]);
            await appendAsLastChild(plugin, observation, header._id);
            parentOfQuotes = observation;
          }
        }
        checkCount++;
        if (write.extras !== 'pins') {
          underCheck = new Set(entry.passages.filter((p) => p.basis));
          for (const { passage, pins } of pinned.filter((p) => underCheck.has(p.passage))) {
            // The observation explains the verdict: no AI notes under its quotes.
            const added = await addQuoteRem(plugin, parentOfQuotes, passage, pins, false);
            if (added.quote) quoteCount++;
            if (added.note) noteCount++;
          }
        }
      }
    }

    if (write.extras !== 'pins') {
      const names = HEADERS[entry.lang];
      const other = HEADERS[entry.lang === 'pt' ? 'en' : 'pt'];
      const rest = pinned.filter((p) => !underCheck.has(p.passage));
      const groups: [string[], typeof pinned][] = [
        [[names.sources, other.sources], rest.filter((p) => p.passage.role === 'source')],
        [[names.related, other.related], rest.filter((p) => p.passage.role !== 'source')],
      ];
      for (const [headerNames, items] of groups) {
        if (!items.length) continue;
        const header = await headerRem(plugin, rem, headerNames);
        if (!header) continue;
        for (const { passage, pins } of items) {
          // AI notes only in Find Sources: a check's observation already explains.
          const added = await addQuoteRem(plugin, header, passage, pins, write.extras === 'notes' && !entry.check);
          if (added.quote) quoteCount++;
          if (added.note) noteCount++;
        }
      }
    } else {
      // Pins only: related and diverging passages still need a place to be pinned, on
      // the list item they support (in a group), else at the end of the Rem.
      const extra = pinned.filter((p) => p.passage.role !== 'source' && p.pins.length);
      for (const p of extra) {
        const target = await plugin.rem.findOne(pinTarget(group, p.passage.covers));
        if (target) await appendPins(target, p.pins);
        pinCount += p.pins.length;
      }
    }
  }
  await dismissNotices(plugin, write.noticeId);
  const feature = answerCount ? 'Ask Your Sources' : checkCount ? 'Check Statement' : 'Find Sources';
  const done = `\ud83d\udccc ${feature}: ` +
    (answerCount ? `${answerCount} answer${answerCount === 1 ? '' : 's'}, ` : '') +
    (checkCount ? `${checkCount} verdict${checkCount === 1 ? '' : 's'}, ` : '') +
    `${pinCount} pin${pinCount === 1 ? '' : 's'}` +
    (write.extras !== 'pins' ? `, ${quoteCount} quote Rem${quoteCount === 1 ? '' : 's'}` : '') +
    (write.extras === 'notes' ? `, ${noteCount} AI note${noteCount === 1 ? '' : 's'}` : '') +
    ` on ${write.rems.length} Rem${write.rems.length === 1 ? '' : 's'}.`;
  if (problems.length) {
    await showNotice(plugin, {
      tone: 'info',
      title: `${feature}: written, with problems`,
      message: done.replace(/^\S+ /, ''),
      detail: [...new Set(problems)].join(' · '),
      openRemId: write.rems[0]?.remId,
    });
  } else {
    await plugin.app.toast(done);
  }
}

const ANSWER_LABELS = {
  pt: { divergences: 'Divergências', others: 'Outras passagens' },
  en: { divergences: 'Divergences', others: 'Other passages' },
};

/**
 * Ask Your Sources, written under the question (first among its children):
 *
 *   • Resposta (18/11/2026): <the direct answer>          Extra Card Detail
 *       • <section, **bold** key terms>
 *           • “quote” (cite, PDF p. N) 📌                  its passages (with quotes on)
 *       • Divergências
 *           • <where the sources disagree> → its quotes
 *       • Outras passagens → accepted passages the answer did not use
 *
 * With Pins only, a section's pins go at the end of its own text instead of quote Rems.
 * Only the passages accepted in the review are quoted or pinned.
 */
async function writeAnswer(
  plugin: ReactRNPlugin,
  rem: PluginRem,
  answer: SourcesAnswer,
  lang: 'pt' | 'en',
  pinned: Pinned[],
  extras: FindSourcesExtras
): Promise<{ quotes: number; notes: number; pins: number }> {
  const counts = { quotes: 0, notes: 0, pins: 0 };
  const byIndex = new Map(pinned.filter((p) => p.passage.index !== undefined).map((p) => [p.passage.index!, p]));
  const used = new Set<number>();
  const written = new Set<string>();

  const child = async (parent: PluginRem, text: RichElement[], first = false): Promise<PluginRem | undefined> => {
    const r = await plugin.rem.createRem();
    if (!r) return undefined;
    await r.setText(text as RichTextInterface);
    if (first) await r.setParent(parent._id, 0);
    else await appendAsLastChild(plugin, r, parent._id);
    return r;
  };

  /** A section (or divergence) with its passages: quote Rems under it, or its pins at its end. */
  const section = async (parent: PluginRem, s: AnswerSection) => {
    // The section's own quotes (Claude's excerpts of each passage), for the passages accepted
    // in the review; a section from an older answer without quotes falls back to its basis.
    const quotes = (s.quotes?.length ? s.quotes : s.basis.map((index) => ({ index, excerpts: [], emphasis: [], key: '' })))
      .map((q) => ({ q, p: byIndex.get(q.index) }))
      .filter((x): x is { q: ChosenQuote; p: Pinned } => !!x.p);
    const mine = quotes.map(({ q, p }) => {
      used.add(p.passage.index!);
      if (!q.excerpts.length) return { passage: p.passage, pins: p.pins };
      const pins = [...new Set(q.excerpts.flatMap((e) => p.byExcerpt?.get(e) ?? []))];
      return {
        passage: { ...p.passage, quote: q.excerpts.join(' [\u2026] '), excerpts: q.excerpts, emphasis: q.emphasis, key: q.key },
        pins: pins.length ? pins : p.pins,
      };
    });
    const pins = extras === 'pins' ? [...new Set(mine.flatMap((p) => p.pins))] : [];
    const r = await child(parent, [...boldToRichText(s.text), ...pins.flatMap((id) => [' ', { i: 'q', _id: id, pin: true }])]);
    counts.pins += pins.length;
    if (!r || extras === 'pins') return;
    for (const p of mine) {
      // A quote already written for an earlier section is not repeated (a divergence that
      // restates the sections would otherwise quote them all again).
      const id = `${p.passage.index}:${excerptsOf(p.passage).join('|')}`;
      if (written.has(id)) continue;
      written.add(id);
      // The answer explains each quote already: no AI notes under them.
      const added = await addQuoteRem(plugin, r, p.passage, p.pins, false);
      if (added.quote) counts.quotes++;
      if (added.note) counts.notes++;
      counts.pins += p.pins.length;
    }
  };

  const header = await child(rem, boldToRichText(answerHeader(answer, lang)), true);
  if (!header) return counts;
  await header.addPowerup(BuiltInPowerupCodes.ExtraCardDetail);
  for (const s of answer.sections) await section(header, s);
  if (answer.divergences.length) {
    const div = await child(header, [ANSWER_LABELS[lang].divergences]);
    if (div) for (const s of answer.divergences) await section(div, s);
  }
  const rest = pinned.filter((p) => p.passage.index === undefined || !used.has(p.passage.index));
  if (rest.length) {
    const others = await child(header, [ANSWER_LABELS[lang].others]);
    if (others) {
      for (const p of rest) {
        if (extras === 'pins') {
          const fresh = p.pins.length ? await plugin.rem.findOne(others._id) : undefined;
          if (fresh) await appendPins(fresh, p.pins);
          counts.pins += p.pins.length;
          continue;
        }
        const added = await addQuoteRem(plugin, others, p.passage, p.pins, false);
        if (added.quote) counts.quotes++;
        if (added.note) counts.notes++;
        counts.pins += p.pins.length;
      }
    }
  }
  return counts;
}

/** From the popup: hand the accepted passages to the tracker (one setSession survives the popup closing). */
export async function queueFindSourcesWrite(plugin: RNPlugin, write: FindSourcesWrite): Promise<void> {
  const queued = (await plugin.storage.getSession<FindSourcesWrite[]>(pendingFindSourcesWritesKey)) || [];
  await plugin.storage.setSession(pendingFindSourcesWritesKey, [...queued, write]);
}
