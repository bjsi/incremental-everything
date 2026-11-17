# Beautiful queue: "View Full Table" is missing on desktop for tables that test individual cells

**Reporter:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Affected:** RemNote desktop for macOS, 1.30.0-beta. The Beautiful queue variant.
**Not affected:** RemNote on my phone, where the button shows on the same kind of card.
**OS:** macOS 27.2
**Date:** 2026-11-10

---

## Summary

In the Beautiful queue, table cards have a "View Full Table" button ("See Full Table" in earlier builds) under the card. It opens the whole table. On my phone it shows. In the desktop app it never shows on cards from a table that **tests individual cells**, even when the card uses the same stacked layout as on the phone. On desktop there seems to be no other way to open the full table from such a card.

Is this intentional? If it is, could the button also be offered on desktop?

## Steps to reproduce

1. Make a table and turn on testing of individual cells.
2. Give it at least three columns, so that a card has an extra column on its back.
3. Practise one of its cards in the desktop app, with the Beautiful queue enabled.
4. Practise the same card on a phone.

**Expected:** the card shows "View Full Table" on both, as it does for cards from ordinary tables.
**Actual:** the phone shows the button. Desktop shows the stacked fields (column name above each value, the answer and the extra column highlighted) and no button.

## Screenshots (attached)

1. **Desktop, 1.30.0-beta:** a card from my table "Information & Requirements", with columns *Information*, *Requirements* (tested) and *Section & Quote* (extra on the back). Stacked layout, no button under the fields.
2. **Phone:** a card from a table, stacked layout, "See Full Table" under the fields.

## What I found

To check whether the plugin was involved, I looked at the desktop app's JavaScript bundle (1.30.0-beta). The Beautiful queue draws table cards through two components that share the same button (`data-test="Beautiful Queue View Full Table"`):

- **Table Preview** (`data-test="Beautiful Queue Table Preview…"`), for ordinary tables, renders the button everywhere, desktop included.
- **Individual Cell Card** (`data-test="Beautiful Queue Individual Cell…"`), used when the table has "test individual cells" on, renders it only when `Env.mobile.mode.isPhone` is true:

  ```js
  M = i.Env.mobile.mode.isPhone
  …
  M ? <ViewFullTableButton onClick={() => setShowFullTable(true)}/> : null
  ```

On desktop the Individual Cell Card still uses the stacked layout when the card has extra front or back columns, when the card is 520 px wide or narrower, or when the cells would wrap too much in two columns. In all those cases the button is hidden. The full-table view is opened only by this button, so on desktop it can't be reached.

The plugin doesn't touch this: the button and its state are inside RemNote's queue component.

## Request

If hiding it on desktop wasn't deliberate, could the button also be shown in the desktop (and web) app for individual-cell table cards, as it already is for ordinary table cards? Seeing the whole table after answering is just as useful on a large screen.
