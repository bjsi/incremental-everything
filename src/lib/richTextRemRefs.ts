import { RNPlugin, RichTextElementRemInterface } from '@remnote/plugin-sdk';

export type RemTextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'pin'; text: string };

const isRemRef = (el: unknown): el is RichTextElementRemInterface =>
  el != null && typeof el === 'object' && (el as any).i === 'q';

/** Resolve a rem-reference element to the plain text of the rem it points at. */
async function resolveRefText(plugin: RNPlugin, el: RichTextElementRemInterface): Promise<string> {
  let text = '';
  try {
    text = (await plugin.richText.toString([el])).trim();
  } catch {
    /* fall through to direct lookup */
  }
  if (!text) {
    try {
      const refRem = await plugin.rem.findOne(el._id);
      if (refRem?.text) text = (await plugin.richText.toString(refRem.text)).trim();
    } catch {
      /* ignore */
    }
  }
  return text || 'Untitled';
}

/**
 * Resolve a rem's rich text into lightweight display segments:
 *  - Plain text and normal rem references (text wrapped in `[ ]`) become `text` segments.
 *  - Pin references become `pin` segments carrying the referenced rem's text, so the
 *    renderer can show a pin icon with that text as a hover tooltip.
 *
 * This deliberately produces plain strings — no SDK `<RichText>` embed — so it stays
 * cheap enough to render thousands of rows. Formatting (bold, cloze, color, highlight)
 * is intentionally dropped.
 */
export async function resolveRemTextSegments(
  plugin: RNPlugin,
  richText: unknown
): Promise<RemTextSegment[]> {
  if (richText == null) return [];
  if (typeof richText === 'string') return [{ kind: 'text', text: richText }];
  if (!Array.isArray(richText)) return [];

  const segments: RemTextSegment[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = segments[segments.length - 1];
    if (last?.kind === 'text') last.text += t;
    else segments.push({ kind: 'text', text: t });
  };

  for (const el of richText) {
    if (typeof el === 'string') {
      pushText(el);
      continue;
    }
    if (isRemRef(el)) {
      const text = await resolveRefText(plugin, el);
      if (el.pin) segments.push({ kind: 'pin', text });
      else pushText(`[${text}]`);
      continue;
    }
    const anyEl = el as any;
    if (anyEl?.text) pushText(anyEl.text);
    else if (anyEl?.i === 'i') pushText('[Image]');
    else if (anyEl?.url) pushText('[Link]');
  }
  return segments;
}
