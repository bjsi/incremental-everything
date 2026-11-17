# Review history archive plan

Working document for a desktop helper that keeps the review history of deleted cards and Incremental Rems, so the Study Dashboard keeps counting it. It also keeps where each deleted Rem lived in the tree. Pick it up at "Phases"; the sections above it hold the decisions and their reasons.

Last updated: **2026-11-11**. **Implemented**: all six phases shipped in v1.0.217 (user docs: Study Dashboard → Deleted Rems).

---

## 1. Why this exists

Measured 2026-11-10 (see `findings/CARD_STATE_REFERENCE.md`, "Deleted cards and their repetition history"):

- A card's repetitions live only in its own `cards` row (`h`). An Incremental Rem's live only in its `repHist` slot (Dismissed: `dismissedHistory`).
- Deleting a Rem moves the Rem to `deleted_quanta` and its cards to `deleted_cards`, both intact, with `deletedAt`.
- **RemNote empties that trash after two weeks** (`emptyTrashAfterTwoWeeks`), and "Clear Trash" empties it at once.
- **No SDK call reaches the trash.** Once a Rem is deleted, the plugin sees neither it nor its cards.

The consequence for the dashboard:

- The authoritative daily aggregates are recomputed from live data. That happens on the Refresh Statistics button and at every startup refresh (`refreshAuthoritativeAggregatesFromCardRead`), and the result overwrites the stored shard.
- So **a deleted Rem's reps drop out of the dashboard's totals at the next launch**, not after two weeks.
- The hierarchy view loses them the moment they are deleted.

## 2. Goal

1. Keep every rep the plugin can no longer see: deleted cards, deleted IncRems, deleted Dismissed Rems. For each, keep the date, grade, and response or review time.
2. Keep the Rem each one belonged to: its text, its deleted parents, and its **nearest ancestor that is still alive**. Then the dashboard tree can show it where it used to be.
3. Feed both into the Study Dashboard: the daily aggregates (Summary, Graphs, "Ever") and the hierarchy tree.

Not a goal: restoring Rems, or touching RemNote's data in any way. The helper only reads.

## 3. Decisions

