# Feature request: let each desktop window keep its own sidebar state

**From:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Date:** 2026-11-02
**Version:** RemNote desktop 1.29.1-beta, macOS 27.0.1

---

## The request

Please let each desktop window keep its own left and right sidebar state, so that showing, hiding or resizing a sidebar affects only the window where you do it.

## Why it matters

Multiple windows are most useful when each has its own job, such as a queue on one screen and PDF sources on another. Those windows need different layouts. A reading window may need the right sidebar's Highlights tab, while the queue window needs the space. Today, each change to one window's sidebar also changes the other's.

## Steps to reproduce

1. Open a second window with `⌘⇧N`.
2. Show or hide the right sidebar in one window.
3. The right sidebar in the other window shows or hides too.

## What the code does

From the app bundle of version 1.29.1-beta:

- **Shared items:** `LocalReactiveDataStore.sidebar` holds `leftSidebarCollapsed`, `rightSidebarCollapsed`, `leftSidebarWidth` and `rightSidebarWidth`, so the left sidebar and sidebar widths should sync the same way. 
- **The sync:** each item's `set()` writes to `localStorage` and posts to a `BroadcastChannel` named after its key. Every window applies what it receives.
- **No opt-out:** I found no per-window setting for these items.

## Suggested behaviour

- Showing, hiding or resizing a sidebar changes only the current window.
- A new window starts from the last saved state, as it does now.
- The saved state keeps following the most recent change, so a single-window user notices no difference.

One way to do this would be to stop broadcasting these four items while still saving them to `localStorage`.

## Why a plugin isn't enough

- **No access:** a plugin's iframe is sandboxed with an opaque origin, so it can't reach the store or its `BroadcastChannel`.
- **No API:** the only sidebar call I found in the SDK is `openWidgetInRightSidebar`, which opens the sidebar through the same shared item.
- **CSS only goes so far:** a plugin could hide a sidebar in one window with CSS, but it couldn't keep one open there, and the window's toggle would stop working.
