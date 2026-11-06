# Multiple-Choice Cards

Improvements to RemNote's own multiple-choice cards in the queue. Nothing changes in how you create them: write the question, add the options as card items, and the plugin adds to the card as you practise it.

---

## Scissors { #scissors }

Rule options out before you answer, as on a digital exam. Each option of a multiple-choice card gets a ✂ to its left: click it and the option is struck through and dimmed, click it again to bring it back. Clicking an option still answers the card as usual, so you can narrow the choice down first and then pick from what is left.

![A multiple-choice card in the queue with a ✂ beside each option; clicking a ✂ strikes that option through, and the answer is then picked from the options that are left](assets/mc-scissors.gif){ width="900" }

- The scissors follow their options when the card scrolls or the window is resized, and an option scrolled out of view takes its ✂ with it.
- Struck options are only a visual aid: they are not saved, and they clear when the next card comes up.
- Works in both the Compact and the Beautiful queue.
- The scissors are on by default. Turn them off in **IE Settings → Queue Display → Scissors on Multiple-Choice Cards**; the change applies from the next card.

### Notes { #notes }

- Cards with more than 12 options get no scissors.
- In a browser without CSS anchor positioning, the scissors appear in a column at the top right of the window instead of beside the options; they still match the options in order, top to bottom.
