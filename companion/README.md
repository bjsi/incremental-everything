# Incremental RemNote Companion

A Chrome extension for incremental reading of web pages. It works with the Incremental RemNote plugin through RemNote in the extension's side panel. The plan and open items are in `plans/COMPANION_EXTENSION_PLAN.md`, and how RemNote behaves here is in `findings/PLUGIN_BRIDGE_AND_SDK.md`.

## What it does

Selecting text brings up a menu beside it:

- **Add Extract** (`Opt+X`): the selection becomes an Incremental Rem under its section, and turns blue.
- **Add Highlight** (`Opt+H`): the same Rem in the same place, not made Incremental, and it turns yellow.
- **Priority:** `Opt+Shift+X`, or Add Extract with **Set priority** ticked, first asks for the extract's priority in a small field beside the selection. Type a number and press Enter; leave it empty for the inherited priority. Esc cancels the extract, and Shift+Enter opens the plugin's full popup in the panel instead, for the interval and scheduler.

A bar stays at the bottom right of every page, whether the panel is open or not:

- **Send to / Set priority:** the knowledge base the page's extracts go to, and whether each extract asks for its priority.
- **Set read point / Go to read point:** remembers the top of the window, and scrolls back to it.
- **Import headings:** creates the page's sections in its document.
- **› / ‹:** hides the bar's buttons on every page, or brings them back.

The panel's header says **✓ Incremental** when the page's document is an Incremental Rem, or offers **Make Incremental**, which asks for a priority.

Writes made while the panel is closed wait in the browser, shown as a count on the toolbar icon, and reach RemNote when the panel connects.

**The panel belongs to one tab** (`chrome.sidePanel` with a `tabId`, and no global panel in the manifest). Chrome hides it on other tabs and shows it again on return. Opening it on a second tab closes the first.

**A page's document is created only when asked for:** by opening the panel on the page, by an action from it, or by **Show this page in RemNote**. `focusDoc`, `getOrCreatePageDocument` and a `clipperURL` in the frame's address all create it, so restarts nobody asked for use `/clipper?clipperId=…` with no page.

**Knowledge bases:** synced plugin storage is shared by all of an account's KBs, while a Rem exists in only one. The plugin keeps each page per KB (`<kbId>|<pageKey>` in the shards), browser copies are `page:<kbId>:<address>`, and queued writes carry `kbId`. `chrome.storage` also holds `kb` (the KB in use), `kbKnown` (id → name) and `kbPick` (a pick the panel has yet to carry out). The panel moves by setting RemNote's `knowledgebaseId` in its frame's `localStorage` and restarting the frame, since RemNote reads it only once as it starts.

User docs: `docs/Chrome-Companion-Extension.md`. Privacy policy: `docs/Companion-Privacy-Policy.md`, which must change along with what the extension handles or stores.

Extracts are built as rich text in `anchors.js`, never through RemNote's Markdown parser, which reads page text as commands.

## How the parts talk

- **Page ↔ panel:** `chrome.storage` holds queued writes as `op:<id>`, and `chrome.runtime` carries reads and results.
- **Panel ↔ RemNote:** `postMessage` to the `/clipper` page, for the page's document.
- **Panel ↔ plugin:** a content script in the plugin's index frame holds a `chrome.runtime` port. It talks to the plugin (`src/lib/companion/`) by `postMessage` within that frame. Chrome reports the port's URL, which is how the panel knows it is really this plugin.

## Try it

Plugin development from `localhost` does not load in the panel, so the plugin side has to be a published build. Plugins belong to the account, so an installed plugin is there in every KB. Keep one plugin enabled at a time, as the panel talks to whichever connected last. The unlisted test plugin (`incremental-everything-plus`) refuses to write in a primary KB, and an extract it refuses is dropped from the queue.

1. In `chrome://extensions`, turn on Developer mode, and **Load unpacked** this folder.
2. Reload open pages, and close the RemNote Clipper's panel.
3. Click the toolbar icon. **Copy diagnostics** in the panel gives the connection details and timings.

## Package for the Chrome Web Store

Raise `version` in `manifest.json`, then from this folder:

```
rm -f ../companion-store.zip && zip -X ../companion-store.zip manifest.json background.js content.js anchors.js panel.html panel.js page.css icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png
```

## Icons

`icons/` has a drawing per size range, in the colours of the plugin's globe (`public/logo.png`): full detail for 48 and 128 px, simplified for 32 px, and drawn on the pixel grid for 16 px. `python3 companion/icons/make_icons.py` writes the SVGs and renders the PNGs.

## Tests

`node --test companion/anchors.test.js companion/integration.test.js`, also part of `npm test`. Add `REAL_PAGE=<saved html>` to check the text-finding and outline logic against a saved page.
