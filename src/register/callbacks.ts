import {
  AppEvents,
  QueueItemType,
  ReactRNPlugin,
  SpecialPluginCallback,
} from '@remnote/plugin-sdk';
import {
  queueCounterId,
  queueLayoutFixId,
  queueHideElementsId,
  incremReviewStartTimeKey,
  incrementalQueueActiveKey,
  currentIncrementalRemTypeKey,
  incremNotesSidebarRemIdKey,
} from '../lib/consts';
import { consumePendingScrollRequest } from '../lib/remHelpers';
import {
  PrefetchQueueInfo,
  VERBOSE_QUEUE_INJECTION,
  buildQueuePrefetch,
  confirmServed,
  isPrefetchReadyFor,
  readCardsPerRem,
  readDueCount,
  readGates,
  resetQueuePrefetch,
  rollbackServed,
  scheduleQueuePrefetchRefill,
  takePrefetchedCandidate,
} from '../lib/queue_prefetch';


// Registered once globally — safe because all selectors are highly specific to the
// incremental-everything plugin iframe and do not affect regular flashcard layout.
const QUEUE_LAYOUT_FIX_CSS = `
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) {
    height: 100% !important;
  }
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) .rn-queue__content,
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) .rn-queue__content .rn-flashcard,
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) .rn-queue__content .rn-flashcard__content,
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) .box-border:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]),
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) div.fade-in-first-load:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]),
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) div.fade-in-first-load:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) > div,
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"] {
    flex-grow: 1 !important;
  }

  /* Ensure card_info_bar (our widget) renders above flashcard-repetition-history.
     The parent flashcard container is already "flex flex-col", so flex order is sufficient.
     Scoped to only activate when our card_info_bar iframe is present, so regular
     flashcards without the plugin widget are not affected. */
  .box-border.flex.flex-col:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=card_info_bar&"])
    .fade-in-first-load:has(iframe[data-plugin-id="flashcard-repetition-history"]) {
    order: 1;
  }

  /* Remove the default pt-6 top padding from the bottom action bar when our
     answer_buttons widget is present — the widget provides its own internal spacing. */
  .spaced-repetition__bottom:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=answer_buttons&"]) {
    padding-top: 0 !important;
  }
`;

// Registered once globally — safe because the :has(iframe[...widgetName=queue...]) gate
// activates ONLY while the Plugin-type queue iframe is in the DOM:
//   • Race condition: if GetNextCard pre-fetches and returns null, the iframe is already
//     gone and the :has() selector stops matching automatically.
//   • Dual-type rems on flashcard turns: the queue widget uses
//     queueItemTypeFilter: QueueItemType.Plugin, so the iframe is never mounted on
//     plain flashcard turns — the selector never fires.
const QUEUE_HIDE_ELEMENTS_CSS = `
  /* Hide unwanted UI elements during incremental rem review.
     Gated on the Plugin queue iframe presence — self-deactivates the instant
     the iframe leaves the DOM, making timing-based race conditions impossible. */
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) .rn-flashcard-insights,
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) [data-cy="bottom-of-card-ai-suggestions"],
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) div.fade-in-first-load:has(div[data-cy="bottom-of-card-suggestions"]),
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue&"]) div.fade-in-first-load:has(iframe[data-plugin-id="flashcard-repetition-history"]) {
    display: none !important;
  }
`;


let sessionItemCounter = 0;

export const resetSessionItemCounter = () => {
  sessionItemCounter = 0;
  lastDecision = null;
  // The prefetch buffer, its seen set and its scope are all per-session. This
  // runs on both queue enter and queue exit, so nothing from a finished session
  // can leak into the next one.
  resetQueuePrefetch();
};

/**
 * Rewinds the interval counter after a dropped injection.
 *
 * The counter exists only to space IncRems among flashcards. When RemNote drops
 * our item it shows a flashcard in its place, so the spacing is already
 * satisfied — rewinding makes the very next call an injection turn again
 * instead of waiting out another full interval. Without this, a single drop cost
 * the user `cardsPerRem + 1` more items before the next attempt.
 */
const rewindSessionItemCounter = () => {
  if (sessionItemCounter > 0) sessionItemCounter--;
};

