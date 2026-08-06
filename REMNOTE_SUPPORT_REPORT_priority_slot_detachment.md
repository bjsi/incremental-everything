# Powerup property references re-pointed to orphaned slot Rems after the storage/sync overhaul

**Reporter:** Hugo Marins — *Incremental Everything* plugin (`incremental-everything`, v1.0.34)
**SDK:** `@remnote/plugin-sdk` ^0.0.46
**RemNote build:** _(to be filled in — desktop build on which the dump below was taken)_
**Date of evidence:** 2026-08-06
**Severity:** Data is intact but unreadable through the plugin API. No data loss; silent wrong values presented to the user.

---

## 1. Summary

On Rems that carried the plugin's `Incremental` powerup **before** RemNote's storage/sync overhaul, the `Priority` property is no longer readable via `getPowerupProperty('incremental', 'priority')`, which returns empty.

The value has **not** been lost. It is still stored on the Rem, in the `backText` of its property Rem. What changed is the *link*: that property Rem's slot reference now points at a **nameless slot Rem that is a child of a different powerup definition** (`CardPriority`) instead of the registered `Incremental` → `Priority` slot.

Because the plugin resolves the property by walking the registered slot, it finds nothing and falls back to a default — so the user sees a fabricated priority (P10 under the old code) while the real value sits on the Rem unread.

Rems created *after* the overhaul are unaffected, and rewriting the priority on an affected Rem restores it (§3.6) — both consistent with a migration artifact rather than a live write-path defect.

Three further findings are included below:

- orphaned slot Rems present on the powerup definitions themselves (§4);
- **dangling Daily Document references on `Next Rep Date` (§5)** — a separate fault where, unlike the above, the value is genuinely unrecoverable from the property;
- the current `getPowerupSlotByCode` error message not matching observed behaviour (§6).

---

## 2. Symptom as seen by the user

A Rem whose priority was set to **17** displays as **P10**, and RemNote's own outliner renders its property row under an **unnamed** slot:

```
• ARPA, que consiste em um radar de navegação comum, …          [P10]
    📅 July 8th, 2026
    • Unnamed — 17
```

The `17` in that row is the correct value. The `10` is the plugin's read fallback for an unreadable slot.

---

## 3. Primary finding — the property reference points at another powerup's orphan slot

Diagnostic Rem: `I4pm1fkBWzvgCdI5n`

### 3.1 The stored value is intact

```json
{
  "propertyRemId":      "vAwvSXgSc3pUNGTxO",
  "rawValue":           "17",
  "slotReferenceLabel": "[Untitled]",
  "slotDefIds":         ["VLmEpU417yLnZEMWf"],
  "slotDefNames":       ["Untitled"],
  "matchedPowerup":     null,
  "matchedSlotCode":    null,
  "apiValue":           null,
  "verdict":            "DETACHED"
}
```

- `rawValue` is read directly from the property Rem's `backText` — this is the stored value: **17**.
- `apiValue` is what `getPowerupProperty('incremental', 'priority')` returns: **empty**.

### 3.2 The slot it references belongs to a different powerup

`VLmEpU417yLnZEMWf` is **not** the registered `Incremental` → `Priority` slot. The registered one is `76Pb95h0XktNfDO7Y`. `VLmEpU417yLnZEMWf` appears as a slot child of the **`CardPriority`** powerup (`PAbc0mEVTzOTk5118`):

```json
"CardPriority": {
  "powerupRemId": "PAbc0mEVTzOTk5118",
  "actualSlotChildren": [
    { "id": "hgwNbXh4gypyUH5uR", "name": "Priority Source" },
    { "id": "we4WQ5lsyor2D1j08", "name": "Last Updated" },
    { "id": "VLmEpU417yLnZEMWf", "name": "" },          ← referenced by the Incremental property above
    { "id": "6eUpUKWrfZdU4nrgc", "name": "Priority" }
  ]
}
```

So an `Incremental` property on a user Rem now resolves through a nameless slot Rem parented under `CardPriority`.

Both powerups declare a slot displayed as **"Priority"** (`incremental:priority` and `cardPriority:priority`). A migration step that keyed on slot display name rather than on the owning powerup would produce exactly this result. This is a hypothesis, not a claim — the observation is the mis-pointed reference.

### 3.3 A sibling property on the same Rem is undamaged

The `Next Rep Date` property on the same Rem resolved correctly, which isolates the fault to the `Priority` reference rather than to the Rem as a whole:

