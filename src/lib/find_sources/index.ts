/**
 * Find Sources: the passages of the user's library that SAY what a note says (a
 * summary, a translation, a paraphrase), found by meaning, checked in the RemNote PDF,
 * reviewed, then pinned. Plan: plans/SOURCE_FINDER_PLAN.md (phase 2).
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
  ancestorIds,
  appendPins,
  ensureSourcePins,
  isPin,
  openSourceRemId,
  selectedOrFocusedRems,
  sourceViews,
} from '../pdf_source_pins';
import { guessLang } from '../read_aloud_script';
import { placeInline, pinnedIds, RichElement } from './placement';
import { attribution, emphasisSegments, segmentsToRichText } from './quote_text';
import { checkHeader, checkStatement, StatementCheck, VERDICTS } from './check';

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
  remId: string;
  title: string;
  texts: string[];
  ancestors: string[];
}

export interface FindSourcesJob {
  /** Unique per run, so a job the tracker reads twice runs once. */
  id: string;
  items: FindSourcesItem[];
  openSourceRemId: string | null;
  queuedAt: number;
  /** Check Statement: also ask Claude for a verdict on each Rem's statement (./check). */
  check?: boolean;
}

/** A passage as the review shows it: where it was found in RemNote, if it was. */
export interface ReviewPassage extends FoundPassage {
  /** The RemNote PDF holding the quote, with the page it was found on. Absent: not pinnable. */
  pdfRemId?: string;
  pdfName?: string;
  pdfPage?: number;
  /** Why it cannot be pinned (no PDF in RemNote, not found in it, …). */
  unpinnable?: string;
  /** Check Statement: the verdict rests on this passage (its quote goes under the Check Rem). */
  basis?: boolean;
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
  /** Check Statement: why there is no verdict (the helper or Claude failed). */
  checkError?: string;
}

export interface FindSourcesReview {
  jobId: string;
  noticeId: string;
  rems: ReviewRem[];
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
  rems: { remId: string; lang: 'pt' | 'en'; passages: ReviewPassage[]; check?: StatementCheck }[];
}

/** The verbatim parts of a passage's quote (one, from a provider without `excerpts`). */
export const excerptsOf = (p: FoundPassage): string[] => (p.excerpts?.length ? p.excerpts : [p.quote]);

/**
 * A quote Rem's text, in the skills' format: ⚠️ for a diverging passage, “quote” with its
 * emphasis (bold; the key word bold italic), then (cite, §x.y, PDF p. N; fora do edital).
 */
export function quoteRichText(p: ReviewPassage): RichElement[] {
  const text: RichElement[] = [
    `${p.role === 'diverges' ? '\u26a0\ufe0f ' : ''}\u201c`,
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

const plainOf = (plugin: RNPlugin, rt: RichTextInterface | undefined) =>
  plugin.richText.toString(((rt ?? []) as RichTextInterface).filter((el) => !isPin(el)));

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

/** Queue a Find Sources run for these Rems; the tracker picks it up. Returns how many were queued. */
export async function enqueueFindSources(
  plugin: RNPlugin,
  remIds: string[],
  openSource?: string | null,
  options: { check?: boolean } = {}
): Promise<number> {
  const items: FindSourcesItem[] = [];
  for (const remId of remIds) {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) continue;
    const texts = [await plainOf(plugin, rem.text), await plainOf(plugin, rem.backText)].map((t) => t.trim()).filter(Boolean);
    if (!texts.length) continue;
    items.push({ remId, title: shortTitle(texts.join(' → ')), texts, ancestors: await ancestorIds(rem) });
  }
  if (!items.length) return 0;
  const job: FindSourcesJob = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    items,
    openSourceRemId: openSource ?? null,
    queuedAt: Date.now(),
    check: !!options.check,
  };
  const queued = (await plugin.storage.getSession<FindSourcesJob[]>(pendingFindSourcesJobsKey)) || [];
  await plugin.storage.setSession(pendingFindSourcesJobsKey, [...queued, job]);
  return items.length;
}

const runningToast = (n: number, check = false) =>
  `\ud83d\udd0e ${check ? 'Checking' : 'Finding the sources of'} ${n === 1 ? 'this Rem' : `${n} Rems`} ` +
  `${check ? 'against your library' : 'by meaning'}, in the background (about ${check ? '45' : '25'} s` +
  `${n === 1 ? '' : ' each'}). A notice will say when ${n === 1 ? 'it is' : 'they are'} ready to review.`;

