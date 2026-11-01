# Incremental RemNote Companion

A Chrome extension for incremental reading of web pages. It works with the Incremental RemNote plugin through RemNote in the extension's side panel. The plan and open items are in `plans/COMPANION_EXTENSION_PLAN.md`, and how RemNote behaves here is in `findings/PLUGIN_BRIDGE_AND_SDK.md`.

## What it does

A bar stays at the bottom right of every page, whether the panel is open or not:

- **Add Extract** (`Opt+X`, when text is selected): the selection becomes an Incremental Rem under its section, and turns blue.
- **Priority:** `Opt+Shift+X`, or Add Extract with **Set priority** ticked, first asks for the extract's priority in a small field beside the selection. Type a number and press Enter; leave it empty for the inherited priority. Esc cancels the extract, and Shift+Enter opens the plugin's full popup in the panel instead, for the interval and scheduler.
- **Set read point / Go to read point:** remembers the top of the window, and scrolls back to it.
- **Import headings:** creates the page's sections in its document.

Writes made while the panel is closed wait in the browser, shown as a count on the toolbar icon, and reach RemNote when the panel connects.

User docs: `docs/Chrome-Companion-Extension.md`. Privacy policy: `docs/Companion-Privacy-Policy.md`, which must change along with what the extension handles or stores.

Extracts are built as rich text in `anchors.js`, never through RemNote's Markdown parser, which reads page text as commands.

## How the parts talk

- **Page ↔ panel:** `chrome.storage` holds queued writes as `op:<id>`, and `chrome.runtime` carries reads and results.
- **Panel ↔ RemNote:** `postMessage` to the `/clipper` page, for the page's document.
- **Panel ↔ plugin:** a content script in the plugin's index frame holds a `chrome.runtime` port. It talks to the plugin (`src/lib/companion/`) by `postMessage` within that frame. Chrome reports the port's URL, which is how the panel knows it is really this plugin.

## Try it

Plugin development from `localhost` does not load in the panel, so the plugin side has to be a published build. Use the unlisted test plugin (`incremental-everything-plus`) in a throwaway KB, with the main plugin disabled there. The test plugin refuses to write in a primary KB.

1. In `chrome://extensions`, turn on Developer mode, and **Load unpacked** this folder.
2. Reload open pages, and close the RemNote Clipper's panel.
3. Click the toolbar icon. **Copy diagnostics** in the panel gives the connection details and timings.

## Icons

`icons/` has a drawing per size range, in the colours of the plugin's globe (`public/logo.png`): full detail for 48 and 128 px, simplified for 32 px, and drawn on the pixel grid for 16 px. `python3 companion/icons/make_icons.py` writes the SVGs and renders the PNGs.

## Tests

`node --test companion/anchors.test.js`, also part of `npm test`. Add `REAL_PAGE=<saved html>` to check the text-finding and outline logic against a saved page.