```json
{
  "propertyRemId":      "RtpNKSweZbmiP4bsS",
  "rawValue":           "July 8th, 2026",
  "slotReferenceLabel": "[Next Rep Date]",
  "slotDefIds":         ["o9GwvFHCn3AH6MAFB"],
  "matchedPowerup":     "Incremental",
  "matchedSlotCode":    "nextRepDate",
  "apiValue":           "July 8th, 2026",
  "verdict":            "OK"
}
```

### 3.4 Independent corroboration that 17 is the correct value

The Rem's `History` slot is readable and records the priority at each repetition. Its last entry confirms 17:

```json
[
  { "date": 1783414230669, "eventType": "madeIncremental",     "priority": 20, "nextRepMs": 1783500630637 },
  { "date": 1783414237796, "eventType": "rescheduledInEditor", "priority": 17, "nextRepMs": 1783500637796 }
]
```

Value in `backText` (17) and value in history (17) agree. The API read (empty) is the outlier.

---

### 3.5 Control — a Rem created after the overhaul is structurally identical and healthy

Rem `IDWpFTp6pC8mkoqro` ("New Inc Rem for test"), created 2026-08-06, dumped from the same knowledge base under the same powerup definitions:

```json
{
  "propertyRemId":      "6LkzHevmU1TUN8lZJ",
  "rawValue":           "26",
  "slotReferenceLabel": "[Priority]",
  "slotDefIds":         ["76Pb95h0XktNfDO7Y"],
  "matchedPowerup":     "Incremental",
  "matchedSlotCode":    "priority",
  "apiValue":           "26",
  "verdict":            "OK"
}
```

This is the same shape as the damaged Rem — one property Rem per visible slot, value in `backText` — differing only in which slot definition the reference points at: `76Pb95h0XktNfDO7Y` (registered, correct) versus `VLmEpU417yLnZEMWf` (nameless orphan under another powerup).

Both Rems report `childCount: 2`. Nothing is missing from the damaged Rem, and its property Rem is not malformed. **The only defect is the target of the reference.**

Two conclusions follow:

1. **The current write path is healthy.** `setPowerupProperty` resolves the registered slot correctly today. The defect is confined to references written before or rewritten during the migration; it is not being reproduced on new writes.
2. **The orphaned slot Rems in §4 are not, by themselves, sufficient to cause the fault.** They were present in the definitions when this Rem was created, and it was written correctly anyway. The orphans and the mis-pointed reference are related but distinct findings.

---

### 3.6 Population, and a confirmed repair

Every pre-overhaul Incremental Rem examined shows the same defect, and every one of them points at the **same** orphan slot `VLmEpU417yLnZEMWf`:

| Rem | Property Rem | Stored value | API read | Last priority in history |
|---|---|---|---|---|
| `I4pm1fkBWzvgCdI5n` | `vAwvSXgSc3pUNGTxO` | `17` | empty | 17 |
| `kPXiWgXG9wzR3oSJZ` | `HAphrUvpVO1Q3PP1r` | `12` | empty | 12 |
| `zO8KahzIJYeAEbqjj` | `j6shjpLjE3O4PDNQ0` | `20` | empty | 20 |
| `IDWpFTp6pC8mkoqro` (post-overhaul) | `6LkzHevmU1TUN8lZJ` | `26` | `26` ✓ | 26 |

In all three damaged cases the stored value agrees with the last priority recorded in the Rem's own history, which independently corroborates that these are the correct values and that nothing rewrote them.

**Rewriting the property repairs the Rem.** Writing a new priority through the normal `setPowerupProperty` path was tested on two Rems, with dumps taken immediately before and after:

```
BEFORE  childCount: 2
  j6shjpLjE3O4PDNQ0  "20"  [Untitled] -> VLmEpU417yLnZEMWf   apiValue null   DETACHED

AFTER (priority set to 21)   childCount: 3
  Zme22i7Jrns88LQkA  "21"  [Priority] -> 76Pb95h0XktNfDO7Y   apiValue "21"   OK
  j6shjpLjE3O4PDNQ0  "20"  [Untitled] -> VLmEpU417yLnZEMWf   apiValue null   DETACHED
```

The write creates a **new**, correctly-referenced property Rem rather than repairing or replacing the mis-pointed one, which is then **left behind**. The user sees it in the outliner as a stray `Unnamed — 20` row, and `childCount` grows permanently by one per repaired Rem.

---

## 4. Secondary finding — orphaned slot Rems on the powerup definitions

