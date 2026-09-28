import { BuiltInPowerupCodes, PluginRem, ReactRNPlugin, RichTextInterface } from '@remnote/plugin-sdk';
import {
  isAreaHighlight,
  MergeSide,
  mergeAreaIntoText,
  pagesOf,
  pickContainedHighlights,
  pickMergeTarget,
} from './ai_ocr_merge';
import { CARD_PRIORITY_CODE } from './card_priority/types';
import {
  dismissedPowerupCode,
  hasImagePowerupCode,
  pdfAreaHighlightPowerupCode,
  powerupCode,
  preservedHistoryPowerupCode,
} from './consts';
import { BAND_COUNT, bandPowerupCode } from './priority_bands';
import { convertRichText } from './markup_to_richtext';
import { getAllIncrementsForPDF, getPdfInfoFromHighlight } from './pdfUtils';
import { readRawPdfState, repointBookmarksInState, writeRawPdfState } from './pdf_state';

/**
 * AI transcription of a PDF highlight (prototype).
 *
 * RemNote's highlight text is the PDF's raw text layer: missing spaces, no
 * formulae. The plugin cannot start the user's AI CLI itself (sandboxed
 * iframe), so it sends the highlight's position to a local helper
 * (scripts/ai_ocr_helper.py), which renders exactly that region, runs
 * `claude -p` on the user's own subscription and returns markup. The markup is
 * turned into rich text here and replaces the highlight's text.
 */

export const AI_OCR_HELPER_URL = 'http://localhost:3457';
const backupKey = (remId: string) => `ai-ocr-backup:${remId}`;

/** Markup -> rich text. Formulae holding \tag are forced to block, since KaTeX
 *  renders \tag only in display mode. */
export const markupToRichText = (markup: string): RichTextInterface => {
  const converted = convertRichText([markup] as RichTextInterface) ?? [markup];
  return (converted as any[]).map((node) =>
    node?.i === 'x' && node.text.includes('\\tag') ? { ...node, block: true } : node
  ) as RichTextInterface;
};

const parseData = (raw: unknown): any => {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return undefined;
  }
};

/** Sends a highlight region to the helper; toasts and returns undefined on failure.
 *  `extend`: the region runs past the raw text on that side (a merged area). */
