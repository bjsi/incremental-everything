# Desktop app: native `title` tooltips no longer show reliably inside plugin widgets

**Reporter:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Affected:** RemNote desktop for macOS. First seen on JS bundle 1.29.6 (native build 78); still happens on 1.29.8-beta (native build 80, Electron 44.10.1, Chrome 152.0.7977.169).
**Not affected:** the RemNote web app (beta.remnote.com) in Google Chrome, on the same Mac, with the same plugin and knowledge base, tested a few minutes apart.
**OS:** macOS 27.2 (26B123)
**First noticed:** 2026-11-03
**Date:** 2026-11-05

---

## Summary

In the desktop app, hovering an element with an HTML `title` attribute inside a plugin widget no longer reliably shows the tooltip. The element's CSS cursor still changes (e.g. the `?` from `cursor: help`, or the hand on a button), so the hover is registered, but the tooltip text either:

- never appears, or
- appears once and then not again until the pointer leaves the element and comes back.

The same widget in the web app, in Chrome on the same Mac, shows the tooltip every time. These tooltips had worked in the desktop app since May 2026, and the plugin code behind them did not change.

## Steps to reproduce

1. Register a popup widget whose content has an element with a `title`:
   ```tsx
   // registered with plugin.app.registerWidget('demo', WidgetLocation.Popup, …)
   <button title="Open the documentation: Enable Flashcard Prioritisation">?</button>
   ```
2. Open it with `plugin.widget.openPopup('demo')` in the **desktop app**.
3. Hover the button and wait. Leave it, come back and repeat a few times.
4. Do the same in the web app in Chrome.

**Expected:** the tooltip shows after the usual delay, every time, as it does in the web app.
**Actual (desktop app):** the cursor changes, but the tooltip is missing on most hovers.

## Side-by-side comparison (screenshots attached)

The plugin's Settings popup, hovering the `?` documentation button next to "Enable Flashcard Prioritisation":

1. **Web app, Chrome, 05:39:** the tooltip "Open the documentation: Enable Flashcard Prioritisation" appears.
2. **Desktop app, 05:40:** same popup, same button, pointer in the same place. The hand cursor shows, but no tooltip.
3. **A plain web page in Chrome, 05:43:** `title` tooltips work as usual, so macOS itself is drawing them normally.

## Where we see it in the desktop app

Every plugin popup we checked:

- the Settings popup: the `?` documentation buttons,
- a popup with a wide table whose column headers each carry a `title` (these worked from May 2026 until this month),
- the Priority popup: a small `<span title="…">` on one line of text.

We have only checked popup widgets. Other widget locations may be affected too.

## What we checked on the plugin side

- The `title` attribute is present in the DOM while hovering.
- Nothing in the widget re-renders during the hover, so the element is not being replaced under the pointer.
- The same code shows its tooltips in the web app, so the markup is fine.

## When it started

| When (local time, UTC−3) | Desktop app |
|---|---|
| Nov 2, 20:59 | JS bundle 1.29.1, native build 78 |
| Nov 3, 06:48 | JS bundle updated to 1.29.6 |
| Nov 3, evening | Problem first noticed |
| Nov 4, 12:12 | Updated to 1.29.8-beta, native build 80; problem remains |

Since the web app on the same JS version works, the cause seems to be in the desktop shell: Electron/Chromium, or something the desktop app does with mouse events or windows over plugin iframes.

## Workaround in the plugin

We are moving to tooltips we draw ourselves inside the iframe. A small component listens for `mouseover`, moves the element's `title` into `data-tip` so the native tooltip can't show a second copy, and renders a positioned `<div>`. This works, but every plugin that uses plain `title` attributes is affected in the desktop app, and most authors won't know why their tooltips disappeared.

## Request

Could you check native `title` tooltips inside plugin iframes in the current macOS desktop build, and restore them?