The plugin declares each slot exactly once, in a single `registerPowerup` call per powerup, and has no code path that creates a second slot. The live powerup definitions nevertheless carry more slot children than were registered.

### `Incremental` (`jhWSM9ZVkEx6uzLL4`) — 5 registered, **7 present**

| Slot Rem id | Name | Matches a registered slot? |
|---|---|---|
| `76Pb95h0XktNfDO7Y` | `Priority` | yes |
| `o9GwvFHCn3AH6MAFB` | `Next Rep Date` | yes |
| `rY5dBJhTFnZVEkD90` | `History` | yes |
| `eyPosVf8lYEfAr18t` | `Created` | yes |
| `fAnEFqDe2zJwECi5N` | `Missing Name` | no |
| `2q46PZilKAtrhRwGP` | `Missing Name` | no |
| `YzfWfdh46cRFzlCOd` | `Missing Name` | no |

`"Missing Name"` is the literal text stored in those Rems, not a placeholder introduced by our diagnostic — the diagnostic reports genuinely empty text as `""`.

The fifth registered slot, `Reading State` (code `pdfState`), does **not** appear under its registered name and could not be resolved by name. It is hidden, and it was registered on 2026-08-06 — i.e. after the overhaul — so its absence as a named Rem is consistent with the new model described in §6, where hidden slots are not represented as Rems. On that reading it accounts for none of the three `Missing Name` entries.

Even allowing generously that one of the three is `Reading State`, **at least two slot Rems under `Incremental` correspond to nothing this plugin has ever registered.** We verified against the full git history of `register/powerups.tsx` that the Incremental powerup has only ever declared these five slot codes — `priority`, `nextRepDate`, `repHist`, `originalIncDate`, `pdfState` — so these are not the residue of slots we registered and later removed.

### `CardPriority` (`PAbc0mEVTzOTk5118`) — 3 registered, **4 present**

All three registered slots are present and correctly named. The extra one is `VLmEpU417yLnZEMWf`, with empty text — the same Rem the damaged `Incremental` property in §3 points at.

### `Dismissed` (`kllsK59tpaXG19XFI`) — 2 registered, 2 present, both correct

Undamaged, and included as a control.

---

## 5. Third finding — dangling Daily Document references on `Next Rep Date`

A separate and independent fault appears on the same class of Rems. `Next Rep Date` stores its value as a **reference to a Daily Document**. On one of the three pre-overhaul Rems that reference no longer resolves:

| Rem | Scheduled for | Reference target | Resolves? |
|---|---|---|---|
| `zO8KahzIJYeAEbqjj` | 2026-07-08 (interval 1) | `AN9vCK2NGI8P23AZO` | yes — daily doc, `Date` = `2026-07-08` |
| `I4pm1fkBWzvgCdI5n` | 2026-07-08 (interval 1) | resolves | yes |
| `kPXiWgXG9wzR3oSJZ` | 2026-08-06 (interval 30) | `oaxQNwxWzYTrzRI3o` | **no — target not found** |

Here the property Rem and its slot link are both **healthy** — it correctly references the registered `Next Rep Date` slot `o9GwvFHCn3AH6MAFB`. The failure is in the value: the Daily Document it points at cannot be resolved, so `getPowerupProperty` returns empty and RemNote's own property row renders as `Loading` indefinitely.

This is materially different from §3. There the value survives on the Rem and can be recovered; here the referenced Rem is simply gone, and the scheduled date is unrecoverable from the property itself. (Our plugin survives it only because it independently stamps the next-repetition timestamp into its own history slot and falls back to that.)

The correlation across the sample is suggestive but not conclusive at n=1 for the failing case: the two references that resolve point at a daily document **one day** ahead of when they were written, while the one that fails pointed **30 days** ahead, to a date that was still in the future at the time. A plausible mechanism is that empty, programmatically-created future daily documents did not survive the migration, orphaning every reference to them. If that is what happened, the scope would be considerably wider than §3, since it would affect any Rem scheduled far enough ahead — for this plugin, that is a large fraction of a mature knowledge base.

We would rather RemNote confirm or rule this out than guess at it.

---

## 6. Fourth finding — `getPowerupSlotByCode` behaviour and error text

`getPowerupSlotByCode` now rejects for a subset of slots with:

> `Plugin Error: Internal API Error: Error: getPowerupSlotByCode only supports visible plugin powerup slots: built-in and hidden slots are not represented as Rem. Use getPowerupProperty or getPowerupPropertyAsRichText to read slot values instead.`