// ---------------------------------------------------------------------------
// GetNextCard instrumentation
// ---------------------------------------------------------------------------
// RemNote awaits this callback with an internal deadline of about one second
// (measured: 993ms landed, 1088ms was dropped). Past it, RemNote stops waiting
// and loads a flashcard of its own; whatever we return afterwards is discarded
// with no error and no event.
//
// The callback now answers entirely from module state (see lib/queue_prefetch),
// so totalMs should read ~0–1ms. The instrumentation stays because it is what
// proves that, and because it is the only way a future regression that puts an
// await back on this path would ever be noticed.
//
// Two things are tracked:
//   1. Wall time of the call. Only ever PRINTED when it crosses
//      SLOW_CALL_WARN_MS, because at that point an `await` has crept back onto
//      a path that is supposed to be synchronous — the exact regression that
//      would resurrect the dropped-injection bug, and one that reports no
//      symptom of its own.
//   2. Whether the PREVIOUS decision actually reached the screen — read off the
//      `queueInfo` counters RemNote hands us, which is exact and costs nothing.
//      This is NOT diagnostics: it drives confirm-then-burn (see
//      verifyPreviousDecision). Its logging is separable; its logic is not.
//
// On (2): the first version compared our returned remId against
// `currentIncRemKey`, which the queue widget writes when it mounts. That
// produced FALSE DROP reports — under bridge congestion the widget can take
// longer to mount and write that key than RemNote takes to ask for the next
// item, so a perfectly good injection looked unconfirmed. The counters settle it
// without ambiguity:
//
//   cardsPracticed +1 and numCardsRemaining UNCHANGED  → a non-flashcard was
//     consumed, i.e. our Plugin item was shown.
//   cardsPracticed +1 and numCardsRemaining DECREASED  → a flashcard was
//     consumed instead — our item was dropped.
//   cardsPracticed UNCHANGED                           → same slot asked twice.
//
// A card rated AGAIN also leaves numCardsRemaining flat, so the SHOWN verdict is
// the softer of the two; DROPPED is high-confidence, and it is the one wired to
// a real consequence (rolling the candidate back onto the buffer).
const SLOW_CALL_WARN_MS = 800;

type QueueInfo = {
  mode: 'practice-all' | 'in-order' | 'normal';
  cardsPracticed: number;
  subQueueId: string | undefined;
  numCardsRemaining: number;
};

type Decision = {
  seq: number;
  remId: string | null; // null = we deliberately yielded a flashcard turn
  reason: string;
  totalMs: number;
  cardsPracticed: number;
  numCardsRemaining: number;
};

let callSeq = 0;
let lastDecision: Decision | null = null;

/**
 * Confirms (or refutes) that the item returned by the PREVIOUS GetNextCard call
 * was actually displayed, using only the counters RemNote passes in. Purely
 * synchronous and free — no bridge traffic on the path whose latency is the
 * whole problem. See the block comment above for the decision table.
 *
 * This is not merely a log: it is the commit point for the confirm-then-burn
 * rule. A candidate is only written into the session's seen list once it is
 * known to have been displayed, and is otherwise returned to the buffer.
 */
function verifyPreviousDecision(plugin: ReactRNPlugin, queueInfo: QueueInfo) {
  const prev = lastDecision;
  if (!prev) return;

  const practicedDelta = queueInfo.cardsPracticed - prev.cardsPracticed;
  const remainingDelta = prev.numCardsRemaining - queueInfo.numCardsRemaining;
  const ctx = {
    practicedDelta,
    remainingDelta,
    tookMs: prev.totalMs,
    reason: prev.reason,
  };

  if (practicedDelta === 0) {
    // Observed so far ONLY as call #1→#2 at queue open, with the IncRem cache
    // still cold — including on calls well under the deadline, while genuinely
    // slower calls mid-session were never re-asked. So this reads as a
    // queue-entry artifact rather than a timeout retry. Logged, not accused.
    //
    // Either way, RemNote asking again for the same slot means our previous
    // answer did not stick. If that answer was an IncRem it must go back on the
    // buffer — leaving it pending would let the next serve overwrite it, losing
    // the candidate without ever marking it seen or showing it.
    if (prev.remId !== null) {
      rollbackServed();
      rewindSessionItemCounter();
    }
    if (VERBOSE_QUEUE_INJECTION) {
      console.log(
        `🔁 GetNextCard #${prev.seq}: same slot asked again ` +
          `(cardsPracticed still ${queueInfo.cardsPracticed}) after our ${prev.totalMs}ms response.` +
          (prev.remId !== null ? ` Candidate ${prev.remId} returned to the buffer.` : ''),
        ctx
      );
    }
    return;
  }

  if (prev.remId === null) return; // we yielded a flashcard on purpose; nothing to verify

  if (remainingDelta === 0) {
    confirmServed(plugin);
    if (VERBOSE_QUEUE_INJECTION) {
      console.log(
        `✅ GetNextCard #${prev.seq}: IncRem ${prev.remId} WAS SHOWN — flashcard count held at ` +
          `${queueInfo.numCardsRemaining} while cardsPracticed advanced (${prev.totalMs}ms).`,
        ctx
      );
    }
  } else {
    const recovered = rollbackServed();
    rewindSessionItemCounter();
    // Unconditional: a dropped injection is the failure this whole subsystem
    // exists to prevent. If it starts happening again, it must be visible
    // without anyone having to switch logging on first.
    console.warn(
      `⛔ GetNextCard #${prev.seq}: DROPPED INJECTION — we returned IncRem ${prev.remId} after ` +
        `${prev.totalMs}ms, but RemNote consumed ${remainingDelta} flashcard(s) instead. ` +
        (recovered
          ? `Candidate returned to the buffer and the interval counter rewound; it will be retried next turn.`
          : `Nothing pending to recover.`),
      ctx
    );
  }
}

