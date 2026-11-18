import {
  BuiltInPowerupCodes,
  PluginRem,
  ReactRNPlugin,
  RichTextElementRemInterface,
  RichTextInterface,
} from '@remnote/plugin-sdk';
import { HelperUnreachableError as HelperDown, helperPost as sharedHelperPost } from '../helper_client';
import { hasCorpusCapability } from '../corpus';
import { HighlightColorName, sourceHighlightColorId } from '../consts';
import { createHtmlHighlight, createPdfHighlight } from '../pdf_highlight_create';
import { safeRemTextToString } from '../pdfUtils';
import { getIESetting } from '../settings';
import DOMPurify from 'dompurify';
import { broadestMatch, quoteCandidates } from './quote';
import { resolvePriorityTargets } from '../priority_targets';
import { MessageDialog, showMessageDialog } from '../message_dialog';
import { sourcesInOtherWindows } from '../window_sources';
import { highlightDataFor, highlightSpan, mathPlaceholder, parseArticle, viewerHtml } from './html';
import {
  LocatedWord,
  PageHighlight,
  TextHighlight,
  orderedPins,
  ownersByInterval,
  planFromOwners,
  planSourcePins,
  positionFromWords,
  rectsOnPage,
  wordsText,
} from './overlap';

/**
 * Source pins: pin the passage a piece of text came from — in a PDF, a saved web
 * article, or a PDF's Text Reader version — reusing the highlights already there
 * and creating new ones only where none covers the passage (see ./overlap.ts for
 * the rule). The helper finds the quote; everything written to RemNote happens here.
 */

/**
 * The views a source can be pinned in. `pdf` is the page view of an uploaded PDF;
 * `html` is an HTML view — a saved web article, or a PDF's Text Reader version,
 * which RemNote stores as a Link powerup (FileURL) on the same PDF Rem.
 */
export type SourceView = 'pdf' | 'html';

export const PIN_SOURCE_VIEWS_POPUP = 'pin_source_views_popup';

export interface SourceQuote {
  quote: string;
  /** PDF view only: 1-based page to search first (±2 pages, then the whole document). */
  page?: number;
}

export interface ViewPinResult {
  view: SourceView;
  found: boolean;
  /** PDF view only. */
  page?: number;
  score?: number;
  /** How many source words the match spans. */
  wordCount?: number;
  /** How many of the quote's own words matched — what candidates are compared by. */
  matched?: number;
  /** Highlight Rem ids to pin, in reading order: reused ones and new ones. */
  pins: string[];
  reused: string[];
  created: string[];
}

export interface SourcePinResult {
  quote: string;
  /** Found in at least one of the views asked for. */
  found: boolean;
  page?: number;
  score?: number;
  /** The widest span any view matched. */
  wordCount?: number;
  /** The most quote words any view matched. */
  matched?: number;
  /** Every view's pins, in the order the views were asked for. */
  pins: string[];
  reused: string[];
  created: string[];
  views: ViewPinResult[];
}

export class SourcePinError extends Error {}

/** The helper is not running: every further request would fail the same way. */
export class HelperUnreachableError extends SourcePinError {}

/**
 * POST to the local helper through the shared client (../helper_client), with its
 * failures turned into this module's errors: callers here catch SourcePinError and
 * stop a run on HelperUnreachableError.
 */
async function helperPost<T>(plugin: ReactRNPlugin, path: string, body: object): Promise<T> {
  try {
    return await sharedHelperPost<T>(plugin, path, body);
  } catch (e) {
    if (e instanceof HelperDown) {
      console.error('[SourcePins] Helper unreachable:', e);
      throw new HelperUnreachableError(e.message);
    }
    throw new SourcePinError((e as Error).message);
  }
}

/** The views `rem` can be pinned in; empty when it is not a source. */
export async function sourceViews(rem: PluginRem): Promise<SourceView[]> {
  const views: SourceView[] = [];
  if (await rem.hasPowerup(BuiltInPowerupCodes.UploadedFile)) views.push('pdf');
  if (await rem.hasPowerup(BuiltInPowerupCodes.Link)) {
    const fileUrl = await rem.getPowerupProperty(BuiltInPowerupCodes.Link, 'FileURL');
    if (fileUrl) views.push('html');
  }
  return views;
}

// ---------------------------------------------------------------------------
// The source's highlight Rems, as remnote.db has them
// ---------------------------------------------------------------------------

/**
 * One Rem in (or one level under) a source's Highlights container, read by the
 * helper from remnote.db: a "Page NNN" Rem, a PDF highlight under one, or an
 * article's highlight. Data is the highlight's stored Data JSON.
 */
interface StoredHighlightRem {
  remId: string;
  parentId: string;
  text: string;
  pdfData: string | null;
  htmlData: string | null;
}

interface StoredHighlights {
  containerId: string | null;
  items: StoredHighlightRem[];
}

/** One listing per source for a minute: a run over many Rems reads the database once. */
const STORED_TTL_MS = 60_000;
const storedCache = new Map<string, { at: number; listing: Promise<StoredHighlights | null> }>();

/**
 * The source's Highlights container and the Rems in it, read from remnote.db by
 * the helper (`/source-highlights`). getChildrenRem alone is not enough: RemNote
 * answers it from its in-memory graph without loading a parent's children first,
 * so for a container nothing has opened this session it can return only some of
 * the pages, and a second "Page 030" was created beside the real one. What this
 * adds is merged with getChildrenRem, which has what was created seconds ago.
 * Null when the helper cannot say (web app, older helper): getChildrenRem only.
 */
function storedHighlights(plugin: ReactRNPlugin, sourceRemId: string): Promise<StoredHighlights | null> {
  const cached = storedCache.get(sourceRemId);
  if (cached && Date.now() - cached.at < STORED_TTL_MS) return cached.listing;
  const listing = sharedHelperPost<{ available: boolean; reason?: string } & StoredHighlights>(
    plugin,
    '/source-highlights',
    { sourceRemId },
    { timeoutMs: 15_000 }
  )
    .then((res) => (res.available ? { containerId: res.containerId, items: res.items ?? [] } : null))
    .catch((e) => {
      console.warn('[SourcePins] Could not read the highlights from the database:', (e as Error).message);
      return null;
    });
  storedCache.set(sourceRemId, { at: Date.now(), listing });
  listing.then((result) => {
    if (!result) storedCache.delete(sourceRemId);
  });
  return listing;
}

