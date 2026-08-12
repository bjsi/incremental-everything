import {
  AppEvents,
  QueueItemType,
  ReactRNPlugin,
  RemId,
  SpecialPluginCallback,
} from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import * as _ from 'remeda';
import {
  allIncrementalRemKey,
  currentScopeRemIdsKey,
  queueCounterId,
  queueLayoutFixId,
  queueHideElementsId,
  seenRemInSessionKey,
  noIncRemTimerKey,
  incremReviewStartTimeKey,
  incrementalQueueActiveKey,
  incRemDisabledDeviceKey,
  currentIncrementalRemTypeKey,
  incremNotesSidebarRemIdKey,
} from '../lib/consts';
import { getIncrementalRemFromRem, IncrementalRem } from '../lib/incremental_rem';
import {
  getCardsPerRem,
  getSortingRandomness,
  getWeightSelectionK,
  applyPriorityWeightedLottery,
} from '../lib/sorting';
import { consumePendingScrollRequest } from '../lib/remHelpers';


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
};

// ---------------------------------------------------------------------------
// GetNextCard latency instrumentation
// ---------------------------------------------------------------------------
// Why this exists: RemNote awaits this callback with an internal deadline. If we
// resolve after it expires, RemNote stops waiting and loads a card of its own
// choosing — our returned Plugin item is discarded with no error, no event, and
// nothing in the log to distinguish it from "we decided not to inject".
//
// That distinction mattered: the old logging stopped at the DECISION line, which
// is ~20 serial SDK round-trips before the actual return. A log reading
// `willShowIncRem: true` therefore proved only that we INTENDED to inject, never
// that RemNote accepted it. In a large KB (5.5k IncRems, each carrying its full
// repetition history through the session-storage bridge) that gap is exactly
// where the injection was being lost.
//
// So we measure two things:
//   1. Wall time per phase, on every return, both paths. Anything at or above
//      SLOW_CALL_WARN_MS is loud, because that is the regime where the deadline
//      is plausibly in play.
//   2. Whether the PREVIOUS decision actually reached the screen — read off the
//      `queueInfo` counters RemNote hands us, which is exact and costs nothing.
//
// On (2): the first version of this compared our returned remId against
// `currentIncRemKey`, which the queue widget writes when it mounts. That
// produced FALSE DROP reports — under bridge congestion the widget can take
// longer to mount and write that key than RemNote takes to ask for the next
// item, so a perfectly good injection looks unconfirmed. The counters settle it
// without ambiguity:
//
//   cardsPracticed +1 and numCardsRemaining UNCHANGED  → a non-flashcard was
//     consumed, i.e. our Plugin item was shown.
//   cardsPracticed +1 and numCardsRemaining DECREASED  → a flashcard was
//     consumed instead — our item was dropped.
//   cardsPracticed UNCHANGED                           → RemNote is asking again
//     for the same slot: a retry, which is itself evidence of a blown deadline.
//
// A card rated AGAIN also leaves numCardsRemaining flat, so the SHOWN verdict is
// the softer of the two; DROPPED is high-confidence and is the one that matters.
const SLOW_CALL_WARN_MS = 800;

type PhaseTimings = Record<string, number>;

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
  phases: PhaseTimings;
  cardsPracticed: number;
  numCardsRemaining: number;
};

let callSeq = 0;
let lastDecision: Decision | null = null;
let cachePayloadProbed = false;

function startTimer() {
  const t0 = Date.now();
  let last = t0;
  const phases: PhaseTimings = {};
  return {
    phases,
    mark(label: string) {
      const now = Date.now();
      phases[label] = now - last;
      last = now;
    },
    total: () => Date.now() - t0,
  };
}

/**
 * Confirms (or refutes) that the item returned by the PREVIOUS GetNextCard call
 * was actually displayed, using only the counters RemNote passes in. Purely
 * synchronous and free — no bridge traffic on the path whose latency is the
 * whole problem. See the block comment above for the decision table.
 */