| Decision | Why |
|---|---|
| **Read `remnote.db` from a localhost helper**, read-only (`?mode=ro`). | It's the only way into the trash. The plugin iframe can't read files, and the bridge never serves deleted records. |
| **Part of the existing helper process** (`scripts/ai_ocr_helper.py` serves the routes), with the logic in its own module `scripts/history_archive.py`, also runnable as a CLI. | One LaunchAgent, one port and one Origin check, all of them already installed and trusted. The module stays testable on its own and doesn't need `claude`. |
| **Archive live reps too, not only the trash.** | "Clear Trash" purges at once, and so does a Rem deleted and purged between two scans. Only a copy taken while the card was alive covers those cases. A full scan of the main KB takes ~4 s (48k items, 296k rep copies, 42k Rems), so every scan is a full one, in one read transaction. |
| **Rep identity = the rep timestamp in ms, across all kinds** (card, inc, dism). Not the card or Rem id, and not (kind, timestamp). | Every path that moves history keeps the original `date` but may change the kind, so only the timestamp survives all of them. **Preserve history & remove** turns card reps into `importedRep` entries on the tombstone's Dismissed history, then deletes the cards (§3a). **Dismiss** moves `repHist` to `dismissedHistory`. **Transfer to parent** copies the history to the parent. **Restore from trash** brings the card back with the same reps. **Copies** (imports, "copy to KB") carry history to new ids via `srcRemId`; the test Rem had reps older than itself. **Stale slots**: legacy `bpc` values survive a removed powerup. Two real reps never share a millisecond, because the queue shows one item at a time. |
| **The plugin counts a rep as "ghost" only if its timestamp is in none of the live histories it just read**: card `repetitionHistory`, IncRem `repHist`, Dismissed `dismissedHistory`, `importedRep` entries included. | Live data stays the source of truth. The helper never has to know what the plugin sees, a restored card stops being a ghost automatically, and a rep preserved on a tombstone is counted once, as the tombstone counts it. |
| **When several archived copies share a timestamp, keep the one that was live most recently** (`last_seen_live`). | A rep keeps being counted the way it was last counted, so a total doesn't change kind when a later deletion happens. Example: a tombstone is itself deleted. Its `importedRep` copies (counted as Dismissed time while it lived) win over the original card records, which died first. |
| **Every scan records each Rem that holds reps, and all its ancestors (`rems`: parent, plain text, live/trash/gone). Chains are walked through that table when asked for.** | Changed from "capture the chain at deletion" while building Phase 1. Recording live Rems on every scan means a Rem deleted *and* purged between two scans still has its last known place and text. Each answer walks `parent` up to the first Rem that is still live; whole deleted subtrees stay together. The plugin still re-checks the live anchor with `findOne`, and falls back to a top-level "Deleted Rems" node. |
| **Ghost daily totals go to a small synced key** (`ghostDailyAggregates_<kbId>`, same compact row format as the authoritative shard), **written only when the helper answered.** | Mobile and web have no helper but should still count the reps. The key holds only the days of deleted items, so it stays far below the 900 KB per-key limit (UTF-16, see `findings/PLUGIN_BRIDGE_AND_SDK.md`). If the helper is unreachable, the last good value stays. |
| **Ghost tree nodes are desktop-only**, fetched from the helper when the dashboard opens. | Per-Rem rep lists with texts and chains are too large for synced storage, and the tree is where the desktop is used anyway. Without the helper the tree shows no ghosts, and the totals still include them. |
| **Archive one folder per KB**, `~/.incremental-remnote/history-archive/<kbId>.sqlite`. Scan only KBs the plugin has called in from. | The user requires the helper to read only the KB in use (as the AI OCR helper does), and every folder but one is a test KB. Not under iCloud: launchd can't write there. The existing Claude-config backup hooks can pick it up. |
| **Raw times go to the plugin; the plugin applies the caps.** | The flashcard response-time cap is a plugin setting (`flashcardResponseTimeLimitId`). IncRem review time stays uncapped, as in `computeAuthoritativeAggregatesForCurrentKb`. |

## 3a. Compatibility with commands that move history

The plugin already moves history between Rems before removing things. Each of these produces two copies of the same rep in the DB once the source is deleted: one live, one in the trash. The archive must count it once.

| Command | What it leaves | Handled by |
|---|---|---|
| **Preserve history & remove** (`phr`, `lib/history_transfer.ts`) | Tombstone (live, `preservedHistory` powerup) whose `dismissedHistory` holds every subtree rep. Card reps become `importedRep` with `date` = the card rep's date and time capped and rounded to seconds; IncRem and Dismissed reps are copied as they are. The cards go to `deleted_cards` and the descendants to `deleted_quanta`. | Timestamp identity across kinds. Every trashed copy's date is in the tombstone's live history, so none becomes a ghost. |
| **Dismiss** | `repHist` copied to `dismissedHistory` on the same Rem. | Same Rem stays live, so both copies are live: nothing to do. If it's deleted later, the most-recently-live rule keeps one copy. |
| **Transfer to parent** (`ttp`, `lib/incremental_rem/transfer.ts`) | History on the parent; it already identifies entries by `${date}\|${eventType}`. | Timestamp identity; the parent's live copy wins. |
| **Deleting a tombstone** | Its `importedRep` copies plus the original card and IncRem records, all in the trash. | Most-recently-live rule: the tombstone's copies win, so totals don't move between Card and IncRem. |

Dashboard tree, for the same reason:
- Drop a ghost Rem whose reps were all deduplicated away. The deleted descendants of a tombstone would otherwise show up as empty 🗑 rows under it, while their time is already on the tombstone.
- When the dropped ghosts' chain passes through a live tombstone, the helper can say so (`preservedOn: <tombstone id>`) for the debug report. They are not drawn.

