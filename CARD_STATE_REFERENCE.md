# Card state reference — disabled, paused, and not-generated cards

Engineering reference. Established by measurement (debug widget → **Probe Card Enablement**)
against a live and a test KB in August 2026. Written because every one of these states looks
identical through the obvious API, and guessing between them produced wrong conclusions twice.

## The core trap

`plugin.card.getAll()` and `rem.getCards()` do **not** return the same thing.

| Source | Returns |
| --- | --- |
| `plugin.card.getAll()` | Every card **record** in the KB, including every disabled one. |
| `rem.getCards()` | Only the cards the Rem currently **surfaces** — disabled cards are dropped. |

So `rem.getCards().length === 0` means *"nothing is surfaced right now"*. It does **not** mean
the Rem has no cards, and it is **not** evidence that a card record is junk. A Rem whose cards
were all switched off looks exactly like a Rem whose cloze markup was deleted.

The scheduler-side marker is `nextRepetitionTime`:

- a card RemNote will never surface has **`nextRepetitionTime === null/undefined`**;
- everything that consumes due-ness (the queue, the Priority Review Document, the Weighted
  Shield) filters on `(nextRepetitionTime ?? Infinity) <= now`, so those cards are invisible to
  all of them — correctly;
- the internal `nextTime` (as opposed to `activeNextTime`, which is what `nextRepetitionTime`
  maps to) is **not exposed** by the SDK. The `Card` object carries only `_id, remId, type,
  createdAt, repetitionHistory, nextRepetitionTime, timesWrongInRow, lastRepetitionTime`. There
  is no "disabled" flag on a card, and no way to read the pre-disable due date.

Repetition history **survives** disabling. A card with 3 reps that gets switched off keeps its 3
reps and loses only its next time.

## The states