/** The highlight Rems a stored listing has under `parentId` that RemNote's own list lacked, if they still exist. */
async function storedOnlyUnder(
  plugin: ReactRNPlugin,
  stored: StoredHighlights | null,
  parentId: string,
  known: Set<string>,
  dataOf: (item: StoredHighlightRem) => string | null
): Promise<{ remId: string; data: string }[]> {
  const out: { remId: string; data: string }[] = [];
  for (const item of stored?.items ?? []) {
    const data = dataOf(item);
    if (item.parentId !== parentId || known.has(item.remId) || !data) continue;
    // The listing can be a minute old: skip a highlight deleted since.
    if (await plugin.rem.findOne(item.remId)) out.push({ remId: item.remId, data });
  }
  return out;
}

/** RemNote's managed container is identifiable only by name + being a direct child of the source. */
async function findHighlightsContainer(plugin: ReactRNPlugin, source: PluginRem) {
  for (const child of await source.getChildrenRem()) {
    if ((await safeRemTextToString(plugin, child.text)) === 'Highlights') return child;
  }
  // Not in RemNote's in-memory list: the database may still have it.
  const stored = await storedHighlights(plugin, source._id);
  const fromDb = stored?.containerId ? await plugin.rem.findOne(stored.containerId) : undefined;
  if (fromDb) console.log('[SourcePins] Highlights container found in the database only:', fromDb._id);
  return fromDb ?? null;
}

// ---------------------------------------------------------------------------
// PDF view
// ---------------------------------------------------------------------------

interface LocateResult {
  found: boolean;
  page?: number;
  score?: number;
  matched?: number;
  pageWidth?: number;
  pageHeight?: number;
  words?: LocatedWord[];
}

const pageNumberOfLabel = (label: string) => {
  const m = /^page\s+0*(\d+)$/i.exec(label.trim());
  return m ? Number(m[1]) : null;
};

/** RemNote names page Rems with the page number padded to the digits of the page count ("Page 095"). */
const pageLabel = (page: number, pageCount: number) =>
  `Page ${String(page).padStart(String(pageCount).length, '0')}`;

/**
 * Tracks one PDF's "Page NNN" Rems and the highlights on each page, so several
 * quotes in one run see each other's new highlights.
 */
class PdfHighlightIndex {
  private pageRems = new Map<number, string>();
  private highlights = new Map<number, PageHighlight[]>();

  private constructor(
    private plugin: ReactRNPlugin,
    private containerId: string,
    private pageCount: number,
    private stored: StoredHighlights | null
  ) {}

  /**
   * The pages RemNote lists, plus the ones only the database has (see
   * storedHighlights): a page missing from both is the only one created.
   */
  static async load(plugin: ReactRNPlugin, source: PluginRem, container: PluginRem, pageCount: number) {
    const stored = await storedHighlights(plugin, source._id);
    const index = new PdfHighlightIndex(plugin, container._id, pageCount, stored);
    const listed = await container.getChildrenRem();
    for (const page of listed) {
      const n = pageNumberOfLabel(await safeRemTextToString(plugin, page.text));
      if (n !== null && !index.pageRems.has(n)) index.pageRems.set(n, page._id);
    }
    const seen = new Set(listed.map((r) => r._id));
    const missed: string[] = [];
    for (const item of stored?.items ?? []) {
      if (item.parentId !== container._id || seen.has(item.remId)) continue;
      const n = pageNumberOfLabel(item.text);
      if (n === null || index.pageRems.has(n) || !(await plugin.rem.findOne(item.remId))) continue;
      index.pageRems.set(n, item.remId);
      missed.push(`${n}`);
    }
    if (missed.length) {
      console.log(`[SourcePins] ${missed.length} page Rem(s) found in the database only (not loaded by RemNote): ${missed.join(', ')}`);
    }
    return index;
  }

  /** Highlights whose rects fall on `page`, including ones filed under the previous page that run onto it. */
  async onPage(page: number, pageWidth: number, pageHeight: number) {
    const cached = this.highlights.get(page);
    if (cached) return cached;
    const found: PageHighlight[] = [];
    for (const n of [page, page - 1]) {
      const pageRemId = this.pageRems.get(n);
      const pageRem = pageRemId ? await this.plugin.rem.findOne(pageRemId) : undefined;
      if (!pageRem) continue;
      const add = (remId: string, raw: string | null | undefined) => {
        let data: any = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          return;
        }
        const rects = rectsOnPage(data, page, pageWidth, pageHeight);
        if (rects.length) found.push({ remId, rects });
      };
      const listed = await pageRem.getChildrenRem();
      for (const child of listed) {
        if (!(await child.hasPowerup(BuiltInPowerupCodes.PDFHighlight))) continue;
        add(child._id, await child.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data'));
      }
      const known = new Set(listed.map((r) => r._id));
      for (const h of await storedOnlyUnder(this.plugin, this.stored, pageRem._id, known, (i) => i.pdfData)) {
        add(h.remId, h.data);
      }
    }
    this.highlights.set(page, found);
    return found;
  }

  async pageRemFor(page: number) {
    const existing = this.pageRems.get(page);
    if (existing) return existing;
    const rem = await this.plugin.rem.createRem();
    if (!rem) throw new Error(`Could not create the page Rem for page ${page}`);
    await rem.setText([pageLabel(page, this.pageCount)]);
    await rem.setParent(this.containerId);
    await rem.addPowerup(BuiltInPowerupCodes.PDFPageNumber);
    this.pageRems.set(page, rem._id);
    return rem._id;
  }
}

