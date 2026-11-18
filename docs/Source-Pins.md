# Source Pins

A **source pin** is a pin reference to the highlight that holds a passage: click it and the PDF or article opens at that passage. Extracting a highlight with [Create Incremental Rem](Create-Incremental-Rem-from-PDF-Highlights.md) gives you one automatically.

**Pin Source Quote** gives one to text you already have — a sentence you typed, pasted or wrote into your notes — without selecting it in the source again. It finds the passage in the open PDF or article, reuses the highlight that already covers it or creates one, and pins it.

**Find Sources** does the same for text that only *means* what the source says — a summary, a paraphrase, a translation, course notes — by searching your library by meaning. See [Find Sources](#find-sources).

## Requirements { #requirements }

- The [AI helper](Desktop-Helpers.md#ai-helper), running — see [Setting up the AI helper](Desktop-Helpers.md#setup). Pin Source Quote only needs Python and PyMuPDF; no AI and no Claude account are involved.
- RemNote **desktop**.
- The source must already have its **Highlights** document, which RemNote creates with the first highlight. For a PDF or article you have never highlighted, make one highlight first.

## Using it { #pin-source-quote }

1. Open the source in a pane: a **PDF**, a **saved web article** (RemNote's reader view of a page), or a **PDF in Text Reader mode**. It can sit next to your notes or in another RemNote window: the command looks in the current window first, then in the others.
2. Focus the Rem whose text comes from that source, or select several Rems. In the queue (the Learn New queue included), the card on screen is the target; a Rem selected in the previewer (`P`) takes its place.
3. Run **Pin Source Quote**: `Opt+Shift+Q` / `Alt+Shift+Q`, or quick code `psq`.

A toast reports where the passage was found and what was reused or created — for example *📌 PDF p.95: reused 0, created 1*.

- **Several Rems at once:** with a multi-Rem selection, each Rem is pinned in turn and a final toast reports how many were done. Rems whose passage was not found are listed together at the end instead of stopping the run, and a PDF with a Text Reader version asks [which view](#text-reader) once, for the whole selection.
- **Front and back:** when the Rem has a back, the command looks for the front, the back, and both joined in either order — a heading on one side and its sentence on the other are often one passage — and pins the version that matches the most of its words. The pin goes at the **end of the back**; on a Rem without a back, at the end of the front.
- The text must be **taken from the source**. Small differences are tolerated — a garbled character from the PDF's text layer, missing punctuation — but a paraphrase, summary or translation will not be found.
- A **leading list marker** in your Rem ("3. ", "b) ", "• ") is ignored: the source shows it as list numbering, not as text.
- The PDF is searched **page by page**; a sentence that runs across a page break is not matched yet.
- If the same short phrase appears **word for word** more than once, the first occurrence is pinned.

## Sources that are not open: a source finder { #no-source-open }

If no PDF or article is open in any RemNote window, or the one that is open does not hold the passage, Pin Source Quote can still pin the quote when you have set up a **source finder**: a program on your computer that knows your books, for example a search index of your library. Given a quote, it says which book the quote comes from and which of your PDF Rems to try, in order. The quote is pinned from the first of them that holds the passage, in its page view.

The source finder gets each quote's text and the Rems above it, so it can tell the book from an attribution in the quote (*“…” (BPG 5.2.1)*), from the notes the quote sits in, or from the text itself. A book split into several PDFs is handled by listing them all.

**When the open source misses:** the passages it holds are pinned there as usual, and only the others are looked up. The open PDF is not searched twice. The dialog says it was searched first and lists it as *(the open source)* among the PDFs tried.

Since the PDF was not in front of you, a **confirmation dialog** follows instead of a toast. For each quote it shows the PDF and page it was pinned from, the book and how the source finder knew, and the highlights reused or created. The quotes that were not found are listed with the PDFs that were tried. If a pin points to the wrong PDF, remove it, open the right PDF and run the command again.

Without a source finder, the command asks you to open the source, or says the passage is not in the open one, as before.

### Setting one up { #source-finder-setup }

The [AI helper](Desktop-Helpers.md#ai-helper) runs the source finder. Name its command in `~/.incremental-remnote/ai-ocr/source-finder.json`:

```json
{ "command": ["/usr/local/bin/python3", "~/my-library-index/find_pdf.py"] }
```

A [corpus provider](Corpus-Provider.md) can take the source finder's place: it answers the same requests, can also give the exact text to search for when a quote was corrected, and serves other features. When both are set up, the corpus provider is used.

Or set the `IR_SOURCE_FINDER` environment variable of the helper (`IR_SOURCE_FINDER="python3 ~/my-library-index/find_pdf.py"`). The file is read on each request, so no restart is needed after changing it. A command ending in a `.py` file runs from that file's folder.

### Writing a source finder { #writing-a-source-finder }

The helper writes one JSON request to the program's standard input and reads one JSON answer from its standard output (exit code 0; anything else is reported as a failure). All the quotes of one run come in a single request.

Request:

```json
{ "items": [ { "remId": "AbC123", "ancestors": ["parent id", "grandparent id"], "texts": ["front", "back"] } ] }
```

Answer, books in the order to try:

```json
{ "items": [ { "remId": "AbC123", "books": [
    { "title": "Bridge Procedures Guide, 6th ed.", "cite": "BPG", "how": "named in the quote",
      "page": 66, "pdfRemIds": ["PdF000"] } ] } ] }
```

- `pdfRemIds` (required): the RemNote PDF Rems of that book, in the order to try.
- `title` (required) and `cite` (optional, short): how the book is shown in the dialog.
- `how` (required): how the program knew, shown as is (*named in the quote*, *in its notes*, *its text matches*).
- `page` (optional): a page to search first; the whole PDF is searched if the passage is not near it.
- `id` and `detail` (optional): passed back by the Local Media Bridge, not shown.
- `quote` (optional, [corpus providers](Corpus-Provider.md#op-find-source) with `quote-literal`): the text to look for instead of the Rem's own, when the Rem's text was corrected and no longer matches the PDF letter for letter.

## Find Sources: by meaning { #find-sources }

Pin Source Quote only finds text taken from the source. **Find Sources** finds the passages of your library that *say what a note says*, in other words or in another language: a summary you are studying from, course material, your own paraphrase. You review what it found, and the accepted passages are pinned to their highlights in your PDFs, as Pin Source Quote does.

It needs a [corpus provider](Corpus-Provider.md) that searches by meaning (the `semantic-search` capability), run by the [AI helper](Desktop-Helpers.md#ai-helper). Without one, the command says so.

### Running it { #find-sources-run }

- **Find Sources (by meaning)** (`fsq`) on the focused Rem or a multi-Rem selection (in the queue, the card on screen). A PDF open in a pane, or the book whose notes the Rem sits in, is searched first; the rest of your library too.
- Or **🔎 Search by meaning** in Pin Source Quote's *Passage not found* dialog (←→ to reach it), for the Rems that missed.

It runs **in the background**, about 20 seconds per Rem. A notice says when the results are ready; nothing is written until you review them.

### Reviewing { #find-sources-review }

**Review** in the notice opens the list of passages, per Rem:

| Group | What it means |
|---|---|
| **Source** | Says what your note says (score 8–10). Selected from the start. |
| **Diverges** | Contradicts your note: a different number, definition, condition or recommendation. |
| **Related** | Same point and context, adds to it or explains it (score 5–7). |

Each row shows the book, the page in your RemNote PDF, the quote with the words it turns on in **bold**, and a short note on what the passage says. A passage whose book has no PDF in RemNote (or which is not found in it) cannot be pinned; it can still be written as a quote.

| Key | Action |
|---|---|
| `↑` `↓` | Move |
| `Space` | Select or unselect the row |
| `A` | Select every passage scoring 9 or more |
| `Q` | What to write besides the pins (below) |
| `Enter` | Pin the selected passages |
| `Esc` | Close; **Review** in the notice opens it again |

### What gets written { #find-sources-written }

`Q` chooses, and the choice is remembered on this device:

- **Pins only**: the pins, on the Rem.
- **Pins + quotes**: also each quote as a child Rem, in the Quote format, under **Fontes** / **Sources** (sources) and **Material relacionado** / **Related material** (related and diverging passages, the latter marked ⚠️). Both headers are Extra Card Detail, so they show on the back of the Rem's cards.
- **Pins + quotes + AI notes**: also, under each quote, the note on what the passage says, as an **AI Note**: small, italic and muted, with a small 🤖 in place of its tag.

```
• Métodos de projeto probabilístico são muito utilizados … 📌
    • Fontes
        • “Probabilistic design methods are widely used to determine the optimum
          dimensions […] and lead to significant savings …” (PIANC 121, PDF p. 29) 📌
            • Métodos probabilísticos dão dimensões ótimas e economias…   (AI Note)
```

- **Quotes** keep only the words that bear on your note: the rest of the passage is cut with `[…]`, and each part gets its own pin, so the pin opens the whole context. The words the point turns on are in **bold**, the one word or figure it hinges on in ***bold italics***. The attribution reads `(book, §section, PDF p. N)`, with `; fora do edital` for a passage the exam does not ask for.
- **Where the pins go:** at the end of the Rem (of its back, when it has one). When the Rem mixes what several passages say, each pin goes right after the sentence it supports, as long as that sentence can be found with certainty; any other goes at the end.
- **Running it again** reuses the highlights, the headers and the quote Rems already there, and adds nothing twice.

## Pinning every quote in a subtree { #quote-rems-in-descendants }

**Pin Source Quote (Quote Rems in descendants)** — `Ctrl+Opt+Shift+Q` / `Ctrl+Alt+Shift+Q` (`Ctrl` on macOS too), or quick code `psqd` — runs Pin Source Quote on every Rem formatted as a **Quote** in the focused Rem and all its descendants, the focused Rem included. With several Rems selected, it covers each of them and their descendants; in the queue, the card's Rem and its descendants.

Other Rems in the subtree are left alone. The run works like a [multi-Rem selection](#pin-source-quote): one question about [which view](#text-reader) for a PDF with a Text Reader version, a final toast with the totals, and the passages not found listed together at the end.

Running it again on the same subtree adds nothing twice, but every Quote Rem is looked up in the source again, so a second run takes as long as the first.

## From outside RemNote { #from-outside }

Scripts and AI assistants writing notes through the RemNote MCP can run Pin Source Quote too, through the [Local Media Bridge](Local-Media-Bridge.md#operations): `media_bridge.py pin-quote <rem> --source <PDF or article rem>`. The source is named, so it does not need to be open; without `--source`, each Rem's source comes from your [source finder](#no-source-open) and the JSON answer says which PDF and page each quote was pinned from. `--quote` gives the passage to look for when the Rem's text is not exactly the source's. `media_bridge.py pin` turns references to highlights that a tool already wrote into pins.

## Reusing highlights { #reusing-highlights }

Highlights never overlap — so every passage keeps a single highlight, and clicking it in the PDF shows every Rem linked to it.

| Where the passage is | What gets pinned |
|---|---|
| Inside an existing highlight | That highlight |
| Mostly covered by existing highlights | Those highlights |
| Partly covered | Those highlights, plus new highlights for the uncovered stretches of at least four words |
| Not highlighted | A new highlight |

Running it again on the same Rem adds nothing twice. With the [AI helper](Desktop-Helpers.md#ai-helper) running on the desktop app, this includes pages and highlights RemNote has not loaded yet this session, which it does not report to plugins: they are read from the knowledge base's database, so no second "Page 030" is created beside the real one. New highlights use the **Source Highlight Colour** setting (default orange; see [Settings → Other](Plugin-Settings-Reference.md#other)); a reused highlight keeps its own colour.

## PDFs with a Text Reader version { #text-reader }

A PDF converted for the Text Reader has two views, and each keeps its own highlights. When you run Pin Source Quote on such a PDF, a dialog asks where to pin:

| Choice | Result |
|---|---|
| **Both views** | A highlight in the PDF page view and one in the Text Reader, both pinned |
| **PDF only** | The page view only |
| **Text Reader only** | The Text Reader only |

Use `↑` `↓` and `Enter`; `Esc` cancels without pinning. Your last choice is remembered on the device. The plugin asks rather than guessing because it cannot tell which of the two views is on screen.

## Telling the pins apart { #pin-rings }

With **pin ring indicators** on ([Settings → Editor Indicators](Plugin-Settings-Reference.md#editor-indicators)), a pin's ring says where it leads:

- **yellow** — a highlight on a PDF page;
- **purple** — a highlight in an HTML source: a saved web article or a PDF's Text Reader view.

So the two pins of a passage pinned in both views are easy to tell apart. See [Reference pin rings](Colour-Coding-Reference.md#reference-pin-rings).

## Pinning both views on Create IncRem { #create-increm-both-views }

Turn on **Create IncRem: Also Pin the Other PDF View** ([Settings → Other](Plugin-Settings-Reference.md#other); off by default) and extracting a highlight from a PDF that has a Text Reader version pins the passage in **both** views:

- extracting from a **PDF page** highlight also pins the passage in the **Text Reader**, and extracting from a **Text Reader** highlight also pins it on the **PDF page**;
- the other view's highlight is reused when one already covers the passage, created when not, and marked as extracted like the original — including the priority band colour.

This happens after the Rem is created and never slows down or interrupts Create Incremental Rem: if the helper is not running or the passage cannot be found in the other view, the Rem simply keeps its single pin. Area (image) highlights have no text to look for and are skipped.

## Troubleshooting { #troubleshooting }

| Message | What to do |
|---|---|
| *Open the source PDF or web article in a pane first (in any RemNote window).* | Open the source next to your notes or in another RemNote window, then run the command again. A source just opened in another window can take a couple of seconds to be seen. Without a source open, it also means no [source finder](#no-source-open) is set up. |
| *Passage not found in the PDFs of its book* | The source finder named a book, but none of the PDFs it listed holds the passage: the one you use may be a different edition, or missing from its list. Open the right PDF and run the command again. |
| *AI helper is not running* | Start the helper ([Setting up the AI helper](Desktop-Helpers.md#setup)). |
| *This PDF has no Highlights document yet — make one highlight in it first.* | Highlight anything in the source once, so RemNote creates its Highlights document, then try again. |
| *Passage not found* | Check that the Rem's text was taken from this source, and that the right PDF or article is open. A paraphrase, translation or summary is not found. With a [source finder](#no-source-open), the dialog also lists the other PDFs it tried. |

In web articles, an existing highlight that starts or ends **inside a formula** is not recognised when deciding what to reuse.
