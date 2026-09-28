# Follow-up: verification of the 1.27.24 fix, and what remains

**Reporter:** Hugo Marins — *Incremental Everything* plugin (`incremental-everything`, v1.0.35)
**Date:** 2026-08-07
**Re:** previous report — *Powerup property references re-pointed to orphaned slot Rems after the storage/sync overhaul*

This is a follow-up. It covers only what is new since that report: what 1.27.24 fixed, what it did not, and what we have since resolved on our own side. Everything below is measured across the same knowledge base (5,434 Incremental Rems, 45,078 CardPriority Rems).

---

## 1. Confirmed fixed by 1.27.24

| Defect | Before | After |
|---|---|---|
| Detached `Incremental` priority | 5,390 / 5,434 (99.2%) | **0** |
| Detached `CardPriority` priority | 3,001 / 45,078 (6.7%) | **0** |
| `Next Rep Date` slot references | ~2,231 unresolvable | **0** |

The migration re-pointed roughly 8,400 property→slot references, including the date properties. Thank you — this was the bulk of the problem.

The `getPowerupSlotByCode` message was also amended to "…although legacy slot Rem may still exist", which resolves the inaccuracy raised in §6 of the previous report.

---

## 2. Residual A — collapsed property pairs (2 Rems, now fixed by us)

Two Rems carrying **both** powerups had their two same-named `Priority` properties **merged into one**. The survivor was correctly linked to one powerup; the other powerup had no priority property at all.

| Rem | Surviving property links to | Powerup left with nothing |
|---|---|---|
| `gJiSum4KOK8YRaCmU` | `6eUpUKWrfZdU4nrgc` (CardPriority) | Incremental |
| `741rSQQHCazbKrttP` | `76Pb95h0XktNfDO7Y` (Incremental) | CardPriority |

In both cases the two priorities were **numerically identical** before the merge — necessarily so for `gJiSum4KOK8YRaCmU`, whose card priority was derived from its incremental priority (`Source: incremental`). That points at a de-duplication step that collapsed two properties judged equivalent by name *and* value.

Only 2 remain, and we have repaired both by rewriting the priority. **The concern is not the count but the rule:** the same de-duplication would silently destroy one of two *differing* priorities wherever the values were not equal.

---

## 3. Residual B — 376 properties referencing a DELETED slot Rem

This is the significant one, and it was not addressed by 1.27.24.

376 property Rems reference slot Rem **`JF0lnO7kCGbDrHRrt`**, which **does not exist** — `findOne` returns nothing. It is not a child of either powerup definition and is not one of the orphan slots identified previously.

The 1.27.24 migration repaired properties pointing at the *surviving* orphan slot (`VLmEpU417yLnZEMWf`). Properties pointing at a **deleted** slot were left as they were.

The consequence was that 376 CardPriority values remained unreadable. They did not appear as "detached" in any check keyed on known slot definitions — they were simply reported as **missing**, indistinguishable from a Rem that never had a priority set:

```
CardPriority: total 45,078 · ok 44,702 · detached 0 · missing 376
```

Of those 376: **21 had `prioritySource: manual`** — user-set values that nothing else held — and 354 were `inherited`.

We note this predates the fix: the same slot id was already unresolvable in a dump taken 2026-08-06, before 1.27.24 was installed.

---

## 4. OUTSTANDING — 2,033 dangling Daily Document references

**This is the one issue we cannot resolve and would like an answer on.**

`Next Rep Date` stores its value as a reference to a Daily Document. The property Rems and their slot links are now healthy, but the documents they point at are gone:

**2,033 of 5,394 (37.7%)** reference a Rem that no longer exists. RemNote's own property row renders as `Loading` indefinitely.

Broken down by the scheduling interval recorded in each Rem's history — i.e. how far ahead of the write date the reference pointed:

