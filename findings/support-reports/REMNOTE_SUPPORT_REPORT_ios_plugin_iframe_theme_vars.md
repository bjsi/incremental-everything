# RemNote's `--rn-clr-*` colour variables are undefined in plugin widget iframes on iOS

**Reporter:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`, v1.0.155)
**SDK:** `@remnote/plugin-sdk` 0.0.46
**Affected:** RemNote iOS app (iPhone), dark mode. _(iOS app version: to be filled in.)_
**Not affected:** RemNote desktop 1.28.48 (macOS), same plugin and knowledge base.
**Date:** 2026-10-15

---

## Summary

In a plugin widget iframe on iOS, none of RemNote's theme variables (`--rn-clr-content-primary`, `--rn-clr-background-secondary`, …) are defined. Every `var(--rn-clr-*)` resolves to nothing, so text falls back to the browser default (black) and backgrounds become transparent. In dark mode the widget shows black text on RemNote's dark card, which is close to unreadable.

The `dark` / `light` class that the SDK puts on the iframe's `<body>` (`setDarkMode`) **does** arrive on iOS. Only the variable definitions are missing.

On desktop the same widget renders correctly in both themes.

## Steps to reproduce

1. On iOS, set RemNote to dark mode.
2. Install a plugin whose widget colours its text with RemNote's variables, e.g.
   ```tsx
   <div style={{ color: 'var(--rn-clr-content-secondary)',
                 background: 'var(--rn-clr-background-secondary)' }}>
     Priority: P9
   </div>
   ```
   registered at `WidgetLocation.FlashcardUnder`.
3. Open a flashcard queue.

**Expected:** light text on a dark background, as on desktop.
**Actual:** black text on a transparent background (screenshots attached: iOS before / after the workaround, desktop for comparison).

## How the variables reach an iframe today

This is from reading RemNote 1.28.48 (desktop build) and SDK 0.0.46:

- **Host side** (module `361710`): the list of stylesheets to share is computed **once, when the module is first evaluated**:
  ```js
  let V = [...document.getElementsByTagName("link")]
    .filter(n => n.href?.includes("/static") || n.href?.includes("/assets") || n.href?.includes("/offline_assets"))
    .map(n => n.href);
  ```
  On widget activation, `WidgetInstance` sends it as `styleSheetHREFs` in the `onActivate` payload (empty for the index widget).
- **SDK side** (`receiveActivateMessage`): when `inSandbox`, it appends one `<link rel="stylesheet" href=…>` per URL to the iframe's `<head>`. Those stylesheets are what define `--rn-clr-*` inside the iframe.
- The only other CSS channel, `setCustomCSS`, carries the user's Custom CSS blocks and active theme `theme.css` URLs. It does not carry the base variables.

So the variables exist in an iframe only if that host-side `<link>` list is non-empty **and** the iframe can load those URLs.

## Likely cause (not confirmed, we could not attach Web Inspector to the iOS app)

One of these, on iOS:

1. **The list is empty.** The iOS build may load its CSS differently (inlined `<style>`, links added after module `361710` first runs, or paths that don't contain `/static`, `/assets` or `/offline_assets`). Since `V` is a module-level snapshot, links added later are never picked up.
2. **The URLs can't be loaded from the iframe.** If they point at an app-local scheme (e.g. `capacitor://localhost/...`), a plugin iframe served from another origin over `https` may be unable to fetch them.

Checking `styleSheetHREFs` in an `onActivate` message on iOS would tell which one it is.

## Suggested fixes

- **Send the variables, not URLs to them.** For example, include a CSS block with the resolved `--rn-clr-*` / `--rn-colors-*` values for the current theme in the activation or `setDarkMode` payload, or as the first `setCustomCSS` block. This works regardless of where the host's stylesheets live or which scheme they use, and it updates when the theme changes.
- Or make sure the iOS build's stylesheet URLs match the filter and are loadable from a plugin iframe.
- Either way, compute the list at activation time, not at module load, so that late-added stylesheets are included.

## Our workaround (shipped in v1.0.155)

The widget now ships its own **fallback** definitions of the variables it uses, with RemNote's values from the 1.28 bundle. It switches on the SDK's `body.dark` class. Every selector is wrapped in `:where()`, so it has zero specificity: wherever RemNote's real stylesheets do load (desktop, or a custom theme), they win.

```css
:where(:root) {                         /* light */
  --rn-colors-gray-5-val: 244 244 250;
  --rn-colors-gray-40-val: 145 145 168;
  --rn-colors-gray-60-val: 99 99 123;
  --rn-colors-gray-100-val: 41 41 54;
  /* … */
}
:where(:root:has(> body.dark)) {        /* dark: the gray scale flips */
  --rn-colors-gray-5-val: 43 43 51;
  --rn-colors-gray-40-val: 108 108 119;
  --rn-colors-gray-60-val: 148 148 159;
  --rn-colors-gray-100-val: 235 235 237;
  /* … */
}
:where(:root) {                         /* semantic colours, same mapping in both modes */
  --rn-clr-content-primary: rgb(var(--rn-colors-gray-100-val));
  --rn-clr-content-secondary: rgb(var(--rn-colors-gray-60-val));
  --rn-clr-content-tertiary: rgb(var(--rn-colors-gray-40-val));
  --rn-clr-background-secondary: rgb(var(--rn-colors-gray-5-val));
  /* … */
}
:where(body) { color: var(--rn-clr-content-primary); }
```

Confirmed on an iPhone: the widget now reads correctly in dark mode, and desktop is unchanged.

The drawback is that every plugin has to copy RemNote's palette and keep it in sync by hand. Any plugin that uses the variables without such a fallback is still unreadable in dark mode on iOS. A fix on RemNote's side would make all of this unnecessary.