function verifyPreviousDecision(queueInfo: QueueInfo) {
  const prev = lastDecision;
  if (!prev) return;

  const practicedDelta = queueInfo.cardsPracticed - prev.cardsPracticed;
  const remainingDelta = prev.numCardsRemaining - queueInfo.numCardsRemaining;
  const ctx = {
    practicedDelta,
    remainingDelta,
    tookMs: prev.totalMs,
    phases: prev.phases,
    reason: prev.reason,
  };

  if (practicedDelta === 0) {
    console.warn(
      `🔁 GetNextCard #${prev.seq}: RETRY — RemNote is asking again for the same slot ` +
        `(cardsPracticed still ${queueInfo.cardsPracticed}) after our ${prev.totalMs}ms response. ` +
        `Strong sign the deadline expired.`,
      ctx
    );
    return;
  }

  if (prev.remId === null) return; // we yielded a flashcard on purpose; nothing to verify

  if (remainingDelta === 0) {
    console.log(
      `✅ GetNextCard #${prev.seq}: IncRem ${prev.remId} WAS SHOWN — flashcard count held at ` +
        `${queueInfo.numCardsRemaining} while cardsPracticed advanced (${prev.totalMs}ms).`,
      ctx
    );
  } else {
    console.warn(
      `⛔ GetNextCard #${prev.seq}: DROPPED INJECTION — we returned IncRem ${prev.remId} after ` +
        `${prev.totalMs}ms, but RemNote consumed ${remainingDelta} flashcard(s) instead. ` +
        `The candidate was burned from the session pool for nothing.`,
      ctx
    );
  }
}

/**
 * One-off measurement of what the IncRem session cache actually costs to move
 * across the plugin bridge. Deliberately off the critical path (the stringify
 * alone is expensive on a 5k-entry cache with full histories) and run at most
 * once per plugin session.
 */
function probeCachePayloadOnce(allIncrementalRem: IncrementalRem[]) {
  if (cachePayloadProbed) return;
  cachePayloadProbed = true;
  setTimeout(() => {
    try {
      const t0 = Date.now();
      const json = JSON.stringify(allIncrementalRem);
      const withHistory = allIncrementalRem.filter((r) => r.history?.length).length;
      console.log('📦 IncRem session-cache payload (transferred on EVERY GetNextCard call):', {
        entries: allIncrementalRem.length,
        entriesWithHistory: withHistory,
        bytesUtf16: json.length * 2,
        megabytesUtf16: +((json.length * 2) / 1024 / 1024).toFixed(2),
        stringifyMs: Date.now() - t0,
      });
    } catch (e) {
      console.error('[GetNextCard probe] failed:', e);
    }
  }, 0);
}

