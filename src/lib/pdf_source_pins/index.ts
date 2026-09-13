import {
  BuiltInPowerupCodes,
  ReactRNPlugin,
  RichTextElementRemInterface,
  RichTextInterface,
} from '@remnote/plugin-sdk';
import { AI_OCR_HELPER_URL } from '../ai_ocr';
import { HighlightColorName, sourceHighlightColorId } from '../consts';
import { createPdfHighlight } from '../pdf_highlight_create';
import { safeRemTextToString } from '../pdfUtils';
import { getIESetting } from '../settings';
import { LocatedWord, PageHighlight, planSourcePins, positionFromWords, rectsOnPage, wordsText } from './overlap';

/**
 * Source pins: pin the PDF passage a piece of text came from, reusing the
 * highlights already on the page and creating new ones only where none covers
 * the passage (see ./overlap.ts for the rule). The helper finds the quote's
 * words in the PDF; everything written to RemNote happens here.
 */

export interface SourceQuote {
  quote: string;
  /** 1-based page to search first (±2 pages around it); omit to search the whole PDF. */
  page?: number;
}

export interface SourcePinResult {
  quote: string;
  found: boolean;
  page?: number;
  score?: number;
  /** Highlight Rem ids to pin, in reading order: reused ones and new ones. */
  pins: string[];
  reused: string[];
  created: string[];
}

interface LocateResult {
  found: boolean;
  page?: number;
  score?: number;
  pageWidth?: number;
  pageHeight?: number;
  words?: LocatedWord[];
}

