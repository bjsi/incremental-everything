# The flashcard queue, from a plugin

How RemNote's queue treats plugin callbacks, events and skips, and what a plugin can launch or embed. Measured and read from `app.asar` between August and September 2026. See also [CARD_STATE_REFERENCE.md](CARD_STATE_REFERENCE.md) for card states.

## GetNextCard has a ~1 second deadline

RemNote awaits the `GetNextCard` callback with an internal deadline of **about 1000 ms**. In August 2026 a 993 ms response was shown and a 1088 ms one dropped. Past it, RemNote shows a flashcard of its own and silently discards the plugin's answer: no error, no event, nothing in the log. This is why large knowledge bases "stopped injecting Incremental Rems" while a small test KB was fine.

The cost is not computation (sorting 5,525 IncRems took 0–3 ms). It is **bridge queueing**: two trivial scalar reads took anywhere from 13 ms to 631 ms depending only on how busy the plugin bridge was. Shrinking the payload made no measurable difference.

The fix (v1.0.39): `src/lib/queue_prefetch.ts` keeps gates, settings, the due count and a buffer of pre-verified candidates in module state, and **`getNextCard` is strictly synchronous, with zero `await`s on every path**. An `await` before a return brings the bug straight back.

A served candidate counts as shown only once the *next* call's `queueInfo` proves it: `cardsPracticed` rose by one while `numCardsRemaining` held. The duplicate call at queue open is a queue-entry artifact, not a timeout retry.

## QueueLoadCard fires without a card id

In a document's Practice All queue, every card change also fires a `QueueLoadCard` **with no `cardId`**, and RemNote moves past it by itself. Calling `removeCurrentCardFromQueue` on those lands 100–400 ms later, after the real card has loaded, and removes the real card instead. The emptied queue reloads and the loop repeats (440 removals in one test).

Ignore id-less loads. Before any skip, confirm with `plugin.queue.getCurrentCard()` that the card is still current, and keep a circuit breaker.

## The next card loads before the rating is reported

Read from the 1.28.19 bundle and confirmed in a Learn New session, 2026-09-28. The answer handler runs `this.updateRepetitionStatus(score)`, which advances the queue; `setCurrentCard` then emits `QueueLoadCard` for the next card synchronously. `QueueCompleteCard` for the rated card is emitted afterwards and deferred (`L6(async () => emitPluginEvent(QueueCompleteCard, {score, cardId}))`). A listener that updates state on the rating therefore judges the next card without it. The next card is often a sibling cloze of the one just rated, and always is with "In Order".

Treat a card the queue has left behind as seen when the next card loads, not when its rating arrives. `src/lib/queue_cooling_skip.ts` does this (`noteSeen`).

## A skip buries the card's siblings

`removeCurrentCardFromQueue` runs every provider's "before pop" hook. The bury provider records the card in `UserDataStore.recentlySeenCardsTuples` (synced, entries last 60 minutes), exactly as if it had been answered.

A recently seen card **buries every other card of its Rem**: forward, backward and cloze are wildcards, but the card itself is not buried. For a descriptor's backward card, the parent's backward card is buried too, and so are the members of the selected Card Cluster.

The plugin API passes only `addToBackStack`, so there is no way around it, and plugins cannot read or clear the tuples. Buried cards come back through the **"Time to Take a Break"** item (`PracticeBuried`, QueueItemType 22), which arrives as an id-less `QueueLoadCard`. Its *Keep Practicing* button has no plugin API.

**Practice All progress** is stored per sub-queue id in `cramQueue.finishedCards.<docId>`, and skipped cards count as finished. Re-entering the same document asks "Continue where you left off?", so use a fresh document per session.

## Queue order is random

The queue controller chains providers:
- `random`: each card is spliced in at a random position. `in_order` is used only for the ordered routes, and a clusterer when clusters are on;
- `new_and_stale`: holds new and stale cards back behind the per-day limits;
- `bury_protection`;
- the cluster selector.

The order of portals in a document is irrelevant. The only order control a plugin has is the **size** of the document it queues (small bursts).

## "Need to Learn" cards and the Learn New queue

Read from the 1.28.19 bundle and the local database, 2026-09-26.

**Storage.** Neither a powerup nor a slot. Two raw document fields, both named `ny`:
- the card doc's `ny` (`NOT_YET_LEARNED`), which marks the card as waiting in Learn New;
- the Rem doc's `ny` (`IS_OR_WAS_NEED_TO_LEARN_CARD`), a sticky "came from AI/import" marker. It is not required for Learn New: in this KB, 1,262 cards carry `ny` but only 6 of their Rems do.

A card created with the flag has no `ny,u` timestamp. `card.isNotYetLearned()` is simply `!!card.ny`. Document and Practice All queues (`allCramItems`) drop these cards unless called with `includeNeedToLearnCards`.

**Leaving Learn New.** A card loses `ny` only when it is answered **Hard, Good or Easy**. Forgot, Skip (written as a `TOO_EARLY` rep) and Reset keep it. Learn New answers are stored as `isCram: true` reps with the page's `subQueueId`. The only native way to clear the flag without answering is the **"Need to Learn" switch** in a Rem's flashcard menu (`Hierarchy Editor Rem Card Menu`). It rewrites every card of that one Rem, and there is no bulk version.

