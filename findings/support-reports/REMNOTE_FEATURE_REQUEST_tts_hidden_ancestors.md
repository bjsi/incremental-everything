# Feature request: a setting so Remy doesn't read the card's parent aloud

**From:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Date:** 2026-11-17
**Version:** RemNote desktop 1.30.4, macOS

---

## The problem

When Remy reads a card's question aloud (Read cards aloud, the Play question button, or voice mode), he usually reads the Rem's parent first.

Many of us hide that parent in the queue on purpose, because it gives the answer away. We use RemNote's official **Hide in Queue** plugin for that, with its **Hide in Queue**, **Remove from Queue** and **No Hierarchy** powerups. The screen shows "Hidden in queue", and then Remy reads it out.

In voice mode, where you only listen, the card is spoiled before you can answer. That breaks the flow, and in practice it keeps Hide in Queue users from adopting the voice-mode queue at all.

## The request

**1. A setting: "Read the parent with the card"**, under the Read aloud settings. When it's off, Remy reads only the card. This is the simplest fix, and it solves the problem for everyone.

**2. Better: follow the Hide in Queue plugin automatically.** RemNote's own plugin already marks which context should stay hidden, so Remy could follow it without a setting. Don't read the parent when either of these is true:

- **The card's Rem** has a tag or powerup whose name starts with "Hide" or "Remove", or is "No Hierarchy".
- **Its parent** has such a tag or powerup.

Matching on the name rather than on fixed codes also covers the variants that build on the original plugin. My plugin, Incremental RemNote, includes the original three and adds Hide Parent, Hide Grandparent, Remove Parent and Remove Grandparent. Nobody has to add anything new to their Rems: the ones they already hid would simply stay silent.

## Steps to reproduce

1. Make a parent Rem whose text gives the answer away, with a flashcard as its child.
2. Tag the parent with **Hide in Queue**.
3. Practice the card with Read cards aloud on, or in voice mode.
4. On screen the parent shows "Hidden in queue", but Remy reads it before the question.

## Why a plugin can't fix this

These powerups hide the parent with CSS on the rendered card. Remy builds what he reads from the Rem data, in the parent walk of `BeautifulQueueTextToSpeech` / `TextToSpeech`, and nothing there checks whether the queue hides the parent. The SDK has no hook into that text, so only RemNote can change it.
