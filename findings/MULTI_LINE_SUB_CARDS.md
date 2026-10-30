# Multi-line cards: how sub-items (partial list/set cards) are scheduled

How RemNote stores and schedules the individual items of a List or Set card, and what they do to the main card. RemNote's [help article](https://help.remnote.com/en/articles/9216774-multi-line-list-set-flashcards) only says that partial cards exist. Read from `app.asar` (RemNote **1.29.1-beta**) and checked against the local database on October 30, 2026.

## In short

- **Storage:** a sub-item has no card and no schedule of its own. Everything lives in one place, the main card's history (`cards.doc.h`), as `subCardScores` inside each repetition.
- **Algorithm:** the same scheduler as the card (FSRS in this KB, but SM-2 and plugin schedulers go through the same path). Each sub-item is a virtual card: its dates and stability are recomputed from scratch by replaying a history filtered down to that item. They are never stored.
- **Release:** the card row has a single due date, `n`. It is the **earliest** of the main card's date and the dates of sub-items recently rated Forgot or Partially Recalled. A sub-item can bring the card back sooner, but can never delay it.
- **Effect on the main card:** partial repetitions don't count toward the main card's schedule. Its stability, difficulty and own date stay frozen until the next full repetition. Which version appears (partial or full) is decided when the card is displayed.

## Where it is stored

