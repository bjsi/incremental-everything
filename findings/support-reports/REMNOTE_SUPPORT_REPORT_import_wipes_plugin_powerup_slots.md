# Bug report: importing into a knowledge base that already uses a plugin erases the plugin's data on every imported Rem

**From:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Date:** 2026-11-03
**Version:** RemNote desktop 1.29.1-beta (macOS), and the web app

---

## Summary

If a plugin has run in a knowledge base, importing a `.rem` file (a document export or a full backup) into it deletes all the plugin powerup slot values on the imported Rems. The import itself brings them in intact. About two seconds after it finishes, RemNote merges the import's copy of each plugin powerup Rem into the existing one, and that merge clears the slots on every imported Rem.

Built-in powerups aren't affected. The data loss is silent: no error, and the Rems keep their plugin tags, so they just look like they were never set.

## Impact

For users of my plugin, the lost slots are their card priorities and their Incremental Reading schedules (next repetition date, priority, review history). Restoring a backup into a new knowledge base where the plugin was already enabled lost about 45,600 card priorities and the schedules of about 5,400 Incremental Rems. Any plugin that stores data in powerup slots is exposed in the same way.

## Steps to reproduce

1. In a knowledge base that uses a plugin with powerup slots, export a document whose Rems carry that powerup with slot values set.
2. Create a new knowledge base and enable the plugin there. Its powerup Rems are created on activation.
3. Import the `.rem` file.
4. Read the slot values on the imported Rems with `getPowerupProperty`, or in `remnote.db`. They are empty.

**Control:** create the knowledge base with the plugin **disabled**, import, then enable the plugin. Every value survives.

## Test results

All tests imported the same export: 5,064 Rems, of which 387 have a card priority and 444 an Incremental Reading next date.

| Test | Setup | Priorities erased | Next dates erased |
|---|---|---|---|
| test 5 | Desktop, plugin enabled before the import | 377 / 387 | 444 / 444 |
| test 7 | Web app, plugin enabled before the import | 386 / 387 | 444 / 444 |
| test 6 | Desktop, plugin enabled only after the import | **0 / 387** | **0 / 444** |

In tests 5 and 7, the few priorities not erased are ones my plugin rewrote a few seconds after the merge, when it noticed them missing. The merge cleared them too.

In tests 5 and 7, each plugin powerup Rem has a merge-history entry (`mh`) from right after the import. On every affected Rem, each cleared slot key's `,u` timestamp is the same millisecond as the removal of that Rem's tag to the merged-away powerup Rem (`tp.<mergedId>.,u`). In test 6 there's one powerup Rem per code and no merge.

Test 5 timeline (UTC):

| Time | Event |
|---|---|
| 07:35:44 | Plugin activates; its CardPriority powerup Rem `i3CKrmfrZd3akv7oS` is created |
| 07:38:35 | The import creates a second CardPriority powerup Rem, `Cp0uQsWEngTHeT6Qr` |
| 07:38:46 | Last imported Rem written |
| 07:38:48 | `Cp0u…` is merged into `i3CK…`; 381 priority slots and 454 schedule slots cleared |

## Cause, as read from the app bundle

The names below are my reading of the minified 1.29.1-beta code.

**1. The import duplicates plugin powerup Rems.** `importRemsToKnowledgeBase` maps an incoming Rem that has `rcrt` onto the existing powerup Rem through `getExistingCRTRem`, which calls `getRemForPowerup(code, kbId, /*returnIfUnregistered*/ true)`. The import runs in the heavy worker (`runHeavyWorkerFunction("importRemNoteJSON", …)`, chosen whenever `Worker` and `BroadcastChannel` exist), and plugin powerups aren't registered there. So the call returns nothing, and the import creates a second Rem with the same `rcrt`. Built-in powerups are registered everywhere, so they map correctly.

**2. The duplicate cleanup erases the instances' slots.** The next `getRemForPowerup` for the code finds both Rems. It keeps the oldest by `createdAt`, which is always the pre-existing one, because imported Rems are stamped with the import time. It then calls `mergeAll(others, false, /*allowPowerups*/ true)`. In `moveInformationToOtherRem`, each Rem tagged with the merged-away powerup Rem is moved with:

```js
await t.addTypeParent(kept, true)
await t.removeTypeParent(merged, true)   // 3rd parameter (clear slots) defaults to true
```

`removeTypeParent` takes the code the removed tag represents and, in the same update that sets `tp.<merged>.t = false`, deletes every `ps` and `psh` key that starts with `<code>_`. Slot values are keyed by code, not by tag Rem, so they belong just as much to the kept tag, which represents the same code. `addTypeParent` doesn't write `ps`, so nothing restores them.

The merge does carry over the slot values of the merged-away Rem itself (the `getAppliedPowerupCodes` / `setPowerupProperty` loop), but there's no step for its instances' values. For ordinary tags this code is harmless, because a tag without `rcrt` makes `removeTypeParent` clear nothing. Powerup Rems normally can't be merged at all ("You cannot merge a power-up bullet"), so the duplicate cleanup is the only path that reaches this.

## Suggested fixes

Either one prevents the loss:

1. **In the merge:** don't clear slots when the kept Rem represents the same code, e.g. `removeTypeParent(merged, true, kept.rcrt !== merged.rcrt)`.
2. **In the import:** map incoming plugin powerup Rems onto the existing Rem by `rcrt`, even when the powerup isn't registered in the worker, so no duplicate is created.

The first also protects any other way a duplicate might arise.

## Workaround I'm giving users

Restore a backup or import documents only into a knowledge base where the plugin has never been enabled. Enable it afterwards. There is no workaround for importing into a knowledge base that already uses the plugin.

I can share the test knowledge bases, the export file, or the database queries behind these numbers.
