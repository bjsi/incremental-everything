import {
  BuiltInPowerupCodes,
  PluginRem,
  ReactRNPlugin,
  RichTextElementRemInterface,
  RichTextInterface,
} from '@remnote/plugin-sdk';
import { AI_OCR_HELPER_URL } from '../ai_ocr';
import { HighlightColorName, sourceHighlightColorId } from '../consts';
import { createHtmlHighlight, createPdfHighlight } from '../pdf_highlight_create';
import { safeRemTextToString } from '../pdfUtils';
import { getIESetting } from '../settings';
import DOMPurify from 'dompurify';
import { stripListMarker } from './quote';
import { MessageDialog, showMessageDialog } from '../message_dialog';
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
  /** Every view's pins, in the order the views were asked for. */
  pins: string[];
  reused: string[];
  created: string[];
  views: ViewPinResult[];
}

export class SourcePinError extends Error {}

async function helperPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${AI_OCR_HELPER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('[SourcePins] Helper unreachable:', e);
    throw new SourcePinError(`AI helper is not running (${AI_OCR_HELPER_URL}). Start scripts/ai_ocr_helper.py.`);
  }
  const json = await res.json().catch(() => null);
  if (!json?.ok) throw new SourcePinError(`AI helper: ${json?.error ?? `HTTP ${res.status}`}`);
  return json as T;
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

/** RemNote's managed container is identifiable only by name + being a direct child of the source. */
async function findHighlightsContainer(plugin: ReactRNPlugin, source: PluginRem) {
  for (const child of await source.getChildrenRem()) {
    if ((await safeRemTextToString(plugin, child.text)) === 'Highlights') return child;
  }
  return null;
}

// ---------------------------------------------------------------------------
// PDF view
// ---------------------------------------------------------------------------

