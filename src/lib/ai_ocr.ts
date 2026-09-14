import { BuiltInPowerupCodes, ReactRNPlugin, RichTextInterface } from '@remnote/plugin-sdk';
import { convertRichText } from './markup_to_richtext';
import { getPdfInfoFromHighlight } from './pdfUtils';

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

  const original = (rem.text ?? []) as RichTextInterface;
  const rawText = await plugin.richText.toString(original);

  await plugin.app.toast('✨ Transcribing highlight with AI…');
  let body: any;
  try {
    const res = await fetch(`${AI_OCR_HELPER_URL}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remId, pdfUrl, data, rawText }),
    });
    body = await res.json();
  } catch (e) {
    console.error('[AI-OCR] Helper unreachable:', e);
    await plugin.app.toast(`AI helper is not running (${AI_OCR_HELPER_URL}). Start scripts/ai_ocr_helper.py.`);
    return false;
  }
  if (!body?.ok || !body.markup) {
    console.error('[AI-OCR] Transcription failed:', body);
    await plugin.app.toast(`AI transcription failed: ${body?.error ?? 'empty result'}`);
    return false;
  }

  // The model takes seconds; if the user edited the highlight meanwhile, keep their edit.
  const fresh = await plugin.rem.findOne(remId);
  if (!fresh || JSON.stringify(fresh.text ?? []) !== JSON.stringify(original)) {
    await plugin.app.toast('The highlight changed while the AI was working — not overwriting it.');
    return false;
  }

  await plugin.storage.setLocal(backupKey(remId), original);
  await fresh.setText(markupToRichText(body.markup));
  await plugin.app.toast(`✨ Highlight transcribed in ${(body.ms / 1000).toFixed(1)}s`);
  return true;
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
