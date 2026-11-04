# Bug report / feature request: bring back the Highlights tab for PDFs in the queue

**From:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Date:** 2026-11-02
**Version:** RemNote desktop 1.29.1-beta, macOS

---

## The request

Please show the right sidebar's Highlights tab again when a PDF is open in the queue. It disappeared in 1.28.46. If this was a deliberate change aimed at the AI tools, please exempt Highlights from it.

## What changed

Until 1.28.45, the Highlights tab was available whenever a PDF was open, including in the queue. From 1.28.46 (October 12, 2026), it appears for a PDF only on document routes. The Summary, Contents and Learn PDF tabs are hidden in the same way.

Web pages, videos and recordings aren't affected by this check, so PDFs are now the exception.

## Why it matters

My plugin brings PDFs into the queue for incremental reading, using the SDK's `PDFWebReader`, so a reading session happens inside the queue. The Highlights tab is where I edit the highlights I make while reading, without losing my place.

Now, to edit a highlight, I have to leave the card and open the PDF on a document route. That breaks the session, and it's most costly for long PDFs with many highlights.

Highlights is also different from the other hidden tabs: it's a plain list of the user's own Rems, not an AI tool. The AI Tutor tab still appears next to the same PDF in the queue.

## Steps to reproduce

1. Open a PDF with highlights on a document route. The Highlights tab is in the right sidebar.
2. With the Incremental RemNote plugin, practice a queue until you reach a PDF card, which the plugin shows with `PDFWebReader`.
3. Look at the right sidebar. It shows AI Tutor and the plugin icons, but no Highlights tab.

I've only seen this through the plugin. From the code, any PDF open in the queue should behave the same way.

## What the code does

From the app bundles, in the function that builds the right sidebar's tabs:

```js
g = getOpenLearningPage()
f = g?.pdf && (!isDocumentRoute() || (isPhone() && isInteractiveLearnPane())) ? undefined : g
T = !!f && (a ?? hasHighlights(f))     // T && { tabId: "Highlights", ... }
```

The names are my reading of the minified code. `isDocumentRoute` accepts only `Document.show`, `Document.showTwo`, `WithTabIdDocumentTree.show`, `WithoutTabIdDocumentTree.show` and `PublishedDocument.show`, so every `Flashcards*` route fails it.

| Version | Date | PDF route check |
|---|---|---|
| 1.28.40 | Oct 5 | Absent |
| 1.28.45 | Oct 11 | Absent |
| 1.28.46 | Oct 12 | Present |
| 1.28.47, 1.28.49, 1.28.51, 1.28.62 | Oct 14–27 | Present |
| 1.29.1 | Oct 30 | Present |

Dates are those of the download files, except 1.29.1, which is the date of my installed copy. I read these bundles but didn't run the older versions.

## Suggested behaviour

Show the Highlights tab whenever a PDF with highlights is open, as before. Summary, Contents and Learn PDF can stay as they are.

One way to do this would be to test the highlights condition against the unfiltered page:

```js
T = !!g && (a ?? hasHighlights(g))
```

`openLearningPageHasHighlights` in the same module has the same route check (`(!r?.pdf || isDocumentRoute()) && hasHighlights(r)`), so it would need the same change. The tab's content reads the open learning page directly, so it appears not to depend on the filtered value.

## Why a plugin isn't enough

- **No access:** the check runs in the host against `FlowRouter`, and a plugin's iframe is sandboxed with an opaque origin.
- **No API:** the only sidebar call I found in the SDK is `openWidgetInRightSidebar`, which opens plugin widgets, not native tabs.
- **A copy falls short:** a plugin widget could show the same Rems in a `DocumentViewer`, but it wouldn't have the native tab's highlight view or stay in step with it.