/** The commands: Find Sources (or Check Statement) for the selected Rems, else the focused one. */
async function startFromCommand(plugin: ReactRNPlugin, check: boolean) {
  const what = check ? 'Check Statement' : 'Find Sources';
  const why = await findSourcesUnavailable(plugin);
  if (why) {
    await showMessageDialog(plugin, {
      tone: 'info',
      title: `${what} is not available`,
      message: why,
      detail:
        `${what} asks your corpus provider (through the AI helper) for the passages of your library ` +
        'that say what a note says. See Corpus Provider in the docs.',
    });
    return;
  }
  const rems = await selectedOrFocusedRems(plugin);
  if (!rems.length) {
    await plugin.app.toast(`Focus or select the Rems ${check ? 'to check' : 'whose sources you want to find'}.`);
    return;
  }
  const n = await enqueueFindSources(plugin, rems.map((r) => r._id), await openSourceRemId(plugin), { check });
  await plugin.app.toast(n ? runningToast(n, check) : 'The selected Rems have no text to look for.');
}

/** Command: Find Sources for the selected Rems, else the focused one (as Pin Source Quote resolves them). */
export const findSources = (plugin: ReactRNPlugin) => startFromCommand(plugin, false);

/**
 * Command: Check Statement — Find Sources, then Claude's verdict on each Rem's statement
 * from the passages found (./check); written as a Check Rem under the Rem after review.
 */
export const checkStatementCommand = (plugin: ReactRNPlugin) => startFromCommand(plugin, true);

