import { BuiltInPowerupCodes, ReactRNPlugin } from '@remnote/plugin-sdk';

/**
 * Create PDF and HTML highlight Rems from the plugin, mirroring RemNote's own
 * `createHighlightOnPDFRem` / `createHTMLHighlight` (read from the app bundle).
 *
 * RemNote's versions also call an internal `addToPortal(...)` the plugin SDK has
 * no equivalent for. It turned out not to matter: plugin-made highlights render
 * in the viewer, sync, and pins to them jump to the passage (verified 2026-09-13).
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

/**
 * A PDF highlight Rem: its text is the highlighted text, the PDFHighlight
 * powerup's `Data` slot holds `{ content: { text }, position, id, temp }` and its
 * `PdfId` slot points at the PDF, parented under the PDF's "Page NNN" Rem.
 */
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
