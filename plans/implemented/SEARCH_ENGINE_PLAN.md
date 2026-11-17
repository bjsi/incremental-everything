# Search engine — design proposal

Maintainer notes, not published (the docs site is built from `docs/` only).
**Status:** implemented — shipped in v1.0.231 (Nov 14, 2026): all five phases plus ✨ AI search. Kept for its decisions; the user-facing result is `docs/Search-Engine.md`, the RemNote facts `findings/SEARCH_AND_DATABASE.md`.

**Goal:** an Anki-style query language over the knowledge base, run by the local helper against
`remnote.db`, returning Rem (or card) ids. First user: Find Rem (`fir`). Later: a browser widget,
the IncRem list, and building queues from a query.

---

## 1. Why the plugin can't do this through RemNote

Measured 2026-11-14 on the main KB (443,381 Rems, 71,730 cards, 357,745 search-index rows).

- The plugin API's `search.search(text, contextRem?, {filterOnlyConcepts, numResults})` takes
  text and nothing else. RemNote's worker (`getPrefixMatches`) builds the FTS query itself, and
  always joins the words with OR:
  `words.filter(w => w.length > 2).map(w => '"w"*').join(" OR ")`.
- The pool is then cut twice: the top 10,000 by FTS relevance, then the top **1,000 by RemNote's
  static Rem rank** (`remsSearchRanks`, which ignores the query). Asking for more results doesn't
  help, because the cut happens before the plugin sees anything.
- Example: `bow weather wave`. 5,874 Rems contain any of the words, and 1 contains all three.
  That one is 244th by relevance but 2,761st by static rank, so it's dropped.
- The same query with `AND`, run directly on `remnote.db`, returns that Rem alone in **5 ms**.

So a real query language needs direct access to the database. The plugin iframe can't read
files; the desktop helper can.

## 2. What Anki does (reference: `~/anki/docs-site/manual/searching.mdx`, `rslib/src/search/`)