| Data | Location |
|---|---|
| Repetition history | Main card row, `cards.doc.h[]` |
| Each item's score in a repetition | `h[].subCardScores: [{remId, score, responseTime}]`; `remId` is the item's Rem |
| Whether the repetition counts for the main card | `h[].isFullMultiLineRep` |
| The one due date | `n` (NEXT_TIME), mirrored in `a` (ACTIVE_NEXT_TIME), which is what the plugin SDK returns as `nextRepetitionTime` |
| Why that date was chosen | `ne` (NEXT_TIME_EXPLANATION): `multiLineDrivenBy` (`"main"` or an item's remId), `multiLineTriggeredSubCardsRemain`, `text` |
| Stale date, mastery level | `st`, `ml`, both derived from `n` |

Item Rems have no card rows (`cards` query by `rId` returns nothing) and no scheduling fields. Their `forget` and `history` fields are unrelated 2021-era data. The "Sub Card Info" block in Bullet Information is computed live, not read from anywhere.

Scores: Forgot `0`, Partially Recalled `0.5`, Recalled With Effort `1`, Easily Recalled `1.5`, Reset `3`.

## Building each history

Module `188814`, sliced after the last Reset (`z8`):

- **Main card** (`NI`/`SX`): keeps a repetition if `isFullMultiLineRep` is true. If that field is missing, it keeps repetitions with empty `subCardScores`.
- **Sub-item** (`p`): keeps a repetition if `subCardScores` lists the item, using the item's own score. A repetition with an **empty or absent** `subCardScores` also counts, with the overall score, so a "Forgot all" hits every item. A non-empty list without the item is skipped.
- **Which items exist** (`h`): only those scored since the last full repetition. An item dropped from the card stops being tracked. Example: `i44HnAnz2EwCm1T7F` was scored once in April 2024, is gone from Sub Card Info, and isn't in later repetitions.

Each history then goes through the ordinary scheduler (`LZ`, with `preventMultiLineCheck`). For FSRS (module `440825`) that means a replay with the card's scheduler settings, including its relearning steps (`frs`). There are no per-item parameters.

## How a rating is written

From `finalRepetitionData` and `isFullMultiLineRep` in the queue component (bundle `70685`):

| Situation | Saved `score` (main) | `subCardScores` |
|---|---|---|
| Set card, some items marked | The button pressed | Ticked items `0`; the rest get the button pressed |
| List card | Derived from item scores (`Hd`, below) | One entry per item rated |
| Forgot all | `0` | `[]`, which counts for all items |
| Skip | Too Early | `[]` |

On a Set card, ticking an item (`toggleWrongSubId`) marks it Forgot, and the button pressed then goes to the others; Forgot and Skip are disabled while only some are ticked, and only Forgot is enabled when all are. A button pressed with nothing ticked saves at once. An item can't be marked Partially Recalled.

**Dead code, don't trust it:** the bundle also holds `pressedHardOnce`, `pressedForgotOnceSetCard` and the text *Press "partially recalled" again to mark all as partially recalled. Or, tap the individual items that were hard*. No code ever sets those two states (no assignment in any bundle of 1.29.1-beta), so that message can't appear. Screen recording on October 30, 2026: pressing Hard on a 3-item Set card moved straight to the next card. In this KB the `0.5` + `1` mixes (8 reps) therefore come from List cards, and `0` + `0.5` (54 reps) from a ticked item plus Partially Recalled.

**Partially Recalled on a whole Set card:** every item gets `0.5`, so the code counts them all as troubled (`JN`). It has no visible effect when their histories match the main card's, because they replay to the same date (the main card wins the tie) and the selection covers every item, which means a full card. In this KB, 112 of the 113 repetitions following such a rep were full.

On a Set card, forgetting one item doesn't fail the main card. With Recalled With Effort as the button, the main card is scored `1` and its interval grows.

List card rule (`Hd`), where *r* counts Forgot + Partial and *a* counts all rated items. The card fails if `a==1 ? r>0 : a<=4 ? r>=a-1 : r/a>=0.6`. A failure saves Forgot if there are more Forgots than Partials, otherwise Partial. A pass saves Easy if more than half are Easy, otherwise Good. As written, items all rated Forgot individually with no Partial compare `n > undefined`, so they save Partial rather than Forgot (read from code, not observed).

`isFullMultiLineRep` is true only if all items are visible and the whole card was tested. Items collapsed in the queue therefore make the repetition partial (read from code, not observed).

## When the card is released

`R` in module `670163` runs on every rating, and the result is written by `eg` in the card status update:

1. **Candidates:** the main card, plus each item that is "troubled" (`JN`): Forgot or Partially Recalled in its last **2** scored repetitions. RemNote's own tooltip describes it: *"re-tested until you recall it 2 times in a row"*. So Partially Recalled also makes an item a candidate, not only Forgot.
2. **`n` = earliest candidate date.** The main card wins ties.
3. **`st` and `ml` follow `n`.** Stale time is `max(n + 2·(n − lastRep), n + 3 days)`, so a forgotten item makes the whole card go stale much sooner.

Items that have recovered are ignored, even if their own date is earlier.

**Ties (`R`):** if the main card and an item have the same date, the result is credited to the main card. The date doesn't change. Only the explanation does: `multiLineDrivenBy: "main"` and "From the main card's schedule". Ties are common, because an item with the same scores as the main card replays to the same date.

## How a forgotten item's schedule is built

The item goes through ordinary FSRS, in three phases. Read from module `673402` (ts-fsrs) and run through it with this KB's weights.

**1. The lapse.** A Forgot in the Review state does three things:

- Stability falls to `min(w11 · D^-w12 · ((S+1)^w13 - 1) · e^((1-R)·w14), S / e^(w17·w18))`.
- Difficulty rises.
- The item enters Relearning at step 1.

**2. Relearning.** The steps are the scheduler's `frs` setting: a comma-separated list in days, with one entry per step and no fixed count. This KB has one step of 0.0625 days (90 min). RemNote's default is 10 min. An empty list skips Relearning. The lengths are fixed and don't depend on the main interval, S or D.

| Rating in Relearning | Next wait | State |
|---|---|---|
| Forgot | First step | Stays in Relearning |
| Partially Recalled | One step: 1.5 × the step. Several: mean of the first two | Stays in Relearning |
| Recalled With Effort | Next step if any. Otherwise graduates, with an interval from S | Review after the last step |
| Easily Recalled | Graduates at once, with an interval from S | Review |

A step of 1 day or more moves the item to Review with that fixed interval (`a >= 1440`).

**3. Graduation and Review.** The interval is S adjusted for target retention (S itself at 90%), in whole days, with fuzz in the stored `n` and capped by the maximum interval. So the post-lapse interval comes from the item's stability, not from a ratio of the main interval. Lapsing when due at R = 90%, with this KB's weights:

| S before | S after | Ratio |
|---|---|---|
| 43.3 | 9.4 | 22% |
| 162.5 | 19.8 | 12% |
| 488.7 | 35.7 | 7% |
| 1243.2 | 58.2 | 5% |

**Same-day reviews.** ts-fsrs counts elapsed time in whole UTC days. A review on the same UTC day uses the short-term formula, where Recalled With Effort leaves S unchanged and a second Forgot lowers it (19.78 → 5.69). On a later UTC day the normal formulas apply, so a Good after one day gave 19.78 → 23.69.

**A troubled item isn't the same as a relearning item.** "Troubled" means Forgot or Partial in the last 2 scored repetitions. That window has nothing to do with `frs`. After graduating, an item stays troubled until two ratings in a row are Good or Easy, so its review date can still drive `n`.

A Forgot on an item that has never been recalled, outside the Learning state, uses `fi` (Forgot Interval Minutes, default 1) instead of a step. Read from code, not observed.

## Partial or full?

`Ae` runs when the card is displayed, using `today` = end of the current RemNote day:

1. **Main card due by today → full card.** This takes priority over any sub-item.
2. Otherwise, test the troubled items with the **lowest sum of their last 2 scores** (all ties), plus any other troubled item due today, plus items never scored (added to the list later).
3. If that selection would cover every item, or no item is troubled → full card.

An item can be tested before its own date if it has the lowest recent scores, because the selection isn't purely date-based. In "Practice All" mode, `Ae` only reads history since the queue opened, so cards start out full (read from code, not observed).

The article says that once you've mastered the partial cards "RemNote will start showing you the full list card again". More precisely, the full card returns **on the main card's own date**, not as soon as the items recover.

## Worked example: `fDW1vj4q2J6KOJyJ7`

Card `D0Qo6vRm4fAsy9kNB`, Set card with 3 items, FSRS with `frs` = 0.0625 days (90 min). On October 30, 2026 at 08:13 (local time), the repetition was **Partially Recalled, full**, with item scores:

| Item | Score | Last 2 scores | Stability | Difficulty | Own next date |
|---|---|---|---|---|---|
| Main card | 0.5 | - | 56.61310193 | 6.83414814 | Dec 26 |
| `CshPb4UINOrkr91mP` | 0.5 | 1, 0.5 | 56.61310193 | 6.83414814 | Dec 26 |
| `OQlkEjf1g4YTytS6m` | **0** | 1, 0 | 13.34087437 | 7.52368679 | **Oct 30, 09:43** |
| `sm117Wn2C9bxGIUzr` | 0.5 | 1, 0.5 | 56.61310193 | 6.83414814 | Dec 26 |

**Verified:** replaying the filtered histories (7 repetitions each, since the April 2024 Reset) through RemNote's own FSRS code extracted from the bundle reproduces all these stability and difficulty values to 8 decimals, exactly as Bullet Information shows them. The dates in that panel are computed without fuzz, while the stored `n` is computed with fuzz on.

All three items are candidates, and the forgotten one has the earliest date, so `n` = 09:43, which is the 90-minute step. `ne.multiLineDrivenBy` = `OQlkEjf1g4YTytS6m`, and `st` = Nov 2 (`n` + 3 days). That is why Bullet Information shows a "Next Interval" of 2 hours on a card whose main schedule is 57 days.

Next steps predicted by the same replay (assumes a Good rating and no fuzz; not yet observed):

1. **Now:** the main card isn't due. Sums of the last 2 scores are 1.5, 1 and 1.5, so a partial card tests only `OQlkEjf…`.
2. **Good, on the same UTC day:** S stays 13.34, interval about 13 days. The last two are `0, 1`, still troubled, so it stays the driver. (Partially Recalled would give about 2h15, Forgot 90 min with S 3.94, Easy about 20 days.)
3. **Good again, about Nov 12:** interval about 50 days and the item is cleared. The other two are still troubled but tied with the main card, so `n` = Dec 26 and the explanation reads "from the main card".
4. **Dec 26:** full card, using the main card's S 56.6 and counting elapsed time from October 30.

## Knowledge-base check

Of the 923 cards in this KB with `subCardScores`, 148 have partial repetitions since their last Reset. 169 carry `multiLineDrivenBy`: 158 main, 11 item. All 11 item-driven cards have Forgot or Partial in that item's last 2 scored repetitions, with no exceptions.

## Other effects

- **FSRS optimizer:** it trains on `NI`, the main-card history only, so sub-item repetitions aren't training data.
- **Rating buttons:** on list cards they show the current item's interval (`nextSpacingDateForSubCardId`). Right-clicking the time shows the schedule explanation.
- **Exams:** exam scheduling adjustments apply to these dates too, through the same `LZ` path.

## For the plugin

- `card.nextRepetitionTime` is the earliest date (`a`), **not** the main card's schedule. There is no SDK call for the main card's own date.
- `repetitionHistory` is the raw `h` array. The bridge's card mapper (`history: n[HISTORY]`, bundle `49950`) doesn't strip anything, so `subCardScores` and `isFullMultiLineRep` reach plugins even though they aren't in the typings. Read from code, not observed in a running plugin.
- `countsForMainCard` in `src/lib/fsrs.ts` applies RemNote's rule. FSRS replay, the forgetting curve, calibration and the outcome stats in Card Analytics (retention, lapses, grade, predicted R) now leave partial repetitions out. Reps, time and cost still count them, because they are real work. Due and stale status keep following `n`.

**Check against RemNote's FSRS:** on the 148 affected cards, the plugin's stability is within 5% of RemNote's on 132 cards, up from 47. The median error fell from 10.5% to 0.2%. The fix was tested on `remnote.db` data, with no change to RemNote.

`src/lib/fsrs.ts` has since been corrected to match RemNote's FSRS exactly. See [Scheduler assignment and replay accuracy](#scheduler-assignment-and-replay-accuracy).

**Items panel (`src/lib/multi_line_items.ts`):** the Flashcard Repetition History applies these rules to explain a card. Replayed on this KB's 906 multi-line cards on Global:

| Check | Agreement |
|---|---|
| Which candidate sets the due date, against stored `ne.multiLineDrivenBy` | 165 of 166 |
| Next showing, for all 2,282 repetitions, against what was actually shown | 2,217 (97.2%) |
| When a full card was predicted | 1,928 of 1,942 (99.3%) |
| When a partial card was predicted | 289 of 340 (85%) |
| Main card's date, against stored `n`, intervals over 3 days | 123 of 153 within 15%, 80 within 5% |

Of the 340, 31 were shown full, and 16 of the other 20 misses were partial repetitions recording no item scores, so the prediction can't be judged there. The date gap includes fuzz and weights that changed after a card's last rating. `isCram` is true on most repetitions in this KB, so it doesn't identify cram sessions.

## Scheduler assignment and replay accuracy

**Where it's stored.** A Rem's `src` field holds a scheduler id from the `spaced_repetition_scheduler` table. The counts match Settings > Schedulers exactly (6 Vocabulary, 97 Questions, 0 imported). A card uses the scheduler from its Rem or nearest ancestor with `src`, through `get_spaced_repetition_scheduler_source_rem` in the WASM graph. If that id no longer exists, RemNote falls back to the Global Default.

The ancestor walk is inferred, because the WASM isn't readable. It was checked against `ne.text`, which records what scheduled each card at its last rating: 16,061 of 16,149 Global cards say FSRS, and 2,427 of 2,433 Questions cards don't.

Cards with history, by resolved scheduler (October 30, 2026):

| Scheduler | Type | Cards |
|---|---|---|
| Global Default | FSRS, optimized weights | 35,655 |
| Deleted scheduler, so Global Default | FSRS, optimized weights | 1,839 |
| Questions | SM-2 | 3,597 |
| Vocabulary | FSRS, default weights | 600 |

**Algorithm differences (fixed October 30, 2026).** The plugin's math differed from RemNote's FSRS in four ways. Running both sides with the card's own scheduler weights, so the weights can't explain the gap, each correction closed part of it:

| Applied in turn | Global, within 5% | Vocabulary, within 5% |
|---|---|---|
| Plugin before the corrections | 93.8% | 76.8% |
| Same UTC day uses the short-term formula, whatever the card's state | 98.9% | 94.0% |
| Elapsed time in whole UTC days | 99.8% | 99.5% |
| Short-term Hard can't lower stability | 100% | 100% |
| Mean reversion uses the unclamped Easy difficulty | 100% (all within 0.1%) | 100% (all within 0.1%) |

The last one only matters when the Easy initial difficulty falls below 1, as with default weights.

After the corrections, `src/lib/fsrs.ts` agrees with RemNote's library within 0.001% on all 38,056 FSRS cards, for stability, difficulty and the forecast of all four grades. `src/lib/fsrs.test.ts` pins this with reference values. The R reported for a repetition (`FSRSStepState.r`, `FSRSState.r`) still uses real elapsed time, so it stays on the drawn curve, and RemNote's formulas use whole days only for the next stability.

**Scheduler differences.** The plugin has one weight set and no API for a card's scheduler, so non-Global cards still differ for this reason, and the corrections don't change that. Assuming the plugin's weights equal the Global Default (the setting isn't in `remnote.db`):

