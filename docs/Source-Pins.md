# Source Pins

A **source pin** is a pin reference to the highlight that holds a passage: click it and the PDF or article opens at that passage. Extracting a highlight with [Create Incremental Rem](Create-Incremental-Rem-from-PDF-Highlights.md) gives you one automatically.

**Pin Source Quote** gives one to text you already have — a sentence you typed, pasted or wrote into your notes — without selecting it in the source again. It finds the passage in the open PDF or article, reuses the highlight that already covers it or creates one, and pins it.

## Requirements { #requirements }

- The local helper, running — see [Setup](AI-Transcription-of-PDF-Highlights.md#setup). Pin Source Quote only needs Python and PyMuPDF; no AI and no Claude account are involved.
- RemNote **desktop**.
- The source must already have its **Highlights** document, which RemNote creates with the first highlight. For a PDF or article you have never highlighted, make one highlight first.

## Using it { #pin-source-quote }

1. Open the source in a pane: a **PDF**, a **saved web article** (RemNote's reader view of a page), or a **PDF in Text Reader mode**.
2. Focus the Rem whose text comes from that source.
3. Run **Pin Source Quote** (quick code `psq`).

A pin is added at the end of the Rem, and a toast reports where the passage was found and what was reused or created — for example *📌 PDF p.95: reused 0, created 1*.

- The text must be **taken from the source**. Small differences are tolerated — a garbled character from the PDF's text layer, missing punctuation — but a paraphrase, summary or translation will not be found.
- A **leading list marker** in your Rem ("3. ", "b) ", "• ") is ignored: the source shows it as list numbering, not as text.
- The PDF is searched **page by page**; a sentence that runs across a page break is not matched yet.
- If the same short phrase appears **word for word** more than once, the first occurrence is pinned.

## Reusing highlights { #reusing-highlights }

Highlights never overlap — so every passage keeps a single highlight, and clicking it in the PDF shows every Rem linked to it.

| Where the passage is | What gets pinned |
|---|---|
| Inside an existing highlight | That highlight |
| Mostly covered by existing highlights | Those highlights |
| Partly covered | Those highlights, plus new highlights for the uncovered stretches of at least four words |
| Not highlighted | A new highlight |

Running it again on the same Rem adds nothing twice. New highlights use the **Source Highlight Colour** setting (default orange; see [Settings → Other](Plugin-Settings-Reference.md#other)); a reused highlight keeps its own colour.

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
| *Open the source PDF or web article in a pane first.* | Open the source next to your notes, then run the command again. |
| *AI helper is not running* | Start the helper ([Setup](AI-Transcription-of-PDF-Highlights.md#setup)). |
| *This PDF has no Highlights document yet — make one highlight in it first.* | Highlight anything in the source once, so RemNote creates its Highlights document, then try again. |
| *Passage not found* | Check that the Rem's text was taken from this source, and that the right PDF or article is open. |

In web articles, an existing highlight that starts or ends **inside a formula** is not recognised when deciding what to reuse.