| State | Set by the user via | Detect with |
| --- | --- | --- |
| **Paused deck** | Deck powerup → Status = "Paused" on an ancestor | see **Paused decks** below — this one does NOT null `nextRepetitionTime` |
| **Disabled by ancestor** | "Disable Descendant Cards" on an ancestor | walk ancestors: `hasPowerup(BuiltInPowerupCodes.DisableCards)` (code `"u"`) |
| **Disabled on the Rem** | flashcard menu → "Enable Cards" off | `rem.getEnablePractice() === false` (or the Rem's own `DisableCards` powerup) |
| **Table row / cell** | nothing — RemNote ships tables this way | `rem.isTable()` on the Rem or any ancestor; reports `enablePractice === false` like a deliberate switch-off |
| **Direction disabled** | flashcard menu → Flashcard Direction, **or** disabling a forward/backward card in the queue | `rem.getPracticeDirection()` no longer includes the card's direction |
| **Single cloze disabled** | queue → disable this card (cloze) | *no Rem-level trace* — see below |
| **Markup removed** | editing the cloze or back side away | *no Rem-level trace* — see below |

### Rem-level states are cheap to detect

`getEnablePractice()`, `getPracticeDirection()` and the two ancestor powerups cover everything
that silences a whole Rem or subtree. Check them first: they explain every card on the Rem at
once.

### Direction cards and cloze cards behave differently

Disabling a **forward/backward** card in the queue does **not** stay on the card — it rewrites
the Rem's practice direction. A bidirectional Rem whose backward card is switched off reports:

```
enablePractice=true, practiceDirection=forward   ← was 'both'
  unQmbZtxdCwPelFtX  forward   inGetCards=true   nextRep=2030-02-28  reps=8
  qqmpC7wbuIuGqWKS6  backward  inGetCards=false  nextRep=(null)      reps=1
```

Measured before/after on a single forward-only Rem, which pins the mechanism exactly:

```
before:  practiceDirection=forward   1 card surfaced   nextRep=2028-10-24  reps=7
after:   practiceDirection=none      0 cards surfaced  nextRep=(null)      reps=7
```

`enablePractice` stayed `true` through both — the Rem's Enable-Cards flag is a *different*
action, which is why it is tested separately and first.

So direction cards ARE detectable at Rem level: compare the card's direction against
`getPracticeDirection()` (`'both'` covers both; `'none'` covers neither). The way back is
`setPracticeDirection`, not a per-card action.

**Corollary:** `getPracticeDirection() === 'none'` on a Rem that still has a back side is the
fingerprint of a direction card disabled from the queue, not of a setting anyone chose. Treat a
KB's `'none'` Rems as disabled cards to review, not as configuration.

Cloze cards are **not** governed by the practice direction — a Rem with direction `'none'` still
generates its clozes — so the direction test must be scoped to forward/backward cards only.

### The two per-card cloze states are the hard part

Disabling **one cloze** in the queue leaves the Rem untouched:

```
enablePractice=true, practiceDirection=forward, DisableCards on this rem: false
cards: 2 in the card table, 1 surfaced by rem.getCards()
  2GAquyN8FdNYsnVZn  cloze:48545702581399686  inGetCards=false  nextRep=(null)  reps=3
  VHi7KlI4Bk2b224xH  cloze:0592505950758665   inGetCards=true   nextRep=2027-03-14  reps=4
```

Nothing at Rem level distinguishes that from a Rem whose cloze was deleted — in both cases the
card sits in `card.getAll()`, is absent from `rem.getCards()`, and has a null next time. (This
is the one state with no Rem-level trace at all; directions, per above, do leave one.)

**The discriminator is the markup itself.** Cloze markup lives in the Rem's rich text as `cId`
on the text elements (also `blocks[].cId` for image clozes, `clozeOrder`, `latexClozes`), and a
cloze card's `type.clozeId` names the cloze it belongs to:

- cloze id **still in the Rem's text** ⇒ the markup exists, so the card was **individually
  disabled**;
- cloze id **absent** ⇒ the cloze was **edited away**;
- forward / backward card: substitute "does the Rem still have a back side" (`rem.backText`).

Verified in both directions on the same card: with the cloze present the probe reports
`markupStillPresent=true`, and after deleting that cloze from the Rem it reports
`markupStillPresent=false` while the card record and its 3 reps persist.

`collectClozeIds()` and `markupStillPresent()` in
[`src/lib/card_analytics_export.ts`](src/lib/card_analytics_export.ts) implement this.

#### Where RemNote actually keeps it: `dci`

Read out of the desktop bundle (`/Applications/RemNote.app/Contents/Resources/app.asar`), not
inferred. Disabled clozes live in one field on the **Rem** document — `DISABLED_CLOZE_IDS`,
serialized as `dci`, a plain array of cloze ids:

```js
isClozeIdEnabled(e) { return !this['dci']?.includes(e) }

isCardTypeEnabledAndRemEnabled(e) {
  return !this.isEntireRemCardsDisabled() &&
    (e === FORWARD  ? !this[DISABLE_FORWARD_CARD]
     : e === BACKWARD ? this[ENABLE_BACK_SR]
     : this.isClozeIdEnabled(e))          // ← clozes
}
```

Three consequences, each of which cost us a wrong assumption at some point:

1. **There is no "all clozes disabled" state.** RemNote's `/Disable All Cloze Cards` command is
   `update({ dci: clozeIdentifiersInText(text) })` and `/Enable All Cloze Cards` is
   `update({ dci: [] })`. Disabling every cloze and disabling one cloze are the same state at
   different lengths, which is why nothing new shows up on a Rem the user ran Disable All on.
2. **`dci` is orthogonal to `forget`.** RemNote's own `/Enable Cards` is `update({ forget: false })`
   and touches nothing else, and the plugin bridge's `setEnablePractice` is literally
   `update({ forget: !enabled })`. So a Rem whose clozes are all in `dci` **stays cardless after
   being switched back on**, from our UI or RemNote's.
3. **No plugin can read or write it.** The SDK's Rem serializer copies a fixed field list
   (`_id`, `parent`, `children`, `type`, `text`, `backText`, `createdAt`, `updatedAt`,
   `localUpdatedAt`) and drops everything else; the host's rem bridge is a closed registry of
   named handlers with no cloze accessor and no generic document write; and its `getCards`
   handler is hardcoded to `getCards({ ignorePausing: false })` — there is no `includeDisabled`
   escape hatch. MCP `read_docs_raw` does not expose it either.

So the state is **derived**, by `derivedDisabledClozeIds()` in
[`src/lib/card_analytics_export.ts`](src/lib/card_analytics_export.ts): a cloze id is in `dci`
when it is still in the text **and** owns a card record **and** that record is absent from
`rem.getCards()`. The markup test excludes an edited-away cloze; requiring a record excludes a
cloze whose card was never generated. Every Rem-wide cause (practice off, a disabling ancestor,
a paused deck, a table) must be ruled out first — each of them drops *all* the Rem's cards from
`getCards()` and would otherwise make every cloze look hand-disabled.

The audit reports this as the `clozes-disabled` verdict (all of them, nothing surfacing) or
`clozes-partly-disabled` (still producing cards, some clozes off). Neither is actionable from
the plugin; both carry the remedy text in `VERDICT_REMEDY`.

## Paused decks are a SECOND axis, orthogonal to `nextRepetitionTime`

Every other state on this page ends with `nextRepetitionTime === null`. Pausing does not.
Measured on a live KB — cards under a paused deck keep real due dates:

```
HxHyRkjx7tVHvkKqw  backward  due        next=2025-05-28
m3597IcQIcp0ziq5B  cloze     due        next=2026-01-30
m3597IcQIcp0ziq5B  cloze     scheduled  next=2026-10-16
```

RemNote applies the pause in the **queue** (the document badge reads "0 Due"), not in the card
records. So anything that decides due-ness by arithmetic over `card.getAll()` counts a paused
deck's whole subtree as due. This is why the Priority Review Document carries its own paused
filter, and it is a live divergence between the two card-priority build paths:

| Path | Card source | Paused cards |
| --- | --- | --- |
| cold (`getCardPriority`) | `rem.getCards()` | excluded — returns `[]` for a paused rem |
| warm (`buildInfoFromStore`) | `card.getAll()` | counted as due until the paused scan is applied |

**Detection is top-down.** Walking up from every card-owning Rem is not viable (a 72k-card KB
has ~45k distinct card-owning Rems). `lib/paused_decks.ts` finds the paused decks once, then
takes `getDescendants()` on each — one call per deck — and caches the suppressed id set in
session *and* local storage, so startup paths can apply it without paying for a scan.

Finding the decks needs a scan because built-in powerup membership is not enumerable: it walks
`plugin.rem.getAll()`, prefilters on the synchronous `children` field (a deck has children), and
probes the survivors with `hasPowerup`.

**"No scan has run" must never be reported as "nothing is paused."** `getPausedRemIds` returns
`null` in that case, and the analytics tab says so in words rather than showing a confident 0.

## Tables look exactly like a deliberate switch-off

A table's rows and cells are Rems under the table Rem, and RemNote creates them with cards
disabled. They therefore report `getEnablePractice() === false` — indistinguishable from a card
the user turned off on purpose, and there can be a great many of them.

`rem.isTable()` separates the two, checked on the Rem itself **and on its ancestors** (a cell's
table is two hops up, through the row). `classifyUnscheduled` splits the result into
`cards-disabled-table` (structural, nothing to investigate) and `cards-disabled-rem` (a decision
someone made, and the only one of the two worth a user's attention).

## Signals that do NOT work

- **`rem.getCards().length`** as an existence test — it is a "currently surfaced" filter. Both
  directions of the comparison against `card.getAll()` are meaningless on their own.
- **`getPracticeDirection()`** as a *Rem-level* disabled signal. A Rem with
  `enablePractice=false` still reports `'forward'`. RemNote's UI shows "Flashcard Direction:
  None" for such a Rem as a display collapse, not because the stored direction changed. Check
  `getEnablePractice()` for that. The direction IS authoritative for whether a given
  forward/backward card is generated — just not for whether the Rem is enabled at all.
- **Card `createdAt` vs Rem `createdAt`** as evidence of anything. A card record can predate its
  own Rem; that does not make it an orphan.
- **`taggedRem()` on built-in powerups** — membership is not enumerable for RemNote built-ins;
  probe with `hasPowerup` from the Rem's side instead.
- **Enabling a Rem to bring back its clozes.** `setEnablePractice(true)` writes `forget` and
  nothing else, so it leaves `dci` intact and the Rem keeps producing nothing. Reporting a
  switched-off cloze as something this plugin can fix is the actual bug to avoid here.

## Classification order

Implemented as `classifyUnscheduled()` in `src/lib/card_analytics_export.ts`. Order matters —
Rem-wide causes first, because they explain every card on the Rem at once:

1. `rem-missing` — the Rem no longer resolves
2. `paused-document` — nearest Deck ancestor is Paused
3. `cards-disabled-ancestor` — an ancestor carries Disable Descendant Cards
4. `cards-disabled-rem` — `getEnablePractice() === false`, or the Rem's own tag
5. `direction-disabled` — forward/backward card whose direction is not in
   `getPracticeDirection()` (covers `'none'`). Never applied to cloze cards.
6. `card-disabled-individually` — markup still present ⇒ this one card was switched off
7. `markup-removed` — the cloze id / back side is gone
8. `not-surfaced-unknown` — none of the above could decide it

The ancestor walk must **fold bottom-up**: memoize per node the facts of the chain *from that
node upward*, or a tag found near the leaf leaks onto the ancestors above it, and a cache hit
higher up erases a tag already found below it. Nearest Deck wins for pause (an active sub-deck
under a paused one is not paused); Disable-Cards ORs upward.

### The Rem-driven order is separate

`classifyRow()` in `src/lib/card_enablement/scan.ts` answers the same question one Rem at a time
(the audit), and its order is not the same list — a Rem with no card material is the majority
case and is dismissed first, and the two cloze verdicts sit at the end because they can only be
claimed once every Rem-wide cause is gone:

1. `no-card-material` — no back side, no clozes, no records
2. `disabled-by-ancestor`
3. `in-table` (before the deliberate switch-off: table rows ship with cards off)
4. `practice-off` — the Rem's own toggle or its own Disable-Cards tag
5. `direction-none`
6. surfacing at all ⇒ `in-paused-deck` / `clozes-partly-disabled` / `ok`
7. `in-paused-deck`
8. `clozes-disabled` — every cloze in `dci` and no back side to explain anything else
9. `not-surfaced` — nothing above decided it

## One population: deferred work still counts

Suppressed cards are not one kind of thing, and the split that matters is **deferred vs. not
work at all**:

| | in the statistics? |
| --- | --- |
| **Paused deck** | **YES** — counts as Due, New, Stale, in the FSRS averages, in the shield's weight, and in the percentile ranking |
| **Unscheduled** (disabled card / Rem / ancestor, table row, markup removed, direction off) | **NO** — excluded from everything |

**Pausing must not change any number.** Pausing defers work; it does not cancel it, and it does
not un-forget the card — its retrievability decays exactly the same. If paused cards were left
out, pausing a backlog-heavy deck would instantly improve the shield, the percentiles and every
bucket statistic, and unpausing would undo the improvement. The plugin keeps a **Priority Shield
History**, so that is not a cosmetic problem: it puts steps into a time series for a reason that
has nothing to do with studying.

Measured on a live KB — unpausing one deck (6,617 Rems) with everything else unchanged:

| | paused | unpaused |
| --- | --- | --- |
| Cards shield | 42.2% | 39.7% |
| top bucket weight share | 24.4% | 22.9% |
| threshold Rel %ile | 15.5% | 12.6% |

Processed weight barely moved (10,435.94 → 10,438.28) — no work had been done. Only the
denominator changed, because the deck had been excluded from it.

**Unscheduled cards leave everything.** A disabled card, a table row, a cloze whose markup is
gone — nothing is waiting to come back, so they are neither work nor ranking material. The
filter is `cardsNextRep === null`, already carried on every `CardPriorityInfo`.

**The two mechanisms are complementary, and users have both.** "Pause deck" says *later*;
**Disable Descendant Cards** says *not at all*. Because the second exists and is excluded from
everything, pausing can safely keep meaning "still counts". A user who wants a document out of
their statistics has an honest way to say so.

Applied in one place — `expandCardInfosToCards` (`lib/card_priority/types.ts`) — which feeds the
Weighted Shield, the standard Priority Shield, the badge `kbPercentile` and the Priority Review
Document. `isPerCardDue` in the same file is the single due predicate. Two more places need the
rule separately: `lib/priority_bands.ts` (skips a Rem only when ALL its cards are unscheduled,
keeping the pool rem-weighted) and `computeCardAnalyticsBreakdown` (deciles sized by the same
population).

Two traps found while implementing this:

- the stale-cache fallback in `expandCardInfosToCards` synthesized non-due cards with
  `nextRepetitionTime: null`, which under this rule would have deleted them from the population.
  They now get a far-future sentinel.
- `computeWeightedShieldBreakdown` stored percentiles in a `Map` keyed by `remId`, so every card
  of a multi-card Rem inherited the last one's rank, weight and bucket. That is why the shield's
  buckets disagreed with the analytics deciles. Percentile is now per item, by index.

## Consequences for the analytics

Unscheduled cards are card records that exist but can never be practised. They must not sit in
the denominator of anything describing practice:

- `Done% = (active − due) / active`, not `(cards − due) / cards` — otherwise a bucket reports
  100% done while holding hundreds of unpractisable cards;
- `%New` counts only **active** new cards (what you could still learn); unscheduled new cards
  are reported separately under `Unsched`;
- FSRS `D / R / S` averages exclude them — an unpractisable card's retrievability decays toward
  zero and would drag the bucket down for no actionable reason;
- `Items` still counts every record, so nothing is hidden.

Throughput and Outcome columns are untouched: those reps genuinely happened, and disabling a
card does not un-practise it.

## How to investigate a specific card

1. Focus the Rem, open the debug widget, hit **Probe Card Enablement**. It prints
   `enablePractice`, `practiceDirection`, the Rem's cloze ids, the whole ancestor chain with its
   flags, and per card `inGetCards` / `nextRepetitionTime` / `reps` / `markupStillPresent` /
   `wouldClassifyAs`.
2. For KB-wide work use **Export cards** in Card Priority × Memory Analytics: one CSV row per
   card with `unscheduledCause`, `remEnablePractice`, `remDisableCardsOwn`,
   `remDisableCardsAncestor`, `remDisablingAncestorId`, `clozeId`, `markupStillPresent`, plus a
   summary file with the bucket × cause matrix.

## Re-enabling

- Rem-level: `rem.setEnablePractice(true)`.
- Direction card: `rem.setPracticeDirection(...)` — this is what brings back a forward/backward
  card disabled from the queue. The pre-disable direction is not stored anywhere, but it can be
  reconstructed from the card records that exist: a backward card record proves backward was
  once enabled, so a Rem holding both records wants `'both'`, one holding only a forward record
  wants `'forward'`. Re-enabling makes the card due immediately.
- Ancestor-level: remove the Disable Descendant Cards powerup from the ancestor — **this flips
  the entire subtree at once**, so it needs an explicit confirmation and a count of what it will
  affect.
- Single cloze card, or every cloze at once: **impossible from a plugin** — see `dci` above. Not
  "no write is known": the field is absent from the SDK's Rem serializer and from the host's rem
  bridge in both directions. Nor does `setEnablePractice(true)` help, since that writes only
  `forget`. The user has to run RemNote's own `/Enable All Cloze Cards` on the Rem, or click the
  greyed cloze and choose "Enable this card". Every surface that can report this state must say
  so rather than offering a button.
- Note that re-enabling in bulk makes every affected card due immediately.
