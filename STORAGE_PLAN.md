# Plugin storage plan

Working document for reducing what Incremental RemNote keeps in RemNote's plugin synced storage. Pick it up at "Phases" — the sections above it exist so the decisions don't have to be re-derived.

Last measured: **2026-08-05**. Last updated: 2026-08-05 (Phases 2, 3 and 5 done).

---

## 1. Why this exists

RemNote 1.27.16 introduced plugin safeguards that broke the plugin outright. After the reports, 1.27.20 walked most of them back. Current state:

| Limit | Status |
|---|---|
| **900 KB per synced value** | **Enforced.** The only hard constraint. |
| 1000 synced keys | Warning only ("for now") |
| 10 MB total synced footprint | Warning only ("for now") |
| Powerup tag / relationship ceiling | Temporarily raised 5,000 → 100,000 |
| `card.getAll()` / `rem.getAll()` | Restored, with deprecation warnings |

RemNote have said they are building "a safer replacement for full-database enumeration" and intend to re-introduce limits once authors have workable APIs. **So the pressure is off, but the direction is signposted.** This work is no longer urgent; it is preparation, to be done on our schedule and before re-enforcement.

Two capabilities are still missing and shape everything below:

- **There is no way to delete a synced key.** `setSynced(key, null)` does *not* free the slot — verified by experiment (write a new key at the cap, null an existing one, retry: still rejected). Every key ever written is permanent until RemNote ships a deletion API.
- **There is no way to enumerate keys.** The audit tool works by *reconstructing* candidate key names from the knowledge base and probing each one, so keys whose rem was deleted can never be named. Those are the "unaccounted" orphans.

---

## 2. Current measurements

From the Synced Storage Key Audit (Debug Widget → `Debug Incremental RemNote` → **Scan Keys**), 2026-08-05:

- **841 live keys** of the 1000 advisory ceiling (840 distinct — the review-graph key is counted in two families)
- **2.16 MB** total, 21.6% of the 10 MB advisory budget
- **~159 unaccounted** orphans (down from ~352, because `rem.getAll()` was restored and full enumeration could finally name them)
- 399,071 rems scanned, 3.6M probes, **424s**

| Family | Live keys | Size | Disposition |
|---|---:|---:|---|
| Fixed keys (current) | 16 | 1.36 MB | stays |
| Known PDF rems index | 108 | 562.6 KB | → local |
| PDF page history | 150 | 156.4 KB | → rem property |
| List-break snapshots | 42 | 57.5 KB | → rem property |
| Priority distribution graph data | 11 | 21.8 KB | → local |
| Debug history backups | 3 | 6.7 KB | → rem property |
| PDF page range | 204 | 4.4 KB | → rem property |
| Parent-selector last dest (IncRem) | 114 | 2.1 KB | → rem property |
| Review graph data | 1 | 1.5 KB | → graph rem |
| Parent-selector last dest (PDF) | 47 | 893 B | → rem property |
| Sorting settings (per KB) | 8 | 499 B | stays |
| Known HTML rems index | 19 | 399 B | → local |
| PDF current page | 101 | 193 B | → rem property |
| Active PDF for IncRem | 9 | 171 B | → rem property |
| Video position / playback rate | 4 | 54 B | → rem property |
| Legacy globals (read-only) | 3 | 29 B | stays |

Largest individual keys, against the **enforced** 900 KB ceiling:

| Key | Size | % of ceiling |
|---|---:|---:|
| `flashcardHistoryData` | 518.9 KB | 57.7% |
| `authoritativeDailyAggregates` | 300.8 KB | 33.4% |
| `known_pdf_rems_D2hDszekc6pYb8bVz` | 183.3 KB | 20.4% |
| `remData` | 129.2 KB | 14.4% |
| `document-priority-shield-history-key` | 120.1 KB | 13.3% |
| `document-card-priority-shield-history-key` | 111.9 KB | 12.4% |

**Nothing is currently at risk of the one enforced limit.**

---

## 3. The design rule

For every piece of state, ask:

> **If this key vanished right now, could the plugin reconstruct it from data RemNote already syncs?**

- **Yes → it is a cache.** Belongs in `plugin.storage.setLocal` (persists per device, unsynced, outside the plugin quota). Losing it costs latency, never data.
- **No → it is the only copy.** Belongs on the rem it describes (hidden powerup property) or, if it is genuinely global, in synced storage with a bound on its growth.

Applied to what we have:

**Caches** — `known_pdf_rems_*` (source of truth is `rem.getSources()`), `known_html_rems_*`, `priority_graph_data_*` (computed from the IncRem + card-priority session caches, already regenerated on demand).