async function locateQuotes(pdfUrl: string, quotes: SourceQuote[]) {
  const res = await fetch(`${AI_OCR_HELPER_URL}/locate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdfUrl, quotes }),
  });
  const body = await res.json();
  if (!body?.ok) throw new Error(body?.error ?? 'locate failed');
  return body as { pageCount: number; results: LocateResult[] };
}

const pageNumberOfLabel = (label: string) => {
  const m = /^page\s+0*(\d+)$/i.exec(label.trim());
  return m ? Number(m[1]) : null;
};

/** RemNote names page Rems with the page number padded to the digits of the page count ("Page 095"). */
const pageLabel = (page: number, pageCount: number) =>
  `Page ${String(page).padStart(String(pageCount).length, '0')}`;

/**
 * Tracks one PDF's Highlights container, its "Page NNN" Rems and the highlights
 * on each page, so several quotes in one run see each other's new highlights.
 */
class PdfHighlightIndex {
  private pageRems = new Map<number, string>();
  private highlights = new Map<number, PageHighlight[]>();

  private constructor(
    private plugin: ReactRNPlugin,
    private containerId: string,
    private pageCount: number
  ) {}

  static async load(plugin: ReactRNPlugin, pdfRemId: string, pageCount: number) {
    const pdfRem = await plugin.rem.findOne(pdfRemId);
    if (!pdfRem) return null;
    // The managed container is identifiable only by name + being a direct child of the PDF.
    let container = null;
    for (const child of await pdfRem.getChildrenRem()) {
      if ((await safeRemTextToString(plugin, child.text)) === 'Highlights') {
        container = child;
        break;
      }
    }
    if (!container) return null;

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

  remember(page: number, highlight: PageHighlight) {
    this.highlights.get(page)?.push(highlight);
  }
}

export class SourcePinError extends Error {}

/** Find each quote in the PDF and return the highlights to pin, creating the missing ones. */
export async function ensureSourcePins(
  plugin: ReactRNPlugin,
  pdfRemId: string,
  quotes: SourceQuote[]
): Promise<SourcePinResult[]> {
  const pdfRem = await plugin.rem.findOne(pdfRemId);
  const pdfUrl = pdfRem ? await pdfRem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL') : '';
  if (!pdfUrl) throw new SourcePinError('That Rem is not an uploaded PDF.');

  let located;
  try {
    located = await locateQuotes(pdfUrl, quotes);
  } catch (e) {
    console.error('[SourcePins] Helper call failed:', e);
    throw new SourcePinError(`AI helper is not reachable (${AI_OCR_HELPER_URL}): ${(e as Error).message}`);
  }

  const index = await PdfHighlightIndex.load(plugin, pdfRemId, located.pageCount);
  if (!index) {
    throw new SourcePinError('This PDF has no Highlights document yet — make one highlight in it first.');
  }
  const color = await getIESetting(plugin, sourceHighlightColorId);

  const results: SourcePinResult[] = [];
  for (let k = 0; k < quotes.length; k++) {
    const hit = located.results[k];
    const result: SourcePinResult = { quote: quotes[k].quote, found: !!hit?.found, pins: [], reused: [], created: [] };
    results.push(result);
    if (!hit?.found || !hit.words?.length || !hit.page || !hit.pageWidth || !hit.pageHeight) continue;
    result.page = hit.page;
    result.score = hit.score;

    const existing = await index.onPage(hit.page, hit.pageWidth, hit.pageHeight);
    const plan = planSourcePins(hit.words, existing);
    result.reused = plan.reuse;

    for (const stretch of plan.create) {
      const position = positionFromWords(stretch, hit.pageWidth, hit.pageHeight, hit.page);
      const highlight = await createPdfHighlight(plugin, {
        pdfRemId,
        parentId: await index.pageRemFor(hit.page),
        text: wordsText(stretch),
        position,
        color: color as HighlightColorName,
      });
      if (!highlight) continue;
      result.created.push(highlight._id);
      index.remember(hit.page, { remId: highlight._id, rects: position.rects });
    }

    // Pins follow the passage's reading order: each highlight at its first word.
    const firstWord = (id: string) => {
      const reusedAt = hit.words!.findIndex((w) => existing.find((h) => h.remId === id)?.rects.some(
        (r) => (w.x1 + w.x2) / 2 >= r.x1 && (w.x1 + w.x2) / 2 <= r.x2 && (w.y1 + w.y2) / 2 >= r.y1 && (w.y1 + w.y2) / 2 <= r.y2
      ));
      return reusedAt === -1 ? Number.MAX_SAFE_INTEGER : reusedAt;
    };
    result.pins = [...new Set([...result.reused, ...result.created])].sort((a, b) => firstWord(a) - firstWord(b));
  }
  return results;
}

const isPin = (el: unknown): el is RichTextElementRemInterface & { pin: true } =>
  typeof el === 'object' && el !== null && (el as any).i === 'q' && !!(el as any).pin;

/** Rich text with pins to `ids` appended, skipping ones already pinned. */
export function withPins(text: RichTextInterface, ids: string[]): RichTextInterface {
  const already = new Set(text.filter(isPin).map((el) => el._id));
  const additions = ids.filter((id) => !already.has(id)).flatMap((id) => [' ', { i: 'q' as const, _id: id, pin: true }]);
  return [...text, ...additions] as RichTextInterface;
}

/**
 * Command: pin the source of the focused Rem's text in the PDF open in a pane.
 * The Rem's text (without its pins) is the quote.
 */
export async function pinSourceQuote(plugin: ReactRNPlugin) {
  const focused = await plugin.focus.getFocusedRem();
  if (!focused) {
    await plugin.app.toast('Focus a Rem whose text is a passage from the open PDF.');
    return;
  }
  const quote = await plugin.richText.toString(((focused.text ?? []) as RichTextInterface).filter((el) => !isPin(el)));
  if (!quote.trim()) {
    await plugin.app.toast('The focused Rem has no text to look for.');
    return;
  }

  let pdfRemId: string | undefined;
  for (const id of await plugin.window.getOpenPaneRemIds()) {
    const rem = await plugin.rem.findOne(id);
    if (rem && (await rem.hasPowerup(BuiltInPowerupCodes.UploadedFile))) {
      pdfRemId = id;
      break;
    }
  }
  if (!pdfRemId) {
    await plugin.app.toast('Open the source PDF in a pane first.');
    return;
  }

  await plugin.app.toast('📌 Looking for the passage in the PDF…');
  let result: SourcePinResult;
  try {
    [result] = await ensureSourcePins(plugin, pdfRemId, [{ quote }]);
  } catch (e) {
    await plugin.app.toast(e instanceof SourcePinError ? e.message : `Pin Source Quote failed: ${(e as Error).message}`);
    console.error('[SourcePins]', e);
    return;
  }
  console.log('[SourcePins] Result', result);

  if (!result.found) {
    await plugin.app.toast('Passage not found in the open PDF.');
    return;
  }
  const fresh = await plugin.rem.findOne(focused._id);
  if (fresh) await fresh.setText(withPins((fresh.text ?? []) as RichTextInterface, result.pins));
  await plugin.app.toast(
    `📌 Page ${result.page}: reused ${result.reused.length}, created ${result.created.length} highlight` +
      `${result.created.length === 1 ? '' : 's'}.`
  );
}