/** For "Search by meaning" in Pin Source Quote's dialog: queue and say so. */
export async function findSourcesFromDialog(plugin: RNPlugin, remIds: string[], openSource?: string | null) {
  const n = await enqueueFindSources(plugin, remIds, openSource);
  await plugin.app.toast(n ? runningToast(n) : 'Those Rems have no text to look for.');
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
        const name = await plugin.richText.toString((pdf.text ?? []) as RichTextInterface);
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
  const rems: ReviewRem[] = [];
  for (const item of job.items) {
    const lang = guessLang(item.texts.join(' ')) === 'en' ? 'en' : 'pt';
    try {
      const res = await corpusRequest<{ items?: { remId: string; passages?: FoundPassage[] }[] }>(
        plugin,
        'find-passages',
        {
          items: [
            { remId: item.remId, texts: item.texts, ancestors: item.ancestors, openSourceRemId: job.openSourceRemId },
          ],
        },
        { timeoutMs: FIND_TIMEOUT_MS, capability: SEMANTIC_SEARCH }
      );
      const found = res.items?.find((it) => it.remId === item.remId)?.passages ?? [];
      const passages: ReviewPassage[] = [];
      for (const p of found) passages.push(await locateInRemNote(plugin, p));
      console.log(`[FindSources] ${item.title}: ${passages.length} passage(s)`, passages);
      const rem: ReviewRem = { remId: item.remId, title: item.title, lang, passages };
      if (job.check) await addCheck(plugin, rem, item.texts.join('\n'));
      rems.push(rem);
    } catch (e) {
      console.error('[FindSources] search failed for', item.remId, e);
      const message =
        e instanceof CorpusUnavailableError || e instanceof HelperUnreachableError
          ? (e as Error).message
          : `the search failed: ${(e as Error).message}`;
      rems.push({ remId: item.remId, title: item.title, lang, passages: [], error: message });
      if (e instanceof HelperUnreachableError) {
        // Every other Rem would fail the same way.
        for (const rest of job.items.slice(job.items.indexOf(item) + 1)) {
          rems.push({ remId: rest.remId, title: rest.title, lang, passages: [], error: message });
        }
        break;
      }
    }
  }

  const noticeId = `${job.id}-notice`;
  const count = (role: PassageRole) => rems.reduce((n, r) => n + r.passages.filter((p) => p.role === role).length, 0);
  const total = rems.reduce((n, r) => n + r.passages.length, 0);
  const failed = rems.filter((r) => r.error);
  const subject = rems.length === 1 ? `\u201c${rems[0].title}\u201d` : `${rems.length} Rems`;
  const what = job.check ? 'Check Statement' : 'Find Sources';
  const checked = rems.filter((r) => r.check);
  if (!total && !checked.length) {
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
  const review: FindSourcesReview = { jobId: job.id, noticeId, rems };
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
  await showNotice(plugin, {
    id: noticeId,
    tone: job.check ? worst : count('source') ? 'success' : 'info',
    title: `${what}: ready to review`,
    message: `${subject}: ${verdicts}${parts.join(' \u00b7 ')}. Nothing is written until you accept it.`,
    action: { label: 'Review', popup: FIND_SOURCES_POPUP, data: review },
  });
}

/**
 * Check Statement: Claude's verdict on the Rem's statement from the passages found
 * (all of them, pinnable or not), and which of them it rests on.
 */
async function addCheck(plugin: ReactRNPlugin, rem: ReviewRem, statement: string) {
  if (!rem.passages.length) {
    rem.check = {
      verdict: 'not-covered',
      observation:
        rem.lang === 'pt'
          ? 'Nenhuma passagem da bibliografia trata desta afirmação.'
          : 'No passage of the bibliography deals with this statement.',
      basis: [],
    };
    return;
  }
  try {
    rem.check = await checkStatement(plugin, statement, rem.lang, rem.passages);
    rem.check.basis.forEach((k) => (rem.passages[k].basis = true));
    console.log('[CheckStatement]', rem.title, rem.check);
  } catch (e) {
    console.error('[CheckStatement] verdict failed for', rem.remId, e);
    rem.checkError = (e as Error).message;
  }
}

// --- 3. write ---------------------------------------------------------------------------

const HEADERS = {
  pt: { sources: 'Fontes', related: 'Material relacionado' },
  en: { sources: 'Sources', related: 'Related material' },
};

/** A child of `parent` whose text is one of `names`, or a new one (Extra Card Detail) named `names[0]`. */
async function headerRem(plugin: ReactRNPlugin, parent: PluginRem, names: string[]): Promise<PluginRem | undefined> {
  for (const child of await parent.getChildrenRem()) {
    const text = (await plugin.richText.toString((child.text ?? []) as RichTextInterface)).trim();
    if (names.includes(text)) return child;
  }
  const rem = await plugin.rem.createRem();
  if (!rem) return undefined;
  await rem.setText([names[0]]);
  await rem.setParent(parent._id);
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
    await quoteRem.setParent(header._id);
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
  await noteRem.setParent(quoteRem._id);
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
  const problems: string[] = [];
  for (const entry of write.rems) {
    const rem = await plugin.rem.findOne(entry.remId);
    if (!rem) {
      problems.push('a Rem was deleted');
      continue;
    }
    // Highlights first: reused or created in the PDF, per passage.
    const pinned: { passage: ReviewPassage; pins: string[] }[] = [];
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
        pinned.push({ passage, pins });
        if (!pins.length) problems.push(`not found again in ${passage.pdfName ?? 'its PDF'}`);
      } catch (e) {
        problems.push((e as Error).message);
        pinned.push({ passage, pins: [] });
      }
    }

    // The Rem's own pins: sources only (related and diverging passages go under the Rem, as quotes).
    const onRem = pinned.filter((p) => p.passage.role === 'source' && p.pins.length);
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
            await observation.setParent(header._id);
            parentOfQuotes = observation;
          }
        }
        checkCount++;
        if (write.extras !== 'pins') {
          underCheck = new Set(entry.passages.filter((p) => p.basis));
          for (const { passage, pins } of pinned.filter((p) => underCheck.has(p.passage))) {
            const added = await addQuoteRem(plugin, parentOfQuotes, passage, pins, write.extras === 'notes');
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
          const added = await addQuoteRem(plugin, header, passage, pins, write.extras === 'notes');
          if (added.quote) quoteCount++;
          if (added.note) noteCount++;
        }
      }
    } else {
      // Pins only: related and diverging passages still need a place to be pinned.
      const extra = pinned.filter((p) => p.passage.role !== 'source' && p.pins.length).flatMap((p) => p.pins);
      if (extra.length) {
        const latest = await plugin.rem.findOne(entry.remId);
        if (latest) await appendPins(latest, extra);
        pinCount += extra.length;
      }
    }
  }
  await dismissNotices(plugin, write.noticeId);
  const done = `\ud83d\udccc ${checkCount ? 'Check Statement' : 'Find Sources'}: ` +
    (checkCount ? `${checkCount} verdict${checkCount === 1 ? '' : 's'}, ` : '') +
    `${pinCount} pin${pinCount === 1 ? '' : 's'}` +
    (write.extras !== 'pins' ? `, ${quoteCount} quote Rem${quoteCount === 1 ? '' : 's'}` : '') +
    (write.extras === 'notes' ? `, ${noteCount} AI note${noteCount === 1 ? '' : 's'}` : '') +
    ` on ${write.rems.length} Rem${write.rems.length === 1 ? '' : 's'}.`;
  if (problems.length) {
    await showNotice(plugin, {
      tone: 'info',
      title: `${checkCount ? 'Check Statement' : 'Find Sources'}: written, with problems`,
      message: done.replace(/^\S+ /, ''),
      detail: [...new Set(problems)].join(' · '),
      openRemId: write.rems[0]?.remId,
    });
  } else {
    await plugin.app.toast(done);
  }
}

/** From the popup: hand the accepted passages to the tracker (one setSession survives the popup closing). */
export async function queueFindSourcesWrite(plugin: RNPlugin, write: FindSourcesWrite): Promise<void> {
  const queued = (await plugin.storage.getSession<FindSourcesWrite[]>(pendingFindSourcesWritesKey)) || [];
  await plugin.storage.setSession(pendingFindSourcesWritesKey, [...queued, write]);
}
