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
| Set card, some items marked | The button pressed | Marked items `0` (or `0.5` if you pressed Partially Recalled first); the rest get the button pressed |
| List card | Derived from item scores (`Hd`, below) | One entry per item rated |
| Forgot all | `0` | `[]`, which counts for all items |
| Skip | Too Early | `[]` |

On a Set card, forgetting one item doesn't fail the main card. With Recalled With Effort as the button, the main card is scored `1` and its interval grows.

List card rule (`Hd`), where *r* counts Forgot + Partial and *a* counts all rated items. The card fails if `a==1 ? r>0 : a<=4 ? r>=a-1 : r/a>=0.6`. A failure saves Forgot if there are more Forgots than Partials, otherwise Partial. A pass saves Easy if more than half are Easy, otherwise Good. As written, items all rated Forgot individually with no Partial compare `n > undefined`, so they save Partial rather than Forgot (read from code, not observed).

`isFullMultiLineRep` is true only if all items are visible and the whole card was tested. Items collapsed in the queue therefore make the repetition partial (read from code, not observed).

## When the card is released

`R` in module `670163` runs on every rating, and the result is written by `eg` in the card status update:

1. **Candidates:** the main card, plus each item that is "troubled" (`JN`): Forgot or Partially Recalled in its last **2** scored repetitions. RemNote's own tooltip describes it: *"re-tested until you recall it 2 times in a row"*. So Partially Recalled also makes an item a candidate, not only Forgot.
2. **`n` = earliest candidate date.** The main card wins ties.
3. **`st` and `ml` follow `n`.** Stale time is `max(n + 2·(n − lastRep), n + 3 days)`, so a forgotten item makes the whole card go stale much sooner.

Items that have recovered are ignored, even if their own date is earlier.

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
2. **Good:** S stays 13.34, interval about 13 days. The last two are `0, 1`, still troubled, so it stays the driver. (Partially Recalled would give about 2h15, Forgot 90 min with S 3.94, Easy about 20 days.)
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
- `repetitionHistory` is the raw `h` array passed through by the SDK's card object. `subCardScores` and `isFullMultiLineRep` aren't in the typings, and whether they arrive at runtime hasn't been tested.
- No plugin code reads those fields. So `fsrs_calibration.ts`, `card_analytics.ts` and `CardForgettingCurve.tsx` replay partial repetitions as if they were main-card repetitions, which RemNote doesn't do. Their stability can differ from RemNote's on affected cards. Not changed so far.

## Method

Start from module `188814` in `build/js/21517.*.bundle.js`, then `670163` (`LZ`, `R`, `O`) and `440825` (FSRS) in the same bundle. The FSRS library is module `673402`, which has no dependencies and runs in Node with a small `r.d` shim. Find them again by searching for `From sub-item {{subItemId}}` or `multiLineDrivenBy`. Minified names change between builds.