Measured behaviour matches the visible/hidden split precisely, against the plugin's own `hidden: true` registration flags:

| Powerup | Slot | Registered `hidden` | `getPowerupSlotByCode` |
|---|---|---|---|
| Incremental | `priority` (Priority) | — | resolves `76Pb95h0XktNfDO7Y` |
| Incremental | `nextRepDate` (Next Rep Date) | — | resolves `o9GwvFHCn3AH6MAFB` |
| Incremental | `repHist` (History) | `true` | throws |
| Incremental | `originalIncDate` (Created) | `true` | throws |
| Incremental | `pdfState` (Reading State) | `true` | throws |
| CardPriority | `priority` (Priority) | — | resolves `6eUpUKWrfZdU4nrgc` |
| CardPriority | `prioritySource` | `true` | throws |
| CardPriority | `lastUpdated` | `true` | throws |
| Dismissed | `dismissedHistory`, `dismissedDate` | `true` | throws |

**The message's premise does not match the current data, though the discrepancy may be transitional.** It states that hidden slots "are not represented as Rem". Walking the powerup Rem's children and filtering on `isPowerupSlot()` nevertheless returns every one of them, with correct names and ids —

- `repHist` → `rY5dBJhTFnZVEkD90` (`History`)
- `originalIncDate` → `eyPosVf8lYEfAr18t` (`Created`)
- `cardPriority:prioritySource` → `hgwNbXh4gypyUH5uR` (`Priority Source`)
- `cardPriority:lastUpdated` → `we4WQ5lsyor2D1j08` (`Last Updated`)
- `dismissed:*` → `vPe7uIq5I5BG1GCv7`, `vji3juTs0R47PS8DA`

Only this accessor declines to return them.

A consistent explanation is that these are **legacy artifacts**: hidden slots registered *before* the overhaul still have their Rems, while hidden slots registered *after* it no longer materialise one. Our `Reading State` slot (§4), registered 2026-08-06, has no Rem under any name — exactly what the new model predicts, and in contrast to `History` and `Created`, which predate the change and still do.

If that is right, the message describes the intended end state while the transitional reality differs, and plugin authors reading it would wrongly conclude these Rems are already gone. Confirmation either way would be useful: whether the surviving hidden-slot Rems are scheduled for cleanup, and whether resolving them via the children walk is a supported path in the meantime or one that will stop working.

---

## 7. Why only the `Priority` property was affected

The dump shows a structural asymmetry between visible and hidden slots that explains the blast radius.

For the diagnostic Rem, `childCount` is **2** — it has exactly two property child Rems, for the two **visible** slots (`Priority`, `Next Rep Date`). The **hidden** slots (`History`, `Created`) read back correctly through `getPowerupProperty` while having **no property child Rem at all**:

| Slot | Visibility | Property child Rem | API read |
|---|---|---|---|
| `priority` | visible | `vAwvSXgSc3pUNGTxO` | **empty (broken)** |
| `nextRepDate` | visible | `RtpNKSweZbmiP4bsS` | OK |
| `repHist` | hidden | none | OK |
| `originalIncDate` | hidden | none | OK |
| `pdfState` | hidden | none | empty (never set) |

Hidden-slot values migrated off the Rem entirely and are unaffected. Visible-slot values still live in a property child Rem whose reference must resolve to the right slot definition — and it is precisely one of those references that was re-pointed.

The control Rem in §3.5 shows the identical layout (`childCount: 2`, no property Rem for the hidden slots), confirming this is the normal post-overhaul structure rather than a symptom. Only visible slots carry a reference that can be mis-pointed, which bounds the exposure to `Priority` and `Next Rep Date`.

---

## 8. Ruled out on the plugin side

