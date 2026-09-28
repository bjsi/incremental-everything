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