| Cards | Compared with | Within 5% | Within 25% | Median plugin ÷ RemNote |
|---|---|---|---|---|
| Vocabulary | RemNote's stability | 3.4% | 12.4% | 2.36 |
| Questions (SM-2) | Actual interval in days, since SM-2 has no stability | 8.7% | 37.7% | 1.09 |

**What RemNote does itself (1.29.1-beta):**

- **Live:** on each displayed card, the answer buttons call `rem.getNextSpacingDateInteractionInfoScheduler()` once, then compute all the grades with that scheduler. `getSpacedRepetitionScheduler` asks the in-memory WASM graph (`get_spaced_repetition_scheduler_source_rem`), caches the answer until the graph changes, and has no bridge cost.
- **Bulk:** the code read doesn't resolve per card. `computeCardBurden` takes the first card's scheduler, and the deck schedule tool takes the deck's.
- **Plugins:** the Rem mapper (`mapRemToPluginInterface`) is a whitelist of `_id`, `owner`, `createdAt`, `parent`, `type`, `u`, `children`, `text` and `backText`, so `src` never reaches a plugin. The card mapper has no scheduler field either.

**Cost on this KB, if a plugin resolved it:** 45,708 Rems own cards, at median depth 7 (p99 12). A walk per Rem is 311,880 parent reads, or 55,782 with memoization. Reading `parent` and `src` for all 434,676 Rems straight from `remnote.db` took about 1 second.

**In the plugin:** `scripts/export_scheduler_cards.py` writes the non-Global cards to a JSON file, and the "Import RemNote Scheduler Data" command stores it (`src/lib/scheduler_cards.ts`). The Global scheduler's id is the `spacedRepetitionSchedulerIdKb` row in `knowledge_base_data`. This KB's list has 7,016 cards, including those not yet practised, and takes one key of 247 KB in UTF-16 (27.5% of the ceiling).

## Method

Start from module `188814` in `build/js/21517.*.bundle.js`, then `670163` (`LZ`, `R`, `O`) and `440825` (FSRS) in the same bundle. The FSRS library is module `673402`, which has no dependencies and runs in Node with a small `r.d` shim. Find them again by searching for `From sub-item {{subItemId}}` or `multiLineDrivenBy`. Minified names change between builds.
