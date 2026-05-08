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
} from '../lib/consts';
import { getIncrementalRemFromRem, IncrementalRem } from '../lib/incremental_rem';
import { getCardsPerRem, getSortingRandomness } from '../lib/sorting';
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

  /* Ensure card_priority_display (our widget) renders above flashcard-repetition-history.
     The parent flashcard container is already "flex flex-col", so flex order is sufficient.
     Scoped to only activate when our card_priority_display iframe is present, so regular
     flashcards without the plugin widget are not affected. */
  .box-border.flex.flex-col:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=card_priority_display&"])
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

const REMOVE_FROM_QUEUE_CSS = `
  /* Remove from Queue Styles */
  .rn-queue__content [data-queue-rem-container-tags~="removefromqueue"]:not(.rn-question-rem) > .rn-queue-rem,
  .rn-queue__content [data-queue-rem-container-tags~="remove-from-queue"]:not(.rn-question-rem) > .rn-queue-rem {
    display: none;
  }

  .rn-queue__content [data-queue-rem-container-tags~="removefromqueue"]:not(.rn-question-rem),
  .rn-queue__content [data-queue-rem-container-tags~="remove-from-queue"]:not(.rn-question-rem),
  .rn-breadcrumb-item[data-rem-tags~="removefromqueue"],
  .rn-breadcrumb-item[data-rem-tags~="remove-from-queue"] {
    margin-left: 0px !important; /* makes it look like its not indented to the removed parent */
  }
`;

/* Remove-Parent: when applied to the current question rem, completely removes the
   parent rem from the queue display on BOTH front and back of the card (no
   "Hidden in queue" placeholder, unlike hide-parent). Mirrors hide-parent's
   :has() selector but drops the --answer-hidden modifier and hides .rn-queue-rem
   outright. */
const REMOVE_PARENT_CSS = `
  .rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="removeparent"]) > .RichTextViewer,
  .rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="remove-parent"]) > .RichTextViewer,
  .rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="removeparent"]) > .rn-flashcard-delimiter,
  .rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="remove-parent"]) > .rn-flashcard-delimiter,
  .rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="removeparent"]) > .rn-queue-rem,
  .rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="remove-parent"]) > .rn-queue-rem,
  .rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="removeparent"]) > .rem-bullet__document,
  .rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="remove-parent"]) > .rem-bullet__document {
    display: none !important;
  }

  .rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="removeparent"]),
  .rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="remove-parent"]) {
    margin-left: 0px !important;
  }
`;

let sessionItemCounter = 0;

export const resetSessionItemCounter = () => {
  sessionItemCounter = 0;
};

export function registerCallbacks(plugin: ReactRNPlugin) {
  plugin.app.registerCSS(queueLayoutFixId, QUEUE_LAYOUT_FIX_CSS);
  plugin.app.registerCSS(queueHideElementsId, QUEUE_HIDE_ELEMENTS_CSS);
  plugin.app.registerCSS('remove-from-queue-css', REMOVE_FROM_QUEUE_CSS);
  plugin.app.registerCSS('remove-parent-css', REMOVE_PARENT_CSS);

  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (queueInfo) => {
      console.log('queueInfo', queueInfo);

      // Helper: clear stale sidebar signals when returning null (flashcard turn).
      // The QueueComponent's useEffect cleanup is unreliable — RemNote can
      // destroy its iframe before React cleanup fires. This main-process
      // helper guarantees the signals are cleared.
      const clearStaleIncRemSignals = () => {
        plugin.storage.setSession(incrementalQueueActiveKey, false);
        plugin.storage.setSession(currentIncrementalRemTypeKey, undefined);
      };

      const noIncRemTimerEnd = await plugin.storage.getSynced<number>(noIncRemTimerKey);
      const isDeviceDisabled = await plugin.storage.getLocal<boolean>(incRemDisabledDeviceKey);
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
        return null;
      } else if (noIncRemTimerEnd && noIncRemTimerEnd <= now) {
        // console.log('🧹 Timer expired, cleaning up...');
        await plugin.storage.setSynced(noIncRemTimerKey, null);
        // console.log('No Inc Rem timer expired and cleared');
      } else {
        // console.log('✅ No timer active and device enabled - IncRem allowed');
      }

      const allIncrementalRem: IncrementalRem[] =
        (await plugin.storage.getSession(allIncrementalRemKey)) || [];

      let docScopeRemIds = await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey);

      if (queueInfo.subQueueId && docScopeRemIds === null) {
        // QueueEnter is still computing the scope in the background.
        // Do NOT call buildDocumentScope here — it hangs and causes RemNote's
        // getNextCard timeout to expire, blocking all IncRem injection.
        // Instead, temporarily skip scope filtering and inject from the full KB.
        // The QueueEnter handler will set the proper scope for future calls.
        console.log('⚠️ GetNextCard: Scope not ready yet. Using full KB for IncRem injection.');
        docScopeRemIds = null; // explicit: no scope filtering
      }

      const cardsPerRem = await getCardsPerRem(plugin);
      const intervalBetweenIncRem =
        typeof cardsPerRem === 'number' ? cardsPerRem + 1 : cardsPerRem;

      const sorted = _.sortBy(allIncrementalRem, (incRem) => {
        if (queueInfo.mode === 'in-order' && docScopeRemIds) {
          return docScopeRemIds.indexOf(incRem.remId);
        } else {
          return incRem.priority;
        }
      });

      const seenRemIds = (await plugin.storage.getSession<RemId[]>(seenRemInSessionKey)) || [];
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
        scopeSource: docScopeRemIds ? (await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey)) !== null ? 'cached' : 'on-the-fly' : 'none',
      });

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
          return null;
        }

        const sortingRandomness = await getSortingRandomness(plugin);
        const numRandomSwaps = sortingRandomness * filtered.length;
        for (let i = 0; i < numRandomSwaps; i++) {
          const idx1 = Math.floor(Math.random() * filtered.length);
          const idx2 = Math.floor(Math.random() * filtered.length);
          [filtered[idx1], filtered[idx2]] = [filtered[idx2], filtered[idx1]];
        }

        // console.log('✅ Filtered has items, selecting first IncRem');
        let first = filtered[0];

        while (!(await getIncrementalRemFromRem(plugin, await plugin.rem.findOne(first.remId)))) {
          filtered.shift();
          if (filtered.length === 0) {
            console.log('❌ All filtered items were invalid after verification - Returning null');
            plugin.app.registerCSS(queueCounterId, '');
            clearStaleIncRemSignals();
            return null;
          }
          first = filtered[0];
        }
        await plugin.storage.setSession(seenRemInSessionKey, [...seenRemIds, first.remId]);
        await plugin.storage.setSession(incremReviewStartTimeKey, Date.now());

        // Activate hide CSS now that we know we're genuinely showing a Plugin (IncRem) item.
        // (No-op: the CSS is now registered globally and self-gates via :has().)

        // console.log('✅ SHOWING INCREM:', first, 'due', dayjs(first.nextRepDate).fromNow());
        sessionItemCounter++;
        return {
          type: QueueItemType.Plugin,
          remId: first.remId,
          pluginId: 'incremental-everything',
        };
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
        return null;
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
