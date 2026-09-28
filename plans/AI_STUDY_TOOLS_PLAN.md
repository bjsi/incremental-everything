# AI Study Tools — plan and status

Maintainer notes, not published (the docs site is built from `docs/` only).

**Goal:** point the plugin at part of a source — pages, a chapter, the current IncRem's range, a web article — pick a prompt, and get summaries or Q&A written into RemNote with **source pins** to the exact passages, reviewed before anything is inserted.

## Done

| Piece | Where | Docs |
|---|---|---|
| Local helper (`scripts/ai_ocr_helper.py`, LaunchAgent) running `claude -p` on the user's subscription | helper `/ocr` | [AI Transcription](../docs/AI-Transcription-of-PDF-Highlights.md) |
| ✨ AI Transcribe for PDF highlights | `src/lib/ai_ocr.ts`, toolbar button, `ait` | same |
| Plugin-made PDF and HTML highlights | `src/lib/pdf_highlight_create.ts` | — |
| Source pins: find a quote, reuse or create highlights, never overlapping | helper `/locate`, `/source`, `/match`; `src/lib/pdf_source_pins/` | [Source Pins](../docs/Source-Pins.md) |
| Pin Source Quote (`psq`) for PDF page view, saved web articles, PDF Text Reader view (asks which view) | `pdf_source_pins/index.ts`, `pin_source_views_popup.tsx` | same |
| Source Highlight Colour setting; pin rings yellow (PDF page) / purple (HTML source) | `settings.ts`, `ui_helpers.ts` | same, [Colour Coding](../docs/Colour-Coding-Reference.md#reference-pin-rings) |
| Message dialog for failures (toasts can be swallowed) | `src/lib/message_dialog.ts`, `message_popup.tsx` | — |
| Create IncRem: Also Pin the Other PDF View (setting, off by default), tags `pdfextract` | `highlightActions.ts` (`pinOtherReaderView`) | [Source Pins](../docs/Source-Pins.md#create-increm-both-views) |

Entry point for every later phase: `ensureSourcePins(plugin, sourceRemId, quotes, views?)` — takes verbatim quotes (with an optional page hint for PDFs) and returns the highlight ids to pin, per quote and per view. `withPins(richText, ids)` appends them without duplicates.

## Decisions already made

- **Overlap rule:** highlights never overlap. Quote inside a highlight → reuse; ≥60 % covered → reuse only; partial → reuse + create uncovered stretches of ≥4 words; none → create.
- **Recipes** live in the RemNote document **AI Tutor Commands** (each child = name, its child = prompt body); the output type is marked **by tag** (Sentences / Q&A / Free).
- **Q&A:** question on the front, answer on the back, **pin on the back** (a pin's hover preview would reveal the answer on the front).
- **Colour:** one Source Highlight Colour for every view; pin rings distinguish PDF page from HTML source.
- **Review step always**, RemNote-flashcard-generator style: a checkbox per item, **Insert selected** and **Insert all**.
- **Text only by default**, with a **vision** switch (page images) for formula-heavy chapters.
- Popups are keyboard-driven (house pattern); failures go to the message dialog, success to a toast.

## Remaining

### Phase 2 — AI engine

- [ ] Helper `/extract`: a PDF page range as per-page text, and the PDF outline (`doc.get_toc()` — chapters and sections with their pages). HTML sources already have their text via `/source` + `parseArticle`.
- [ ] Helper `/run`: recipe prompt + source text → `claude -p --output-format json`. The plugin appends a fixed contract to the user's prompt: at most N items, most important first; every item cites 1–2 sentences **copied verbatim** from the given text, with the page; allowed markup (`**bold**`, `*italic*`, `$…$`, `$$…$$`); answer as JSON `{"items":[{"front","back","sources":[{"page","quote"}]}]}`. Validate; one retry on malformed JSON.
- [ ] Read recipes from **AI Tutor Commands** in the plugin, with their tag-based type.
- [ ] **Thin slice first:** one command that runs a recipe on the current IncRem's page range and inserts every item with pins, no review UI — to judge output quality on real books before building phase 3.

### Phase 3 — Popup, review, insert (Sentences)

- [ ] Popup: scope (page range / outline section / current IncRem range / whole article), recipe, max items, destination (reuse the hierarchical parent selector), vision switch.
- [ ] Progress and cancel for long runs.
- [ ] Review list: checkbox per item, editable text, source quote under each, Insert selected / Insert all.
- [ ] Insert Sentences: one Rem per item, markup → rich text (`convertRichText`), pins from one batched `ensureSourcePins` call. Quotes that cannot be located: ask the model once to correct them, else insert without a pin and flag the item.

### Phase 4 — Q&A and queue integration

- [ ] Q&A insert: `setText(front)` + `setBackText(back + pins)`.
- [ ] Default scope from the IncRem under review (queue and Editor Review).
- [ ] Vision mode: send page images (helper already renders crops for `/ocr`).

### Phase 5 — Docs

- [ ] Changelog entry, feature page, settings/commands references (per `DOCUMENTATION.md`), version bump.

## Risks and open questions

- **LLM reliability:** verbatim quotes and valid JSON are not guaranteed. Mitigated by locating every quote (fuzzy matcher, whole-document fallback) and validation — quality only becomes visible on real books.
- **Long scopes:** time and usage for a 30–50 page chapter via `claude -p` are unmeasured; may need chunking by section.
- **Text layers:** scanned PDFs have none (no pins possible); garbled layers only affect locating, not the generated text.
- **Two views:** decide whether generated pins go to the PDF view, the Text Reader view, or both (reuse the popup choice or the Create IncRem setting).

## RemNote facts this relies on

- PDF highlight `Data`: `{content:{text}, position:{boundingRect, rects[], pageNumber}, id, temp}`; rect coordinates are in a viewport whose size (`width`/`height`) is stored with them — the PDF's page size in points. Parent: the PDF's `Highlights` › `Page NNN` Rem (number padded to the page count's digits).
- HTML highlight `Data`: `{startXPath, endXPath, startOffset, endOffset, text, textBefore, textAfter}`, XPaths relative to the `<div>` the viewer mounts the article in (after `<inline_math>`/`<block_math>` → KaTeX and DOMPurify). Parent: `Highlights`, directly.
- A PDF's Text Reader version is a Link powerup (`FileURL`) on the same PDF Rem; its highlights are HTML highlights pointing at the PDF Rem.
- The `Highlights` container is identifiable only by name + being a direct child of the source; do not create it from the plugin (risk of duplicates).
- Anything reached from the index widget must be imported statically: lazily loaded webpack chunks break (`import.meta` banner in `webpack.config.js`).
- New widget files need `npm run dev` restarted (entries are globbed at startup).
