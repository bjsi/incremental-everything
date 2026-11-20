# Source Pins

A **source pin** is a pin reference to the highlight that holds a passage: click it and the PDF or article opens at that passage. Extracting a highlight with [Create Incremental Rem](Create-Incremental-Rem-from-PDF-Highlights.md) gives you one automatically.

**Pin Source Quote** gives one to text you already have — a sentence you typed, pasted or wrote into your notes — without selecting it in the source again. It finds the passage in the open PDF or article, reuses the highlight that already covers it or creates one, and pins it.

**Find Sources** does the same for text that only *means* what the source says — a summary, a paraphrase, a translation, course notes — by searching your library by meaning. See [Find Sources](#find-sources). **Check Statement** goes one step further and tells you whether a note is right, from those passages. See [Check Statement](#check-statement). **Ask Your Sources** answers a question from them. See [Ask Your Sources](#ask-your-sources).

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

It needs a [corpus provider](Corpus-Provider.md) that searches by meaning (the `semantic-search` capability), run by the [AI helper](Desktop-Helpers.md#ai-helper). Find Sources, Check Statement, Ask Your Sources and their tree versions appear among the commands only once the provider reports that capability (looked at shortly after RemNote starts, then every few minutes until the helper answers).

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

### Lists in your notes { #find-sources-lists }

Notes often split one sentence over several Rems: a lead-in ending with ":" and its list items as children.

```
• A profundidade segura de um canal é determinada por:
    • fatores do nível d'água,
    • fatores do navio e
    • fatores do fundo.
```

Neither part is a statement alone, so Find Sources and Check Statement read them as **one**: *"…é determinada por: fatores do nível d'água, fatores do navio e fatores do fundo."*

- **A list** is a Rem ending with ":" (or with a word that waits for its list, like *…composta por*) whose children are all short (up to 30 words) and not headings. An item can have its own list, which is folded in.
- **Running a command on one item** judges its whole list.
- **The pin** goes on the item a passage supports when it supports just that one, otherwise on the lead-in. Quotes and Check Rems go under the lead-in.
- **Headings are titles, not statements:** they are skipped, and their children are judged one by one. So are labels of fewer than six words and the caption over an audio or image.

### Whole summaries { #find-sources-in-descendants }

**Find Sources (by meaning) in descendants** (`fsqd`) and **Check Statements against Sources in descendants** (`cksd`) run on every statement under the focused or selected Rems: a course or summary document, or a section of one.

- **What is searched:** each statement once, lists read as above. Quotes, AI Notes and what Find Sources and Check Statement already wrote are left out. `fsqd` also skips statements that already have a pin; `cksd` checks them all. At most 120 per run.
- **Speed:** three statements at a time, in the background. A notice follows the progress and turns into the review when all are done.
- **Reviewing:** one list for the whole run, grouped by note. `A` selects every passage scoring 9 or more, `Shift+A` only in the current note, and `PageDown` / `PageUp` jump between notes.

### Descriptors and where the note sits { #find-sources-context }

A note often means something only in its place in the outline. What is sent with it:

- **A descriptor** (*Não pode rebocar em que método? → no cabo longo* under *Rebocadores com tubulão*) names no subject on its own, so it goes with its **concept**: the first Rem above it that is not a descriptor, then any descriptors in between, front only. The concept is searched with the note, and Claude reads the note as being about it. This applies to Find Sources, Check Statement and Ask Your Sources.
- **Check Statement and Ask Your Sources** also give Claude up to three Rems above the note (above the concept, for a descriptor), up to and including its document, so a question under *3.3) Tug assistance in ice* is read as being about ice. Rems longer than a heading are left out. These go to Claude only, never to the search, where they would pull in passages about the whole topic.
- **The review** shows what was sent, under each note's title: *3) Assisting methods › 3.3) Tug assistance in ice › Rebocadores com tubulão › this note*.

## Check Statement: is my note right? { #check-statement }

**Check Statement against Sources** (`cks`) runs [Find Sources](#find-sources) on the focused or selected Rems, then asks Claude (Opus, through the [AI helper](Desktop-Helpers.md#ai-helper), on your Claude subscription) whether each note is right, judging **only from the passages found**, never from its own knowledge. Claude reads each passage in full and picks the words that show its verdict: those become the quotes, with their emphasis, and the pins. Same requirements as Find Sources, plus the Claude CLI signed in.

It runs in the background (about half a minute per Rem), and the notice shows the verdict:

| Verdict | Meaning |
|---|---|
| ✅ Correta / Consistent | Every claim of the note is supported |
| ⚠️ Em parte / Partly | Some claims are supported, others are missing, imprecise or wrong |
| ❌ Incorreta / Contradicted | A central claim is contradicted |
| ❔ Não coberta pelas fontes / Not covered | No passage settles the note |

**Review** opens the same list as Find Sources, with the verdict and an **observation** at the top of each Rem: what is right, what is wrong and what the source says instead, citing book and page. The passages the verdict rests on are marked ◆ and selected from the start. Enter writes the verdict, even with no passage selected:

```
• Para canais de acesso expostos à ação de ondas, … 📌
    • Verificação: ⚠️ Em parte (18/11/2026)        (Extra Card Detail)
        • A primeira parte está correta: … A segunda parte está errada: …
            • “…” (PIANC 121, PDF p. 30) 📌
```

- The **source pins** go on the Rem, as in Find Sources.
- With quotes on (`Q`), the ◆ passages go under the observation; any other accepted passage goes under Fontes / Material relacionado.
- Each check is **dated**: checking again adds a new one and leaves the old one.

## Ask Your Sources: a question to your library { #ask-your-sources }

Write a question or a topic in a Rem, *qual deve ser o ângulo de presa das âncoras tipo patente?* or just *ângulo de presa das âncoras tipo patente*, and run **Ask Your Sources** (`ask`). It finds the passages of your library that answer it, then Claude (Opus) answers **only from them**, the way `/explain-with-quotes` does, and says so when they do not settle it. Same requirements as Check Statement.

- **The answer:** one sentence, then a few short sections from the core idea to the details and conditions, then where the sources disagree. Key terms and figures in **bold**.
- **The quotes:** Claude reads each passage in full and quotes, under each section, exactly the words that section rests on, trimmed with `[…]` and emphasised; the same passage can be quoted differently in two sections. Every quote is checked against the source before it is offered.
- **Review:** the answer at the top, each section with its quotes and passage numbers, and the passages below with the same numbers; the ones the answer uses (◆) start selected, a passage that disagrees with another is marked ⚠ diverges.

Written under the question, first among its children:

```
• qual deve ser o ângulo de presa das âncoras tipo patente?
    • Resposta (18/11/2026): Segundo a Arte Naval, … aproximadamente 45°; Clark … entre 35° e 37°.   (Extra Card Detail)
        • Nas âncoras tipo patente, o ângulo de presa é … aproximadamente 45°.
            • “Nas âncoras tipo patente, é o ângulo máximo …” (Arte Naval II, PDF p. 61) 📌
        • O valor do ângulo é um meio-termo: … 30° para areia … 50° para lama …
            • “the optimum maximum angle for the flukes varies …” (Clark, PDF p. 200) 📌
        • Divergências
            • A Arte Naval dá cerca de 45°; Clark, 35° a 37° … → each side's quote
        • Outras passagens → accepted passages the answer did not use
```

- `Q` chooses **Pins only** (a section gets its pins at the end of its own text) or **Pins + quotes**; there are no AI notes here, since the answer already explains. The same goes for Check Statement.
- The question itself gets no pin. Each answer is **dated**: asking again adds a new one.

### Asking a follow-up { #ask-follow-up }

When the answer misses a point, or you want another aspect in it, write what to change in the field at the bottom of the review (`F` puts the cursor there) and press `Enter` or **Ask again**: *include the effect of the ice thickness*, *shorter*, *say which book gives 45°*.

- The question is **searched again** with your follow-up added, so a new aspect brings its own passages. The passages of the first answer that the new search does not find again are kept.
- Claude **rewrites the whole answer** from the previous one and your request, still only from the passages, and says so when they do not cover what you asked.
- It runs in the background like the first time. A new notice (*Ask Your Sources: follow-up ready to review*) opens a new review, which shows your follow-up under the question; you can follow up again from there.
- Nothing is written until you accept an answer. With one question in the review, the old notice goes; in a review of several, the follow-up applies to the question under the cursor, and the old notice stays for the others.
- `Esc` in the field goes back to the list.

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