**Why siblings run back to back.** The page is `/need_to_learn/:examId/:documentId/:order?` (`NeedToLearnQueuePage`), which mounts `QueueMain` with **`skipCheckpoints: true`**. The bury provider's constructor sets `practiceBuriedCards = r.skipCheckpoints`, so this flag, meant to hide daily-goal checkpoints, also turns off same-Rem burying. The selector sends one document at a time, often a handful of cards from one or two Rems. With "In Order", the cards also come in cloze order.

**From a plugin.**
- The plugin **can't read or write `ny`**. The SDK `Card` copies only `_id`, `remId`, `type`, `createdAt`, `history`, `activeNextTime` and `timesWrongInRow`, and no bridge method sets the field. `updateCardRepetitionStatus(GOOD)` would clear it, but only by recording a fake review.
- It **can tell it is in Learn New**: `plugin.window.getURL()` starts with `/need_to_learn/`. Flashcard widgets and queue events work there, as the Priority badge and live session recording show.
- So a plugin-side bury is possible. `src/lib/queue_cooling_skip.ts` (Sep 2026) does it with the Priority Queue's cooling engine, in Learn New and in spaced-repetition queues. The skipped card keeps `ny` and returns in a later batch. Still to measure: whether a skip here also writes Practice All-style `finishedCards` progress.
- A per-card live check is too slow for a reveal mask: the first time a Rem appears, the tree walk plus the Card Cluster probe is 12–20 round trips (915 ms measured). `QueueLoadCard` carries only `{cardId}` (bundle: `emitPluginEvent(QueueLoadCard, void 0, {cardId})`), so one read per load is unavoidable. The rest is judged when the queue opens, from the scope the plugin's QueueEnter writes to `currentScopeRemIdsKey`. The host broadcasts every `setSession` as `StorageSessionChange` with the value as payload, to every realm, the writer's included.
- Cooling covers RemNote's hour-long bury without a rule of its own. Every rating in a 90-day sample of this KB scheduled the card's next repetition at least 60 min ahead: Forgot and Skip exactly an hour, Hard/Good/Easy a day or more. A just-rated sibling is therefore "not due", which is cooling's condition, for at least that hour.
- The clean fix is on RemNote's side: keep `bury_protection` on in this queue, and add `card.isNotYetLearned()` / `setNotYetLearned()` to the SDK.

## Launching a queue

The SDK has no `startQueue`, but `plugin.window.setURL(url)` is implemented as `FlowRouter.go(FlowRouter.coerce(url))`, and RemNote's own `rem.practice()` is `FlowRouter.go("Flashcards.subQueue", {id})`:

| Route | Mode |
|---|---|
| `/flashcards/:id` | normal practice |
| `/flashcards/:id/all` | Practice All |
| `/flashcards/:id/ordered` | in order |
| `/flashcards/:id/all_no_srs`, `/ordered_no_srs` | no-SRS variants |
| `/flashcards/:id/need_to_learn` | need to learn |

`plugin.window.setURL('/flashcards/' + docId)` launches practice for a document. The Priority Queue uses it.

**A queue over an arbitrary set of cards is out of reach.** RemNote's `openFilteredQueue(cardIds, …)` writes the ids to the **host window's** `localStorage` (`queueFilteredCardIds`) and routes to `/filtered_queue/:kb` (also `/all`, `/ordered`…). A plugin iframe has its own origin: `storage.setLocal` writes a namespaced `plugin|<id>|<key>` store, and no SDK method wraps `openFilteredQueue`. The workaround is a document of portals, with card-level filtering done by skipping.

## The SDK `<Queue>` embed

- It renders RemNote's queue with **`inArticle: true`** on every path, and `QueueProps` offers only `cardIds`/`folderId`. Every flashcard and queue widget slot is `enabled: !inArticle && …`, so **no plugin widget renders under a card inside it**: Flashcard, FlashcardAnswer, FlashcardAnswerButtons, FlashcardExtraDetail, FlashcardUnder, QueueToolbar and QueueBelowTopBar are all off.
- It is a **fake embed**: the plugin iframe holds only an empty `div.js-fake-embed` placeholder, and RemNote paints the real component in a layer **above** the iframe at that position. Plugin overlays, whatever their z-index, are hidden beneath it. The SDK re-sends the position on any attribute change in the plugin's DOM (a MutationObserver), so moving the wrapper off-screen (`position: fixed; top: 200vh`) hides the embed without unmounting it. Unmounting a `<Queue>` fires QueueEnter again and starts a new session.
- The `DocumentViewer` fake embed mounts the real `Document` component, where DocumentBelowTitle and DocumentAboveToolbar widgets **are** enabled. Not yet confirmed at runtime.

## Cross-plugin side channel

`messaging.broadcast` reaches only the caller's own widgets, but plugin events are keyed by event and key, not by plugin. So `storage.setSession(k, v)` fires `StorageSessionChange` for **any** plugin listening on `k`. This is undocumented and may be closed.