interface LocateResult {
  found: boolean;
  page?: number;
  score?: number;
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
    private pageCount: number
  ) {}

  static async load(plugin: ReactRNPlugin, container: PluginRem, pageCount: number) {
    const index = new PdfHighlightIndex(plugin, container._id, pageCount);
    for (const page of await container.getChildrenRem()) {
      const n = pageNumberOfLabel(await safeRemTextToString(plugin, page.text));
      if (n !== null && !index.pageRems.has(n)) index.pageRems.set(n, page._id);
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
      for (const child of await pageRem.getChildrenRem()) {
        if (!(await child.hasPowerup(BuiltInPowerupCodes.PDFHighlight))) continue;
        const raw = await child.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data');
        let data: any = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          continue;
        }
        const rects = rectsOnPage(data, page, pageWidth, pageHeight);
        if (rects.length) found.push({ remId: child._id, rects });
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
  color: HighlightColorName
): Promise<ViewPinResult[]> {
  const pdfUrl = await source.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL');
  const located = await helperPost<{ pageCount: number; results: LocateResult[] }>('/locate', { pdfUrl, quotes });
  const index = await PdfHighlightIndex.load(plugin, container, located.pageCount);

  const results: ViewPinResult[] = [];
  for (let k = 0; k < quotes.length; k++) {
    const hit = located.results[k];
    const result: ViewPinResult = { view: 'pdf', found: !!hit?.found, pins: [], reused: [], created: [] };
    results.push(result);
    if (!hit?.found || !hit.words?.length || !hit.page || !hit.pageWidth || !hit.pageHeight) continue;
    result.page = hit.page;
    result.score = hit.score;

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
  color: HighlightColorName
): Promise<ViewPinResult[]> {
  const fileUrl = await source.getPowerupProperty(BuiltInPowerupCodes.Link, 'FileURL');
  const { text: html } = await helperPost<{ text: string }>('/source', { url: fileUrl });
  // Prepare the article as RemNote's viewer does, or the XPaths will not line up.
  // Static import on purpose: webpack.config.js banners every non-sandbox chunk
  // with `import.meta`, which breaks lazily loaded chunks.
  const article = parseArticle(
    viewerHtml(html, (s) => String(DOMPurify.sanitize(s)), mathPlaceholder),
    new DOMParser()
  );

  // HTML highlights sit directly in the container. A PDF's page-view highlights
  // live one level down, under "Page NNN" Rems, so they are never mistaken here.
  const existing: TextHighlight[] = [];
  for (const child of await container.getChildrenRem()) {
    if (!(await child.hasPowerup(BuiltInPowerupCodes.HTMLHighlight))) continue;
    const raw = await child.getPowerupProperty(BuiltInPowerupCodes.HTMLHighlight, 'Data');
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      continue;
    }
    const span = highlightSpan(article, data);
    if (span) existing.push({ remId: child._id, intervals: [span] });
    else console.warn('[SourcePins] HTML highlight anchor did not resolve', child._id, data);
  }

  const { results: matches } = await helperPost<{
    results: { found: boolean; start?: number; end?: number; score?: number }[];
  }>('/match', { words: article.words.map((w) => w.text), quotes: quotes.map((q) => ({ quote: q.quote })) });

  const results: ViewPinResult[] = [];
  for (let k = 0; k < quotes.length; k++) {
    const match = matches[k];
    const result: ViewPinResult = { view: 'html', found: !!match?.found, pins: [], reused: [], created: [] };
    results.push(result);
    if (!match?.found || match.start === undefined || match.end === undefined) continue;
    result.score = match.score;

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
 */
export async function ensureSourcePins(
  plugin: ReactRNPlugin,
  sourceRemId: string,
  quotes: SourceQuote[],
  views?: SourceView[]
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

  const perView: ViewPinResult[][] = [];
  for (const view of wanted) {
    perView.push(
      view === 'pdf'
        ? await ensurePdfPins(plugin, source, container, quotes, color)
        : await ensureHtmlPins(plugin, source, container, quotes, color)
    );
  }

  return quotes.map((q, k) => {
    const views = perView.map((results) => results[k]);
    return {
      quote: q.quote,
      found: views.some((v) => v.found),
      page: views.find((v) => v.view === 'pdf')?.page,
      pins: [...new Set(views.flatMap((v) => v.pins))],
      reused: views.flatMap((v) => v.reused),
      created: views.flatMap((v) => v.created),
      views,
    };
  });
}

const isPin = (el: unknown): el is RichTextElementRemInterface & { pin: true } =>
  typeof el === 'object' && el !== null && (el as any).i === 'q' && !!(el as any).pin;

/** Rich text with pins to `ids` appended, skipping ones already pinned. */
export function withPins(text: RichTextInterface, ids: string[]): RichTextInterface {
  const already = new Set(text.filter(isPin).map((el) => el._id));
  const additions = ids.filter((id) => !already.has(id)).flatMap((id) => [' ', { i: 'q' as const, _id: id, pin: true }]);
  return [...text, ...additions] as RichTextInterface;
}

export interface PinQuoteRequest {
  focusedRemId: string;
  sourceRemId: string;
  quote: string;
}

export type PinOutcome = { ok: true } | { ok: false; dialog: MessageDialog };

/**
 * Pin `request.quote`'s source in `views` and append the pins to the Rem. Success
 * is reported in a toast. A failure is returned as a dialog for the caller to
 * show, since the caller may itself be a popup that a second popup would replace.
 */
export async function pinQuoteInViews(
  plugin: ReactRNPlugin,
  request: PinQuoteRequest,
  views: SourceView[]
): Promise<PinOutcome> {
  let result: SourcePinResult;
  try {
    [result] = await ensureSourcePins(plugin, request.sourceRemId, [{ quote: request.quote }], views);
  } catch (e) {
    console.error('[SourcePins]', e);
    return {
      ok: false,
      dialog: {
        tone: 'error',
        title: 'Could not pin the source',
        message: e instanceof SourcePinError ? e.message : `Pin Source Quote failed: ${(e as Error).message}`,
      },
    };
  }
  console.log('[SourcePins] Result', result);

  if (!result.found) {
    const quote = request.quote.length > 200 ? `${request.quote.slice(0, 200)}…` : request.quote;
    return {
      ok: false,
      dialog: {
        tone: 'info',
        title: 'Passage not found',
        message: 'This passage does not appear in the open source:',
        quote,
        detail:
          'Only text taken from the source matches — a paraphrase, translation or summary will not. ' +
          'Check that the right PDF or article is open.',
      },
    };
  }
  const fresh = await plugin.rem.findOne(request.focusedRemId);
  if (fresh) await fresh.setText(withPins((fresh.text ?? []) as RichTextInterface, result.pins));

  const source = await plugin.rem.findOne(request.sourceRemId);
  const sourceIsPdf = source ? (await sourceViews(source)).includes('pdf') : false;
  const label = (v: ViewPinResult) =>
    v.view === 'pdf' ? `PDF p.${v.page ?? '?'}` : sourceIsPdf ? 'Text Reader' : 'Article';
  const summary = result.views
    .map((v) => (v.found ? `${label(v)}: reused ${v.reused.length}, created ${v.created.length}` : `${label(v)}: not found`))
    .join(' · ');
  await plugin.app.toast(`📌 ${summary}`);
  return { ok: true };
}

/**
 * Command: pin the source of the focused Rem's text in the PDF or web article
 * open in a pane. The Rem's text (without its pins or a leading list marker) is
 * the quote. A PDF that also has a Text Reader version asks which view(s) to use.
 */
export async function pinSourceQuote(plugin: ReactRNPlugin) {
  const focused = await plugin.focus.getFocusedRem();
  if (!focused) {
    await plugin.app.toast('Focus a Rem whose text is a passage from the open PDF or article.');
    return;
  }
  const quote = stripListMarker(
    await plugin.richText.toString(((focused.text ?? []) as RichTextInterface).filter((el) => !isPin(el)))
  );
  if (!quote.trim()) {
    await plugin.app.toast('The focused Rem has no text to look for.');
    return;
  }

  for (const id of await plugin.window.getOpenPaneRemIds()) {
    const rem = await plugin.rem.findOne(id);
    const views = rem ? await sourceViews(rem) : [];
    if (!views.length) continue;
    const request: PinQuoteRequest = { focusedRemId: focused._id, sourceRemId: id, quote };
    if (views.length > 1) {
      await plugin.widget.openPopup(PIN_SOURCE_VIEWS_POPUP, { request });
    } else {
      const outcome = await pinQuoteInViews(plugin, request, views);
      if (!outcome.ok) await showMessageDialog(plugin, outcome.dialog);
    }
    return;
  }
  await plugin.app.toast('Open the source PDF or web article in a pane first.');
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