export function registerCallbacks(plugin: ReactRNPlugin) {
  plugin.app.registerCSS(queueLayoutFixId, QUEUE_LAYOUT_FIX_CSS);
  plugin.app.registerCSS(queueHideElementsId, QUEUE_HIDE_ELEMENTS_CSS);

  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (queueInfo) => {
      const timer = startTimer();
      const seq = ++callSeq;
      console.log(`▶️ GetNextCard #${seq}`, queueInfo);

      // Did the item we returned LAST time actually make it onto the screen?
      // Answered from `queueInfo` alone, so it costs nothing.
      verifyPreviousDecision(queueInfo);

      /**
       * Single exit point for logging. Every `return` in this callback goes
       * through here so the phase breakdown is emitted on all paths — including
       * the ones that yield a flashcard, which are just as interesting when the
       * question is "why did no IncRem appear".
       */
      const finish = <T extends { remId: string } | null>(result: T, reason: string): T => {
        const totalMs = timer.total();
        lastDecision = {
          seq,
          remId: result?.remId ?? null,
          reason,
          totalMs,
          phases: { ...timer.phases },
          cardsPracticed: queueInfo.cardsPracticed,
          numCardsRemaining: queueInfo.numCardsRemaining,
        };
        const label = result ? `IncRem ${result.remId}` : 'flashcard (null)';
        if (totalMs >= SLOW_CALL_WARN_MS) {
          console.warn(
            `🐢 GetNextCard #${seq} → ${label} [${reason}] took ${totalMs}ms — ` +
              `slow enough that RemNote may have stopped waiting.`,
            timer.phases
          );
        } else {
          console.log(`⏱️ GetNextCard #${seq} → ${label} [${reason}] in ${totalMs}ms`, timer.phases);
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

      const [noIncRemTimerEnd, isDeviceDisabled] = await Promise.all([
        plugin.storage.getSynced<number>(noIncRemTimerKey),
        plugin.storage.getLocal<boolean>(incRemDisabledDeviceKey),
      ]);
      timer.mark('gates');
      const now = Date.now();

      const isTimerActive = noIncRemTimerEnd && noIncRemTimerEnd > now;

      if (isTimerActive || isDeviceDisabled) {
        if (isTimerActive) {
          const remainingSeconds = Math.ceil((noIncRemTimerEnd - now) / 1000);
          // console.log('⚠️ TIMER IS ACTIVE - BLOCKING INCREM! Time remaining:', remainingSeconds, 'seconds');
        } else {
          // console.log('⚠️ DEVICE IS DISABLED - BLOCKING INCREM!');
        }

        // Timer or Device is blocking IncRem — this turn will be a flashcard.
        plugin.app.registerCSS(queueCounterId, '');
        clearStaleIncRemSignals();
        return finish(null, isTimerActive ? 'timer-active' : 'device-disabled');
      } else if (noIncRemTimerEnd && noIncRemTimerEnd <= now) {
        // console.log('🧹 Timer expired, cleaning up...');
        await plugin.storage.setSynced(noIncRemTimerKey, null);
        // console.log('No Inc Rem timer expired and cleared');
      } else {
        // console.log('✅ No timer active and device enabled - IncRem allowed');
      }

      // One parallel wave instead of a serial chain. Every read below is
      // independent of the others, but they used to be awaited one at a time and
      // interleaved with the sorting/filtering logic — nine-plus sequential
      // round-trips (three of them full `getCurrentKnowledgeBaseData` fetches,
      // via the settings getters) stacked end to end on the critical path.
      // Firing them together collapses that to roughly the cost of the slowest
      // one, which is the IncRem cache read.
      const [allIncrementalRemRaw, docScopeRemIdsRaw, cardsPerRem, seenRemIdsRaw, sortingRandomness, weightK] =
        await Promise.all([
          plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
          plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey),
          getCardsPerRem(plugin),
          plugin.storage.getSession<RemId[]>(seenRemInSessionKey),
          getSortingRandomness(plugin),
          getWeightSelectionK(plugin),
        ]);
      timer.mark('load');

      const allIncrementalRem: IncrementalRem[] = allIncrementalRemRaw || [];
      const seenRemIds = seenRemIdsRaw || [];
      probeCachePayloadOnce(allIncrementalRem);

      let docScopeRemIds = docScopeRemIdsRaw;

      if (queueInfo.subQueueId && docScopeRemIds === null) {
        // QueueEnter is still computing the scope in the background.
        // Do NOT call buildDocumentScope here — it hangs and causes RemNote's
        // getNextCard timeout to expire, blocking all IncRem injection.
        // Instead, temporarily skip scope filtering and inject from the full KB.
        // The QueueEnter handler will set the proper scope for future calls.
        console.log('⚠️ GetNextCard: Scope not ready yet. Using full KB for IncRem injection.');
        docScopeRemIds = null; // explicit: no scope filtering
      }

      const intervalBetweenIncRem =
        typeof cardsPerRem === 'number' ? cardsPerRem + 1 : cardsPerRem;

      const sorted = _.sortBy(allIncrementalRem, (incRem) => {
        if (queueInfo.mode === 'in-order' && docScopeRemIds) {
          return docScopeRemIds.indexOf(incRem.remId);
        } else {
          return incRem.priority;
        }
      });

      const filtered = sorted.filter((x) => {
        const isDue = Date.now() >= x.nextRepDate;
        const hasBeenSeen = seenRemIds.includes(x.remId);
        const isInScope = !queueInfo.subQueueId || !docScopeRemIds || docScopeRemIds.includes(x.remId);

        if (!isInScope) {
          return false;
        }

        switch (queueInfo.mode) {
          case 'practice-all':
          case 'in-order':
            return !hasBeenSeen;
          default:
            return isDue && !hasBeenSeen;
        }
      });

      console.log('📊 GetNextCard Summary:', {
        allIncrementalRem: allIncrementalRem.length,
        sorted: sorted.length,
        filtered: filtered.length,
        seenRemIds: seenRemIds.length,
        queueMode: queueInfo.mode,
        subQueueId: queueInfo.subQueueId,
        sessionItemCounter,
        intervalBetweenIncRem,
        // This used to re-read currentScopeRemIdsKey to label the source, which
        // cost a second full transfer of the scope array purely for a log string
        // — and could only ever print 'cached', since docScopeRemIds is itself
        // that same read. Same information, no round-trip.
        scopeSource: docScopeRemIds ? 'cached' : 'none',
      });
      timer.mark('sortFilter');

      // Always register the queue counter — don't gate it behind scope being cached.
      // During the race window (QueueEnter still running), the counter would never appear
      // because currentScopeRemIdsKey is null.
      plugin.app.registerCSS(
        queueCounterId,
        `
        .rn-queue__card-counter {
          /*visibility: hidden;*/
        }

        .light .rn-queue__card-counter:after {
          content: ' + ${filtered.length}';
        }

        .dark .rn-queue__card-counter:after {
          content: ' + ${filtered.length}';
        }`.trim()
      );

      const shouldShowIncRem =
        (typeof intervalBetweenIncRem === 'number' &&
          (sessionItemCounter + 1) % intervalBetweenIncRem === 0) ||
        queueInfo.numCardsRemaining === 0 ||
        intervalBetweenIncRem === 'no-cards';

      console.log('🎯 GetNextCard → deciding NEXT item:', {
        willShowIncRem: shouldShowIncRem,
        sessionItemCounter,
        counterCheck: typeof intervalBetweenIncRem === 'number' ? `(${sessionItemCounter}+1) % ${intervalBetweenIncRem} = ${(sessionItemCounter + 1) % intervalBetweenIncRem}` : intervalBetweenIncRem,
        numCardsRemaining: queueInfo.numCardsRemaining,
        filteredIncRems: filtered.length,
      });

      if (shouldShowIncRem) {
        // console.log('🎯 INCREM CONDITION TRUE:', {
        //   sessionItemCounter,
        //   intervalBetweenIncRem,
        //   calculation: `(${sessionItemCounter} + 1) % ${intervalBetweenIncRem} = ${
        //     (sessionItemCounter + 1) % intervalBetweenIncRem
        //   }`,
        //   numCardsRemaining: queueInfo.numCardsRemaining,
        //   filteredLength: filtered.length,
        //   allIncrementalRemLength: allIncrementalRem.length,
        // });

        if (filtered.length === 0) {
          // console.log('⚠️ FILTERED LENGTH IS 0 - Returning null, will show a flashcard.');
          plugin.app.registerCSS(queueCounterId, '');
          sessionItemCounter++;
          clearStaleIncRemSignals();
          return finish(null, 'no-due-increms');
        }

        // Inject randomness via the priority-weighted lottery — the SAME weighting
        // used by the Priority Review Document — so raising the IncRem randomness
        // slider pulls higher-priority due IncRems toward the front far more often
        // than low-priority ones (instead of the old flat uniform swap).
        // Only applies when `filtered` is in priority order: in 'in-order' mode it is
        // sorted by document position, so we leave it untouched (no randomisation).
        // Settings for the lottery are now read in the parallel wave above rather
        // than here, where they added two serial settings round-trips (each of
        // which fetches the whole KB data object) between the decision and the
        // return.
        if (queueInfo.mode !== 'in-order') {
          applyPriorityWeightedLottery(filtered, sortingRandomness, weightK);
        }

        // console.log('✅ Filtered has items, selecting first IncRem');
        let first = filtered[0];

        let verifyRounds = 0;
        while (!(await getIncrementalRemFromRem(plugin, await plugin.rem.findOne(first.remId)))) {
          verifyRounds++;
          filtered.shift();
          if (filtered.length === 0) {
            console.log('❌ All filtered items were invalid after verification - Returning null');
            plugin.app.registerCSS(queueCounterId, '');
            clearStaleIncRemSignals();
            timer.mark('verifyCandidate');
            return finish(null, `all-candidates-invalid(${verifyRounds})`);
          }
          first = filtered[0];
        }
        // Each round of the loop above is ~11 serial SDK round-trips
        // (hasPowerup, two Daily-Doc resolutions of 3 calls each, the history
        // slot, and the priority slot + richText conversion). Recorded
        // separately because it is the single most expensive phase whenever the
        // first candidate does not verify.
        timer.mark('verifyCandidate');

        await Promise.all([
          plugin.storage.setSession(seenRemInSessionKey, [...seenRemIds, first.remId]),
          plugin.storage.setSession(incremReviewStartTimeKey, Date.now()),
        ]);
        timer.mark('markSeen');

        // Activate hide CSS now that we know we're genuinely showing a Plugin (IncRem) item.
        // (No-op: the CSS is now registered globally and self-gates via :has().)

        // console.log('✅ SHOWING INCREM:', first, 'due', dayjs(first.nextRepDate).fromNow());
        sessionItemCounter++;
        return finish(
          {
            type: QueueItemType.Plugin,
            remId: first.remId,
            pluginId: 'incremental-everything',
          },
          verifyRounds > 0 ? `inject(after ${verifyRounds} invalid)` : 'inject'
        );
      } else {
        const moduloDenominator: number =
          typeof intervalBetweenIncRem === 'number'
            ? intervalBetweenIncRem
            : Number(intervalBetweenIncRem);
        // console.log('🎴 FLASHCARD TURN:', {
        //   sessionItemCounter,
        //   intervalBetweenIncRem,
        //   calculation: `(${sessionItemCounter} + 1) % ${intervalBetweenIncRem} = ${
        //     (sessionItemCounter + 1) % moduloDenominator
        //   }`,
        //   nextIncRemAt:
        //     typeof intervalBetweenIncRem === 'number'
        //       ? intervalBetweenIncRem - ((sessionItemCounter + 1) % intervalBetweenIncRem)
        //       : 'N/A',
        // });
        sessionItemCounter++;
        // Flashcard turn — the hide CSS is globally registered and self-deactivates via :has()
        // when the Plugin iframe is absent; no manual clearing needed.
        clearStaleIncRemSignals();
        return finish(null, 'interval-not-reached');
      }
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
