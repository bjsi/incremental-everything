import {
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
} from '../lib/consts';
import { getIncrementalRemFromRem, IncrementalRem } from '../lib/incremental_rem';
import { getCardsPerRem, getSortingRandomness } from '../lib/sorting';


// Registered once globally — safe because all selectors are highly specific to the
// incremental-everything plugin iframe and do not affect regular flashcard layout.
const QUEUE_LAYOUT_FIX_CSS = `
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) {
    height: 100% !important;
  }
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) .rn-queue__content,
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) .rn-queue__content .rn-flashcard,
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) .rn-queue__content .rn-flashcard__content,
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) .box-border:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]),
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) div.fade-in-first-load:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]),
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) div.fade-in-first-load:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) > div,
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"] {
    flex-grow: 1 !important;
  }

  /* Ensure card_priority_display (our widget) renders above flashcard-repetition-history.
     The parent flashcard container is already "flex flex-col", so flex order is sufficient.
     Scoped to only activate when our card_priority_display iframe is present, so regular
     flashcards without the plugin widget are not affected. */
  .box-border.flex.flex-col:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=card_priority_display"])
    .fade-in-first-load:has(iframe[data-plugin-id="flashcard-repetition-history"]) {
    order: 1;
  }
`;

// Registered dynamically in GetNextCard — applied ONLY when we are returning a Plugin
// (QueueItemType.Plugin) item so that rems that are both an IncRem and a flashcard
// do NOT have these elements hidden when they appear on a regular flashcard turn.
//
// Belt-and-suspenders against the pre-fetch race (same pattern as QUEUE_LAYOUT_FIX_CSS):
// all selectors are rooted at .rn-queue:has(iframe[data-plugin-id="incremental-everything"]).
// This means even if a concurrent GetNextCard null-return fires registerCSS('') a few ms
// late, the rules stop matching the instant RemNote removes the plugin iframe from the DOM —
// the CSS is self-deactivating at the DOM level and does not depend solely on JS timing.
const QUEUE_HIDE_ELEMENTS_CSS = `
  /* Hide unwanted UI elements during incremental rem review.
     Gated on two conditions:
       1. The plugin iframe is present (.rn-queue:has(iframe...)) — self-deactivates when
          the iframe is removed, guarding against the pre-fetch GetNextCard race.
       2. The item is tagged as incremental ([data-queue-rem-tags~="incremental"]) — ensures
          rems that are both an IncRem and a flashcard are only affected on Plugin turns. */
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) [data-queue-rem-tags~="incremental"] .rn-flashcard-insights,
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) [data-queue-rem-tags~="incremental"] [data-cy="bottom-of-card-ai-suggestions"],
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) [data-queue-rem-tags~="incremental"] div.fade-in-first-load:has(div[data-cy="bottom-of-card-suggestions"]),
  .rn-queue:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue"]) [data-queue-rem-tags~="incremental"] div.fade-in-first-load:has(iframe[data-plugin-id="flashcard-repetition-history"]) {
    display: none !important;
  }
`;

const HIDE_PARENT_CSS = `
  /* Hide Parent Styles */
  .rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .RichTextViewer,
  .rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-flashcard-delimiter,
  .rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-queue-rem > .RichTextViewer,
  .rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rem-bullet__document {
    display: none !important;
  }

  .rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-queue-rem > .rn-bullet-container,
  .rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-queue-rem > .rem-bullet__document {
    position: relative;
  }

  .rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-queue-rem > .rn-bullet-container:after,
  .rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-queue-rem > .rem-bullet__document:after {
    content: "Hidden in queue";
    opacity: .3;
    white-space: nowrap;
    position: absolute;
    left: 25px;
    top: 0;
  }
`;

let sessionItemCounter = 0;

export const resetSessionItemCounter = () => {
  sessionItemCounter = 0;
};

  export function registerCallbacks(plugin: ReactRNPlugin) {
  plugin.app.registerCSS(queueLayoutFixId, QUEUE_LAYOUT_FIX_CSS);
  plugin.app.registerCSS('hide-parent-css', HIDE_PARENT_CSS);

  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (queueInfo) => {
      console.log('queueInfo', queueInfo);

      const noIncRemTimerEnd = await plugin.storage.getSynced<number>(noIncRemTimerKey);
      const now = Date.now();
      // console.log('⏰ TIMER CHECK:', {
      //   noIncRemTimerEnd,
      //   now,
      //   isTimerActive: noIncRemTimerEnd && noIncRemTimerEnd > now,
      //   timerWillExpireIn: noIncRemTimerEnd
      //     ? Math.ceil((noIncRemTimerEnd - now) / 1000) + ' seconds'
      //     : 'no timer set',
      // });

      const isTimerActive = noIncRemTimerEnd && noIncRemTimerEnd > now;

      if (isTimerActive) {
        const remainingSeconds = Math.ceil((noIncRemTimerEnd - now) / 1000);
        // console.log('⚠️ TIMER IS ACTIVE - BLOCKING INCREM! Time remaining:', remainingSeconds, 'seconds');

        // Timer is blocking IncRem — this turn will be a flashcard; ensure hide CSS is cleared.
        plugin.app.registerCSS(queueHideElementsId, '');
        await plugin.app.registerCSS(queueCounterId, '');

        return null;
      } else if (noIncRemTimerEnd && noIncRemTimerEnd <= now) {
        console.log('🧹 Timer expired, cleaning up...');
        await plugin.storage.setSynced(noIncRemTimerKey, null);
        console.log('No Inc Rem timer expired and cleared');
      } else {
        console.log('✅ No timer active - IncRem allowed');
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

      console.log('🎯 GetNextCard Decision:', {
        shouldShowIncRem,
        sessionItemCounter,
        counterCheck: typeof intervalBetweenIncRem === 'number' ? `(${sessionItemCounter}+1) % ${intervalBetweenIncRem} = ${(sessionItemCounter + 1) % intervalBetweenIncRem}` : intervalBetweenIncRem,
        numCardsRemaining: queueInfo.numCardsRemaining,
        filteredLength: filtered.length,
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
          plugin.app.registerCSS(queueHideElementsId, '');
          sessionItemCounter++;
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
            plugin.app.registerCSS(queueHideElementsId, '');
            return null;
          }
          first = filtered[0];
        }
        await plugin.storage.setSession(seenRemInSessionKey, [...seenRemIds, first.remId]);
        await plugin.storage.setSession(incremReviewStartTimeKey, Date.now());

        // Activate hide CSS now that we know we're genuinely showing a Plugin (IncRem) item.
        plugin.app.registerCSS(queueHideElementsId, QUEUE_HIDE_ELEMENTS_CSS);

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
        // Flashcard turn — deactivate hide CSS so flashcard widgets remain visible.
        // Also clears incrementalQueueActiveKey as a bullet-proof mid-session reset:
        // if the previous IncRem widget unmounted unceremoniously (skipping its useEffect
        // cleanup), this ensures CardPriorityDisplay and similar widgets can render.
        plugin.app.registerCSS(queueHideElementsId, '');
        await plugin.storage.setSession(incrementalQueueActiveKey, false);
        return null;
      }
    }
  );
}
