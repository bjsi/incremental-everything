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

Going back with the left arrow reloads the previous card with an ordinary `QueueLoadCard`. The card you left gets no `QueueCompleteCard`, and it loads again when you move forward. Observed 2026-09-29: a card rated Again, the next card left unrated after 3.5 s, then both loaded again. So a card seen earlier in the session can come back. It must never cool itself: its own sighting is left out when it is judged (`verdictForCard`).

## Card Cluster ratings emit no QueueCompleteCard

Read from the bundle and confirmed in the database, 2026-10-04. The queue's `answerCard` emits `QueueCompleteCard` only when `this.answerCardOverride?.(score)` is falsy. The Card Cluster renderer defines `answerCardOverride`, writes the repetition itself (`submitAnswerWrite` → `updateRepStatusInner`), moves to the next sibling (`goToNextCompoundCard`) and returns `true`. So a cluster member's rating reaches no plugin event, even when it is the only member of its cluster in the queue. `GlobalRemChanged` is not a substitute: the Rem changes only when the rating moves its mastery level.

Two cards of `cc` parents had Good ratings stored with the drill document as `subQueueId` and were still in `finalDrillIds`. The card's `repetitionHistory` is the only reliable source: read it back after the next card change (`reconcileRatings` in `src/lib/mastery_drill_native.ts`; the popup drill's `registerDrillCardRatingListener` does the same for the card `QueueLoadCard` named).

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

## Flashcard widget slots and the Beautiful queue's bottom

Read from the 1.28.19 bundle (`renderSR`, `SwipeQueueHOC`, the insight scroll layout `sQ`). Not yet tried at runtime.

- **FlashcardAnswerButtons replaces the native buttons.** The slot's `componentToRenderIfNoWidgets` holds the answer buttons, type-in answer, MCAT indicator and "Grade yourself" hint. Any matching widget swaps all of them out. It is only safe for Plugin queue items, which is how `answer_buttons` uses it.
- **FlashcardUnder** is the last child of the card content, inside the scroll surface. Its widget is part of the height RemNote measures for the card.
- **QueueBelowTopBar** is the only slot pinned in place, at the top of the box.
- Every widget iframe sits in `div.fade-in-first-load.relative` with inline `transform: rotate(0); overflow: hidden`. That wrapper is a containing block and a stacking context, so a `position: fixed` iframe stays trapped inside it. To relocate a widget, move the wrapper.
- **Beautiful bottom controls** are `div.beautiful-queue-bottom-controls-overlay` (`absolute bottom-0`, `z-[10000]`, `pointer-events-none`) wrapping a transparent `.spaced-repetition__bottom`. The backdrop behind the buttons is `.beautiful-queue-bottom-fade-mask` (`z-[9998]`). A ResizeObserver reads the overlay's `offsetHeight` into `--beautiful-queue-bottom-controls-height` on the HOC root (`.spacedRepetition`), and also into `bottomControlsHeight`.
- **The AI insights panel ("Explanation") is not pinned.** It is in-flow after the card content. A computed spacer (`scroll height − controlsHeight − 16 − card height − 16 − min(insights, 100)`) lands it just above the controls, and the card content goes `--sticky` (`position: sticky`, so it is a stacking context) when there is room. If the controls get taller, the Explanation moves up with them. Padding on `.spaced-repetition__bottom` does this, because it grows the overlay's content box and the ResizeObserver fires. Padding on the overlay itself would not trigger the observer.
- **Anything between the widget and the HOC root that becomes a stacking context hides a relocated widget.** Its z-index is then scoped below the mask (`z-[9998]`). An opacity animation on `.rn-queue__content` with a forwards fill (`both`) does this for the whole card, even though the final opacity is 1. Use `backwards` when the end value is the natural one.
- **The suggested-grade tab.** After a type-in answer is graded, RemNote highlights one button (`suggestedAnswerButton()`: Good or Easy if right, Again if wrong). It hangs an absolute "↵ Enter" tab above it (height 25, `top: -25px`; "Say 'Done'" while voice-listening). On desktop only that button gets `border-t-transparent rounded-t-none`, so `.rn-queue__answer-btn.border-t-transparent.rounded-t-none` detects it. With swipe gestures on (`tF.t()`), every button instead shows a 25px "← Left"/"→ Right" label above it, with no class hook.

## Images in the queue are drawn by the drawing canvas

Read from the 1.28.19 bundle and a real knowledge base (2026-09-30). The exact cause of the crop below was **not** proven; the data shapes are.

- **Every plain image on a queue card goes through the zoomable drawing canvas**, not an `<img>`. The test (`Uc`, module 322262) is `no blocks && currentQueueCard && url is not .gif/.webp/.bin`. The scrollbars seen around a cropped image are the canvas's own. The editor uses a plain `<img>`.
- **Canvas world** = `{width: element.width ?? 800, height: element.height ?? 800}` (module 29269), and the image is stretched to it. **Initial zoom** = `min(containerW / world.width, containerH / world.height)` (`hc`, module 246687), recomputed only when the canvas's `containerWidth` prop or the bounds type changes.
- **Box size** (`i1`, module 536824): with `percent`, `percent% × min(editor width − 10, 800)`, height from the stored aspect ratio; without, the stored size shrunk to fit.
- **What the UI writes.** A drag-resize: on-screen `width`/`height`, `percent` removed. Small / Medium / Large: `percent` 25 / 50 / 100, with `width`/`height` passed through `xD(w, h, editorClientWidth − 10)`, which shrinks and never enlarges. So anything sized in the UI has a stored width no wider than the editor. An image with no stored size gets its natural one written the first time it loads in an editable editor, never in the queue.
- **What imports leave.** Anki imports store `percent: 50` with the file's full pixel size, or no size at all. One such image (`{percent: 50, width: 1071, height: 1017}`) showed in the queue as a centred crop of about 78%.
- **`setText` accepts** fractional `width`/`height` and `percent` of 5, 25, 50 or 100 only; other percents make it throw, so `sanitizeRichTextForSetText` drops them.
- "Cycle Image Size" (`lib/image_sizing.ts`, `lib/image_size_cycle.ts`) rewrites unsized images into the UI's shapes.

## Cross-plugin side channel

`messaging.broadcast` reaches only the caller's own widgets, but plugin events are keyed by event and key, not by plugin. So `storage.setSession(k, v)` fires `StorageSessionChange` for **any** plugin listening on `k`. This is undocumented and may be closed.
