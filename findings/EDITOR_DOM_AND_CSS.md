# The editor's DOM, and what plugin CSS can reach

A plugin cannot touch RemNote's DOM (its iframe is cross-origin to `app://`), but `plugin.app.registerCSS` can style it. These are the hooks that exist. They were verified by grepping `app.asar` and against live DOM, July to September 2026.

## One editor row

```
div.rn-editor__rem__body.rem-container[data-rem-tags][data-rem-id]   ← the row; tags live HERE
  span.rem-bullet__container[data-test="Rem Bullet Container"]       ← 24×24 inline-flex
    svg.rn-rem-bullet(.rn-rem-bullet--hidden-children)
      .rem-bullet__core   (fill: currentColor)   ← the dot
      .rem-bullet__ring   (fill: transparent)    ← grey disc, filled when children are collapsed
  …text (.rem-text / .EditorContainer)…
  div.hierarchy-editor__tag-bar (float: right)
    .hierarchy-editor__tag-bar__tag              ← one pill per tag
```

- `data-rem-tags` sits on `.rn-editor__rem__body.rem-container`, which **contains** both the bullet and the tag bar. So `[data-rem-tags~="slug"] .rem-bullet__container` reaches the bullet.
- The tree above is abridged: the bullet is **not a direct child** of the row. It sits under `div > .rem-button__container > div > div.inline-flex` (saved DOM, 2026-10-03), so `[data-rem-tags~="slug"] > .rem-bullet__container` matches nothing. Use the descendant combinator; the flat list below makes that safe.
- The editor is a **flat virtualized list**: a Rem's children are separate top-level rows, not DOM descendants. Block-level markers need the container div (`[data-container-node-id]`, class `container-node`). It carries `data-rem-container-tags` (the Rem's **own** tags and powerup names, never inherited), `data-rem-container-id` and `data-rem-container-property`.
- Every container gets inline `z-index: 2` (content div 3, children div 1). Each is a stacking context painted below the later rows of its subtree, so an overlay on an ancestor cannot cover its descendants. Styling a subtree needs its Rem ids (`src/lib/tag_subtree_css.ts`).
- The bullet box is `--rem-button-width: 24px`, `user-select: none` and not contenteditable: the safe place for editor chrome. A `background` on it plus `.rem-bullet__core { fill: transparent }` swaps the dot for an icon with no layout shift, and `.rem-bullet__ring` still signals a collapsed branch.
- `data-rem-tags` also appears on rem references (`.rem-reference-container`) and PDF highlights, which have no bullet. A bare `[data-rem-tags~=…]` rule hits them too.
- Other confirmed classes: `rem-container--with-tags`, `--focused`, `--spacious`, `--not-in-article`, `.toggle-collapse-button`, `.rn-doc-title`, `.rn-document[data-document-tags]`. The queue uses separate names: `.rn-queue-rem`, `.rn-bullet-container`, `.rem-bullet__document`, `data-queue-rem-tags`, `data-queue-rem-container-tags` (see `src/register/queue_display_powerups.ts`).

## Tag slugs come from the powerup's name

The slug in `data-rem-tags` and `data-queue-rem-container-tags` is the powerup's **name**, lowercased with spaces turned into hyphens, **not its code**. For example, `Hide Front Extra Details` (code `hideFrontExtras`) renders as `hide-front-extra-details`. RemNote's own tags follow the same rule: `CardPriority` → `cardpriority`.

Write selectors against the slugified name. To fix a mismatch, change the CSS, never the code: tagged Rems are keyed on the code.

## The tag bar collapses past one tag

Individual `.hierarchy-editor__tag-bar__tag` pills render only while a Rem has a **single** tag. With a second one, the bar collapses into a "2 tags" chip, taking any icon painted on a pill with it. A marker that must always show belongs on the row border or the bullet, not a pill. `SHOW_LEFT_BORDER_CSS` in `src/register/settings.ts` is an example.

## Table cells host no plugin widgets

- `UnderRemEditor` renders only for `NodeType.REM`. Table nodes are `TABLE_CELL`, `TABLE_CELL_LIST`, `TABLE_ROW` and `TABLE_ROW_HANDLE`, so the `<div data-plugin-node-id="table_cell-…">` on every cell stays empty.
- `RightSideOfEditor` is skipped for cells in practice: a probe showed 0 of 4 cells, against 4 of 4 plain Rems.
- There are no Rem-level context menus for plugins either, and floating widgets take fixed coordinates only.

The only per-row channel is `registerCSS` keyed on `data-rem-tags`, which is present in a cell's static markup. Showing a value, not just presence, means encoding it as tags first (the priority band powerups). Cells stay static HTML until hovered or focused.

## registerCSS works only from the index widget

