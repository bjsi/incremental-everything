import {
  RICH_TEXT_FORMATTING,
  RichTextInterface,
  RichTextElementInterface,
} from '@remnote/plugin-sdk';

/**
 * Sanitize a RichTextInterface array so that every element conforms strictly to
 * the shapes accepted by RemNote's cross-sandbox rich-text validator (used by
 * both `rem.setText()` and `editor.insertRichText()`).
 *
 * When copying rich text that contains images (e.g. a PDF-highlight rem, or any
 * rem whose text embeds an image), the internal representation may carry
 * extra/internal properties — most notably an out-of-range image `percent` — that
 * the validator rejects with "Invalid input", throwing the whole call. This
 * normalizes each element down to a valid shape while preserving fidelity
 * (including image crop data) so the copied content renders identically.
 */
export const sanitizeRichTextForSetText = (richText: RichTextInterface): RichTextInterface => {
  return richText.map((element): RichTextElementInterface => {
    // Plain strings pass through as-is
    if (typeof element === 'string') return element;

    const el = element as any;
    switch (el.i) {
      case 'm': {
        // RichTextElementTextInterface
        const clean: any = { i: 'm', text: el.text ?? '' };
        // Drive the formatting allowlist from the SDK enum so new formatting
        // types (sup/sub/str/clozes/links/code-language/hints/…) don't get
        // silently stripped during highlight → IncRem inheritance.
        const textKeys = [
          'workInProgressTag', 'workInProgressRem', 'workInProgressPortal',
          'block', 'title',
          ...Object.values(RICH_TEXT_FORMATTING),
        ];
        for (const k of textKeys) {
          if (k in el) clean[k] = el[k];
        }
        return clean;
      }

      case 'q': {
        // RichTextElementRemInterface
        const clean: any = { i: 'q', _id: el._id };
        if (el.aliasId !== undefined) clean.aliasId = el.aliasId;
        if (el.pin !== undefined) clean.pin = el.pin;
        if (el.content !== undefined) clean.content = el.content;
        if (el.textOfDeletedRem !== undefined) {
          clean.textOfDeletedRem = sanitizeRichTextForSetText(el.textOfDeletedRem);
        }
        if ('cloze' in el) clean.cloze = el.cloze;
        return clean;
      }

      case 'i': {
        // RichTextImageInterface — this is the key culprit for PDF highlights with images.
        //
        // Passthrough (denylist), NOT allowlist: we shallow-copy EVERY property on the
        // source image element and then only fix the handful that the cross-sandbox
        // `setText` validator actually rejects. An earlier allowlist rebuilt the element
        // from a fixed set of known keys, which silently dropped any field the public SDK
        // types don't model — most importantly RemNote's image *crop* data, which lives in
        // `drawingData.bounds.crop` ({ x, y, width, height } in full-image coordinates).
        // That crop rect is what defines the visible region's aspect ratio; dropping it
        // while keeping the top-level width/height makes RemNote squeeze the full uncropped
        // image into that box, distorting the aspect ratio. Preserving unknown fields keeps
        // the copied image pixel-identical to the source.
        const clean: any = { ...el, i: 'i', url: el.url };
        // width/height are passed through untouched. RemNote itself persists these as
        // floats (e.g. 385.576) and keeps top-level width/height exactly equal to
        // drawingData.bounds.width/height; rounding only the top-level values would break
        // that invariant and nudge the display box off the crop. Floats are proven valid
        // (they round-trip through the same setText validator inside drawingData), so we
        // keep them verbatim for pixel-perfect fidelity.
        // percent: SDK only allows 5 | 25 | 50 | 100. The PDF engine sometimes stores
        // the highlight's area percentage (e.g. 68.08…) which the validator rejects.
        // Drop it entirely when out of range rather than passing the bad value through.
        const VALID_PERCENTS = new Set([5, 25, 50, 100]);
        if (el.percent !== undefined && !VALID_PERCENTS.has(el.percent)) {
          delete clean.percent;
        }
        // Recursively sanitize nested rich text so it, too, conforms to setText's shapes.
        if (el.label !== undefined) clean.label = sanitizeRichTextForSetText(el.label);
        if (el.frontLabel !== undefined) clean.frontLabel = sanitizeRichTextForSetText(el.frontLabel);
        return clean;
      }

      case 'a': {
        // RichTextAudioInterface
        const clean: any = { i: 'a', url: el.url };
        if (el.onlyAudio !== undefined) clean.onlyAudio = el.onlyAudio;
        if (el.width !== undefined) clean.width = el.width;
        if (el.height !== undefined) clean.height = el.height;
        if (el.percent !== undefined) clean.percent = el.percent;
        return clean;
      }

      case 'p': {
        // RichTextPluginInterface
        const clean: any = { i: 'p', url: el.url };
        if (el.pluginName !== undefined) clean.pluginName = el.pluginName;
        return clean;
      }

      default:
        // For any other element types (latex 'x', card delimiter 's', annotations, etc.)
        // pass through as-is — they rarely appear in PDF highlights.
        return el;
    }
  });
};