async function ensurePdfPins(
  plugin: ReactRNPlugin,
  source: PluginRem,
  container: PluginRem,
  quotes: SourceQuote[],
  color: HighlightColorName,
  dryRun: boolean
): Promise<ViewPinResult[]> {
  const pdfUrl = await source.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL');
  const located = await helperPost<{ pageCount: number; results: LocateResult[] }>(plugin, '/locate', { pdfUrl, quotes });
  const index = dryRun ? null : await PdfHighlightIndex.load(plugin, source, container, located.pageCount);

  const results: ViewPinResult[] = [];
  for (let k = 0; k < quotes.length; k++) {
    const hit = located.results[k];
    const result: ViewPinResult = { view: 'pdf', found: !!hit?.found, pins: [], reused: [], created: [] };
    results.push(result);
    if (!hit?.found || !hit.words?.length || !hit.page || !hit.pageWidth || !hit.pageHeight) continue;
    result.page = hit.page;
    result.score = hit.score;
    result.wordCount = hit.words.length;
    result.matched = hit.matched;
    if (!index) continue;

    // `existing` is the index's own list for the page, so highlights created
    // below are seen by the next quote in this run.
    const existing = await index.onPage(hit.page, hit.pageWidth, hit.pageHeight);
    const plan = planSourcePins(hit.words, existing);
    result.reused = plan.reuse;

    const created: { id: string; firstWord: number }[] = [];
    for (const stretch of plan.create) {
      const position = positionFromWords(stretch, hit.pageWidth, hit.pageHeight, hit.page);
      const highlight = await createPdfHighlight(plugin, {
        pdfRemId: source._id,
        parentId: await index.pageRemFor(hit.page),
        text: wordsText(stretch),
        position,
        color,
      });
      if (!highlight) continue;
      created.push({ id: highlight._id, firstWord: hit.words.indexOf(stretch[0]) });
      existing.push({ remId: highlight._id, rects: position.rects });
    }
    result.created = created.map((c) => c.id);
    result.pins = orderedPins(plan.owners, created);
  }
  return results;
}

// ---------------------------------------------------------------------------
// HTML view (saved web articles, and a PDF's Text Reader version)
// ---------------------------------------------------------------------------