The archive doesn't make the command unnecessary. The tombstone keeps the history in RemNote itself, synced, with no helper, and on any device. The archive is the safety net for deletions that didn't go through it.

## 3b. Imported history that isn't the user's

Importing a document that someone else studied brings their reps along. Older RemNote importers had no way to leave the history out. In the main KB, 2,289 cards of a classmate's export arrived on 2025-08-23, already flagged `b`, with 9,530 of his reps (2024-08 → 2025-08). The Rems were later moved to their own KB (`67a35…`) and deleted from the main one. Counted as ghosts, they would have added 168 h that the user never studied.

Nothing in the record tells them apart. `owner` is rewritten to the importing user. The rep fields are the usual ones (`addedExternally: false`). The card's `m` is no arrival stamp either: RemNote rewrites it, and most live cards have reps older than their `m`.

From the first archive scan on, imported reps **count**. RemNote's importer can now leave history out, so reps that arrive with an import are there because the user chose to keep them. The archive still tags them: an item first seen after the archive's first scan, arriving with reps more than 7 days older than its `first_seen` (7 days covers devices syncing late), gets `source = 'imported'`. They stay in the totals. The tag only lets the debug report list import batches by top Rem, and lets a CLI flag drop a batch if one ever needs it. A re-import of the user's own export adds nothing, because its reps already sit in the archive under the same timestamps.

The exclusion applies only to the past, before the importer offered that choice, and so only to backfill (Phase 5). Backfill has no `first_seen`. It drops reps whose timestamps exist in another local KB, and uses a manual exclude list of subtrees for the rest.

## 4. Archive schema (helper side)

As built: see `SCHEMA` in `scripts/history_archive.py`. Changes from the sketch below:
- Liveness is per item (`items.state`, `last_seen_live`), not per rep copy.
- A rep that disappears from a still-live item is marked `removed_live` (history edit), so it can never come back as a ghost.
- `rems` replaces `chain_json`, and no raw rich text is kept.
- The archive of the main KB is ~57 MB.

The original sketch:


```
reps   (kind TEXT,            -- 'card' | 'inc' | 'dism'
        date_ms INTEGER,      -- rep timestamp: THE identity, across kinds (§3)
        item_id TEXT,         -- card id, or Rem id for inc/dism
        rem_id TEXT,
        score REAL,           -- cards: QueueInteractionScore; null for inc/dism
        time_ms INTEGER,      -- card responseTime, or inc reviewTimeSeconds*1000
        event_type TEXT,      -- inc/dism eventType, e.g. 'importedRep' (filtered with repCountsForStats on the plugin)
        first_seen INTEGER,
        last_seen_live INTEGER, -- last scan that saw this copy outside the trash
        PRIMARY KEY (date_ms, kind, item_id))   -- every copy is kept; dedup happens on read

items  (item_id TEXT PRIMARY KEY, kind TEXT, rem_id TEXT,
        last_seen_live INTEGER, seen_in_trash INTEGER, deleted_at INTEGER)

rems   (rem_id TEXT PRIMARY KEY,
        text TEXT,            -- plain text from `key` (refs resolved by name where possible)
        key_json TEXT,        -- raw rich text, for later rendering
        parent_id TEXT,
        deleted_at INTEGER,
        chain_json TEXT,      -- [{id, text, aliveAtCapture}] from parent upward to the first live Rem
        captured_at INTEGER)

scans  (kb_id TEXT, at INTEGER, kind TEXT, watermark_y INTEGER, cards INTEGER, rems INTEGER, ms INTEGER)
```

- Card reps: read `cards.doc.h` and `deleted_cards.doc.h`, with the Rem from `rId`.
- IncRem and Dismissed reps: read the slot value from both layouts, inline `doc.bpc.<code>.<slot>.v` and `doc.ps["<code>_<slot>"].v.v`, in `quanta` and `deleted_quanta`. A slot stored as a child Rem has to be read from the child.
- **The archive never deletes a row.** `rems` rows are written for every Rem that has archived reps. Live Rems' rows are refreshed (text, parent) on each scan, so the ancestry is already there on the day they are deleted.

