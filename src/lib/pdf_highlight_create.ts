import { BuiltInPowerupCodes, ReactRNPlugin, RichTextElementRemInterface } from '@remnote/plugin-sdk';

/**
 * Create a PDF highlight Rem from the plugin, mirroring RemNote's own
 * `createHighlightOnPDFRem` (read from the app bundle): a Rem whose text is the
 * highlighted text, with the PDFHighlight powerup's `Data` slot holding
 * `{ content: { text }, position, id, temp }` and its `PdfId` slot pointing at
 * the PDF, parented under the PDF's "Page NNN" Rem.
 *
 * RemNote's version also calls an internal `addToPortal("pdfHighlight", pdfId)`
 * that the plugin SDK has no equivalent for, so whether a plugin-made highlight
 * shows in the PDF viewer is what `probeClonePdfHighlight` below is testing.
 */

/** A box in the coordinates of a page viewport whose size is `width` × `height`. */
export interface HighlightRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
  pageNumber: number;
}

export interface PdfHighlightPosition {
  boundingRect: HighlightRect;
  rects: HighlightRect[];
  pageNumber: number;
}

export async function createPdfHighlight(
  plugin: ReactRNPlugin,
  opts: {
    pdfRemId: string;
    parentId: string;
    positionAmongstSiblings?: number;
    text: string;
    position: PdfHighlightPosition;
    color?: 'Red' | 'Orange' | 'Yellow' | 'Green' | 'Blue' | 'Purple';
  }
) {
  const rem = await plugin.rem.createRem();
  if (!rem) return undefined;

  const data = {
    content: { text: opts.text },
    position: opts.position,
    id: String(Math.random()).slice(2),
    temp: false,
  };
  await rem.setText([opts.text]);
  await rem.setParent(opts.parentId, opts.positionAmongstSiblings);
  await rem.addPowerup(BuiltInPowerupCodes.PDFHighlight);
  await rem.setPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data', [JSON.stringify(data)]);
  await rem.setPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'PdfId', [{ i: 'q', _id: opts.pdfRemId }]);
  if (opts.color) await rem.setHighlightColor(opts.color);
  return rem;
}

/**
 * An HTML highlight's Data, as RemNote's viewer records a selection: XPaths
 * relative to the <div> the article is mounted in, plus offsets inside the start
 * and end text nodes.
 */
export interface HtmlHighlightData {
  startXPath: string;
  endXPath: string;
  startOffset: number;
  endOffset: number;
  text: string;
  textBefore: string;
  textAfter: string;
}

/**
 * Create an HTML highlight Rem, mirroring RemNote's `createHTMLHighlight`: the
 * HTMLHighlight powerup's `Data` holds the anchor, `HTMLId` points at the
 * article Rem, and the Rem sits directly in the article's Highlights container
 * (web articles have no "Page NNN" Rems).
 */
export async function createHtmlHighlight(
  plugin: ReactRNPlugin,
  opts: {
    sourceRemId: string;
    parentId: string;
    data: HtmlHighlightData;
    color?: 'Red' | 'Orange' | 'Yellow' | 'Green' | 'Blue' | 'Purple';
  }
) {
  const rem = await plugin.rem.createRem();
  if (!rem) return undefined;
  await rem.setText([opts.data.text]);
  await rem.setParent(opts.parentId);
  await rem.addPowerup(BuiltInPowerupCodes.HTMLHighlight);
  await rem.setPowerupProperty(BuiltInPowerupCodes.HTMLHighlight, 'Data', [JSON.stringify(opts.data)]);
  await rem.setPowerupProperty(BuiltInPowerupCodes.HTMLHighlight, 'HTMLId', [{ i: 'q', _id: opts.sourceRemId }]);
  if (opts.color) await rem.setHighlightColor(opts.color);
  return rem;
}

/** Shift every box of a position vertically, in page units. */
const shiftPosition = (position: PdfHighlightPosition, dy: number): PdfHighlightPosition => {
  const shift = (r: HighlightRect): HighlightRect => ({ ...r, y1: r.y1 + dy, y2: r.y2 + dy });
  return { ...position, boundingRect: shift(position.boundingRect), rects: position.rects.map(shift) };
};

const PROBE_PREFIX = '🧪 Probe copy — ';

/**
 * Test: clone the focused highlight through the plugin API, placed just below
 * the original (or above, near the page bottom), in blue. If the copy shows in
 * the PDF viewer, plugin-made highlights work and AI features can pin sources.
 */
export async function probeClonePdfHighlight(plugin: ReactRNPlugin, sourceRemId: string) {
  const source = await plugin.rem.findOne(sourceRemId);
  if (!source || !(await source.hasPowerup(BuiltInPowerupCodes.PDFHighlight))) {
    await plugin.app.toast('Focus a PDF highlight Rem (in the Highlights document) first.');
    return;
  }

  const dataString = await source.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data');
  const pdfIdRichText = await source.getPowerupPropertyAsRichText(BuiltInPowerupCodes.PDFHighlight, 'PdfId');
  const pdfRemId = (pdfIdRichText?.[0] as RichTextElementRemInterface | undefined)?._id;
  const sourceData = dataString ? JSON.parse(dataString) : null;
  const box: HighlightRect | undefined = sourceData?.position?.boundingRect;
  if (!sourceData?.position || !box || !pdfRemId || !source.parent) {
    console.warn('[HighlightProbe] Unusable source', { dataString, pdfIdRichText, parent: source.parent });
    await plugin.app.toast('This highlight has no position data or PDF link — pick a highlight made in the PDF view.');
    return;
  }

  const boxHeight = box.y2 - box.y1;
  const gap = 12 * (box.height / 792); // ~12 pt on a letter-sized page, scaled to the viewport
  const dy = box.y2 + gap + boxHeight <= box.height ? boxHeight + gap : -(boxHeight + gap);
  const sourceText = await plugin.richText.toString(source.text ?? []);
  const siblingIndex = await source.positionAmongstSiblings();

  const copy = await createPdfHighlight(plugin, {
    pdfRemId,
    parentId: source.parent,
    positionAmongstSiblings: siblingIndex !== undefined ? siblingIndex + 1 : undefined,
    text: PROBE_PREFIX + sourceText,
    position: shiftPosition(sourceData.position, dy),
    color: 'Blue',
  });
  if (!copy) {
    await plugin.app.toast('Could not create a Rem.');
    return;
  }

  const readBack = {
    copyId: copy._id,
    hasPowerup: await copy.hasPowerup(BuiltInPowerupCodes.PDFHighlight),
    data: await copy.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data'),
    pdfId: await copy.getPowerupPropertyAsRichText(BuiltInPowerupCodes.PDFHighlight, 'PdfId'),
    shiftedBy: dy,
  };
  console.log('[HighlightProbe] Created copy', readBack);

  try {
    await copy.scrollToReaderHighlight();
  } catch (e) {
    console.warn('[HighlightProbe] scrollToReaderHighlight failed:', e);
  }

  await plugin.app.toast(
    readBack.hasPowerup && readBack.data
      ? `🧪 Probe highlight created ${dy > 0 ? 'below' : 'above'} the original, in blue. Check the PDF, then delete the "🧪 Probe copy" Rem.`
      : '🧪 Probe Rem created, but the highlight data did not stick — see the console.'
  );
}