async function ensureHtmlPins(
  plugin: ReactRNPlugin,
  source: PluginRem,
  container: PluginRem,
  quotes: SourceQuote[],
  color: HighlightColorName,
  dryRun: boolean
): Promise<ViewPinResult[]> {
  const fileUrl = await source.getPowerupProperty(BuiltInPowerupCodes.Link, 'FileURL');
  const { text: html } = await helperPost<{ text: string }>(plugin, '/source', { url: fileUrl });
  // Prepare the article as RemNote's viewer does, or the XPaths will not line up.
  // Static import on purpose: webpack.config.js banners every non-sandbox chunk
  // with `import.meta`, which breaks lazily loaded chunks.
  const article = parseArticle(
    viewerHtml(html, (s) => String(DOMPurify.sanitize(s)), mathPlaceholder),
    new DOMParser()
  );

  // HTML highlights sit directly in the container. A PDF's page-view highlights
  // live one level down, under "Page NNN" Rems, so they are never mistaken here.
  // A dry run only measures matches, so it skips reading them.
  const existing: TextHighlight[] = [];
  if (!dryRun) {
    const add = (remId: string, raw: string | null | undefined) => {
      let data: any = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        return;
      }
      const span = highlightSpan(article, data);
      if (span) existing.push({ remId, intervals: [span] });
      else console.warn('[SourcePins] HTML highlight anchor did not resolve', remId, data);
    };
    const listed = await container.getChildrenRem();
    for (const child of listed) {
      if (!(await child.hasPowerup(BuiltInPowerupCodes.HTMLHighlight))) continue;
      add(child._id, await child.getPowerupProperty(BuiltInPowerupCodes.HTMLHighlight, 'Data'));
    }
    // The ones RemNote has not loaded this session (see storedHighlights).
    const stored = await storedHighlights(plugin, source._id);
    const known = new Set(listed.map((r) => r._id));
    for (const h of await storedOnlyUnder(plugin, stored, container._id, known, (i) => i.htmlData)) add(h.remId, h.data);
  }

  const { results: matches } = await helperPost<{
    results: { found: boolean; start?: number; end?: number; score?: number; matched?: number }[];
  }>(plugin, '/match', { words: article.words.map((w) => w.text), quotes: quotes.map((q) => ({ quote: q.quote })) });

  const results: ViewPinResult[] = [];
  for (let k = 0; k < quotes.length; k++) {
    const match = matches[k];
    const result: ViewPinResult = { view: 'html', found: !!match?.found, pins: [], reused: [], created: [] };
    results.push(result);
    if (!match?.found || match.start === undefined || match.end === undefined) continue;
    result.score = match.score;
    result.wordCount = match.end - match.start + 1;
    result.matched = match.matched;
    if (dryRun) continue;

    const words = article.words.slice(match.start, match.end + 1);
    const plan = planFromOwners(words, ownersByInterval(words, existing));
    result.reused = plan.reuse;

    const created: { id: string; firstWord: number }[] = [];
    for (const stretch of plan.create) {
      const highlight = await createHtmlHighlight(plugin, {
        sourceRemId: source._id,
        parentId: container._id,
        data: highlightDataFor(article, stretch),
        color,
      });
      if (!highlight) continue;
      created.push({ id: highlight._id, firstWord: words.indexOf(stretch[0]) });
      existing.push({ remId: highlight._id, intervals: [{ start: stretch[0].start, end: stretch[stretch.length - 1].end }] });
    }
    result.created = created.map((c) => c.id);
    result.pins = orderedPins(plan.owners, created);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Find each quote in the source and return the highlights to pin, creating the
 * missing ones, in each of `views` (default: the source's first view — the PDF
 * view for a PDF). Every view uses the one Source Highlight Colour; pin rings
 * (yellow for a PDF page, purple for an HTML source) tell the views' pins apart.
 *
 * With `dryRun`, nothing is read beyond the source text and nothing is written:
 * each result only says whether, where and how widely the quote matched.
 */
export async function ensureSourcePins(
  plugin: ReactRNPlugin,
  sourceRemId: string,
  quotes: SourceQuote[],
  views?: SourceView[],
  options: { dryRun?: boolean } = {}
): Promise<SourcePinResult[]> {
  const source = await plugin.rem.findOne(sourceRemId);
  const available = source ? await sourceViews(source) : [];
  if (!source || !available.length) throw new SourcePinError('That Rem is not a PDF or a saved web article.');
  const wanted = (views ?? available.slice(0, 1)).filter((v) => available.includes(v));
  if (!wanted.length) throw new SourcePinError('That view is not available for this source.');

  const isPdf = available.includes('pdf');
  const container = await findHighlightsContainer(plugin, source);
  if (!container) {
    throw new SourcePinError(
      `This ${isPdf ? 'PDF' : 'article'} has no Highlights document yet — make one highlight in it first.`
    );
  }
  const color = (await getIESetting(plugin, sourceHighlightColorId)) as HighlightColorName;
  const dryRun = !!options.dryRun;

  const perView: ViewPinResult[][] = [];
  for (const view of wanted) {
    perView.push(
      view === 'pdf'
        ? await ensurePdfPins(plugin, source, container, quotes, color, dryRun)
        : await ensureHtmlPins(plugin, source, container, quotes, color, dryRun)
    );
  }

  return quotes.map((q, k) => {
    const views = perView.map((results) => results[k]);
    return {
      quote: q.quote,
      found: views.some((v) => v.found),
      page: views.find((v) => v.view === 'pdf')?.page,
      score: Math.max(0, ...views.map((v) => v.score ?? 0)),
      wordCount: Math.max(0, ...views.map((v) => v.wordCount ?? 0)),
      matched: Math.max(0, ...views.map((v) => v.matched ?? 0)),
      pins: [...new Set(views.flatMap((v) => v.pins))],
      reused: views.flatMap((v) => v.reused),
      created: views.flatMap((v) => v.created),
      views,
    };
  });
}

export const isPin = (el: unknown): el is RichTextElementRemInterface & { pin: true } =>
  typeof el === 'object' && el !== null && (el as any).i === 'q' && !!(el as any).pin;

/** Rich text with pins to `ids` appended, skipping ones already pinned. */
export function withPins(text: RichTextInterface, ids: string[]): RichTextInterface {
  const already = new Set(text.filter(isPin).map((el) => el._id));
  const additions = ids.filter((id) => !already.has(id)).flatMap((id) => [' ', { i: 'q' as const, _id: id, pin: true }]);
  return [...text, ...additions] as RichTextInterface;
}

/**
 * Append pins to a Rem: at the end of its back when it has one, else of its
 * front — and never a pin either side already holds.
 */
export async function appendPins(rem: PluginRem, ids: string[]) {
  const front = (rem.text ?? []) as RichTextInterface;
  const back = (rem.backText ?? []) as RichTextInterface;
  const already = new Set([...front, ...back].filter(isPin).map((el) => el._id));
  const fresh = ids.filter((id) => !already.has(id));
  if (!fresh.length) return;
  if (back.length) await rem.setBackText(withPins(back, fresh));
  else await rem.setText(withPins(front, fresh));
}

export interface PinQuoteRequest {
  /** The Rem the pins are appended to. */
  remId: string;
  sourceRemId: string;
  /** Texts to try, best match wins (see quoteCandidates). The first is shown to the user. */
  candidates: string[];
  /** PDF view only: page to search first (see SourceQuote.page). */
  page?: number;
}

export type PinOutcome = { ok: true } | { ok: false; dialog: MessageDialog };

const excerpt = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max)}\u2026` : text);

const errorDialog = (e: Error): MessageDialog => ({
  tone: 'error',
  title: 'Could not pin the source',
  message: e instanceof SourcePinError ? e.message : `Pin Source Quote failed: ${e.message}`,
});

const notFoundDialog = (candidates: string[]): MessageDialog => ({
  tone: 'info',
  title: 'Passage not found',
  message: 'This passage does not appear in the open source:',
  quote: excerpt(candidates[0] ?? ''),
  detail:
    'Only text taken from the source matches \u2014 a paraphrase, translation or summary will not. ' +
    'Check that the right PDF or article is open.',
});

/**
 * One Rem: try every candidate without writing anything, pin the best match and
 * append its pins. Silent — the caller reports, so a run over many Rems does not
 * raise a toast or a dialog per Rem. Also run by the Local Media Bridge's
 * `pin-quote` (lib/media_bridge_ops.ts).
 */
export async function pinOneQuote(
  plugin: ReactRNPlugin,
  request: PinQuoteRequest,
  views: SourceView[]
): Promise<{ result?: SourcePinResult; error?: Error }> {
  const { candidates } = request;
  let result: SourcePinResult | undefined;
  try {
    let best = 0;
    if (candidates.length > 1) {
      const trial = await ensureSourcePins(
        plugin,
        request.sourceRemId,
        candidates.map((quote) => ({ quote, page: request.page })),
        views,
        { dryRun: true }
      );
      best = broadestMatch(trial);
      console.log('[SourcePins] Candidates', trial.map((t) => ({ quote: t.quote, found: t.found, matched: t.matched, span: t.wordCount, score: t.score })));
    }
    if (best !== -1) {
      [result] = await ensureSourcePins(plugin, request.sourceRemId, [{ quote: candidates[best], page: request.page }], views);
    }
  } catch (e) {
    const source = await plugin.rem.findOne(request.sourceRemId).catch(() => undefined);
    const name = source ? await safeRemTextToString(plugin, source.text).catch(() => '?') : '(Rem not found)';
    console.error(`[SourcePins] Source "${name}" (${request.sourceRemId}):`, e);
    return { error: e as Error };
  }
  console.log('[SourcePins] Result', result);
  if (!result?.found) return {};
  const rem = await plugin.rem.findOne(request.remId);
  if (rem) await appendPins(rem, result.pins);
  return { result };
}

/** One run's per-view counts, as the toast shows them: "PDF p.95: reused 0, created 1". */
async function viewSummary(plugin: ReactRNPlugin, sourceRemId: string, result: SourcePinResult) {
  const source = await plugin.rem.findOne(sourceRemId);
  const sourceIsPdf = source ? (await sourceViews(source)).includes('pdf') : false;
  const label = (v: ViewPinResult) =>
    v.view === 'pdf' ? `PDF p.${v.page ?? '?'}` : sourceIsPdf ? 'Text Reader' : 'Article';
  return result.views
    .map((v) => (v.found ? `${label(v)}: reused ${v.reused.length}, created ${v.created.length}` : `${label(v)}: not found`))
    .join(' \u00b7 ');
}

/**
 * Pin the source of one Rem's text in `views`. Success is reported in a toast; a
 * failure is returned as a dialog for the caller to show, since the caller may
 * itself be a popup that a second popup would replace. A passage that is not in
 * the open source is looked up with the source finder (see pinQuotesInViews).
 */
export async function pinQuoteInViews(
  plugin: ReactRNPlugin,
  request: PinQuoteRequest,
  views: SourceView[],
  onProgress?: (done: number, total: number) => void
): Promise<PinOutcome> {
  const { result, error } = await pinOneQuote(plugin, request, views);
  if (error) return { ok: false, dialog: errorDialog(error) };
  if (!result) {
    const dialog = (await finderFallback(plugin, [request], 0, onProgress)) ?? notFoundDialog(request.candidates);
    const stillMissing = dialog.items ? (dialog.items[0]?.tone === 'miss' ? [request.remId] : []) : [request.remId];
    return { ok: false, dialog: await offerSearchByMeaning(plugin, dialog, stillMissing, request.sourceRemId) };
  }
  await plugin.app.toast(`\ud83d\udccc ${await viewSummary(plugin, request.sourceRemId, result)}`);
  return { ok: true };
}

/**
 * With a corpus provider that searches by meaning, a "not found" dialog offers Find
 * Sources for the Rems that missed: a paraphrase, translation or summary is what the
 * literal search cannot find.
 */
async function offerSearchByMeaning(
  plugin: ReactRNPlugin,
  dialog: MessageDialog,
  remIds: string[],
  openSourceRemId?: string
): Promise<MessageDialog> {
  if (!remIds.length || !(await hasCorpusCapability(plugin, 'semantic-search'))) return dialog;
  return {
    ...dialog,
    findSources: { remIds, openSourceRemId: openSourceRemId ?? null },
    detail:
      `${dialog.detail ? `${dialog.detail} ` : ''}Search by meaning finds the passages that say the same thing in ` +
      `other words or another language: about 25 s per Rem, in the background, then a notice to review them.`,
  };
}

/**
 * The Rems whose passage is not in the open source: ask the source finder which
 * book each comes from and pin it from that book's PDFs, skipping the open source
 * (already searched) unless the finder gives the literal text to look for there.
 * Null when there is no source finder, so the caller shows its own dialog.
 */
async function finderFallback(
  plugin: ReactRNPlugin,
  missed: PinQuoteRequest[],
  pinnedInOpen: number,
  onProgress?: (done: number, total: number) => void
): Promise<MessageDialog | null> {
  if (!missed.length || !(await hasCorpusCapability(plugin, 'find-source'))) return null;
  const openId = missed[0].sourceRemId;
  const open = await plugin.rem.findOne(openId);
  const openName = (open ? await safeRemTextToString(plugin, open.text).catch(() => '') : '') || 'the open source';
  await plugin.app.toast(
    `\ud83d\udd0e Not in \u201c${excerpt(openName, 40)}\u201d \u2014 asking your source finder\u2026`
  );
  const run = await pinFromSourceFinder(
    plugin,
    missed.map(({ remId, candidates }) => ({ remId, candidates })),
    onProgress,
    { searched: [openId] }
  );
  if (run.unavailable !== undefined) return null;
  return finderPinDialog(run, { openSourceName: openName, pinnedInOpen });
}

/**
 * Pin the sources of several Rems (a multi-Rem selection), one after another.
 * Rems whose passage is not found are collected rather than interrupting the
 * run, then looked up with the source finder in the other books (see
 * finderFallback); a helper failure stops it, since every remaining Rem would
 * fail the same way.
 */
export async function pinQuotesInViews(
  plugin: ReactRNPlugin,
  requests: PinQuoteRequest[],
  views: SourceView[],
  onProgress?: (done: number, total: number) => void
): Promise<PinOutcome> {
  if (requests.length === 1) return pinQuoteInViews(plugin, requests[0], views, onProgress);

  const missed: PinQuoteRequest[] = [];
  let pinned = 0;
  let created = 0;
  let reused = 0;
  for (let k = 0; k < requests.length; k++) {
    onProgress?.(k, requests.length);
    const { result, error } = await pinOneQuote(plugin, requests[k], views);
    if (error) {
      const dialog = errorDialog(error);
      dialog.detail = `Stopped after ${k} of ${requests.length} Rems; ${pinned} pinned.`;
      return { ok: false, dialog };
    }
    if (!result) missed.push(requests[k]);
    else {
      pinned++;
      created += result.created.length;
      reused += result.reused.length;
    }
  }
  onProgress?.(requests.length, requests.length);

  await plugin.app.toast(
    `\ud83d\udccc ${pinned} of ${requests.length} Rems pinned \u2014 reused ${reused}, created ${created} highlight${created === 1 ? '' : 's'}.`
  );
  if (!missed.length) return { ok: true };
  const fromFinder = await finderFallback(plugin, missed, pinned, onProgress);
  if (fromFinder) {
    const stillMissing = missed.filter((_, k) => fromFinder.items?.[k]?.tone === 'miss').map((r) => r.remId);
    return { ok: false, dialog: await offerSearchByMeaning(plugin, fromFinder, stillMissing, missed[0].sourceRemId) };
  }
  const list = missed.map((r) => excerpt(r.candidates[0] ?? '', 90));
  return {
    ok: false,
    dialog: await offerSearchByMeaning(plugin, {
      tone: 'info',
      title: `Passage not found for ${missed.length} of ${requests.length} Rems`,
      message: 'The others were pinned. These were not found in the open source:',
      quote: list.slice(0, 8).map((m) => `\u2022 ${m}`).join('\n') + (list.length > 8 ? `\n\u2022 \u2026and ${list.length - 8} more` : ''),
      detail: 'Only text taken from the source matches \u2014 a paraphrase, translation or summary will not.',
    }, missed.map((r) => r.remId), missed[0].sourceRemId),
  };
}

/**
 * Command: pin the sources of the selected Rems' text — a multi-Rem selection
 * takes precedence, else the focused Rem — in the PDF or web article open in a
 * pane of this window, else of another RemNote window. For each Rem the front,
 * the back and both joined are tried (without pins or a leading list marker) and
 * the best match is pinned, at the end of the back when the Rem has one. A PDF that also has a Text Reader version asks which
 * view(s) to use, once for the whole selection.
 */
export async function pinSourceQuote(plugin: ReactRNPlugin) {
  const rems = await selectedOrFocusedRems(plugin);
  if (!rems.length) {
    await plugin.app.toast('Focus or select Rems whose text is a passage from the open PDF or article.');
    return;
  }
  await pinSourcesOfRems(plugin, rems);
}

/**
 * Command: Pin Source Quote over every Quote-formatted Rem in the focused Rem's
 * subtree (or the selected Rems' subtrees), the Rems themselves included.
 */
export async function pinSourceQuotesInTree(plugin: ReactRNPlugin) {
  const roots = await selectedOrFocusedRems(plugin);
  if (!roots.length) {
    await plugin.app.toast('Focus or select the Rem whose descendants hold the quotes to pin.');
    return;
  }

  const seen = new Set<string>();
  const scope: PluginRem[] = [];
  for (const root of roots) {
    for (const rem of [root, ...(await root.getDescendants())]) {
      if (seen.has(rem._id)) continue;
      seen.add(rem._id);
      // Snapshot filter first: a Rem with no text is never worth a powerup read.
      if (rem.text?.length || rem.backText?.length) scope.push(rem);
    }
  }

  // Quote is a built-in powerup, so its members cannot be listed (taggedRem
  // under-reports built-ins); probe each Rem instead, a few reads in flight.
  const isQuote = new Array<boolean>(scope.length).fill(false);
  let next = 0;
  const worker = async () => {
    while (next < scope.length) {
      const k = next++;
      isQuote[k] = await scope[k].isQuote();
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, scope.length) }, worker));
  const quotes = scope.filter((_, k) => isQuote[k]);

  if (!quotes.length) {
    await plugin.app.toast(
      roots.length === 1
        ? 'No Quote Rems in the focused Rem or its descendants.'
        : 'No Quote Rems in the selected Rems or their descendants.'
    );
    return;
  }
  await pinSourcesOfRems(plugin, quotes);
}

/**
 * The Rems a command acts on, wherever it was run: in the queue the card (or
 * IncRem) on screen, unless a Rem is selected in the previewer; in the editor a
 * multi-Rem or table-row selection, else the focused Rem. Same resolution as the
 * priority commands (lib/priority_targets).
 */
export async function selectedOrFocusedRems(plugin: ReactRNPlugin): Promise<PluginRem[]> {
  const { remIds } = await resolvePriorityTargets(plugin);
  if (!remIds.length) {
    console.warn(`[PinSourceQuote] No target Rem resolved on ${await plugin.window.getURL()}`);
    return [];
  }
  return (await plugin.rem.findMany(remIds)) || [];
}

/**
 * The first PDF or saved article open in a pane, in this window first, then in the
 * other RemNote windows (lib/window_sources.ts); undefined when none is.
 */
export async function openSourceRemId(plugin: ReactRNPlugin): Promise<string | undefined> {
  for (const id of [...(await plugin.window.getOpenPaneRemIds()), ...(await sourcesInOtherWindows(plugin))]) {
    const rem = await plugin.rem.findOne(id);
    if (rem && (await sourceViews(rem)).length) return id;
  }
  return undefined;
}

async function pinSourcesOfRems(plugin: ReactRNPlugin, rems: PluginRem[]) {
  const plain = (rt: RichTextInterface | undefined) =>
    plugin.richText.toString(((rt ?? []) as RichTextInterface).filter((el) => !isPin(el)));
  const withText: { remId: string; candidates: string[] }[] = [];
  for (const rem of rems) {
    const candidates = quoteCandidates(await plain(rem.text), await plain(rem.backText));
    if (candidates.length) withText.push({ remId: rem._id, candidates });
  }
  if (!withText.length) {
    await plugin.app.toast(
      rems.length === 1 ? 'The focused Rem has no text to look for.' : 'The selected Rems have no text to look for.'
    );
    return;
  }

  // This window's panes first; then the sources open in the other RemNote
  // windows, which only they can see (lib/window_sources.ts).
  const candidates = [...(await plugin.window.getOpenPaneRemIds()), ...(await sourcesInOtherWindows(plugin))];
  for (const id of candidates) {
    const rem = await plugin.rem.findOne(id);
    const views = rem ? await sourceViews(rem) : [];
    if (!views.length) continue;
    const requests: PinQuoteRequest[] = withText.map((w) => ({ ...w, sourceRemId: id }));
    if (views.length > 1) {
      await plugin.widget.openPopup(PIN_SOURCE_VIEWS_POPUP, { requests });
      return;
    }
    if (requests.length > 1) await plugin.app.toast(`\ud83d\udccc Pinning ${requests.length} Rems\u2026`);
    const outcome = await pinQuotesInViews(plugin, requests, views);
    if (!outcome.ok) await showMessageDialog(plugin, outcome.dialog);
    return;
  }
  // No source open: ask the user's source finder which book each quote is from.
  await plugin.app.toast(
    `\ud83d\udd0e No source open \u2014 looking up ${withText.length === 1 ? 'the quote' : `${withText.length} quotes`} with your source finder\u2026`
  );
  const run = await pinFromSourceFinder(plugin, withText);
  if (run.unavailable !== undefined) {
    await plugin.app.toast('Open the source PDF or web article in a pane first (in any RemNote window).');
    return;
  }
  const notPinned = run.rows.filter((r) => !r.pinned).map((r) => r.remId);
  await showMessageDialog(plugin, await offerSearchByMeaning(plugin, finderPinDialog(run), notPinned));
}

// --- no source open: the source finder ---------------------------------------

/**
 * A book the user's source finder names for a quote (the AI helper's
 * `/find-source`; the contract is in docs/Source-Pins.md, "Writing a source
 * finder"), with its RemNote PDFs in the order to try.
 */
export interface FoundBook {
  /** The finder's own id for the book, if it has one. */
  id?: string;
  title: string;
  /** How the book is cited, short ("BPG"); the title when absent. */
  cite?: string;
  /** How the finder knew, shown as is in the dialog ("named in the quote"). */
  how: string;
  detail?: string;
  /** Page to search first, when the finder knows one. */
  page?: number | null;
  pdfRemIds: string[];
  /**
   * The text to look for in this book's PDFs instead of the Rem's own, when the
   * Rem's text was corrected and no longer matches the PDF letter for letter (the
   * corpus provider's `quote-literal` capability; docs/Corpus-Provider.md).
   */
  quote?: string;
}

export interface FinderPinRow {
  remId: string;
  quote: string;
  books: FoundBook[];
  /** Set when pinned. */
  pinned?: {
    pdfRemId: string;
    pdfName: string;
    book: FoundBook;
    page?: number;
    reused: number;
    created: number;
    pins: string[];
  };
  /** PDFs tried without finding the passage (name, and why when it failed). */
  tried: string[];
}

export interface FinderPinRun {
  /** Set (with the reason) when the index is not there: the caller falls back to asking for an open source. */
  unavailable?: string;
  rows: FinderPinRow[];
  /** A failure that stopped the run (the helper went away). */
  stopped?: string;
}

export async function ancestorIds(rem: PluginRem, max = 40): Promise<string[]> {
  const ids: string[] = [];
  let parent = await rem.getParentRem();
  while (parent && ids.length < max) {
    ids.push(parent._id);
    parent = await parent.getParentRem();
  }
  return ids;
}

/**
 * Pin each Rem's quote from a PDF that is not open: the helper asks the user's
 * source finder (`/find-source`) which book the quote is from, given its text and
 * the Rems above it, and which of that book's RemNote PDFs to try, in order. The first PDF where the passage is found
 * is pinned (its page view). Also run by the Local Media Bridge's `pin-quote`
 * without `--source`, and by Pin Source Quote for the passages the open source
 * does not hold (`searched`: the PDFs already searched with the Rem's own text).
 */
export async function pinFromSourceFinder(
  plugin: ReactRNPlugin,
  requests: { remId: string; candidates: string[] }[],
  onProgress?: (done: number, total: number) => void,
  options: { searched?: string[] } = {}
): Promise<FinderPinRun> {
  const searched = new Set(options.searched ?? []);
  const items = [];
  for (const r of requests) {
    const rem = await plugin.rem.findOne(r.remId);
    const texts = rem
      ? [await plugin.richText.toString((rem.text ?? []) as RichTextInterface), await plugin.richText.toString((rem.backText ?? []) as RichTextInterface)]
      : r.candidates;
    items.push({ remId: r.remId, ancestors: rem ? await ancestorIds(rem) : [], texts: texts.filter(Boolean) });
  }
  const found = await helperPost<{ available: boolean; reason?: string; items: { remId: string; books: FoundBook[] }[] }>(
    plugin,
    '/find-source',
    { items }
  ).catch((e: Error) => ({ available: false, reason: e.message, items: [] }));
  if (!found.available) return { unavailable: found.reason ?? 'no index', rows: [] };

  const booksOf = new Map(found.items.map((it) => [it.remId, it.books]));
  const names = new Map<string, string>();
  const nameOf = async (id: string, source?: PluginRem) => {
    if (!names.has(id)) names.set(id, source ? (await safeRemTextToString(plugin, source.text)) || id : id);
    return names.get(id)!;
  };

  const rows: FinderPinRow[] = [];
  for (let k = 0; k < requests.length; k++) {
    onProgress?.(k, requests.length);
    const request = requests[k];
    const books = booksOf.get(request.remId) ?? [];
    const row: FinderPinRow = { remId: request.remId, quote: request.candidates[0] ?? '', books, tried: [] };
    rows.push(row);
    outer: for (const book of books) {
      for (const pdfRemId of book.pdfRemIds) {
        const source = await plugin.rem.findOne(pdfRemId);
        const views = source ? await sourceViews(source) : [];
        if (!source || !views.length) {
          row.tried.push(`${pdfRemId} (not a PDF in this knowledge base)`);
          continue;
        }
        // Already searched with the Rem's own text (the open source); worth a
        // second look only for the finder's literal text (quote-literal).
        if (searched.has(pdfRemId) && !book.quote?.trim()) {
          row.tried.push(`${await nameOf(pdfRemId, source)} (the open source)`);
          continue;
        }
        const view: SourceView = views.includes('pdf') ? 'pdf' : views[0];
        // quote-literal: the provider's text first (what the PDF holds), then the Rem's own
        const candidates = book.quote?.trim()
          ? [book.quote.trim(), ...request.candidates.filter((c) => c !== book.quote?.trim())]
          : request.candidates;
        const { result, error } = await pinOneQuote(
          plugin,
          { ...request, candidates, sourceRemId: pdfRemId, page: book.page ?? undefined },
          [view]
        );
        if (error instanceof HelperUnreachableError) return { rows, stopped: error.message };
        if (error) {
          row.tried.push(`${await nameOf(pdfRemId, source)} (${error.message})`);
          continue;
        }
        if (!result) {
          row.tried.push(await nameOf(pdfRemId, source));
          continue;
        }
        row.pinned = {
          pdfRemId,
          pdfName: await nameOf(pdfRemId, source),
          book,
          page: result.page,
          reused: result.reused.length,
          created: result.created.length,
          pins: result.pins,
        };
        break outer;
      }
    }
  }
  onProgress?.(requests.length, requests.length);
  return { rows };
}

const bookName = (book: FoundBook) => book.cite || book.title;

/**
 * The confirmation shown after pinning from PDFs that were not open: per quote,
 * which PDF and how its book was found. `fallback` when the finder was asked
 * because an open source did not hold the passages.
 */
export function finderPinDialog(
  run: FinderPinRun,
  fallback?: { openSourceName: string; pinnedInOpen: number }
): MessageDialog {
  const pinned = run.rows.filter((r) => r.pinned).length;
  const total = run.rows.length;
  const items = run.rows.map((row) => {
    const p = row.pinned;
    if (p) {
      return {
        title: excerpt(row.quote, 120),
        tone: 'ok' as const,
        lines: [
          `PDF: ${p.pdfName}${p.page ? ` \u00b7 p. ${p.page}` : ''}`,
          `Book: ${bookName(p.book)} \u2014 ${excerpt(p.book.how, 140)}`,
          `Highlights: reused ${p.reused}, created ${p.created}`,
        ],
      };
    }
    return {
      title: excerpt(row.quote, 120),
      tone: 'miss' as const,
      lines: row.books.length
        ? [
            `Not found in: ${row.tried.join('; ') || 'no PDF of ' + row.books.map(bookName).join(', ')}`,
            `Books tried: ${row.books.map(bookName).join(', ')}`,
          ]
        : ['Your source finder found no book for this quote.'],
    };
  });
  const missed = total - pinned;
  const open = fallback ? `\u201c${excerpt(fallback.openSourceName, 60)}\u201d` : '';
  const title = fallback
    ? total === 1
      ? pinned
        ? 'Pinned from another PDF'
        : 'Passage not found'
      : `Pinned ${pinned} of ${total} quotes from other PDFs`
    : total === 1
    ? pinned
      ? 'Pinned from a PDF that was not open'
      : 'Passage not found in the PDFs of its book'
    : `Pinned ${pinned} of ${total} quotes from PDFs that were not open`;
  const message = fallback
    ? (fallback.pinnedInOpen ? `${fallback.pinnedInOpen} pinned in the open source, ${open}. ` : '') +
      `${total === 1 ? 'This passage is' : 'These passages are'} not in ${fallback.pinnedInOpen ? 'it' : open}, ` +
      `so your source finder looked for ${total === 1 ? 'its book' : 'their books'}:`
    : 'No PDF or article was open, so each quote\u2019s book was found by your source finder.';
  const hints = [
    run.stopped ? `Stopped: ${run.stopped}` : '',
    pinned ? 'Wrong PDF? Remove the pin, open the right PDF and run Pin Source Quote again.' : '',
    missed ? 'Only text taken from the source matches \u2014 a paraphrase, translation or summary will not.' : '',
  ];
  return {
    tone: pinned ? 'success' : 'info',
    title,
    message,
    items,
    detail: hints.filter(Boolean).join(' '),
  };
}

export interface OtherViewPinOutcome {
  status: 'pinned' | 'not-found' | 'skipped' | 'failed';
  pins: string[];
  reason?: string;
}

const parseJson = (raw: string | undefined) => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

/**
 * For a PDF that has both views: pin on `targetRemId` the passage of
 * `highlightRemId` in the OTHER view — the Text Reader for a PDF-page highlight,
 * the PDF page for a Text Reader highlight — reusing that view's highlight or
 * creating one. Best effort: it never throws, so a caller such as Create IncRem
 * is never broken by it (the helper may not be running, the passage may differ).
 */
export async function pinOtherViewOfHighlight(
  plugin: ReactRNPlugin,
  highlightRemId: string,
  targetRemId: string
): Promise<OtherViewPinOutcome> {
  try {
    const highlight = await plugin.rem.findOne(highlightRemId);
    if (!highlight) return { status: 'skipped', pins: [], reason: 'highlight not found' };

    // The quote is the highlight's stored source text, not its Rem text: a
    // ✨-transcribed highlight holds LaTeX that matches neither view.
    let otherView: SourceView;
    let sourceRemId: string | undefined;
    let quote = '';
    if (await highlight.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) {
      otherView = 'html';
      sourceRemId = (
        (await highlight.getPowerupPropertyAsRichText(BuiltInPowerupCodes.PDFHighlight, 'PdfId'))?.[0] as
          | RichTextElementRemInterface
          | undefined
      )?._id;
      quote = parseJson(await highlight.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data'))?.content?.text ?? '';
    } else if (await highlight.hasPowerup(BuiltInPowerupCodes.HTMLHighlight)) {
      otherView = 'pdf';
      sourceRemId = (
        (await highlight.getPowerupPropertyAsRichText(BuiltInPowerupCodes.HTMLHighlight, 'HTMLId'))?.[0] as
          | RichTextElementRemInterface
          | undefined
      )?._id;
      quote = parseJson(await highlight.getPowerupProperty(BuiltInPowerupCodes.HTMLHighlight, 'Data'))?.text ?? '';
    } else {
      return { status: 'skipped', pins: [], reason: 'not a PDF or HTML highlight' };
    }
    // Area highlights hold an image, not text: nothing to look for.
    if (!sourceRemId || !quote.trim()) return { status: 'skipped', pins: [], reason: 'no source or no text' };

    const source = await plugin.rem.findOne(sourceRemId);
    const views = source ? await sourceViews(source) : [];
    if (!views.includes('pdf') || !views.includes('html')) {
      return { status: 'skipped', pins: [], reason: 'the source has only one view' };
    }

    const [result] = await ensureSourcePins(plugin, sourceRemId, [{ quote }], [otherView]);
    if (!result.found) return { status: 'not-found', pins: [] };
    const pins = result.pins.filter((id) => id !== highlightRemId);
    const target = await plugin.rem.findOne(targetRemId);
    if (target && pins.length) await target.setText(withPins((target.text ?? []) as RichTextInterface, pins));
    return { status: 'pinned', pins };
  } catch (e) {
    console.warn('[SourcePins] Pinning the other view failed:', e);
    return { status: 'failed', pins: [], reason: (e as Error).message };
  }
}
