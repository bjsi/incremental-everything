# RemNote's search and local database

What the Search Engine (`scripts/rem_search.py`, `scripts/rem_index.py`; plan in
`plans/implemented/SEARCH_ENGINE_PLAN.md`) relies on. Established 2026-11-14 on RemNote desktop
1.30.2-beta (macOS) by reading the app bundle and the main knowledge base's
`~/remnote/remnote-<kbId>/remnote.db` (SQLite, opened `?mode=ro`; 443,381 Rems, 71,730
cards, 357,745 search rows). Re-verify after a RemNote update: its storage changed under
the plugin before.

## How RemNote's search retrieves (and why a plugin can't AND)

The plugin API's `search.search(queryText, searchContextRemId?, {filterOnlyConcepts,
numResults})` passes text only. The search worker (`getPrefixMatches` /
`execGetPrefixMatches` in the bundle) builds the FTS query itself:

```js
a = words.filter(w => !/^[a-z0-9]{0,2}$/.test(w))   // words of ≤2 characters dropped
s = a.map(w => '"w"*').join(" OR ")                  // always OR
… WHERE data MATCH s ORDER BY rank LIMIT 10000       // bm25
… ORDER BY remsSearchRanks.rank ASC LIMIT 1000       // static rank, blind to the query
```

plus one branch for the whole query as a phrase (LIMIT 100, only with ≥2 tokens and no
context Rem). A context Rem filters by an `ancestor_ids` range and skips the 10,000 cap.

Consequence: a Rem with every typed word can be cut inside RemNote. `bow weather wave`
matched 5,874 Rems on any word and 1 on all three; that one was 244th by bm25 and 2,761st
by static rank, so it never reached the plugin. `numResults` can't help. The same query
with `AND` on `remnote.db` returns it alone in 5 ms.

## The search tables

| Table | What it holds |
|---|---|
| `remsContents` | FTS5 (`unicode61`, prefix `1 2 3`), one row per Rem **and per alias**. Lower-case, accents and cloze markup removed, front and back text. **A reference's text is appended at the end** (`… expected . becomes useless … sea margin`), so a phrase can't span a reference. Parentheses are stored as `% 7e`. |
| `remsSearchInfos` | `ftsRowId`, `id`, `aliasId` (= `id` on the Rem's own row), `doc` (JSON below), `ancestor_ids` (`"  root … parent"`, indexed: a prefix range = a whole subtree, ~0 ms), `ancestor_not_ref_text` (the path's names). |
| `remsSearchRanks` | The static rank (lower is better), computed by a trigger from the `doc` fields. |

`remsSearchInfos.doc` field names (bundle enum): `_id`, `a` alias id, `p` parent, `i`
is document, `l` is folder, `d` is PDF, `g` is image, `w` website, `wl` website link, `h`
PDF highlight, `fl` flashcard, `m` in template, `e` not visible to the user, `y` type,
`r` the raw text **in reading order, references in place** (folded), `kt`/`ke`/`vt`/`ve`
key and value text without and with references, `st` search aliases, `c` created, `t`
text cost, `rd` depth.

These rows follow RemNote's indexer (`pendingRecomputeRems`), so a new Rem can be missing
for a while; RemNote's own search has the same delay.

## Rem and card documents

`quanta(_id, doc, x)` and `cards(_id, doc, x)`. Field names, from the bundle's enums:

- **Rem:** `key`, `value`, `parent`, `type` (1 concept, 2 descriptor, 6 portal; absent =
  default), `createdAt`, `tp` its tags (`{tagId: {t: bool}}`, `t: false` = removed), `apu`
  applied powerups, `ps` powerup slots (`"<code>_<slot>": {v: {v: richText, s: text},
  ",u": ms}`), `bpc` older slot cache, `rcrt` the powerup a Rem represents, `al` aliases
  (`[{aliasId, alias}]`, not Rems), `ie` not shown in the editor, `dci` disabled cloze ids,
  `forget`, `efc`, `enableBackSR`, `ny`, `docUpdated`, and a `<field>,u` write time per field.
- **Card:** `rId` Rem, `c` type (`f`, `b`, or a cloze id), `n` next time, `a` active next
  time, `h` history (`date`, `score`, …), `ml` mastery level (New, Acquiring, Growing,
  Solidifying, Retaining, NotYetLearned), `l` last repetition, `t` times wrong in a row,
  `e` created, `b` no longer generated, `ny` Learn New.
- **Rating scores in `h`** (bundle enum `QueueInteractionScore`): 0.01 TOO_EARLY (a
  skip), 0 AGAIN, 0.5 HARD, 1 GOOD, 1.5 EASY, 2 VIEWED_AS_LEECH, 3 RESET, 4 MANUAL_DATE,
  5 MANUAL_EASE. Counts in the main KB: 1 (211,677), 0.5 (20,544), 1.5 (17,500), 0 (16,511),
  0.01 (1,804), 2–5 (583).
- **Card type `c`:** `f` forward, `b` backward; anything else is a cloze id, in several
  shapes (long digits, `c1`, short digits, random letters).
- **Paused decks:** the Deck powerup (`de`) slot `s` = "Paused" (7 decks in the main KB).
  Their cards keep a real `a`, so a due count must leave them out; the nearest deck above
  a Rem decides (see CARD_STATE_REFERENCE.md).

### Finding what changed: `y`

Neither table has a change counter: `x` is a number given at creation and never moves.
But `y` (last local write) has an expression index, so
`json_extract(doc, '$.y') > ?` costs ~0 ms, against ~0.7 s for the same test on `u`.
Over 7 days no Rem had `u` newer than `y`, so `y` also follows edits arriving by sync.
`rem_index.refresh` re-reads every Rem with `y` above its watermark (minus 10 s, since
stamps need not commit in order) before each search: ~5 ms.

### Index traps

- `json_extract(doc, '$.rcrt') IS NOT NULL` scans every Rem (0.8 s); `> ''` uses RemNote's
  index on `rcrt` (1 ms).
- Asking FTS5 for `bm25` over a list of rowids is ~300× slower than scoring every match
  (600 ms vs 2 ms for 505 rows; a one-letter prefix scores 159k rows in 92 ms).
- ORing several `ancestor_ids` ranges in a `WHERE` keeps SQLite off their index (1.9 s for
  11 scopes); a `UNION ALL` of one range per scope uses it (0.39 s, the rest a name scan).
- Scanning every Rem's name (`json_extract(doc, '$.r') LIKE …`) costs ~0.3 s.

## Why a card isn't shown, as stored

Every suppression but pausing clears the card's `a` (measured: all 443 cards under the
15 Rems with Disable Descendant Cards). The cause is readable from stored fields, in the
order of the Suppressed Cards tab (`classifyUnscheduled`):

| Cause | Stored as |
|---|---|
| paused deck | nearest Deck (`de`) above has slot `s` = "Paused"; `a` stays set |
| an ancestor's Disable Descendant Cards | an ancestor has powerup `u` |
| off on the Rem | Rem `forget: true`, or powerup `u` on the Rem itself |
| … in a table | the same, with the Rem or an ancestor having `vt: 1` (TABLE; 2 = LIST). 827 tables, 5,755 Rems in them |
| direction off | forward card and Rem `efc: true`, or backward card without `enableBackSR` |
| cloze switched off | the card's cloze id (`c`) is in the Rem's `dci` (4 Rems use it) |
| text removed | card `b: true` |

`dci`, `forget`, `efc` and `enableBackSR` never reach a plugin (the SDK's Rem serializer
drops them), which is why the tab infers "switched off card by card"; the database has
them as stored. Main KB, cards by cause: table 2,081, Rem 332, removed 324, direction 75,
cloze 1, and 359 left for the paused/ancestor causes (`rem_search.py` `CARD_CAUSE`).

## Stability and difficulty are computed, not stored

RemNote's Bullet Information panel computes them when it opens (1.30.2-beta: component
`X` → module `440825` `O$`/`Wx`): `ts-fsrs` (module `673402`) built from the card's
scheduler settings and replayed over its history sorted by date. Scheduler doc fields
(`spaced_repetition_scheduler`): `n` name, `st` type (`fsrs`, `sm2`, `plugin`), `w`
weights (empty = defaults), `tr` target retention (0.9), `fls`/`frs` learning and
relearning steps, `md` maximum interval (1,825), plus SM-2 ones (`se`, `ift`, `eb`…).
The card's scheduler is the `src` of its Rem or nearest ancestor, else the Global
Default (`knowledge_base_data` key `spacedRepetitionSchedulerIdKb`). An SM-2 scheduler
shows Ease and Phase instead. No bridge call returns any of this.

The panel replays the whole history, Resets included; RemNote's scheduling starts over
at a Reset. `scripts/fsrs.py` (a port of `src/lib/fsrs.ts`) follows the scheduling.
Checked Nov 14, 2026: the panel's S 198.86914922 / D 6.52020114 for one card came out
as 198.8691506 / 6.5202011; for cards reviewed in the last 14 days, 92.4% of the
intervals RemNote scheduled are within ±10% of S × the retention factor (median ratio
0.999, the rest RemNote's fuzz and reviews made under the previous Global weights).
Main KB schedulers: Global Default (FSRS, optimised), Vocabulary (FSRS, default
weights), Questions and an imported one (SM-2). Only 138 Rems carry `src`.

## Slot and property values live in two places

- **User properties** of a tag are hidden child Rems of the tagged Rem: `ie: true`, `key` =
  a single reference to the property Rem (a child of the tag), `value` = the value. 66,129
  such children for 1,807 properties in the main KB (e.g. the Anki-import tags' Book, Page,
  Chapter, Decks In).
- **Powerup slots** use the same shape for **visible** slots: an IncRem's Priority and Next
  Rep Date are written to property children of the Incremental powerup's slot Rems, while
  hidden slots (history, dates, Card Priority) are in `ps` (see
  `src/lib/powerup_slot_compat.ts`).
- A visible slot can **also** keep an older copy in `ps`: 5,063 IncRems had both, and in
  every one the child was written later (`value,u` > the `ps` entry's `,u`). The `ps` copy
  is stale. Reading "a slot's value" means taking the newest write across both places.
- A property child is a Rem too and can carry **slots of its own**: the plugin's
  inherited card priority lands on them (e.g. a "Mnemonic recall" value). Only the
  child's `value` belongs to the parent; its own `ps` stays its. (An index filing the
  child's whole document under the parent lost thousands of card priorities, Nov 2026.)
- **Card priority** is the hidden `cardPriority_priorityValue`, with the visible
  `cardPriority_priority` as fallback (`src/lib/card_priority/slot_access.ts`). 1,913
  Rems hold different values in the two; the hidden one is the priority.
- Date slots hold a reference to a daily document; the text is its name ("August 1st,
  2026"). Sources are the slot `os_os`, whose value lists references to the source Rems.

## Bulk writes move edit times

`key,u` is bumped by any write of the text, not only a person typing: 992 Rems got a new
`key,u` within one minute on 2026-11-13. So "edited in the last N days" means "text
written", as Anki's `edited:` does.
