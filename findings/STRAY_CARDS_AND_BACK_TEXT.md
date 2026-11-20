# Stray flashcards: how to find them, and how to make a card a plain Rem again

Established on November 19, 2026 (RemNote 1.30.2-beta, main KB) while cleaning up the Anki decks: RemNote's parse of the Anki HTML had turned the lines of the **Extra** field (a slot of the "Anki Card - …" tags, meant to be text only) into flashcards. 285 such cards were turned back into plain Rems; 28 others were left for the user to judge.

## In short

- **A multi-line card is marked on its answer lines, not on the question.** Each answer child carries the `w` powerup (Card Item; `MultiLineCard` in the SDK). The card row belongs to the parent. Removing `w` from the direct children is what RemNote's own card-type menu does, and it leaves a plain Rem.
- **The Rem field `qe` is not a multi-line flag.** It is `QUEUE_IS_EXPANDED_RAW` (whether the Rem's children show expanded in the queue). It often sits on multi-line questions, but 58,358 Rems in the main KB carry it with no card at all. Don't confuse it with the powerup *code* `qe` (QueueEditStatus).
- **No plugin call can remove a back once it exists.** `setBackText([])` leaves `value: []`, which still draws the green arrow and "Back of card" in the editor. `setBackText(null)` is rejected ("Expected array, received null"), and so is `undefined` ("Required"), although the typings allow it. The RemNote MCP's `edit_rem`, given a line with no delimiter, sets `value: null`, which the editor treats as no back.
- **A card's real birth date is the card row's `e`.** A Rem's `createdAt` is reset when a RemNote export is imported again; `e` survives that import.
- **`enablePractice` is the Rem's `forget` field, inverted.** Plain Rems have it on as well; it doesn't have to be switched off for a Rem without a card.

## Telling stray cards from the user's own

The decks had been through two imports: Anki into an old KB (July 15 and 18, 2024), and then a RemNote export of that KB into the main KB (October 29, 2024).

| Signal | What it shows |
|---|---|
| `srcRemId` + `srcRemC: "a/fakeImportArticle<random>"` on the Rem | The Rem came in through a RemNote→RemNote import; `srcRemId` is its id in the source KB (which is not on disk any more) |
| Rem `createdAt` | The **import** time (2024-10-29 for every Rem of those decks). Useless for "made before or after Anki" |
| Card `e` | When the card first appeared in RemNote, kept across the second import. The notes' own cards show `e` = 2024-07-15/18 while `h` holds Anki reps from 2018–2020 |
| Card `h` | Reps since the import mean the user practiced the stray card; converting it drops them |
| A rem reference in the text (`~Mnemonic`, `[~Motivo(s)]`) | Written in RemNote, not parsed from Anki |

Classification used: card `e` on the Anki import days, never reviewed, no references → **stray** (285). Same but reviewed since → **stray, ask** (8). Card `e` later than the Anki import but before the second import, inside notes that carry Anki history → **unclear** (5; cards regenerated in Aug–Sep 2024). Created after the second import, or card `e` after it → **the user's own** (15).

## Converting

Everything goes through the plugin (media bridge) or the MCP; `remnote.db` is only read, read-only, to plan and to check.

**Multi-line card** (a Rem with `w` children and no back), 256 Rems:

1. `untag <children> powerup:w` on the **direct** answer children only. The card row goes at once.
2. `strip-priority <rem>`: the plugin's own `removeCardPriorityFromRems` clears the CardPriority slots first (priority, hidden `priorityValue`, source, lastUpdated, priority history), then removes the powerup, then the band tag, then the cache entry.

Setting the practice direction to "none" also removes the card, but the editor then shows the `—` delimiter and "This is not a flashcard because it was created with the `>-` delimiter". Removing `w` from the question itself does nothing when its own parent isn't a multi-line card.

**In-line card** (front and back), 29 Rems:

1. `set-text`: front = front + " ⇒ " + back, back = `[]`. The card goes, but the editor still draws "→ Back of card".
2. `edit_rem` (MCP) with the same line as plain markdown, no delimiter: `value` becomes `null` and the stub disappears. It keeps the Rem's children (checked on a Rem with 14), but flattens what markdown can't hold (colored text, links, `{"i": "s"}` elements).
3. `set-text` on the front again, with the exact rich text of step 1 (only the front; the back stays `null`).
4. `strip-priority`.

"⇒" was the separator because the user's own unsplit copies of the same lines used it ("voluntárias ⇒ SAR"); ":" already appears in about 4,950 Extra lines as heading and label punctuation.

**Checks after each batch**, read from `remnote.db`: no card row for the Rem; front equal to the planned rich text; back `null` (in-line) or unchanged (multi-line); no `w` left on the planned children; `tp.<CardPriority tag>.t` false; the children list unchanged. All 285 passed. Do one Rem first and have the user look at it in the editor: the database said "no card" for two states that still looked like flashcards on screen (direction "none", and `value: []`).

## Value states in the main KB

| `value` | Rems | In the editor |
|---|---|---|
| absent | 343,062 | plain Rem |
| `null` | 979 | plain Rem |
| array (including `[]`) | 105,697 | arrow + back; `[]` shows "Back of card" |

## How it was found

- **DB:** walked every Rem whose `key` is a single reference to an "Extra" property of a tag named "Anki…" (that is what a slot Rem looks like), collected the descendants with card rows, and compared `createdAt`, card `e`, `h` and `srcRemC`. Then correlated `qe`, `w` children and card rows across the whole KB to see which predicts a card.
- **Bundle:** `QUEUE_IS_EXPANDED_RAW:"qe"` in the Rem field enum. The multi-line → single-line/cloze conversion is `(await rem.childrenRemAsync()).map(e => e.setIsCardItem(false, …))`. The "enabled" test is `!forget && !(!enableBackSR && DISABLE_FORWARD_CARD) && …`.
- **Plugin:** the debug widget's Probe Card Enablement and Card API Comparison confirmed 0 cards through `rem.getCards()` and `card.getAll()`. Every statistic (Card Memory Analytics, Priority Review Document, Shield) builds from `card.getAll()`, so a Rem without a card row is invisible to them.
- **Editor:** the user checked each test Rem's look before every batch.

Related: [MULTI_LINE_SUB_CARDS.md](MULTI_LINE_SUB_CARDS.md) (how multi-line items are scheduled), [CARD_STATE_REFERENCE.md](CARD_STATE_REFERENCE.md) (`forget`, `efc`, `enableBackSR`), [REMNOTE_POWERUP_CODES.md](REMNOTE_POWERUP_CODES.md) (`w`).