- **No write path can produce this.** The plugin writes the Priority slot at exactly three call sites, each with an explicit value, all via `setPowerupProperty(powerupCode, prioritySlotCode, …)`. None can emit an incorrect value, and none can alter a property Rem's slot reference.
- **The plugin never creates duplicate or nameless slot Rems.** Slots are declared once per powerup in `registerPowerup`.
- **The displayed `10` was our own read fallback**, not stored data — confirmed by `apiValue: null` against `rawValue: "17"`. It was never written back to the slot. (We have since replaced that silent fallback with an explicit provenance flag, and now recover the value from the Rem's history when the slot is unreadable, so affected users see the correct number again. This is a workaround for the symptom; the underlying reference is still mis-pointed and we have not written to it.)

---

## 9. Impact

- Priority is the plugin's core scheduling input. An unreadable slot silently substitutes a default, which changes queue ordering and review weighting for every affected Rem.
- The value presented to the user is wrong while the correct value remains on the Rem, so the fault is not visible as data loss and is easy to mistake for a plugin defect.
- The reporting user observes this across Rems created before the overhaul; Rems created after it are unaffected. The evidence in this report is a full trace of one representative Rem.
- Any plugin reading a **visible** powerup slot on pre-overhaul Rems is potentially exposed to the same failure, not only this one.

---

## 10. Reproducing the diagnostic

The dump is produced read-only by the plugin's own tooling (`src/lib/raw_slot_dump.ts`), which bypasses `getPowerupProperty` and reads the property Rems directly:

1. Focus an affected Rem.
2. Run the command **"Debug: Dump Raw Powerup Slots (console)"**, or use **Dump Raw Slots** in the plugin's debug widget.
3. It emits JSON containing, per property Rem: the value from `backText`, the slot definition its `text` references (id and name), whether that id matches the registered slot, and the corresponding `getPowerupProperty` result.

Full JSON dumps for Rem `I4pm1fkBWzvgCdI5n` are attached.

---

## 11. Questions for RemNote

1. Can the storage/sync migration re-point a powerup property's slot reference to a slot Rem belonging to a **different** powerup? The two powerups here share the display name "Priority", which would be consistent with name-keyed matching during migration.
2. What are the nameless / `Missing Name` slot Rems now attached to these powerup definitions, and is it safe for a plugin to delete them?
3. Rewriting the priority repairs the read but leaves the mis-pointed property Rem behind (§3.6). Is it safe for the plugin to delete those orphaned property Rems outright as part of a repair pass, or is there a supported way to re-point an existing property Rem at the correct slot definition so no debris is created?

4. Are the dangling Daily Document references in §5 a known consequence of the migration, and specifically were empty future-dated daily documents pruned? This determines whether affected users have lost scheduled dates at scale or only in isolated cases.
5. Is the `getPowerupSlotByCode` restriction to visible slots intended to be permanent? If so, the message's claim that hidden slots "are not represented as Rem" should be corrected, since they remain reachable and resolvable via the powerup's children.
6. Is a corrective migration planned on RemNote's side? If so we will hold off on any repair pass of our own to avoid conflicting writes.

---

## Appendix — identifier reference

| Id | What it is |
|---|---|
| `I4pm1fkBWzvgCdI5n` | Diagnostic user Rem (pre-overhaul) |
| `vAwvSXgSc3pUNGTxO` | Its `Priority` property Rem — `backText` = `17`, reference broken |
| `RtpNKSweZbmiP4bsS` | Its `Next Rep Date` property Rem — intact |
| `IDWpFTp6pC8mkoqro` | Control Rem, created post-overhaul — fully healthy |
| `6LkzHevmU1TUN8lZJ` | Its `Priority` property Rem — correctly references `76Pb95h0XktNfDO7Y` |
| `kPXiWgXG9wzR3oSJZ` | Second affected Rem — `Priority` detached (`12`) **and** dangling date reference |
| `oaxQNwxWzYTrzRI3o` | Its `Next Rep Date` target — **does not exist** (was 2026-08-06, 30 days ahead) |
| `zO8KahzIJYeAEbqjj` | Third affected Rem — repair test subject (before/after dumps) |
| `j6shjpLjE3O4PDNQ0` | Its original detached `Priority` property (`20`) — left behind after repair |
| `Zme22i7Jrns88LQkA` | The new, correctly-referenced `Priority` property (`21`) created by the repair |
| `AN9vCK2NGI8P23AZO` | Its `Next Rep Date` target — exists, daily doc `2026-07-08`, resolves fine |
| `jhWSM9ZVkEx6uzLL4` | `Incremental` powerup definition (7 slot children, 5 registered) |
| `76Pb95h0XktNfDO7Y` | Registered `Incremental` → `Priority` slot (**expected** target) |
| `PAbc0mEVTzOTk5118` | `CardPriority` powerup definition (4 slot children, 3 registered) |
| `VLmEpU417yLnZEMWf` | Nameless orphan slot under `CardPriority` (**actual** target) |
| `fAnEFqDe2zJwECi5N`, `2q46PZilKAtrhRwGP`, `YzfWfdh46cRFzlCOd` | `Missing Name` orphan slots under `Incremental` |
| `kllsK59tpaXG19XFI` | `Dismissed` powerup definition — undamaged control |