- **Parser** (`parser.rs`, nom): text → `Vec<Node>`, with `Node = And | Or | Not(Node) |
  Group(Vec<Node>) | Search(SearchNode)`. Terms are separated by spaces, with an implicit AND;
  `or`/`and` are case-insensitive keywords; `-` negates; `( )` groups; `"…"` quotes, and
  `key:"…"` quotes only the value; `\` escapes. `search_node_for_text_with_argument` dispatches on
  the key (`deck`, `tag`, `is`, `prop`, `added`, `rated`, …). An unknown key means a field name.
- **Writer** (`sqlwriter.rs`): walks the tree and emits ONE SQL `WHERE` clause. Each
  `SearchNode` writes its own fragment; `And`/`Or`/`Not`/`Group` write `and`/`or`/`not`/`( )`.
  Plain text becomes `LIKE '%text%'` over the note's fields (substring, not word).
- **Round trip** (`writer.rs`): a tree back to normalized text, so a UI can combine searches
  ("add this filter to the current search") safely. **Builder** (`builder.rs`): searches built
  in code.
- Errors carry a kind and the failing input (`UnclosedQuote`, `MisplacedAnd`, `UnknownEscape`…),
  so the UI can say what is wrong.

We copy this architecture: parse → tree → one SQL statement, with typed errors and a
tree-to-text writer.

## 3. What `remnote.db` offers (read-only, WAL; field maps read from the 1.30.2-beta bundle)

| Need | Where | Notes |
|---|---|---|
| Text | `remsContents` (FTS5, `unicode61`, prefixes 1–3) | Lower-case, accents folded, cloze markup gone. **References are appended at the end** of the Rem's text, not where they sit. Each alias is its own row (`remsSearchInfos.aliasId`). Updated by RemNote lazily (`pendingRecomputeRems`). |
| Subtree | `remsSearchInfos.ancestor_ids` (indexed, space-separated root→parent) | Prefix range = all descendants; 0 ms. `ancestor_not_ref_text` holds the path as text. |
| Rem fields | `quanta.doc` (JSON) | `key`, `value`, `parent`, `type` (concept/descriptor), `createdAt`, per-field edit stamps (`key,u`, `value,u`), `tp` tags, `apu` powerups, `ps`/`bpc` slots, `srcRemId` (source), `al` aliases, `forget`/`efc`/`enableBackSR`/`dci` (card switches), `ny`, `docUpdated`. |
| Slots ("fields") | `ps["<powerup>_<slot>"].v.s` (new), `bpc.<powerup>.<slot>` (old) | Plugin data is here: `cardPriority_priority`, `incremental_priority`, `incremental_nextRepDate`, `dismissed_dismissedDate`; built-ins: `h_c` highlight colour, `n_p` PDF page, `b_u` URL… |
| Cards | `cards.doc` (JSON) | `rId` Rem, `c` type (`f`/`b`/cloze id), `n` next time, `a` active next time, `h` history (`date`, `score`), `ml` mastery level (New/Acquiring/Growing/Solidifying/Retaining/NotYetLearned), `l` last rep, `t` times wrong in a row, `e` created, `b` no longer generated, `ny` Learn New. |
| Ratings | `h[].score` | Counts in the main KB: 1 (211,677), 0.5 (20,544), 1.5 (17,500), 0 (16,511), 0.01 (1,804), and 2–5 (583 in all). 0/0.5/1/1.5 = Forgot/Hard/Good/Easy; **0.01 and 2–5 are still to be named** from the bundle. |

**Speed.** FTS and subtree queries take milliseconds. JSON filters over the whole of `quanta`
don't: one tag test took **1.2 s** (443k JSON documents), and all due cards 143 ms. Structured
filters therefore need an index of their own (§5.2).

## 4. Proposed query language

Anki's grammar unchanged: spaces = AND, `or`, `-`, `( )`, `"…"`, `key:value`, `key:"…"`, `\`
escapes, numeric comparisons `<`, `<=`, `>`, `>=`, `=`, `!=`. The keys are RemNote's.

### 4.1 Text

| Query | Meaning | Anki difference |
|---|---|---|
| `bow weather` | both words, each as a **word prefix** (`bow` matches *bowsprit*, not *elbow*) | Anki matches substrings. FTS can't do infixes; a post-filter `LIKE` would be slow. |
| `bow or bowsprit`, `-weather`, `bow (wave or sea)` | boolean | same |
| `"bow flare"` | adjacent words (a phrase) | same, but a phrase can't cross a reference (it is indexed at the end) |
| `w:bow` | whole word, no prefix | same idea |
| `navegacao` = `navegação` | accents ignored always (the index folds them) | Anki needs `nc:` |
| — | clozes ignored always (the index has plain text) | Anki needs `sc:` |
| `alias:"sea margin"` | matches only through an alias row | new |

Not offered: `d_g`/`d*g` wildcards inside a word, `re:` (regex), HTML entities.

### 4.2 Where

| Query | Meaning | Anki |
|---|---|---|
| `in:"Wärtsilä Encyclopedia"` / `in:63ZzPW7lNc3ceJWVy` | the Rem and everything under it (a name is resolved like Find Rem's exact match; ambiguous names report an error listing the candidates) | `deck:` |
| `-in:Archive` | not under it | `-deck:` |
| `parent:<name or id>` | direct children only | `deck:x -deck:x::*` |
| `path:pscpp` | text anywhere in the ancestors' names | — |
| `is:document`, `is:folder` | | — |

### 4.3 What a Rem is

| Query | Source | Anki |
|---|---|---|
| `tag:Flashcards`, `tag:none`, `tag:Flash*` | `tp` → tag Rem's name | `tag:` |
| `is:concept`, `is:descriptor` | `type` | `note:` |
| `has:powerup:<code or name>` (e.g. `has:powerup:n` PDF highlight) | `apu`/`bpc` | `note:` |
| `is:incremental`, `is:dismissed`, `is:pdf-highlight`, `is:table`, `is:portal` | powerups | — |
| `has:source`, `source:<name or id>` | `srcRemId`, Sources | — |
| `has:alias` | `al` | — |
| `refs:<name or id>` (Rems whose text references it) | `key`/`value` reference elements, indexed in §5.2 | — (RemNote's own `kr`/`vr` are never saved) |
| `id:a,b,c` | | `nid:` |

### 4.4 Slots ("fields")

`<powerup>.<slot>:<text>` and `<powerup>.<slot><op><number>`, on `ps`/`bpc`, in both
storages. Short aliases for the plugin's own:

| Query | Slot |
|---|---|
| `prop:priority<20` | card priority (`cardPriority_priority`) |
| `prop:incpriority<=10`, `prop:incdue<=0` (days) | `incremental_priority`, `incremental_nextRepDate` |
| `highlight.color:yellow` | `h_c` |

The slot catalogue (code → name) is read from the powerup Rems, so the browser can offer
completions. User-created table properties: **to verify** whether they are slots in `ps` or
child Rems; if child Rems, a later phase.

### 4.5 Cards (a Rem matches when any of its cards does; `mode=cards` returns the cards)

| Query | Source | Anki |
|---|---|---|
| `card:forward`, `card:backward`, `card:cloze` | `c` | `card:` |
| `is:due`, `is:new` (no reps), `is:learn-new` (`ny`), `is:disabled`, `is:not-generated` (`b`) | `n`/`a`, `h`, `ny`, `forget`/`efc`/`dci`, `b` | `is:` |
| `is:paused` | nearest Deck ancestor's status | `is:suspended` (roughly) |
| `ml:growing` | `ml` | — |
| `prop:due<=-7`, `prop:ivl>=30`, `prop:reps>10`, `prop:lapses>3` | `n`, `n − l`, `h` | `prop:` |
| `rated:7`, `rated:7:forgot`, `introduced:30` | `h` | same |
| `added:7` (Rem), `edited:7` (`key,u`/`value,u`) | stamps | same |
| `prop:s>21`, `prop:d`, `prop:r<0.9` | FSRS replay | needs the FSRS port in Python (`src/lib/fsrs.ts` matches RemNote exactly); last phase |

Not offered: flags (RemNote has none), presets, `dupe:`, custom data.

### 4.6 Results

- Default: Rem ids, best first. With text terms, order by FTS relevance (`bm25`), then static
  rank. Without text, by edit time. `sort:` key later.
- Aliases collapse to their Rem, and the matching `aliasId` comes back with it (Find Rem uses it).
- `limit` (default 200), plus a `total` count.

## 5. Architecture

### 5.1 Where it runs

- **In the AI helper** (`scripts/ai_ocr_helper.py`, port 3457), as a module
  `scripts/rem_search.py`, which is also runnable as a CLI (`rem_search.py "<query>" --kb …`) for
  tests. It reuses `history_archive.py`'s KB handling (`check_kb_id`, `remnote_db_path`,
  `open_remnote(mode=ro)`, the registry of KBs the plugin called from). This follows the
  Ghost-history decision: one LaunchAgent, one port, already installed.
- **Python, hand-written recursive-descent parser** after Anki's grammar (~300 lines), with the
  same error kinds and the failing position.
- **Route** `POST /search {kbId, query, mode: 'rems'|'cards', limit, offset}` →
  `{ids: [{remId, aliasId?, cardIds?}], total, tookMs}` or `{error: {kind, at, message}}`.

### 5.2 Two data paths

1. **Straight to `remnote.db`** for text and scope: FTS5 `MATCH` with real AND/OR/NOT/phrase,
   joined to `remsSearchInfos` for ids, aliases and `ancestor_ids`. No copy, always as fresh as
   RemNote's index. This alone fixes Find Rem.
2. **A sidecar index** for everything structured: `~/.incremental-remnote/search/<kbId>.sqlite`
   with normalized, indexed tables (`rems`, `rem_tags`, `rem_powerups`, `slots(text, num)`,
   `refs`, `cards`, `reps`). Built in one read transaction (a full build is expected to take
   seconds, like the 4 s archive scan), then refreshed **incrementally** before each query from
   Rems and cards whose `u` is newer than the last watermark. Deletions are picked up by a
   periodic full id diff. The query `ATTACH`es `remnote.db` read-only, so one SQL statement
   can mix FTS and indexed filters.

### 5.3 Plugin side

- `src/lib/rem_search_client.ts`: `searchViaHelper(plugin, query, opts)`. It fails quietly
  (returns `null`) when the helper is off, on mobile, or on the web app.
- **Find Rem:** when the helper answers, its ids lead the candidate pool and the seeds of today
  stay as fallback, so typing works the same without the helper. Operators are only interpreted
  by the helper; without it they are plain words, as today. A small **⚡** in the box tells which
  engine answered; a parse error is shown under the box.
- **Later:** a **Search & Browse** widget (an Anki-Browser-like table: text, path, type, tags,
  priority, due), saved searches, and "make a queue from this search". That queue would go
  through a portal document, since a plugin can't start RemNote's filtered queue
  (its card list is read from the host's localStorage).

## 5b. ✨ AI search (shipped in v1.0.231; docs: Search Engine → ✨ AI)

Search & Browse's ✨ AI button (and Ctrl/Cmd+Enter): the box's plain-language request,
in any language, becomes a query through `/search/ai` (`scripts/rem_search_ai.py`): one
`claude -p` turn via the helper's `run_claude` (model `IR_AI_MODEL`, default sonnet, the
user's subscription), instructions in `ai-ocr/search-prompt.md` (written from
DEFAULT_PROMPT, re-read per request, never overwritten: delete it for newer defaults).
Sent with the request: scheduler names, the 60 most-used tags and top 150
documents/folders (names only), so places resolve to real `in:`. The reply is parsed by
`rem_search.parse`; an invalid one goes back once with the error. ~3.5 s per request.

## 6. Security and privacy (blocking)

The helpers listen on 127.0.0.1 with `Access-Control-Allow-Origin: *`; the AI helper's
`IR_AI_ORIGINS` allow-list is **unset = allow all**. Today the routes do work on request. A
search route would **hand out the whole knowledge base** to any web page open in the browser,
which can `fetch('http://127.0.0.1:3457/search')`.

Plugin iframes have an opaque origin (`null`), and any page can produce `null` from a sandboxed
iframe, so an Origin check is not enough. Proposal: **a pairing token**. The helper creates a
random secret at install (`~/.incremental-remnote/token`), the user pastes it once into a plugin
setting, and `/search` (and in time every route) requires it in a header. A wrong or missing token
gets 403, with no hint. The existing routes should get the same check; that's worth doing
independently of this plan.

## 7. Risks and open questions

- **RemNote can change the schema** (it did in the storage overhaul). Mitigation: a startup
  self-check (tables, columns, FTS tokenizer) that reports `{error: 'schema'}`; the plugin then
  falls back. Tests run against a fixture copied from a real DB.
- **Freshness.** `remsContents` follows RemNote's indexer, so a Rem typed seconds ago may be
  missing; RemNote's own search has the same lag. The sidecar lags by at most one refresh.
- **Desktop only** (Mac today). Mobile and web keep today's behaviour.
- **One KB at a time**, the one the plugin is in, per the user's rule for helpers.
- **Unknowns to measure first:** rating codes 0.01 and 2–5; where user-made table properties
  live; full sidecar build time and size; incremental refresh cost on a busy KB; whether
  `key,u` is bumped by RemNote's own migrations (seen: `key,u` newer than any edit on
  `go7LdXuu9hpAZH12G`).

## 8. Phases

- [ ] **0. Decide** the open choices (§9, done) and measure §7's unknowns in a test KB.
- [x] **1. Text search through the helper.** Shipped in v1.0.231: `scripts/rem_search.py` (+ `test_rem_search.py`), `/search` + pairing token in `ai_ocr_helper.py`, `src/lib/rem_search_client.ts` / `rem_search_protocol.ts`, setting `ai-helper-pairing-token`, Find Rem (helper first, ⚡, notes under the box). Docs: Desktop Helpers → Searching with AND, OR and NOT; Find Rem → Search with the AI helper.
      `alias:`), `in:`/`parent:`/`path:`, `/search` with the pairing token, the plugin client, Find
      Rem integration with the ⚡ marker and parse errors. Python tests on the parser and on a
      fixture DB; a TS test on the client fallback. *Fixes `bow weather wave`.*
- [x] **2. Sidecar index + Rem filters.** Shipped with v1.0.231 (same changelog entry); docs: `docs/Search-Engine.md`, findings: `findings/SEARCH_AND_DATABASE.md`. *Built 2026-11-14: `scripts/rem_index.py` (index in `~/.incremental-remnote/search/<kb>.sqlite`, ~180 MB and ~17 s to build for 443k Rems, refreshed in ~5 ms from quanta's indexed `y` stamp, built in the background by the helper), keys in `rem_search.py`, 29 tests. Findings: visible powerup slots live in property children with a stale `ps` copy (newest write wins); `y` tracks local and synced writes. Docs and changelog after approval.* *Then: `*` in in:/parent: (documents and folders first, else any Rem, ≤200), source:/refs: (names of Source and referenced Rems kept in the index), names shared by several Rems cover all of them; `/search/source` route + `remsWithSourceViaHelper` used by findIncrementalRemForPDF, getCacheRemsForPDF, findAllRemsForPDF/HTML.* `tag:`, `is:` (Rem kinds), `has:`, `source:`, `refs:`,
      slots and the `prop:` aliases, `added:`/`edited:`, `id:`.
- [x] **3. Cards.** Shipped with v1.0.231 (same changelog entry); docs: Search Engine → Cards, Suppressed cards. *Built 2026-11-14: `cards` + `reps` tables in `rem_index.py` (schema 7, refreshed from cards' indexed `y`; index now ~240 MB), card terms in `rem_search.py` (ANDed card terms hold for one card; is:due leaves out paused decks; is:paused by nearest deck), 34 tests. Score enum from the bundle: 0.01 TOO_EARLY, 0 AGAIN, 0.5 HARD, 1 GOOD, 1.5 EASY, 2 VIEWED_AS_LEECH, 3 RESET, 4 MANUAL_DATE, 5 MANUAL_EASE. Then `is:suppressed` + `suppressed:paused|ancestor|rem|table|direction|cloze|removed|other` (one cause per card, the Suppressed Cards tab's order; index schema 8 adds forget/efc/enableBackSR/dci/vt/in_table and the cloze id), 35 tests. The Suppressed Cards tab now uses `/search/suppression` (rem_search.card_causes) when the helper answers: stored causes, no paused scan, no Rem-by-Rem walk. Results as cards (`mode=cards`) not done: Find Rem needs Rems; left for the browser widget (phase 4). Docs after approval.* `card:`, card `is:` states, `ml:`, `prop:due/ivl/reps/lapses`, `rated:`,
      `introduced:`, `mode=cards`.
- [x] **4. Search & Browse widget**, saved searches, queue from a search. Shipped with v1.0.231 (same changelog entry); docs: Search Engine → Search & Browse. *Built 2026-11-14. Decisions (user): wide popup; a Search Queue document per saved search (references, as the Priority Queue; under "Search Queues"; up to 500 Rems; practice via `/flashcards/<doc>`); saved searches in synced plugin storage (`search-browse-saved`, queue doc per KB). Helper: `scripts/rem_browse.py` + `/search/browse` (rows with every column from the index, sorted over the whole result before paging, Rems or cards; ~90–300 ms a page of 100); `match()` split out of `search()`; alias references rendered by their alias. Plugin: `components/SearchBrowseView.tsx`, `widgets/search_browse_popup.tsx` (1300 px × screenFittedHeight), command `Search & Browse` (`sb`), `lib/search_browse.ts` (saved searches, Search Queue doc, set card priority, switch cards on). 39 helper tests. Docs after approval.* *Then (user's choice, Nov 14): a floating panel instead of a popup (`search_browse_floating`, '90vw' wide, centred by measuring the window with getDimensions), collapsing to a 270×44 bar at the bottom right by moving the frame mostly off-screen (RemNote clips it; moving doesn't remount, so search/rows/scroll survive); keys stolen only while expanded; opening a Rem opens first, then collapses (the popup closed first and the open never ran); `sb` re-expands via session request + ack. Rejected: browser as a pane (user tried; doesn't fit), right sidebar (can't live with a popup), embedded editor in the popup (kept as a possible addition).*
- [x] **5. FSRS properties** Shipped with v1.0.231 (same changelog entry); docs: Search Engine → Cards. *Built 2026-11-14: `scripts/fsrs.py` (port of fsrs.ts, fixtures in `test_fsrs.py`), per-card scheduler resolved in `rem_index.py` (schema 10: rems.src, cards.sched/mem_s/mem_d/decay/mem_last, schedulers table; subtree recompute when a Rem moves or changes scheduler, full when a scheduler changes), keys prop:s/d/r, scheduler:, is:fsrs/sm2, browse columns S/D/R/Scheduler. No SM-2 ease (user: not needed). Docs after approval.* (`prop:s/d/r`) after porting the scheduler replay.

## 9. Decisions (approved 2026-11-14)

1. It lives in the **AI helper** (port 3457, already reads `remnote.db`), not the Media Bridge helper.
2. A **pairing token** guards the search route, and later every route. Blocking for phase 1.
3. Text matches from the **start of a word** (FTS), not Anki's substring; `w:` for whole words.
4. Key names in **English**, after Anki's (`in:`, `tag:`, `is:due`), so its manual carries over.