async function requestTranscription(
  plugin: ReactRNPlugin,
  req: { remId: string; pdfUrl: unknown; data: unknown; rawText: string; extend?: MergeSide }
): Promise<{ markup: string; ms: number } | undefined> {
  await plugin.app.toast('✨ Transcribing highlight with AI…');
  let body: any;
  try {
    const res = await fetch(`${AI_OCR_HELPER_URL}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // kbId: the helper looks for the PDF's local copy only in this knowledge base's folder.
      body: JSON.stringify({ ...req, kbId: (await plugin.kb.getCurrentKnowledgeBaseData())?._id }),
    });
    body = await res.json();
  } catch (e) {
    console.error('[AI-OCR] Helper unreachable:', e);
    await plugin.app.toast(`AI helper is not running (${AI_OCR_HELPER_URL}). Start scripts/ai_ocr_helper.py.`);
    return undefined;
  }
  if (!body?.ok || !body.markup) {
    console.error('[AI-OCR] Transcription failed:', body);
    await plugin.app.toast(`AI transcription failed: ${body?.error ?? 'empty result'}`);
    return undefined;
  }
  return { markup: body.markup, ms: body.ms };
}

export async function aiTranscribeHighlight(plugin: ReactRNPlugin, remId: string): Promise<boolean> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem || !(await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight))) {
    await plugin.app.toast('Not a PDF highlight — focus a highlight Rem or use its toolbar.');
    return false;
  }

  const data = await rem.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data');
  if (!data) {
    await plugin.app.toast('This highlight has no position data (PDF Text Reader highlights are not supported).');
    return false;
  }

  const { pdfRemId } = await getPdfInfoFromHighlight(plugin as any, rem);
  const host = pdfRemId ? await plugin.rem.findOne(pdfRemId) : undefined;
  const pdfUrl = host ? await host.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL') : '';

  const area = parseData(data);
  if (isAreaHighlight(area)) {
    const merge = await findMergeTarget(plugin, rem, area);
    if (merge) return mergeAndTranscribe(plugin, { area: rem, areaData: area, ...merge, pdfUrl, pdfRemId });
  }

  const original = (rem.text ?? []) as RichTextInterface;
  const rawText = await plugin.richText.toString(original);
  const result = await requestTranscription(plugin, { remId, pdfUrl, data, rawText });
  if (!result) return false;

  // The model takes seconds; if the user edited the highlight meanwhile, keep their edit.
  const fresh = await plugin.rem.findOne(remId);
  if (!fresh || JSON.stringify(fresh.text ?? []) !== JSON.stringify(original)) {
    await plugin.app.toast('The highlight changed while the AI was working — not overwriting it.');
    return false;
  }

  await plugin.storage.setLocal(backupKey(remId), original);
  await fresh.setText(markupToRichText(result.markup));
  const absorbed = await absorbContainedHighlights(plugin, fresh, parseData(data), pdfRemId);
  await plugin.app.toast(`✨ Highlight transcribed in ${(result.ms / 1000).toFixed(1)}s${absorbedNote(absorbed)}`);
  return true;
}

const absorbedNote = (n: number) =>
  n ? ` — merged the ${n === 1 ? 'highlight' : `${n} highlights`} it contains` : '';

/** The text highlight on the same page that an area highlight sits right above or below. */
async function findMergeTarget(plugin: ReactRNPlugin, area: PluginRem, areaData: any) {
  const siblings = (await (await area.getParentRem())?.getChildrenRem()) ?? [];
  const candidates: { rem: PluginRem; data: any }[] = [];
  for (const sibling of siblings) {
    if (sibling._id === area._id || !(await sibling.hasPowerup(BuiltInPowerupCodes.PDFHighlight))) continue;
    const data = parseData(await sibling.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data'));
    if (data) candidates.push({ rem: sibling, data });
  }
  const picked = pickMergeTarget(areaData, candidates);
  return picked && { target: picked.target.rem, targetData: picked.target.data, side: picked.side };
}

/**
 * Area highlight next to a text highlight: the area covers what the text layer
 * missed. The area's box becomes one more rect of the text highlight, the combined
 * region is transcribed into the text highlight, and the area Rem is deleted
 * (its children move over first). Nothing changes if the transcription fails.
 */
async function mergeAndTranscribe(
  plugin: ReactRNPlugin,
  opts: {
    area: PluginRem;
    areaData: any;
    target: PluginRem;
    targetData: any;
    side: MergeSide;
    pdfUrl: unknown;
    pdfRemId?: string | null;
  }
): Promise<boolean> {
  const { area, target } = opts;
  const merged = mergeAreaIntoText(opts.targetData, opts.areaData);
  const original = (target.text ?? []) as RichTextInterface;
  const rawText = await plugin.richText.toString(original);

  const result = await requestTranscription(plugin, {
    remId: target._id,
    pdfUrl: opts.pdfUrl,
    data: merged,
    rawText,
    extend: opts.side,
  });
  if (!result) return false;

  const fresh = await plugin.rem.findOne(target._id);
  const areaStill = await plugin.rem.findOne(area._id);
  if (!fresh || !areaStill || JSON.stringify(fresh.text ?? []) !== JSON.stringify(original)) {
    await plugin.app.toast('A highlight changed while the AI was working — not merging.');
    return false;
  }

  await plugin.storage.setLocal(backupKey(target._id), original);
  await fresh.setText(markupToRichText(result.markup));
  await fresh.setPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data', [JSON.stringify(merged)]);
  for (const child of (await areaStill.getChildrenRem()) ?? []) await child.setParent(fresh._id);
  await areaStill.remove();
  const absorbed = await absorbContainedHighlights(plugin, fresh, merged, opts.pdfRemId);
  await plugin.app.toast(
    `✨ Area merged into the text highlight ${opts.side === 'below' ? 'above' : 'below'} it and transcribed in ${(result.ms / 1000).toFixed(1)}s${absorbedNote(absorbed)}`
  );
  return true;
}

/** Page highlights on the given pages: children of the PDF's "Page NNN" Rems. */
async function highlightsOnPages(plugin: ReactRNPlugin, highlight: PluginRem, pages: number[]) {
  const pageRem = await highlight.getParentRem();
  const container = await pageRem?.getParentRem();
  const pageRems = [];
  for (const candidate of (await container?.getChildrenRem()) ?? []) {
    const number = Number((await plugin.richText.toString(candidate.text ?? [])).match(/(\d+)\s*$/)?.[1]);
    if (pages.includes(number)) pageRems.push(candidate);
  }
  if (pageRem && !pageRems.some((r) => r._id === pageRem._id)) pageRems.push(pageRem);

  const found: { rem: PluginRem; data: any }[] = [];
  for (const page of pageRems) {
    for (const rem of (await page.getChildrenRem()) ?? []) {
      if (rem._id === highlight._id || !(await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight))) continue;
      const data = parseData(await rem.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data'));
      if (data) found.push({ rem, data });
    }
  }
  return found;
}

/** Tags derived from a highlight's state, recomputed by the plugin: never carried over. */
const DERIVED_POWERUPS = [
  hasImagePowerupCode,
  pdfAreaHighlightPowerupCode,
  ...Array.from({ length: BAND_COUNT }, (_, band) => bandPowerupCode(band)),
];
/** Plugin state the larger highlight keeps when both have it; otherwise it moves over. */
const KEPT_BY_LARGER = [powerupCode, CARD_PRIORITY_CODE, dismissedPowerupCode, preservedHistoryPowerupCode];

/**
 * Highlights lying inside `outer` (made earlier over part of the same passage) are
 * merged into it with RemNote's own merge, which repoints every reference, pin,
 * inline link, tag, source and portal inclusion to `outer` in the same shape, moves
 * children, aliases and cards (with their history), then deletes the merged Rem.
 *
 * Merge also copies every powerup slot of the merged Rem onto the kept one, so the
 * inner highlight first loses what must not overwrite `outer`: its PDF Highlight
 * powerup (Data, PdfId), the derived tags, and plugin state `outer` already has.
 */
async function absorbContainedHighlights(
  plugin: ReactRNPlugin,
  outer: PluginRem,
  outerData: any,
  pdfRemId: string | null | undefined
) {
  // An area highlight's text reverts to an image when its rectangle is resized: never a merge target.
  if (!outerData || isAreaHighlight(outerData)) return 0;
  const inner = pickContainedHighlights(outerData, await highlightsOnPages(plugin, outer, pagesOf(outerData)));
  const moved: Record<string, string> = {};
  for (const { rem } of inner) {
    try {
      if (await mergeHighlightInto(plugin, outer, rem)) moved[rem._id] = outer._id;
    } catch (e) {
      console.error('[AI-OCR] Merging a contained highlight failed:', rem._id, e);
    }
  }
  const merged = Object.keys(moved).length;
  if (merged && pdfRemId) await repointBookmarks(plugin, pdfRemId, outer._id, moved);
  return merged;
}

/**
 * Bookmarks are page-history entries holding a highlight id, inside the PDF state
 * of an Incremental or Dismissed Rem: plain JSON that RemNote's merge cannot see.
 * The hosts are the Rems reading this PDF (as the bookmark popup finds them), the
 * PDF itself, and the outer highlight, which inherits a merged highlight's own
 * Incremental state when it had none.
 */
async function repointBookmarks(plugin: ReactRNPlugin, pdfRemId: string, outerId: string, moved: Record<string, string>) {
  const hostIds = new Set([pdfRemId, outerId]);
  for (const entry of await getAllIncrementsForPDF(plugin as any, pdfRemId)) hostIds.add(entry.remId);
  for (const id of hostIds) {
    const host = await plugin.rem.findOne(id);
    if (!host) continue;
    for (const powerup of [powerupCode, dismissedPowerupCode]) {
      if (!(await host.hasPowerup(powerup))) continue;
      const repointed = repointBookmarksInState(await readRawPdfState(host, powerup), moved);
      if (repointed) {
        await writeRawPdfState(host, powerup, repointed);
        console.log('[AI-OCR] Moved bookmark(s) to the merged highlight on', id);
      }
    }
  }
}

async function mergeHighlightInto(plugin: ReactRNPlugin, outer: PluginRem, inner: PluginRem): Promise<boolean> {
  const code = BuiltInPowerupCodes.PDFHighlight;
  const data = await outer.getPowerupProperty(code, 'Data');
  const pdfId = await outer.getPowerupPropertyAsRichText(code, 'PdfId');
  const color = await outer.getHighlightColor();

  await inner.removePowerup(code);
  for (const powerup of DERIVED_POWERUPS) if (await inner.hasPowerup(powerup)) await inner.removePowerup(powerup);
  for (const powerup of KEPT_BY_LARGER) {
    if ((await inner.hasPowerup(powerup)) && (await outer.hasPowerup(powerup))) await inner.removePowerup(powerup);
  }

  await outer.merge(inner._id);

  // Belt and braces: the outer highlight's own position, PDF and colour must survive.
  if ((await outer.getPowerupProperty(code, 'Data')) !== data) await outer.setPowerupProperty(code, 'Data', [data]);
  if (JSON.stringify(await outer.getPowerupPropertyAsRichText(code, 'PdfId')) !== JSON.stringify(pdfId)) {
    await outer.setPowerupProperty(code, 'PdfId', pdfId);
  }
  if (color && (await outer.getHighlightColor()) !== color) await outer.setHighlightColor(color as any);
  return !(await plugin.rem.findOne(inner._id));
}

/** Put back the text a transcription replaced (kept per rem, on this device). */
export async function restoreHighlightBeforeAi(plugin: ReactRNPlugin, remId: string): Promise<boolean> {
  const backup = await plugin.storage.getLocal<RichTextInterface>(backupKey(remId));
  const rem = await plugin.rem.findOne(remId);
  if (!backup || !rem) {
    await plugin.app.toast('No pre-AI text saved for this Rem on this device.');
    return false;
  }
  await rem.setText(backup);
  await plugin.storage.setLocal(backupKey(remId), undefined);
  await plugin.app.toast('Restored the highlight text from before the AI transcription.');
  return true;
}
