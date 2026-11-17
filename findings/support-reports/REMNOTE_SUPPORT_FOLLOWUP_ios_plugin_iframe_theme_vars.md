# Follow-up: on iOS the theme variables now reach plugin iframes, but RemNote's base `body` style does not

**Re:** "RemNote's `--rn-clr-*` colour variables are undefined in plugin widget iframes on iOS" (reported 2026-10-15; marked fixed in 1.28.51 on 2026-10-21)
**Reporter:** Hugo Marins
**Affected:** RemNote iOS app (iPhone), dark mode. _(iOS app version: to be filled in.)_
**Not affected:** RemNote desktop (macOS), same plugin and knowledge base.
**Date:** 2026-11-10

---

Hi Martin, thanks for the fix. It works for the variables. One part of the original problem is still there, though.

## The test

I took out our own fallback copy of RemNote's variables from the *Context Tree for Outline Cards* plugin, so the widget shows only what RemNote provides. Then I opened a flashcard in the queue on iOS, in dark mode. The widget is at `WidgetLocation.FlashcardUnder`. Screenshot attached.

## What works now

The `--rn-clr-*` variables are defined inside the iframe, with the correct dark values. I sampled pixels from the screenshot:

| Element in the widget | Styled with | Pixel colour | RemNote dark value |
|---|---|---|---|
| `?` chip background | `--rn-clr-background-light-accent` | `rgb(21, 38, 125)` | `--rn-colors-blue-5` = `21 38 125` ✓ |
| `?` glyph and rem reference link | `--rn-clr-content-accent` | `rgb(118, 141, 255)` | `--rn-colors-blue-60` = `118 141 255` ✓ |

Before 1.28.51 these were undefined.

## What is still missing

All plain text in the widget is **pure black, `rgb(0, 0, 0)`, in the browser's default serif font (Times)**.

That text sets no colour or font of its own. It inherits from `<body>`, the same way RemNote's own UI does. On desktop, RemNote's stylesheet gives the iframe's `body` its text colour and font:

```css
body { background-color: var(--rn-clr-background-primary);
       color: var(--rn-clr-content-primary);
       font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", …; … }
```

On iOS that rule still doesn't apply in the iframe. The variables are there, but nothing uses them for the body text. So the iframe seems to receive the variables only, not RemNote's stylesheet. Any plugin that renders plain text and relies on the inherited colour and font, as it does on desktop, is still black on a dark card on iOS.

## Could you

1. Include the base `body` rule (at least `color` and `font-family`) with the variables you now send to plugin iframes on iOS. That would make iOS match desktop.
2. Or, if plugins are expected to set `color: var(--rn-clr-content-primary)` and a font on their own root element, say so in the plugin docs. On desktop nothing makes this visible, because the inherited style is always there.

## Our side

The plugin now sets `color: var(--rn-clr-content-primary)` and RemNote's font stack on `body` itself, in a zero-specificity `:where(body)` rule, so RemNote's own rule wins wherever it loads. That is enough for us. The point of this follow-up is that every other plugin hits the same black-text problem until it does the same.
