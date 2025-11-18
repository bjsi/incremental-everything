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
  seenRemInSessionKey,
  noIncRemTimerKey,
} from '../lib/consts';
import { getIncrementalRemFromRem, IncrementalRem } from '../lib/incremental_rem';
import { getCardsPerRem, getSortingRandomness } from '../lib/sorting';
import { buildQuickScope } from '../lib/scope_helpers';

const QUEUE_LAYOUT_FIX_CSS = `
  .rn-queue {
    height: 100% !important;
  }
  .rn-queue__content,
  .rn-queue__content .rn-flashcard,
  .rn-queue__content .rn-flashcard__content,
  .rn-queue__content > .box-border,
  .rn-queue__content > .box-border > .fade-in-first-load {
    flex-grow: 1 !important;
  }
  /* Hide unwanted UI elements during incremental rem review */
  .rn-flashcard-insights,
  div.fade-in-first-load:has(div[data-cy="bottom-of-card-suggestions"]),
  div:has(> iframe[data-plugin-id="flashcard-repetition-history"]) {
    display: none !important;

  }
`;

let sessionItemCounter = 0;

export const resetSessionItemCounter = () => {
  sessionItemCounter = 0;
};

export function registerCallbacks(plugin: ReactRNPlugin) {
  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (queueInfo) => {
      console.log('queueInfo', queueInfo);

      const noIncRemTimerEnd = await plugin.storage.getSynced<number>(noIncRemTimerKey);
      const now = Date.now();
      console.log('⏰ TIMER CHECK:', {
        noIncRemTimerEnd,
        now,
        isTimerActive: noIncRemTimerEnd && noIncRemTimerEnd > now,
        timerWillExpireIn: noIncRemTimerEnd
          ? Math.ceil((noIncRemTimerEnd - now) / 1000) + ' seconds'
          : 'no timer set',
      });

      const isTimerActive = noIncRemTimerEnd && noIncRemTimerEnd > now;

      if (isTimerActive) {
        const remainingSeconds = Math.ceil((noIncRemTimerEnd - now) / 1000);
        console.log('⚠️ TIMER IS ACTIVE - BLOCKING INCREM! Time remaining:', remainingSeconds, 'seconds');

        await plugin.app.registerCSS(queueLayoutFixId, '');
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
        console.log('⚠️ GetNextCard: Session cache not ready yet. Calculating scope on-the-fly...');

        const itemSelectionScope = await buildQuickScope(plugin, queueInfo.subQueueId);

        if (itemSelectionScope.size === 0) {
          console.log('❌ GetNextCard: Could not build scope. Returning null.');
          return null;
        }

        docScopeRemIds = Array.from(itemSelectionScope);
        console.log(`✅ GetNextCard: Calculated on-the-fly scope with ${docScopeRemIds.length} items (including PDF extracts)`);
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
        const isInScope = !queueInfo.subQueueId || docScopeRemIds?.includes(x.remId);

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
        usingCachedScope: queueInfo.subQueueId
          ? (await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey)) !== null
          : 'N/A',
      });

      if (
        !queueInfo.subQueueId ||
        (await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey)) !== null
      ) {
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
      }

      const shouldShowIncRem =
        (typeof intervalBetweenIncRem === 'number' &&
          (sessionItemCounter + 1) % intervalBetweenIncRem === 0) ||
        queueInfo.numCardsRemaining === 0 ||
        intervalBetweenIncRem === 'no-cards';

      if (shouldShowIncRem) {
        console.log('🎯 INCREM CONDITION TRUE:', {
          sessionItemCounter,
          intervalBetweenIncRem,
          calculation: `(${sessionItemCounter} + 1) % ${intervalBetweenIncRem} = ${
            (sessionItemCounter + 1) % intervalBetweenIncRem
          }`,
          numCardsRemaining: queueInfo.numCardsRemaining,
          filteredLength: filtered.length,
          allIncrementalRemLength: allIncrementalRem.length,
        });

        if (filtered.length === 0) {
          console.log('⚠️ FILTERED LENGTH IS 0 - Returning null, will show a flashcard.');
          await plugin.app.registerCSS(queueLayoutFixId, '');
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

        console.log('✅ Filtered has items, selecting first IncRem');
        let first = filtered[0];

        while (!(await getIncrementalRemFromRem(plugin, await plugin.rem.findOne(first.remId)))) {
          filtered.shift();
          if (filtered.length === 0) {
            console.log('❌ All filtered items were invalid after verification - Returning null');
            return null;
          }
          first = filtered[0];
        }
        await plugin.app.registerCSS(queueLayoutFixId, QUEUE_LAYOUT_FIX_CSS);
        await plugin.storage.setSession(seenRemInSessionKey, [...seenRemIds, first.remId]);

        await plugin.storage.setSession('current-queue-mode', queueInfo.mode);
        await plugin.storage.setSession('increm-review-start-time', Date.now());

        console.log('✅ SHOWING INCREM:', first, 'due', dayjs(first.nextRepDate).fromNow());
        sessionItemCounter++;
        return {
          type: QueueItemType.Plugin,
          remId: first.remId,
          pluginId: 'incremental-everything',
        };
      } else {
        console.log('🎴 FLASHCARD TURN:', {
          sessionItemCounter,
          intervalBetweenIncRem,
          calculation: `(${sessionItemCounter} + 1) % ${intervalBetweenIncRem} = ${
            (sessionItemCounter + 1) % intervalBetweenIncRem
          }`,
          nextIncRemAt:
            typeof intervalBetweenIncRem === 'number'
              ? intervalBetweenIncRem - ((sessionItemCounter + 1) % intervalBetweenIncRem)
              : 'N/A',
        });
        sessionItemCounter++;
        await plugin.app.registerCSS(queueLayoutFixId, '');
        return null;
      }
    }
  );
}
