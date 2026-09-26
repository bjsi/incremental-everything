# PDF and web-article highlights

What a highlight Rem holds, how RemNote creates and draws one, and what a plugin can and cannot change. Read from `app.asar` and real data in September 2026, while building AI Transcribe (`src/lib/ai_ocr.ts`, `scripts/ai_ocr_helper.py`) and Source Pins (`src/lib/pdf_source_pins/`). See also [REM_REFERENCES_AND_MERGE.md](REM_REFERENCES_AND_MERGE.md) for merging highlights.

## PDF highlight Rems

A PDF highlight is a Rem with the **PDF Highlight** powerup (`n`) and two slots:

- **`Data`**: a JSON string:

    ```json
    {
      "content": { "text": "…", "textBefore": "…", "textAfter": "…" },
      "position": {
        "boundingRect": { "x1": 0, "y1": 0, "x2": 0, "y2": 0, "width": 580.32, "height": 837.24, "pageNumber": 57 },
        "rects": [ { "x1": 0, "y1": 0, "x2": 0, "y2": 0, "width": 580.32, "height": 837.24, "pageNumber": 57 } ],
        "pageNumber": 57
      },
      "id": "2686446911712237",
      "temp": false
    }
    ```

    Every rect carries its own `width`/`height`, the size of the page viewport it was measured in (the PDF page size in points, at scale 1). Divide by them to get page fractions, independent of zoom. A text highlight has many `rects`, roughly one per word or line, and they may span pages.
- **`PdfId`**: a reference to the PDF Rem (`[{i:'q', _id}]`).

Highlights sit under the PDF's **Highlights** container, grouped under one **"Page NNN"** Rem per page. The Rem's own text is the highlighted text (or the image, for an area highlight).

The PDF Rem's `UploadedFile` `URL` is `%LOCAL_FILE%<name>`: a placeholder for `https://remnote-user-data.s3.amazonaws.com/<name>`, which is publicly fetchable. The desktop copy is `~/remnote/remnote-<kbId>/files/<name>`, one folder per knowledge base.

As of Sep 2026 some PDFs hand the plugin a second form instead: `local://` followed by the URL-encoded absolute path of that desktop copy (`local://%2FUsers%2F…%2Fremnote-<kbId>%2Ffiles%2F<name>.pdf`), seen from both the dev and the marketplace build. Take the file name from it and resolve as for the placeholder; `scripts/ai_ocr_helper.py` `fetch()` does.

## Text highlights vs area highlights

Both use the same powerup and the same two slots. The difference is what they hold:

| | Text highlight | Area highlight |
|---|---|---|
| Rem text | the PDF's text layer | a single image element |
| `Data.content` | `text`, `textBefore`, `textAfter` | `imageUrl` (the uploaded snapshot) |
| `Data.position.rects` | one box per word/line | empty; `boundingRect` is the area |

RemNote decides between them in **two different places**:

- **The PDF viewer looks at `Data.content.imageUrl`.** With it, the highlight is drawn as a resizable rectangle (a `pdf_area_highlight` drawing item on the canvas). Without it, the text-highlight renderer draws each rect.
- **The highlight popup looks at the Rem's text.** If it starts with an image, the popup offers *Copy Image as Text With AI* (RemNote's own OCR) and *Make Image Occlusion Flashcards*. Otherwise it offers Explain, AI card suggestions and *Copy as Plain Text*.

So an area highlight whose text was replaced (e.g. by AI Transcribe) stays a rectangle in the PDF, while its Rem and popup behave like a text highlight.

**Resizing or moving an area rectangle re-screenshots it** (`recomputeImagesForAreaHighlights` → `fillOutImageHighlight`) and **overwrites the Rem's text with the new image**. Any transcription is lost.

**Never remove `imageUrl` from a live area highlight.** Tried in September 2026 to turn one into a text highlight: RemNote's `syncAreaHighlightsWithRems` dropped the rectangle, and deleting that drawing item deleted the highlight Rem 175 ms later. To extend a text highlight with an area, add the area's box to the text highlight's `rects` and delete the area Rem (what AI Transcribe's area merge does). Extra hand-made rects on a text highlight draw correctly.

## Creating a highlight from a plugin

RemNote's `createHighlightOnPDFRem`:
1. creates a Rem and sets `Data` (with a random numeric `id`) and `PdfId`;
2. sets the highlight colour, and the key to the text;
3. parents it under the "Page NNN" Rem, creating that Rem if needed;
4. calls an internal `addToPortal("pdfHighlight", pdfRem)`.

The last step has no SDK equivalent, **and it is not needed**. A Rem built by a plugin (createRem → setText → setParent under the Page Rem → addPowerup `n` → set `Data` and `PdfId` → setHighlightColor) renders at its position immediately, lists in the Highlights panel, syncs, and pins to it jump to the passage. `createPdfHighlight` in `src/lib/pdf_highlight_create.ts` does this.

## The Highlights container

Since RemNote's mid-2026 storage overhaul, the **Highlights** container (a direct child of the PDF Rem) carries no tag, no powerup other than `AutoSort` and no property marker. All 46 `BuiltInPowerupCodes` were probed on it. The PDF Rem itself also carries `AutoSort`, which is normal. **The only reliable identity is `text === "Highlights"` and being a direct child of the PDF Rem.** That is English-specific: a localized RemNote would name it differently. The Repair PDF tool in `src/widgets/debug.tsx` relies on this.

## AI Tutor citations

The AI Tutor's "P78" citation chips **store no coordinates**. A citation is the source sentence's text. Clicking one:
1. finds the page by exact match, or by Levenshtein distance within ±20 pages;
2. matches the sentence against that page's text boxes;
3. creates a **temporary** highlight, removed after 2 seconds.

None of it is in the SDK.

## Web-article highlights

- **Source Rem**: Link powerup `b`, slot `FileURL` = `%LOCAL_FILE%<name>.html` (readability output).
- **Highlight Rem**: HTML Highlight powerup `hh`. `Data` is `{startXPath, endXPath, startOffset, endOffset, text, textBefore, textAfter}`, and `HTMLId` references the source Rem. It is parented **directly** under the source's "Highlights" child, with no Page Rems. RemNote also calls an internal `addToPortal("htmlHighlight", …)`.
- **The XPath root** is the viewer's `<div>`, mounted as follows: `<inline_math>`/`<block_math>` replaced with `katex.renderToString`, then `DOMPurify.sanitize` (default config), then `dangerouslySetInnerHTML`. Each XPath step is `nodeName.toLowerCase()` (`#text` → `text()`) plus `[n]`, counting previous siblings with the same name, itself included. Resolve with `document.evaluate('.' + xpath, root)`. `src/lib/pdf_source_pins/html.ts` reproduces it.
- **PDF Text Reader view**: converting a PDF adds a Link powerup `b` to the PDF Rem itself (`FileURL` = the full S3 URL of an `.html`), plus `ShouldOpenInTextReader = "true"`, which is **never cleared**. So a plugin cannot tell which view is on screen. Text Reader highlights are ordinary HTML highlights under the PDF's Highlights container, next to the Page Rems of the PDF view. They carry no page position.
