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

A persistent **Set priority** checkbox on the bar makes Add Extract open the priority popup. `Opt+X` follows the checkbox, and `Opt+Shift+X` always opens the popup.

**The full `priority_interval` popup opens in the panel, rather than a priority-only prompt on the page.** It is 370 px wide, which fits the panel, and it already has priority, interval, scheduler, the previews and the tracker save job. Rebuilding that on the page would duplicate about 450 lines and drift from the original, and it would need several round trips for inherited values. This supersedes the earlier idea of a prompt on the page.

**Chrome refuses the focus (tested on 0.0.55):** after a key press on the page, the popup opens in the panel, but one click there is needed before typing. Moving the focus by script does not work. If the click proves annoying, the next option is a small priority field on the page, which opens the full popup on request. Set priority also opens a closed panel, which Chrome allows only as a direct response to the key or click.

## Shortcuts

- **A `keydown` listener in the page's content script, not `chrome.commands`.** Commands fire whether or not text is selected, and would take `Opt+X` from the typing of `≈` across Chrome.
- **Match `event.code === 'KeyX'` with `altKey`, in the capture phase.** On a Mac, `event.key` is `≈` with Option held.
- **Act only on a non-empty selection outside inputs and editable areas.** Otherwise leave the key alone.

## Open items

- [x] Plugin frame's port, and the popup, on 0.0.55.
- [ ] Confirm the closed-panel queue and highlights after a reload on the final build: the 0.0.55 diagnostics do not show them.
- [ ] Decide whether one click before typing in the popup is acceptable.
- [ ] Release the listener in the main plugin, and measure connection and extract times on a large KB.
- [ ] A way to change the shortcut keys, for sites that use `Opt+X` themselves.
- [ ] Decide how to publish the extension, without using RemNote's name or icon as if official.
- [ ] Docs and changelog, once the final shape is approved.
