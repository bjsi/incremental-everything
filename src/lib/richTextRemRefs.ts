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
 * Flatten a rem's rich text into a single plain string, resolving rem references
 * (and pins) to the referenced rem's text. Unlike `plugin.richText.toString()`
 * (and `safeRemTextToString`, which wraps it), this does NOT drop rem-reference
 * elements — a rem whose text is just a reference (e.g. a `Decks In — [Vocabulary]`
 * slot value) resolves to the referenced text instead of "Untitled". Normal refs
 * are shown wrapped in `[ ]`; pins contribute their referenced text. Returns
 * 'Untitled' only when genuinely empty.
 */
export async function resolveRemTextToString(
  plugin: RNPlugin,
  richText: unknown
): Promise<string> {
  const segments = await resolveRemTextSegments(plugin, richText);
  const text = segments.map((s) => s.text).join('').trim();
  return text || 'Untitled';
}

/**
 * Resolve a rem's rich text into a compact single-line string for breadcrumbs /
 * ancestor labels. Builds on {@link resolveRemTextSegments}, so it shares the
 * reference-vs-pin distinction: normal rem references are shown as their text
 * wrapped in `[ ]`, but a *reference pin* is collapsed to a small 📌 marker
 * instead of being expanded into the (often huge) referenced rem's text. This is
 * what keeps an extract whose title carries a pin (e.g. "Agulhas magnéticas 📌")
 * from dumping the entire referenced rem into the breadcrumb. Returns 'Untitled'
 * only when genuinely empty.
 */
export async function resolveRemTextForBreadcrumb(
  plugin: RNPlugin,
  richText: unknown
): Promise<string> {
  const segments = await resolveRemTextSegments(plugin, richText);
  const text = segments
    .map((s) => (s.kind === 'pin' ? '📌' : s.text))
    .join('')
    .trim();
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
