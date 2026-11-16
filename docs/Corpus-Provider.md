# Corpus Provider

A **corpus provider** is a program on your computer that knows your library: which books you have, where each passage sits in each book's outline, which RemNote PDF holds each book, and where your own notes for each section live. When one is set up, several features of the plugin use it. Without one, they behave exactly as before.

It generalises the [source finder](Source-Pins.md#no-source-open): a source finder is a corpus provider that offers one capability, `find-source`.

The plugin never sees your library. It asks the [AI helper](Desktop-Helpers.md#ai-helper) a question, and the helper runs your provider and passes the answer back. Everything stays on your computer, unless your provider itself calls an online service.

## What it is used for { #capabilities }

Each feature checks for its own **capability**. A provider offers only the capabilities it implements, and the others stay off.

| Capability | Used by | What the provider does |
|---|---|---|
| `find-source` | [Pin Source Quote](Source-Pins.md#no-source-open) with no source open | Names the book a quote comes from and the PDF Rems to try |
| `quote-literal` | Pin Source Quote, same path | Also gives, per book, the exact text to search for when the Rem's text was corrected and no longer matches the PDF letter for letter |
| `suggest-parent` | The [parent selector](Create-Incremental-Rem-from-PDF-Highlights.md#corpus-suggestion) | Names the Rem in your notes for the section the highlight comes from, so the selector can suggest it |

## Setting one up { #setup }

Name the provider's command in `~/.incremental-remnote/ai-ocr/corpus-provider.json`:

```json
{ "command": ["/usr/local/bin/python3", "~/my-library-index/provider.py"] }
```

or set the helper's `IR_CORPUS_PROVIDER` environment variable. The file is read on every request, so no restart is needed. A command ending in a `.py` file runs from that file's folder.

When there is no `corpus-provider.json`, the helper uses `source-finder.json` (or `IR_SOURCE_FINDER`) as a provider with the single capability `find-source`, sending it the request in the old form, without `op`. Source finders written before corpus providers existed keep working unchanged.

## The protocol { #protocol }

For each request, the helper starts the program, writes one JSON object to its standard input, and reads one JSON object from its standard output. Exit code 0 means success; anything else is reported as a failure, with the end of the program's error output. Every request carries `op`, the operation asked for.

### `status` { #op-status }

```json
{ "op": "status" }
```

```json
{ "name": "My library index", "version": "2026.11", "capabilities": ["find-source", "quote-literal", "suggest-parent"] }
```

The plugin asks for this once, keeps the answer for a minute, and turns features on or off from it. Answer quickly: do not open large files or call online services for `status`.

### `find-source` { #op-find-source }

The request and answer are those of [Writing a source finder](Source-Pins.md#writing-a-source-finder), plus `"op": "find-source"`. With the `quote-literal` capability, a book may also carry:

- `quote` (optional): the text to look for in that book's PDFs instead of the Rem's own. Use it when you know the Rem's text no longer matches the PDF word for word, for instance because a garbled word was corrected in the quote. The pin still goes on the Rem; only the search uses `quote`.

### `suggest-parent` { #op-suggest-parent }

Asked when the parent selector opens for a highlight (Create Incremental Rem or Extract). One item per highlight:

```json
{ "op": "suggest-parent",
  "items": [ { "remId": "HighlightRem", "sourceRemId": "PdfRem", "page": 51,
               "texts": ["At high speeds, an additional resistance component can arise…"],
               "ancestors": ["parent id", "grandparent id"] } ] }
```

- `sourceRemId`: the PDF or article the highlight is in.
- `page` (optional): the highlight's 1-based page in that PDF.
- `texts`: the highlight's text.

Answer, best first:

```json
{ "items": [ { "remId": "HighlightRem", "parents": [
    { "remId": "SectionRem", "path": ["Ship Resistance and Flow", "5 Inviscid Flow…", "5.6 Wave Breaking and Spray"],
      "confidence": "high", "how": "the highlight's text is in this section (p. 51)" } ] } ] }
```

- `remId` (required): a Rem in the user's knowledge base.
- `path` (optional): the breadcrumb, shown in the tooltip.
- `confidence`: `high` (the passage is mapped to the section through the book's own outline) or `medium` (a weaker match). Only `high` and `medium` are shown, and `medium` is marked as less sure.
- `how` (required): one line on how the provider knew, shown as is.

An empty `parents` list means "no suggestion". The plugin checks that the Rem still exists before showing it.

### Unknown operations { #unknown-op }

A provider that gets an `op` it does not implement should answer `{"error": "unsupported op"}` (exit 0) or exit with an error. The plugin only sends the operations listed under `capabilities`, so this happens only with a mismatch.

## In the plugin { #in-the-plugin }

- **Status:** the plugin asks for `status` at most once a minute (every 15 seconds while the helper or the provider is missing), shares the answer between its widgets, and never waits on it before showing anything.
- **Parent selector:** the provider's suggestion arrives after the list is shown.
  - **Its row:** a green tint and bar and a **📚 Suggested** label (*Suggested?* when the provider is less sure). The tooltip shows the breadcrumb and how the provider knew. The selected row always keeps the strongest look: its background, a blue bar and a blue frame.
  - **Jumping to it:** **📚 Suggested section** in the header, or `S`. A keyboard-key badge shows it, left of the row's arrow (right after the arrow on top-level rows, which have no room before it): `S` on the suggested row, `L` on the row `L` returns to.
  - **What it never does:** replace the remembered destination or the IncRem you are reviewing. It is selected only when the popup had nothing else to suggest and you have not moved the selection yet.
  - **Outside the tree:** when the suggested Rem is outside the tree the selector shows, it gets a row of its own at the top.
- **Pin Source Quote:** when a book in the `find-source` answer carries `quote`, that text is searched first, then the Rem's own.

## For developers { #developers }

The client is `src/lib/corpus/` (`getCorpusStatus`, `hasCorpusCapability`, `corpusRequest`, `suggestParentFromCorpus`). It reaches the helper's `POST /corpus` route through `src/lib/helper_client.ts`, the shared client for every helper route. `/corpus` takes `{ "op": "…", …payload }` and answers `{ "ok": true, "available": true, …provider answer }`, or `{ "ok": true, "available": false, "reason": "…" }` when there is no provider. New capabilities need no new helper route. Add the operation to this page, gate the feature on its capability, and call `corpusRequest(plugin, '<op>', payload)`.
