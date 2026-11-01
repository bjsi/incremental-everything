# Companion extension

A Chrome extension for incremental reading of web pages, working with the plugin through RemNote in the extension's side panel. It lives in this repo. The test harness is `spikes/companion-extension/`, and the test results are in `findings/PLUGIN_BRIDGE_AND_SDK.md`.

## Status (Nov 1, 2026)

Tested in production through the unlisted plugin `incremental-everything-plus` 0.0.54, in a small throwaway KB. The user confirmed that Add Extract, highlights, read points and heading import worked as expected on the test pages.

## Features

- **Add Extract:** the selection becomes an Incremental Rem under its section, keeping bold, links and images.
- **Blue highlight:** painted with the CSS Highlight API and restored on reload. RemNote holds the master copy and the browser a local one.
- **Read point:** save the top of the window, and a button to scroll back to it.
- **Import headings:** nested section Rems, with extracts kept in reading order.
- **Shortcuts, with text selected:** `Opt+X` for Add Extract, `Opt+Shift+X` for Add Extract and set priority.

## Shortcut design

- **A `keydown` listener in the page's content script, not `chrome.commands`.** Commands fire whether or not text is selected, and would take `Opt+X` from the typing of `≈` across Chrome.
- **Match `event.code === 'KeyX'` with `altKey`, in the capture phase.** On a Mac, `event.key` is `≈` with Option held.
- **Act only on a non-empty selection outside inputs and editable areas.** Otherwise leave the key alone.
- **Priority prompt on the page, not in the panel.** Focus stays on the page after the key press, and whether an extension can move it to the side panel is untested. Numbers and Enter on the page keep it keyboard-driven.

## Before release

1. Replace the per-page synced keys: synced storage caps a plugin at 1000 keys.
2. Add the message code to the main plugin, inert unless the extension answers, and measure on a large KB.
3. Handle Add Extract while the panel is closed, instead of timing out.
4. Move the extension out of `spikes/`, without the test bar and checks.
5. Decide how to publish it, without using RemNote's name or icon as if official.

The `companion-test` and `companion-extension` branches carry test code in the plugin. Do not merge them into main as they stand.
