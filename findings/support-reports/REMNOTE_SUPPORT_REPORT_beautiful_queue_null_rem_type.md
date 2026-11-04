# Bug report: in the Beautiful queue, basic cards that were once a Concept or Descriptor never get the question / answer layout

**From:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Date:** 2026-11-03
**Version:** RemNote desktop 1.29.6-beta (macOS)

---

## Summary

The Beautiful queue shows a basic card with the question on top, a short divider, and the answer below. Some basic cards never get this layout and show the classic "question → answer" line instead. They are the cards whose Rem was turned into a Concept or Descriptor at some point and then unset.

"Unset as Concept/Descriptor" (Opt+Cmd+Q) saves the Rem's type as `null` instead of removing it. The Beautiful queue only uses the basic-card layout when the type is `undefined`, so these Rems fall back to the classic view. Unsetting the type again doesn't help, because it writes `null` again. A plugin can't fix it either: `rem.setType(SetRemType.DEFAULT_TYPE)` is rejected by the plugin bridge.

## Impact

My main knowledge base has 845 Rems with `"type": null`, 152 of them with a back side. Only cards stay stuck in the classic layout, and the user can do nothing about it. To the user it looks random: two cards with the same structure under the same parent are shown differently.

## Steps to reproduce

1. Create a basic card `Question >> Answer` directly under a document.
2. Practice it in the Beautiful queue. It shows question / divider / answer.
3. Turn the Rem into a Concept (Opt+Cmd+C), then unset it (Opt+Cmd+Q). It's a plain basic card again.
4. Practice it again in the Beautiful queue. It now shows "Question → Answer" on one line.
5. In `remnote.db`, the Rem's `quanta.doc` now holds `"type": null`. Before step 3 it had no `type` field.

**Real example:** Rem `Am6k9j4o9cTmKU4fM`, a forward basic card one level below its document. Its `type` is `null`. I pressed Opt+Cmd+Q on it today, and `type,u` changed to that moment, but the value stayed `null`.

## Cause, as read from the app bundle

The names below are my reading of the minified 1.29.6-beta code.

**1. The layout check is strict.** The basic-card predicate in the Beautiful queue helpers is:

```js
ex: ({isLastRem, rem}) => isLastRem && hasBackText(rem)
      && rem.type === RemType.DEFAULT_TYPE      // DEFAULT_TYPE = void 0
      && !rem.anyChildHasPowerup(MultiLineCard)
```

The Concept (`ET`) and Descriptor (`VS`) predicates test for `1` and `2`. A Rem with `type === null` matches none of them, so `renderKey` / `renderValue` fall through to `super.renderKey()` / `super.renderValue()`, which draw the classic "question → answer" row. The tree component uses the same `type === DEFAULT_TYPE` test to decide whether the card's row gets the detached-leaf layout (`renderAsDetachedCardLeaf`).

**2. Unsetting the type stores `null`.** `SetTypeToQuestion` ("Unset as Concept/Descriptor") sets the type to `DEFAULT_TYPE` (`undefined`). The value that gets saved and synced is `null`, while Rems that were never typed have no `type` field. In my knowledge base:

| `type` field | Rems with a back side |
|---|---|
| absent | 36,176 |
| `1` (Concept) | 10,657 |
| `2` (Descriptor) | 53,784 |
| `null` | 152 |

The most recent `null` was written today, so this is current behavior.

**3. Plugins can't set the default type.** The bridge handler is registered as `name:"setType"` with `signature: z.object({remId, type: z.nativeEnum(SetRemType)})`. `SetRemType.DEFAULT_TYPE` is `void 0`, and `z.nativeEnum` rejects `undefined`:

```
Plugin Error: [Invalid Method Arguments from incremental-everything]: rem.setType
type parameter: Required
```

Plugins can only set Concept and Descriptor.

## Suggested fixes

1. **In the queue:** treat a missing type and `null` the same way. `rem.type == null` (or `!rem.type`) in place of `rem.type === RemType.DEFAULT_TYPE` in the Beautiful queue predicates. Other code paths already compare types loosely (`e.type != p1.DEPRECATED_TEXT`). This fixes every existing Rem without a migration.
2. **When unsetting the type:** remove the field instead of storing `null`, or normalize `null` to `undefined` when loading.
3. **In the plugin bridge:** accept the default type in `rem.setType`, e.g. `z.nativeEnum(SetRemType).optional()` or a `z.union` that also allows `null`/`0`. The SDK documents `SetRemType.DEFAULT_TYPE` as a valid argument, but it can never pass the check.

I can share the database queries behind these numbers, or the list of affected Rem ids.
