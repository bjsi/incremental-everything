# Feature request: start new concept cards with back → front

**From:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Date:** 2026-11-01

---

## The request

For a new bidirectional concept (`Term :: description`), please always serve the back → front card first, so the learner sees the description and recognizes the term. Front → back, where the learner sees the term and defines it, should start only after back → front has been passed.

A setting under the flashcard options would let users choose this.

## Why it matters

Both directions need recall, but they are different steps. A learner should be able to recognize what a new term refers to before being asked to define it. Today, about half of new concepts open with the request to define a term the learner has never practised.

## What happens today

RemNote has no preferred direction. In the app bundle of October 30, 2026:

- **Without clusters:** the `random` provider inserts each card at a random position.
- **With clusters:** `addCardsFromRemTinygraph` runs `shuffle([forward, backward, cloze])`.
- **New cards:** `new_and_stale` releases them with `_.sample`.
- **After the first card:** whichever direction comes first buries the other for 60 minutes (`hasSpoiler`).

My own knowledge base shows the same result. Of 1,052 concepts first practised since 2023, 46.6% started with front → back (±3.0).

## Suggested behaviour

- A never-reviewed concept serves back → front first in every queue, including Learn New Cards.
- Front → back stays out of the queue until back → front is rated Good or Easy.
- Again and Hard keep front → back waiting.
- Concepts set to one direction, and concepts already reviewed in either direction, keep their current behaviour.
- Ideally, the user can also require a minimum back → front interval before front → back starts.

## Why a plugin isn't enough

I shipped this as an optional setting in Incremental RemNote v1.0.183. The only reliable method I found is to change the Rem's practice direction, because a plugin skip of front → back buries back → front for 60 minutes. That has costs that a native rule wouldn't:

- **The Rem is changed:** its arrow shows one direction, on every device, until it is released.
- **Card records are replaced:** with `setPracticeDirection('backward')`, a never-reviewed front → back card moves to `deleted_cards`. Setting `'both'` later writes a new card with a new id.
- **Deleted cards are still served:** the queue's loaded batch keeps the deleted card, and `QueueLoadCard` still fires for it. The plugin has to remember those ids and skip them.
- **Cards can flash:** a front → back card that loads first can be visible briefly before the plugin removes it, which shows the term that back → front is about to ask for.

## A smaller alternative

If a native rule isn't possible soon, exposing the queue controller's `moveCurrentCardToBackOfQueue` in the plugin SDK would help. It doesn't go through the bury hook, so a plugin could put front → back behind back → front without changing the Rem.

## Environment

- RemNote desktop 1.29.1-beta (macOS)
- `@remnote/plugin-sdk` 0.0.46