| Interval | Resolves | Dangling | Dangling |
|---|---|---|---|
| 0–1 days | 1,362 | 961 | 41.4% |
| 2–7 days | 204 | 109 | 34.8% |
| 8–30 days | 161 | 107 | 39.9% |
| 31–90 days | 50 | 72 | 59.0% |
| 90+ days | 7 | 146 | **95.4%** |
| (not recorded) | 1,553 | 636 | 29.1% |

The gradient is steep at the far end but the baseline is already ~41%, so "far-future documents were pruned" does not by itself account for it. A single mechanism that fits the whole curve: **empty Daily Documents did not survive, and survival tracks the probability that the document had content.** A document one day ahead is very likely a day the user actually opened RemNote; one ninety days ahead is almost certainly an auto-created, never-visited placeholder — and 95.4% of those are gone.

Supporting this, the missing targets are heavily **shared** rather than unique per Rem: `SiSUgRPP4AmE6VtYN` is referenced by 6 different Rems in our sample, `e7EeGUq2xn4AhdFsa` by 4, `RJX52l8YddImAH0UT` by 3. Whole dates disappeared, not individual references.

**Impact is limited only because our plugin independently stamps the next-repetition timestamp into its own history slot**, so the schedule survives and the affected Rems still come due correctly. 1,768 of the 2,033 (87%) are rebuildable from that stamp; 265 are not, because they predate the field. Any other plugin storing a date in a powerup slot, and any RemNote feature doing the same, would have no equivalent fallback.

### Questions

1. Were Daily Documents deleted as part of the migration — specifically empty, auto-created, future-dated ones?
2. **Can it recur?** This is what matters most to us. If empty daily documents are pruned again, every future-dated reference breaks again, and we would need to stop storing dates as Daily Document references altogether.
3. Is there any way to recover the deleted documents, or should we rebuild the references from our own history?

---

## 5. Also outstanding — orphan slot Rems on the powerup definitions

Unchanged since the previous report. The powerup definitions still carry slot children that this plugin never registered:

| Powerup | Slot Rem | Name |
|---|---|---|
| `Incremental` (`jhWSM9ZVkEx6uzLL4`) | `fAnEFqDe2zJwECi5N` | `Missing Name` |
| `Incremental` | `2q46PZilKAtrhRwGP` | `Missing Name` |
| `Incremental` | `YzfWfdh46cRFzlCOd` | `Missing Name` |
| `CardPriority` (`PAbc0mEVTzOTk5118`) | `VLmEpU417yLnZEMWf` | *(empty text)* |

Nothing points at them any longer, so they are inert. We would still like to know what they are and whether it is safe for a plugin to delete them.

---

## 6. What we resolved on our own side

Recorded here so you know the current state of this knowledge base, and in case it is useful for other affected users.

1. **Recovered the 21 manual CardPriority values** by reading the value from the mis-pointed property Rem and rewriting it through the normal write path, preserving the original `prioritySource` and `lastUpdated`. Each write was verified to read back. 21/21 succeeded.
2. **Re-materialised the 354 inherited values** using our own "Update all inherited Card Priorities" command, which recomputes from the ancestor cascade and skips manual values. This also cleared the remaining `missing` count: 376 → **0**.
3. **Deleted the 370 orphaned property Rems**, in stages — 3 first, verified, then the rest. Each deletion was individually guarded (refused unless the owner's priority already read back) and recorded the owner's state either side. Result: **370 deleted, 0 disturbed**. Deleting a mis-pointed property does not affect the correctly-linked one.

Final state:

```
Incremental    5,434 total · detached 0 · missing 40
CardPriority  45,078 total · detached 0 · missing 0
Leftover priority properties: 0
Next Rep Date: 2,033 dangling  ← the only outstanding data issue
```

---

## Summary

1.27.24 resolved the reference detachment. Two classes of residue remained — collapsed property pairs, and properties pointing at a deleted slot Rem — and we have repaired both locally; they are reported here because the underlying rules could affect other users.

The dangling Daily Document references are the one outstanding problem, and the only one where data is genuinely unrecoverable from the property itself. Whether it can recur is the question that determines whether we change how this plugin stores dates.