export function registerCallbacks(plugin: ReactRNPlugin) {
  plugin.app.registerCSS(queueLayoutFixId, QUEUE_LAYOUT_FIX_CSS);
  plugin.app.registerCSS(queueHideElementsId, QUEUE_HIDE_ELEMENTS_CSS);

  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (queueInfo) => {
      const startedAt = Date.now();
      const seq = ++callSeq;

      // Did the item we returned LAST time actually make it onto the screen?
      // Answered from `queueInfo` alone, so it costs nothing — and it is what
      // commits the previous candidate to the seen list or rolls it back.
      verifyPreviousDecision(plugin, queueInfo);

      const prefetchInfo: PrefetchQueueInfo = {
        mode: queueInfo.mode,
        subQueueId: queueInfo.subQueueId,
      };

      /**
       * Single exit point. Records the decision so the NEXT call can verify it —
       * that part is load-bearing and runs regardless of logging.
       */
      const finish = <T extends { remId: string } | null>(result: T, reason: string): T => {
        const totalMs = Date.now() - startedAt;
        lastDecision = {
          seq,
          remId: result?.remId ?? null,
          reason,
          totalMs,
          cardsPracticed: queueInfo.cardsPracticed,
          numCardsRemaining: queueInfo.numCardsRemaining,
        };
        const label = result ? `IncRem ${result.remId}` : 'flashcard (null)';
        if (totalMs >= SLOW_CALL_WARN_MS) {
          // Unconditional. This path is synchronous by construction, so it can
          // only take this long if someone has put an `await` back in front of a
          // return — which silently reintroduces dropped injections in large KBs.
          console.warn(
            `🐢 GetNextCard #${seq} → ${label} [${reason}] took ${totalMs}ms — ` +
              `slow enough that RemNote may have stopped waiting. An await has ` +
              `crept back onto this path; it is supposed to be synchronous.`
          );
        } else if (VERBOSE_QUEUE_INJECTION) {
          console.log(`⏱️ GetNextCard #${seq} → ${label} [${reason}] in ${totalMs}ms`);
        }
        return result;
      };

      // Helper: clear stale sidebar signals when returning null (flashcard turn).
      // The QueueComponent's useEffect cleanup is unreliable — RemNote can
      // destroy its iframe before React cleanup fires. This main-process
      // helper guarantees the signals are cleared.
      const clearStaleIncRemSignals = () => {
        plugin.storage.setSession(incrementalQueueActiveKey, false);
        plugin.storage.setSession(currentIncrementalRemTypeKey, undefined);
        // Also clear the rem-extract id the notes sidebar keys off. ExtractViewer's
        // unmount cleanup that clears this is unreliable during sandbox teardown,
        // and its sidebar guard (remExtractId === currentIncRemId) can't catch a
        // stale value here because currentIncRemKey is also stale on a flashcard
        // turn — both end up equal to the previous rem, so the sidebar would keep
        // showing it. Clearing here (main process) guarantees the empty state.
        plugin.storage.setSession(incremNotesSidebarRemIdKey, undefined);
      };

      // ---------------------------------------------------------------------
      // Everything from here to the return is synchronous by design.
      //
      // No `await`. Not for storage, not for settings, not for rem lookups. The
      // decision is read out of module state that lib/queue_prefetch keeps warm
      // in the background, so this callback cannot be pushed past RemNote's
      // ~1s deadline by bridge congestion no matter how busy the plugin is.
      //
      // Side effects (counter CSS, review timestamp, sidebar signal clearing,
      // buffer rebuild) are all fired WITHOUT await. Putting an `await` back in
      // front of any return below is exactly what caused injections to be
      // silently dropped in large KBs.
      // ---------------------------------------------------------------------

      const gates = readGates();
      if (gates.blocked) {
        // A No-IncRem timer is running, or IncRems are disabled on this device.
        plugin.app.registerCSS(queueCounterId, '');
        clearStaleIncRemSignals();
        scheduleQueuePrefetchRefill(plugin, prefetchInfo);
        return finish(null, gates.reason ?? 'blocked');
      }

      const cardsPerRem = readCardsPerRem();
      const intervalBetweenIncRem =
        typeof cardsPerRem === 'number' ? cardsPerRem + 1 : cardsPerRem;
      const dueCount = readDueCount();

      // Queue counter suffix (" + N" due IncRems). Never awaited, as before.
      plugin.app.registerCSS(
        queueCounterId,
        `
        .rn-queue__card-counter {
          /*visibility: hidden;*/
        }

        .light .rn-queue__card-counter:after {
          content: ' + ${dueCount}';
        }

        .dark .rn-queue__card-counter:after {
          content: ' + ${dueCount}';
        }`.trim()
      );

      const shouldShowIncRem =
        (typeof intervalBetweenIncRem === 'number' &&
          (sessionItemCounter + 1) % intervalBetweenIncRem === 0) ||
        queueInfo.numCardsRemaining === 0 ||
        intervalBetweenIncRem === 'no-cards';

      if (VERBOSE_QUEUE_INJECTION) {
        console.log('🎯 GetNextCard → deciding NEXT item:', {
          willShowIncRem: shouldShowIncRem,
          sessionItemCounter,
          counterCheck:
            typeof intervalBetweenIncRem === 'number'
              ? `(${sessionItemCounter}+1) % ${intervalBetweenIncRem} = ${
                  (sessionItemCounter + 1) % intervalBetweenIncRem
                }`
              : intervalBetweenIncRem,
          numCardsRemaining: queueInfo.numCardsRemaining,
          dueIncRems: dueCount,
          prefetchReady: isPrefetchReadyFor(prefetchInfo),
        });
      }

      if (!shouldShowIncRem) {
        sessionItemCounter++;
        // Flashcard turn — the hide CSS is globally registered and self-deactivates
        // via :has() when the Plugin iframe is absent; no manual clearing needed.
        clearStaleIncRemSignals();
        scheduleQueuePrefetchRefill(plugin, prefetchInfo);
        return finish(null, 'interval-not-reached');
      }

      if (!isPrefetchReadyFor(prefetchInfo)) {
        // The buffer was built for a different queue (the mode or sub-queue
        // changed), or the plugin activated mid-session and has never built one.
        // Rebuild for the real parameters immediately — this turn yields a
        // flashcard rather than blocking on it.
        plugin.app.registerCSS(queueCounterId, '');
        sessionItemCounter++;
        clearStaleIncRemSignals();
        void buildQueuePrefetch(plugin, prefetchInfo);
        return finish(null, 'prefetch-not-ready');
      }

      const candidate = takePrefetchedCandidate(prefetchInfo);
      if (!candidate) {
        // Nothing due and in scope, or every candidate failed verification.
        plugin.app.registerCSS(queueCounterId, '');
        sessionItemCounter++;
        clearStaleIncRemSignals();
        scheduleQueuePrefetchRefill(plugin, prefetchInfo);
        return finish(null, 'no-due-increms');
      }

      // Baseline for the review-duration measurement. Fire-and-forget: nothing
      // reads it until the user finishes the item, many seconds from now.
      void plugin.storage.setSession(incremReviewStartTimeKey, Date.now());

      // Refill in the background while the user reads this item. The candidate
      // is NOT written to the seen list here — see confirm-then-burn in
      // verifyPreviousDecision.
      scheduleQueuePrefetchRefill(plugin, prefetchInfo);

      sessionItemCounter++;
      return finish(
        {
          type: QueueItemType.Plugin,
          remId: candidate.remId,
          pluginId: 'incremental-everything',
        },
        'inject'
      );
    }
  );

  // Pending-scroll listener. Runs in the main-process context, so the
  // polling and setTimeouts inside `consumePendingScrollRequest` survive
  // the widget iframe death caused by `setRemWindowTree` reorganizing the
  // panes. Triggered widgets stash their request in session storage and
  // call openRemInNewPane; this listener picks it up after the layout
  // settles.
  let scrollInflight = false;
  plugin.event.addListener(AppEvents.CurrentWindowTreeChange, undefined, async () => {
    if (scrollInflight) return;
    scrollInflight = true;
    try {
      await consumePendingScrollRequest(plugin);
    } catch (e) {
      console.error('[pending-scroll listener] consume threw:', e);
    } finally {
      scrollInflight = false;
    }
  });
}