**Only copies** — page position / range / history, parent-selector destinations, list-break snapshots, video positions, debug backups, shield history, and `priority_review_graph_data_*` (a point-in-time snapshot from review-document creation; recomputing later yields different numbers — *not* the same thing as `priority_graph_data_*` despite the similar name).

Guidance from RemNote (Nate) that this follows: put per-rem state on the rem via hidden powerup properties; keep rebuildable indexes in local/session storage; don't build one giant JSON blob under a single key; version any JSON property and bound its history; migrate read-through — check the property, fall back to the legacy key, write the property on the way past.

---

## 4. Decisions already taken

Recorded so they aren't re-litigated.

**A `pdfLinks` property was designed and then dropped.** It existed to make the rem↔PDF association survive removal of the PDF source. On inspection the benefit was thin and the cost real — see below. Without that requirement, the index is a pure cache and `setLocal` is simpler and cheaper than any property.

**"Keep the rem in `known_pdf_rems_*` after its PDF source is removed" was considered and rejected.** What the code does today: association is defined solely by `rem.getSources()` ([`findPDFinRem`](src/lib/pdfUtils.ts#L553)), and [`getInstantRemsForPDF`](src/lib/pdfUtils.ts#L860) — Page Range's first phase — verifies every entry and then overwrites the index with only the verified ids. So a detached chapter is dropped. Retaining it would gain only visibility from the PDF side (the rem stops being a reading item anyway once the source is gone, since `getAllPDFsInRem` finds nothing), while making the index unable to self-heal and creating a real hazard: [`findIncRemFast`](src/lib/pdfUtils.ts#L458) returns the first known rem carrying the Incremental powerup **without checking sources**, so a deliberately-retained stale entry could resolve as "the IncRem for this PDF" and open the wrong chapter.

The underlying goal — *don't lose the reading history when a chapter is detached* — is delivered instead by moving page/range/history onto the rem itself (Phase 3), where it travels with the rem regardless of sources.

**Doc-level shield histories will not be migrated.** They are 120.1 KB and 111.9 KB — 13% of the enforced ceiling — and migrating means tagging the user's own documents with a plugin powerup, which is visible in their editor. They get a retention window instead. Revisit only if they approach 50%.

---

## 5. Already shipped (v1.0.30)

- **`authoritativeDailyAggregates` compacted** — was 1.21 MB (137% of the ceiling, so every write was being silently rejected and the Study Dashboard's lifetime stats were frozen). Now stored `kbId → date → positional row` instead of an array of named-field objects: **1.21 MB → 300.8 KB**, no history lost. Reads accept either shape; a startup pass rewrites the legacy value in place. See [`authoritative_aggregates.ts`](src/lib/authoritative_aggregates.ts).
- **Row-expansion state removed from synced storage** in the three history widgets. Each chevron click had been rewriting the whole array (>500 KB for Flashcard History).
- **Text caps** — flashcard history 500 chars/side; visited-rem history 200 (its writer previously had *no* cap while its own backfill truncated at 200).
- **The audit tool itself** — [`synced_key_audit.ts`](src/lib/synced_key_audit.ts) + the Debug Widget section.

---

## 6. Phases

Ordered by value now that only the 900 KB per-value limit is enforced.

### ▶ Phase 1 — Cache families to local storage
**Removes ~138 keys, ~585 KB. No user data moves; nothing to migrate.**

`known_pdf_rems_*` (108), `known_html_rems_*` (19), `priority_graph_data_*` (11) → `plugin.storage.setLocal`.

Accept knowingly: the rebuild is the existing "slow phase" full-tree walk, so a new device pays it once per PDF. Local (not session) storage keeps that cost paid once per device. A rebuild also silently drops the historical pollution in the large keys — that 183 KB entry is mostly junk from an old bug, and nothing derivable will reproduce it.

### ✅ Phase 2 — Fix `findIncRemFast` source verification *(done)*
It resolved "the IncRem for this PDF" from the known-rems index without confirming the candidate still had the PDF as a source, so a detached chapter could be returned — and would beat a correctly-sourced rem sitting later in the same list. Now verifies with `findPDFinRem`, the same predicate `getInstantRemsForPDF` uses, after the cheap `hasPowerup` filter. Stale ids are skipped and counted in a log line (a useful measure of how polluted a PDF's index is), not deleted: this is a read path, and pruning stays owned by the self-heal.

### ✅ Phase 3 — PDF reading state onto the rem *(done)*
**Removes ~464 keys, ~161 KB.** Also delivers history durability for detached chapters.

State lives in [`pdf_state.ts`](src/lib/pdf_state.ts) as `{v:1, active?, bySource: {[pdfRemId]: {page, range, history}}}` in one hidden, `onlyProgrammaticModifying` slot — collapsing current page, page range, page history *and* active PDF into a single property per Rem, however many PDFs it draws on. History keeps its 100-entry cap per source.

**The slot is registered on BOTH the Incremental and Dismissed powerups**, same code, same shape. Dismissal removes the Incremental powerup, which would take the property with it, so `transferToDismissed` copies the serialized string across — after the Dismissed powerup is attached, before the caller removes the Incremental one. `initIncrementalRem` reads it back off the Dismissed powerup *before* `mergeHistoryFromDismissed` deletes that powerup, then writes it once the Incremental powerup is attached. Because both sides share a shape, transfer is a string copy; re-dismissal merges per source with the newer value winning.

A separate slot rather than folding into the history slot: that slot holds `IncrementalRep[]`, read by ~8 modules that all do `tryParseJson(raw) || []` and assume every element is a rep. Wrapping or polluting it would break all of them, for no gain.

Reads migrate per (Rem, PDF) pair on the way past — the legacy key names cannot be enumerated without knowing both ids, so migration is necessarily lazy. Legacy keys are blanked (not deleted — no API) by `clearIncrementalPDFData` and `clearIncrementalPageRange`, so a clear cannot be undone by the fallback resurrecting the old value.

All call sites now route through the accessors in `pdfUtils`, whose signatures are unchanged: three widgets and two libs that wrote the legacy keys directly were converted, and `setPageHistory` / `clearIncrementalPageRange` were added for the two operations that had no accessor. The debug inflation tool's "no key present → skip" check became "empty history → skip", since a migrated Rem legitimately has no legacy key.

**Not done: write debouncing.** A page turn is still one write, now a Rem edit rather than a storage write. Debouncing needs a cross-iframe-safe pending buffer — each widget iframe holds its own module instance, so a naive module-level buffer would make the Reader and the Page Range panel disagree. Revisit if sync churn shows up in practice.

**Known gap:** a Rem dismissed with *no* review history returns early from `transferToDismissed` and never gains the Dismissed powerup, so its reading state is not preserved. Matches how history itself behaves.

### ⏸ Phase 4 — Small per-rem families
Parent-selector destinations (114 IncRem + 47 PDF), list-break snapshots (42), debug backups (3), video positions (4). **~210 keys.** The PDF-keyed parent-selector variant needs a home on the PDF rem.

### ✅ Phase 5 — Review-graph snapshot onto its graph rem *(done)*
The snapshot now lives in a hidden, programmatic-only `graphData` slot on the **existing** Priority Review Graph powerup the graph Rem already carries — so no new powerup and no extra tagging. Deleting the review document now takes its graph data with it, which is the point: the orphan problem disappears rather than being swept up afterwards.

Reads go property-first, fall back to the legacy `priority_review_graph_data_*` key, and migrate it onto the Rem on the way past — no bulk pass, so pre-existing documents move themselves the first time they are opened. Both historical value shapes (bare bin array, and the later object) are normalized in one place. A malformed property falls back to the legacy key rather than blanking a graph the user can still see.

New code in [`graph_data.ts`](src/lib/priority_review_document/graph_data.ts). `registerReviewGraphKey` is deleted (nothing registers new entries now); `cleanupOrphanedReviewGraphs` stays as a legacy sweep and is documented as such — it can only blank values, never free slots.

Legacy keys are left in place: there is still no deletion API, so they wait for Phase 7.

### ⏸ Phase 6 — Retention, not migration
The two doc-level shield keys have **no pruning at all** — add a retention window. Plus the daily-aggregate rollup (daily for ~2 years, monthly before that).

### ⏸ Phase 7 — Legacy ledger
Record migrated key names so a future deletion API can sweep them in one pass. Nothing can be reclaimed before that API exists.

**End state:** roughly 27 synced keys — 16 fixed, 8 per-KB sorting, 3 legacy — none of which grow with the size of the knowledge base.

---

## 7. Watch list

- **`flashcardHistoryData`, 518.9 KB (58%)** — the largest key and the closest to the enforced ceiling. Hard-capped at 1000 entries, and the 500-char text cap should pull it toward ~300–350 KB as entries are rewritten. Re-measure before assuming it fell.
- **The doc-level shield keys** — the only families with no bound of any kind.
- **RemNote's enumeration replacement** — may change how reverse lookups should work, which touches Phase 1's rebuild path. Worth knowing before investing further.
- **Audit cost** — 424s and rising, because rem-keyed families are probed against every rem in the KB. Narrow the candidate sets before the next run.
- **`nulled` column is meaningless** on current builds: an unwritten key reads back as `null`, so absent and nulled are indistinguishable. The audit calibrates for this and excludes the column; use the capacity experiment instead.