## 5. Helper routes

All are POST, carry `kbId`, and go through the existing Origin check:

- `/history/scan` `{kbId, full?}`: run a scan now (incremental by default). Returns counts.
- `/history/ghosts` `{kbId}`: every archived rep whose item is no longer live in `remnote.db`. That's a card absent from `cards`, or an inc/dism Rem absent from `quanta` or without the slot. They come with their `rems` rows and chains. The plugin still applies the timestamp test of §3, so this is only a pre-filter that keeps the payload small.
- `/history/status` `{kbId}`: last scans, archive size, how many items are in the trash right now, and the oldest `deletedAt` there.

Background thread: a full scan of every known KB a minute after the helper starts, then every 6 hours. A KB is known once any helper request carries its `kbId`, or once the CLI `scan` ran on it (`~/.incremental-remnote/history-archive/kbs.json`). Two weeks is the deadline, so this leaves a wide margin.

## 6. Plugin side

- `src/lib/history_archive.ts`:
  1. `fetchGhosts(plugin)` calls the helper and fails quietly when it's unreachable.
  2. It builds one `Set` of live rep timestamps from all three histories (card, inc, dism, `importedRep` included), using the reads the caller already made.
  3. It drops ghosts found in that set, then keeps one copy per timestamp among the rest (most recently live, §3).
  4. It returns per-Rem ghost records and ghost daily buckets.
- **Aggregates.** `computeAuthoritativeAggregatesForCurrentKb` and `refreshAuthoritativeAggregatesFromCardRead` write the ghost buckets to `ghostDailyAggregates_<kbId>` when the helper answered. `aggregatePeriodStatsCombined` and the Graphs timeline add the ghost buckets to the authoritative ones. Ghost rows carry the same fields as `TimelineDay` (grade split, inc vs card time), so the Graphs tab can stack them.
- **Tree.** The dashboard's gather step (`study_dashboard.tsx`, both scope modes) turns each ghost Rem into a `RemData` with `deleted: true`. Its `parentId` points to a ghost parent if that parent is archived, otherwise to the nearest live chain entry. The existing structural-ancestor walk does the rest. Document mode includes a ghost when the document is in its chain.
- **UI:**
  - a 🗑 marker and the deletion date on ghost rows;
  - a "Include deleted Rems" toggle, on by default;
  - a line in the Summary: "N reps from deleted Rems".
- **No helper, no change.** Without the helper the dashboard behaves exactly as today, plus the synced ghost totals.

## 7. Open questions to measure first (Phase 0)

- ~~Removing a cloze's markup or a card type~~ **Answered 2026-11-10:** a card with history stays in `cards`, flagged `b` (`NO_LONGER_NEEDED`), with its history intact and still returned by `card.getAll()`. Only a never-practiced card is removed, and that one has no reps to lose. So edited-away cards need nothing from the archive while their Rem lives. When the Rem is deleted they go to `deleted_cards` with it, like any other card. See `findings/CARD_STATE_REFERENCE.md`.
- Disabled directions: same question for `card.getAll()`. Per `findings/`, `rem.getCards()` drops them.
- New-layout IncRems: confirm a deleted IncRem's `ps` slot values survive in `deleted_quanta`. The 2026-11-10 sample was legacy `bpc`.
- A trash cleared on another device: does the local `deleted_cards` row vanish on the next sync, and how fast? This sets how much the live archiving matters.
- Preserve history & remove on a test subtree with cards, an IncRem and a Dismissed Rem: confirm that every trashed copy's `date` appears unchanged in the tombstone's `dismissedHistory`. Do the same for Transfer to parent.
- ~~Cost of a full scan~~ **Measured:** ~4 s on the main KB with RemNote running.

## Phases