`plugin.app.registerCSS` silently does nothing when called from any widget other than the index (`onActivate` in `src/widgets/index.tsx`): popups, floating widgets, the highlight toolbar and queue widgets are all ignored. To change CSS in response to something elsewhere, write a session key and let a `plugin.track` in the index re-register. `pdfHighlightBordersReloadKey` works that way.

## A card's answer in the queue

In both the Compact and the Beautiful queue, the back of a basic card is rendered inside the question Rem as `span.rn-fill-in-blank.rn-fill-in-blank--revealed`, after the ` → ` delimiter (saved DOM, 2026-10-03). Beautiful's `.queue-beautiful-basic-card-answer-line` class exists only on the block variant; short cards use an inline span that carries no class, only `data-test="Beautiful Queue Basic Card Answer Line"`. So `.rn-question-rem[data-queue-rem-container-tags~="slug"] .rn-fill-in-blank--revealed` is the selector that styles an answer in every case (`src/register/true_false.ts`).

The question Rem's bullet is `absolute left-[-24px]`: a border or background on `.rn-question-rem` needs about 36px of left padding to clear it.

## Card Cluster cards carry no tags and no Rem ids

A card whose parent is a Card Cluster is drawn by a separate renderer in both queue variants (`data-test="Beautiful Queue Card Cluster"` in Beautiful). It emits plain flex divs: no `.rn-question-rem`, no `data-queue-rem-container-tags`, no Rem id, and the answer is a bare `.RichTextViewer` after a `span.mx-2` delimiter instead of a fill-in-the-blank. Tag-keyed CSS cannot reach these cards at all (saved DOM + `app.asar`, 2026-10-03).

The only hook is the class `cluster-answer-container`, put on the wrapper of the Rem being tested on both sides of the card (`currentCompoundCardIdToTest.remId === rem._id`). Its first row child is the card's own line (`.min-w-0.items-start` in Beautiful, `.justify-between` in Compact); the cluster's other cards are in a sibling div. To style by tag, the plugin has to read the current card on `QueueLoadCard` and register CSS against that class (`refreshClusterCardCss` in `src/register/true_false.ts`).

## Text import cannot name a powerup

Pasting `#[[TFT]]` (RemNote's flashcards-from-text syntax) resolves the name among ordinary Rems only. With a powerup of that name registered, it still creates a plain tag Rem. The plain tag slugifies to the same `data-rem-tags` value, so CSS keyed on the slug applies either way; converting it to the powerup takes a command (`convertPlainTags` in `src/register/true_false.ts`). Observed 2026-10-03.

## A document pane's scroller, and pinning a DocumentAboveToolbar widget

Measured Oct 8 2026 from a pane's DOM:

```
div#tile__document.rn-pane__body          <- the scroller (overflow-y-scroll)
  div.w-full.h-full.relative
    div.document-inner-container          <- overflow-hidden
      div.fade-in-first-load.relative     <- one per DocumentAboveToolbar widget
        div > iframe[data-plugin-id]
      div.rn-document-wrapper             <- the document
```

`position: sticky` on the widget's wrapper does nothing by itself: `overflow: hidden` makes `.document-inner-container` the wrapper's scroll container, and that box never scrolls. Setting it to `overflow: clip` keeps the clipping without creating a scroll container, so the wrapper sticks to `#tile__document`. Shipped in v1.0.152 for the Editor Review Timer (`EDITOR_REVIEW_TIMER_STICKY_CSS` in `src/register/widgets.ts`).

The PDF viewer does not render this location at all; only the "Notes" view of the Rem does.

## Sticky headers are a fixed layer, not document flow

Read from the 1.28 bundle (`renderStickyBar`) and a pane's DOM, Oct 9 2026. The parent Rems RemNote keeps visible while their descendants scroll are rendered inside `.rn-editor` as:

```
div.fixed.h-full.pointer-events-none.z-[6000]   <- inline translateY(<top of the scroller>), width, clip-path; .invisible when empty
  div.relative.w-full.h-full
    div.rn-sticky-header.absolute.z-[6000]      <- inline top: <extraOffsetFromTop || 0>, width, translateX; data-portalid-sticky-header
```

So anything a plugin pins to the top of the pane is painted over by them. `.rn-sticky-header` is the stable hook: it is absolutely positioned, so a `margin-top` adds to its inline `top` and moves the whole stack down. A Rem turns sticky when it passes the top of the scroller, whatever the margin, so it is hidden behind the pinned element for that last stretch.

Shipped in v1.0.153 (`src/lib/editor_review_timer_sticky.ts`): the Editor Review Timer reports its height through a session key and the index widget registers the margin. DocumentAboveToolbar's widget context has a `documentId` but no pane id, so the offset cannot be per pane; the tallest reported timer is used.

