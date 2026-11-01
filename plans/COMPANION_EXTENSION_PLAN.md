# Companion extension

A Chrome extension for incremental reading of web pages, working with the plugin through RemNote in the extension's side panel. It lives in this repo. The test harness is `spikes/companion-extension/`, and the test results are in `findings/PLUGIN_BRIDGE_AND_SDK.md`.

## Status (Nov 1, 2026)

The feature tests passed in Chrome on the unlisted plugin `incremental-everything-plus` 0.0.54, in a small throwaway KB. The final structure below ran in Chrome as 0.0.55: the plugin connected through its frame's port in 12 s, and an extract with the priority popup took 242 ms. Next: a main plugin release, to measure a large KB.

## Decisions

- **The extension lives in this repo,** in `companion/`, and the plugin side in `src/lib/companion/`. The plugin build only packages `dist/`, so the extension cannot leak into a release.
- **The bar stays on every page,** whether the panel is open or not.
- **Writes are queued in `chrome.storage`,** so they survive a closed panel. The toolbar badge counts them, and they run when the panel connects. `addExtract` carries an id, so a retry cannot add it twice.
- **Reaching the plugin:** a content script in the plugin's index frame holds a `chrome.runtime` port, and talks to the plugin by `postMessage` within that frame. Messaging through the RemNote page also worked in the tests, but any plugin frame could have posed as ours. Chrome reports the port's URL, so this one cannot be spoofed, and the plugin's only cost without the extension is one idle listener.
- **Storage:** 32 synced keys, `companion_pages_{n}`, with pages hashed across them, instead of one key per page. Keys are created only once used. A write that would pass the per-key limit fails with a message. Two devices writing the same key can still overwrite each other, which is worth revisiting if highlights ever go missing.
- **The test plugin refuses primary KBs.** The main plugin must not, as that is its purpose.

## Set priority

A persistent **Set priority** checkbox on the bar makes Add Extract ask for a priority. `Opt+X` follows the checkbox, and `Opt+Shift+X` always asks.

**A small field beside the selection asks, per extract:** Enter adds the extract, an empty field keeps the inherited priority, and Esc cancels it. Nothing is written until Enter, and the priority goes straight into `initIncrementalRem`, so it works with the panel closed and needs no second save.

**Why not only the popup:** a side panel cannot take the keyboard focus from the page (tested on 0.0.55), so the plugin's `priority_interval` popup needed one click before typing. The user found that annoying, since most of their extracts get a priority. The popup stays one key away: Shift+Enter in the field opens it in the panel, for the interval and scheduler, which would be too much to rebuild on the page.

## Shortcuts

- **A `keydown` listener in the page's content script, not `chrome.commands`.** Commands fire whether or not text is selected, and would take `Opt+X` from the typing of `≈` across Chrome.
- **Match `event.code === 'KeyX'` with `altKey`, in the capture phase.** On a Mac, `event.key` is `≈` with Option held.
- **Act only on a non-empty selection outside inputs and editable areas.** Otherwise leave the key alone.

## Open items

- [x] Plugin frame's port, and the popup, on 0.0.55.
- [x] Closed-panel queue, highlights after a reload, and `Opt+X` in text boxes: confirmed by the user on 0.0.55.
- [x] One click before typing in the popup: not acceptable, replaced by the field.
- [ ] Try the priority field in Chrome on build 0.0.56.
- [ ] Release the listener in the main plugin, and check connection and extract times on a large KB. The user expects it to work, if slower, having used the Clipper on their main KB.
- [ ] A way to change the shortcut keys, for sites that use `Opt+X` themselves.
- [ ] Decide how to publish the extension, without using RemNote's name or icon as if official.
- [x] Docs, changelog and a privacy policy draft (Nov 1, 2026). When the store listing is live, replace the Load unpacked step in the docs with its link.