- [ ] **0. Measure** the open questions above in a test KB, and write the answers to `findings/`. Cloze removal and scan cost are done. Still open: disabled directions in `getAll()`, Preserve history live check (in Phase 3), and a trash cleared on another device.
- [x] **1. Scanner + archive** (`scripts/history_archive.py`, CLI only):
  - `--kb <id> scan | report | status | ghosts`;
  - 13 tests in `scripts/test_history_archive.py` (`python3 scripts/test_history_archive.py`), each on a fake `remnote.db`. They cover: a deleted card, a purged trash, a restore, a deleted subtree, a rep edited out before deletion, IncRems in both layouts, Dismiss, Preserve history & remove, a deleted tombstone, reference texts, and the report.
  - First real run (2026-11-10), main KB: 26 ghost reps (12 min), in 3 deleted subtrees. RemNote's trash only reaches back to Oct 31. 76 of the trashed card reps were correctly skipped, because they live on as `importedRep` on Preserve-history tombstones. This confirms §3a on real data.
- [x] **2. Helper routes + background scans** in `ai_ocr_helper.py`, plus the LaunchAgent restart. Verify `/history/ghosts` on the main KB (read-only).
- [x] **3. Plugin client** `src/lib/history_archive.ts`:
  - **Built 2026-11-10. The live checks below passed on the main KB the same day:** the header showed the archive's 26 counted reps, Ever stayed the same after Preserve history & remove, and Ever stayed the same with the helper unloaded.
    - `fetchGhosts` asks the helper with `scan: true` and has a 30 s timeout. `filterGhosts` drops ghosts by the live timestamp set.
    - `authoritative_aggregates.ts` collects the live set during both walks (Refresh Statistics, and the startup refresh from the card cache's read). `bucketGhostReps` uses the same predicates and cap as the live walk, and `refreshGhostAggregates` writes `ghostDailyAggregates_<kbId>` (`{v:2, kbs, n, at}`) only when the result changed.
    - Practiced Queues merges the key through `mergeGhostBuckets`. Ghost days after `lastComputed` are left out, since listener sessions count those. Pre-cutoff IncRem days still take MAX(archive + live, listener). The header shows "· incl. N from deleted Rems".
    - Tests are in `src/lib/history_archive.test.ts`.
  - Scope change: the Study Dashboard builds its Summary and Graphs from per-Rem `RemData`, not from these buckets, so it gets ghosts with the ghost `RemData` nodes in Phase 4.
  - ghost buckets into `ghostDailyAggregates_<kbId>`, merged into the Practiced Queues summary;
  - check the totals against a manual count from the archive;
  - a no-double-count check: run Preserve history & remove on a test subtree. The dashboard's totals must be identical before and after, with the helper on and off.
- [x] **4. Dashboard tree**: ghost `RemData` nodes, the marker, the toggle and the Summary line.
  - **Built and approved 2026-11-10.**
    - `buildGhostNodes` (lib) turns the kept ghosts into nodes: each Rem with reps, plus the deleted Rems between it and its nearest live ancestor. A chain with no live ancestor goes under `DELETED_ROOT_ID` ("Deleted Rems with no surviving ancestor"), and a card deleted from a live Rem goes under a "Removed cards" node beneath that Rem.
    - In the dashboard they become `RemData` with `deleted: true`. Global mode chains them to their anchor's live chain (`withGhostsGlobal`). Document mode keeps those whose anchor is the document or below it (`withGhostsDocument`). So the Summary, the Graphs and the tree count them through the existing code.
    - The helper is asked once per opening, with `scan: true`, in parallel with the live load.
    - UI: 🗑 plus the deletion date on rows, no Open button on those rows, an "Include deleted Rems" checkbox (persisted with the other dashboard prefs, disabled with "helper not running"), and a note under the Summary ("🗑 Includes N reps (time) from deleted Rems").
- [x] **5. Backfill** from snapshots: local `backups/`, iCloud `Back Ups/RemNote` `.db.zip`, Google Drive 2024 `.db`; open with `?immutable=1`. Reps found only there are archived with `source = '<backup name>'`. Skip imported history (§3b). Measured 2026-11-10 over 38 snapshots (2020-12 → 2026-11, main KB): 18,604 card reps are in no live or trashed record today. 12,341 of them are the classmate's (§3b). The user's own loss is **6,263 card reps, ~62 h** (~2% of card time), and 0 IncRem reps. They are mostly 2021–2022 reps. About 5,100 of them (50 h) went in one event around **2023-10-11**. The Oct 2023 DB copy (saved 2023-10-11 11:22, last rep Oct 10) still has them. Today the same Rems exist, re-imported, but their cards were re-created on 2023-10-11 with an empty history (835 such cards today, all created in the same hour). Those are mostly cards last reviewed in 2021 (68% of the lost cards, against 19% of the kept ones). Smaller losses: 427 reps (5.5 h) between Sep 2024 and Mar 2025, and a few dozen per window after that. Imports themselves keep history intact: in the control sample, every rep that survived an import kept its exact timestamp, and 301 of 302 cards kept their creation time `e`. Rem `createdAt` does not survive an import (it becomes the import date), and neither do Rem or card ids. Checked by `verify_lost.py` (scratchpad; to move into `scripts/` with this phase). It takes a random sample of lost reps, finds today's Rems with the same text, and looks for the rep there by exact timestamp, a shift under 2 s, a whole-hour shift, or the same response time and score on another date. 396 of 400 sampled reps were confirmed lost. One match on an "[image]" Rem was a coincidence, and three reps had no snapshot recorded.
  - **Built 2026-11-10:** `scripts/history_backfill.py`, `scripts/history_backfill_verify.py`, `scripts/test_history_backfill.py`.
    - It reads each snapshot newest first, from any snapshot format: RemNote backup `.db`/`.db.zip`, a KB folder, or a JSON export `.zip`/`.rem`. Snapshots of other KBs are skipped.
    - It archives every rep whose timestamp the archive lacks, with `source` = the file name. Items are `gone` with `last_seen_live` = the snapshot's date, and the Rems on their chains are added from the snapshot. `--exclude-kb` drops reps whose timestamps exist in another KB (the classmate's, §3b).
    - It writes one short transaction per snapshot, so the helper's scans never wait on it. `--dry-run` reports and writes nothing.
    - Placement goes in a new `anchors` table, which `rem_chains` reads. Each old chain is tied to the nearest ancestor whose id is live today, else to the deepest ancestor whose path matches today's tree by text, top-down.
    - The Rem holding the reps is never matched itself, so a re-imported twin keeps its own fresh history, and the old reps show as a 🗑 sibling beside it.
    - The verify script samples the backfilled card reps and looks for them on today's same-text Rems: a shifted timestamp, or the same response time and grade. It is the routine from the 2026-11-10 investigation, now reading the archive.
  - **Run on the main KB's archive 2026-11-10**, with `--exclude-kb 67a35…` over the 38 snapshots: 6,417 reps (6,263 counted, 62.5 h) on 1,124 Rems; 77 placed by id, 995 by text, 52 with no surviving ancestor. Verify (400 sampled): 400 confirmed lost. A copy of the archive from before the run is kept next to it (`*.pre-backfill-2026-11-10.sqlite`). Undo: delete the reps with `source != 'live'`, then the items, Rems and anchors that only they use, or restore that copy.
  - Known limit: about 594 reps (4.1 h) stop at today's "Suporte", because their old branches were later moved one level deeper (e.g. "Suporte › Using RemNote" is now "Suporte › RemNote › Using RemNote"). They still count, just higher in the tree.
  - Approved 2026-11-10 after the user checked both dashboards. The first look showed nearly everything under "no surviving ancestor": the running helper still had the pre-`anchors` module loaded, and a restart fixed it.
- [x] **6. Docs** (v1.0.217): Changelog, Study Dashboard → Deleted Rems (+ recovering from backups), a bullet in Practiced Queues → Refresh Statistics, and the helper setup now downloads `history_archive.py`. The helper treats that module as optional, so an install with only `ai_ocr_helper.py` keeps working.
