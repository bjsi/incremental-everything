# Edit Spaced Repetition Data: "Reset SRS Data" resets every card of the bullet, not only the selected cards

**Reporter:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Affected:** RemNote desktop for macOS, 1.30.2-beta
**OS:** macOS 27.2
**Date:** 2026-11-11

---

## Summary

In the **Edit Spaced Repetition Data** dialog (`/srs`), you can pick individual flashcards of a bullet, and the reset section says it applies to "the selected flashcards". But **Reset SRS Data** resets **every card of the bullet**, including the ones left unticked. There's no way to reset only one cloze of a multi-cloze bullet from this dialog.

## Steps to reproduce

1. Take a bullet with several clozes that all have practice history. Mine has three, each practised 6–10 times.
2. Run `/srs` on it.
3. Hover the bullet chip and tick **one** cloze only, leaving the other two unticked. The stats panel updates to "Total 1 card".
4. Click **Reset SRS Data** (or press `r`) and confirm.
5. Open the bullet's information panel.

**Expected:** only the ticked cloze is reset. The section's description reads "Reset your study progress for the **selected flashcards**", and the stats panel already counts only the ticked card.
**Actual:** all three clozes show **New** / "Never" practised. Each one's practice history count went up by one (8→9, 10→11, 6→7).

The confirmation hints at what really happens: "Reset practice history for **1 bullet**? The flashcards created from the bullet will return to your queue as if they were new cards." This contradicts the section text and the card picker.

## Screenshots (attached)

1. Bullet information before: three clozes, all Stale, with 8 / 10 / 6 practice sessions.
2. Edit Spaced Repetition Data with only "Cloze (parting towlines)" ticked; the stats panel reads "Total 1 card".
3. The Reset SRS Data section: "Reset your study progress for the selected flashcards".
4. The confirmation: "Reset practice history for 1 bullet? …"
5. Bullet information after: all three clozes New, 9 / 11 / 7 practice sessions.

## What I found

To see whether the plugin was involved, I read the stored cards and the app's JavaScript bundle (1.30.2-beta).

**The stored cards.** All three cards of the bullet got a RESET entry (`score: 3`) at the same millisecond, `1794435300517` (2026-11-11 19:15:00). The ticked card and the two unticked ones look the same.

**The dialog.** It keeps two separate selections:

- `n`: the selected bullet ids
- `K`: the selected card ids

The other actions in the dialog respect the card selection. Record External Practice Session, Set Next Practice Date and Set Ease each run on the selected cards only:

```js
ec = /* per bullet */ (await rem.getCards({ignorePausing:true})).filter(c => K.includes(c._id))
…
for (let card of Object.values(ec).flat()) await card.updateCardRepetitionStatus(…)
```

Reset SRS Data ignores `K` and resets the bullets:

```js
onClick: async () => {
  if (await confirmUser("Reset practice history for {{remCount}} bullet? …", {remCount: n.length})) {
    let rems = Rem(kb).findMany(n);
    await writeGuarantee("resetSRSData", async () => { for (let rem of rems) await rem.resetRepetitionHistory() })
  }
}
```

`Rem.resetRepetitionHistory()` resets every card of the bullet, disabled ones included:

```js
async resetRepetitionHistory() {
  let cards = await this.getCards({ignorePausing:true, includeDisabled:true});
  await Promise.all(cards.map(c => c.resetRepetitionHistory()))
}
```

The card-level method that would do the right thing already exists. `Card.resetRepetitionHistory()` adds one RESET entry to that card only, and skips it if the card's last entry is already a RESET.

The plugin doesn't touch this dialog or these methods.

## Suggested fix

Reset only the selected cards, the same way the dialog's other actions do:

```js
for (let card of Object.values(ec).flat()) await card.resetRepetitionHistory()
```

The confirmation could then count cards ("Reset practice history for 1 flashcard?").

If resetting whole bullets is intended, the section text should say "the selected bullets", and the card picker should be disabled or explained for this action. As it is, a user who ticks one cloze loses the schedule of all the others without warning. On mature cards that is years of spacing.

## Workaround

None inside RemNote itself. A plugin can reset a single card, because the plugin API's `card.updateCardRepetitionStatus(QueueInteractionScore.RESET)` writes to that one card only. My plugin now offers this as a per-card **Reset SRS** button in its flashcard history panel.
