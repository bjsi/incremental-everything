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
- **PDF Text Reader view**: converting a PDF adds a Link powerup `b` to the PDF Rem itself (`FileURL` = the full S3 URL of an `.html`), plus `ShouldOpenInTextReader = "true"`, which is **never cleared**. So a plugin cannot tell which view is on screen. Text Reader highlights are ordinary HTML highlights under the PDF's Highlights container, next to the Page Rems of the PDF view. They carry no page position. The flag is not always there: some PDFs converted in August 2025 got the Link powerup without it, which breaks clicks on them (see the next section).

## Clicking a converted PDF in the Sources list

Established on 9 November 2026 by comparing working and failing Rems in the main KB's `remnote.db`, reading the click handlers in the RemNote 1.29.8-beta bundle, and testing in the app.

**The Link handler goes first.** A source click (and any reference click) goes to `tk(event, rem, ctx, …)`. It walks `U5(rem)`, which is the keys of `rem.apu` with `v === true` followed by tag powerups, and the first `onClickReferenceToRem` that returns true handles the click. On converted PDFs the Link powerup `b` takes it ahead of the PDF powerup `f` (UploadedFile). On disk `apu` lists `b` before `f` on every converted PDF checked, and both symptoms below match that order.

```js
// Link powerup (b)
async onClickReferenceToRem(e, rem, ctx, flag) {
  if (e.shiftKey || rem.getPowerupProperty("b", ShouldOpenInTextReader))
    return openRem(rem, ctx.focusId, { forceOtherPane: e.shiftKey, fromDocumentSourcePill: false }), true;
  if (flag) return false;
  const url = rem.getPowerupProperty("b", URL);           // slot `u`
  url ? openLink(url, rem.owner) : toast("Missing URL");
  return true;
}
// PDF powerup (f)
onClickReferenceToRem: async (e, rem, ctx) =>
  !e.ctrlKey && (openReader(rem, ctx.focusId, { forceOtherPane: e.shiftKey, fromDocumentSourcePill: ctx.fromDocumentSourcePill ?? false }), true)
```

This causes two symptoms:

- **"Missing URL" toast.** It appears when the Rem has `b` but no `ShouldOpenInTextReader` (`ps.b_s` / `bpc.b.s` absent, and no `b_s_*` entry in `psh`). A converted PDF stores only `FileURL` (`b.f`), never `URL` (`b.u`), so the link branch has nothing to open. Opening the Text Reader once writes `b.s = "true"` and ends the toast. Rems that were never converted (no `b` in `apu`) are not affected.
- **The PDF replaces the document instead of opening beside it.** Once `b.s` is set, every plain click goes through the Link branch. That branch hard-codes `fromDocumentSourcePill: false`, so the PDF opens in the current pane and closes the notes document. The PDF handler passes `ctx.fromDocumentSourcePill` through, which gives the paired side pane. Every converted PDF behaves this way, including ones that were converted cleanly with the flag set. Switching back to the PDF view doesn't change it, because `b.s` is never cleared. Clearing it wouldn't help either: the click would fall back to "Missing URL".

**Workaround: Shift+click the source.** Shift takes the first branch with `forceOtherPane: true`, so the PDF opens in the other pane next to the document, whether or not `b.s` is set. A plugin can't fix this. Both handlers are host code, and removing the Link powerup is programmatic-only (`onlyProgrammaticTagging`) and would also drop the Text Reader copy.

## Reader zoom steps

The PDF reader (the `PDFWebReader` embed, drawn by the drawing canvas) changed its zoom buttons in RemNote 1.28.48 (October 2026). In 1.28.45 `zoomIn`/`zoomOut` added or removed 0.25. In 1.28.48 they snap to the next preset in `[0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8]`, with an animated transition, so one click goes from 100% straight to 200%. The `⌘+` / `⌘−` shortcuts use the same steps. Zooming with Cmd, Ctrl or Option held while scrolling (or pinching) is still continuous.

The SDK's `PDFWebReader` component takes no zoom props, and the toolbar is a host layer above the plugin iframe, so a plugin cannot change the steps.

## The Highlights tab is gone from the queue

The right sidebar's Highlights, Summary, Contents and Learn PDF tabs no longer appear for a PDF on the Flashcards routes, so they are missing beside a PDF IncRem in the queue. Read in the bundle of RemNote 1.29.1 in November 2026, not run.

`tt()` in the right-sidebar module starts from the open learning page and drops it for a PDF outside a document route:

```js
g = getOpenLearningPage()
f = g?.pdf && (!isDocumentRoute() || (isPhone() && isInteractiveLearnPane())) ? undefined : g
T = !!f && (a ?? hasHighlights(f))     // T && { tabId: "Highlights", ... }
```

`isDocumentRoute` (`Sl`) accepts only `Document.show`, `Document.showTwo`, `WithTabIdDocumentTree.show`, `WithoutTabIdDocumentTree.show` and `PublishedDocument.show`. The gate tests `g.pdf` only, so by this code a web article, video or recording in the queue keeps the tab.

The gate is absent in 1.28.45 (October 11, 2026) and present from 1.28.46 (October 12, 2026). Older builds download from `https://download2.remnote.io/remnote-desktop2/RemNote-<ver>-beta-arm64-mac.zip`.

**A plugin cannot force the tab.** The check runs in the host against `FlowRouter`, the iframe has an opaque origin, and the marketplace rejects `requestNative`. `openRightSidebar("Highlights")` only searches the same `tt()` list. A queue on a document route means a `<Queue>` embed, which hard-codes `inArticle` and so shows no plugin widgets. A plugin `RightSidebar` widget can show the same Rems: the container is the PDF's direct child named "Highlights" (see above).
