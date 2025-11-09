import {
  QueueItemType,
  ReactRNPlugin,
  RemId,
  SpecialPluginCallback,
} from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import * as _ from 'remeda';
import {
  allIncrementalRemKey,
  currentScopeRemIdsKey,
  noIncRemTimerKey,
  queueCounterId,
  queueLayoutFixId,
  seenRemInSessionKey,
} from '../lib/consts';
import { getCardsPerRem, getSortingRandomness } from '../lib/sorting';
import { IncrementalRem } from '../lib/types';
import { getIncrementalRemInfo } from '../lib/incremental_rem';

dayjs.extend(relativeTime);

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

export const resetQueueSessionItemCounter = () => {
  sessionItemCounter = 0;
};

export const registerGetNextCardCallback = (plugin: ReactRNPlugin) => {
  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (queueInfo) => {
      console.log('queueInfo', queueInfo);

      // Check if "No Inc Rem" timer is active (using SYNCED storage)
      const noIncRemTimerEnd = await plugin.storage.getSynced<number>(noIncRemTimerKey);
      const now = Date.now();
      console.log('⏰ TIMER CHECK:', {
        noIncRemTimerEnd,
        now,
        isTimerActive: noIncRemTimerEnd && noIncRemTimerEnd > now,
        timerWillExpireIn: noIncRemTimerEnd ? Math.ceil((noIncRemTimerEnd - now) / 1000) + ' seconds' : 'no timer set'
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

      // ---
      // --- ⬇️ MODIFIED LOGIC ⬇️ ---
      // ---

      // Check if session cache is ready
      let docScopeRemIds = await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey);

      // RACE CONDITION FIX:
      // GetNextCard can be called before QueueEnter finishes calculating the scope.
      // If the cache isn't ready yet, calculate a basic scope on-the-fly.
      // This prevents returning null when there are IncRems to show.
      if (queueInfo.subQueueId && docScopeRemIds === null) {
        console.log('⚠️ GetNextCard: Session cache not ready yet. Calculating scope on-the-fly...');

        const scopeRem = await plugin.rem.findOne(queueInfo.subQueueId);
        if (!scopeRem) {
          console.log('❌ GetNextCard: Could not find scope Rem. Returning null.');
          return null;
        }

        const descendants = await scopeRem.getDescendants();
        const itemSelectionScope = new Set<RemId>([
          scopeRem._id,
          ...descendants.map(r => r._id)
        ]);

        docScopeRemIds = Array.from(itemSelectionScope);
        console.log(`✅ GetNextCard: Calculated on-the-fly scope with ${docScopeRemIds.length} items`);
      }

      // --- ⬆️ END OF MODIFICATION ⬆️ ---


      const cardsPerRem = await getCardsPerRem(plugin);
      const intervalBetweenIncRem = 
        typeof cardsPerRem === 'number' ? cardsPerRem + 1 : cardsPerRem;
      
      const sorted = _.sortBy(allIncrementalRem, (incRem) => {
        if (queueInfo.mode === 'in-order' && docScopeRemIds) {
          // Use the fetched scope for in-order sorting.
          return docScopeRemIds.indexOf(incRem.remId);
        } else {
          return incRem.priority;
        }
      });
      
      // Use the fetched scope for filtering.
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
          default: // SRS mode
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
        usingCachedScope: queueInfo.subQueueId ? (await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey)) !== null : 'N/A'
      });

      // Only update counter if cache is ready OR we're not in a document queue
      if (!queueInfo.subQueueId || (await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey)) !== null) {
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

      if (
        (typeof intervalBetweenIncRem === 'number' &&
          (sessionItemCounter + 1) % intervalBetweenIncRem === 0) || // <-- This line is corrected
        queueInfo.numCardsRemaining === 0 ||
        intervalBetweenIncRem === 'no-cards'
      ) {
        // CONDITION IS TRUE - SHOULD SHOW INCREMENTAL REM
        console.log('🎯 INCREM CONDITION TRUE:', {
          sessionItemCounter,
          intervalBetweenIncRem,
          calculation: `(${sessionItemCounter} + 1) % ${intervalBetweenIncRem} = ${(sessionItemCounter + 1) % intervalBetweenIncRem}`,
          numCardsRemaining: queueInfo.numCardsRemaining,
          filteredLength: filtered.length,
          allIncrementalRemLength: allIncrementalRem.length
       });

        // 1. FIRST, check if there are any valid rems to show.
        if (filtered.length === 0) {
          console.log('⚠️ FILTERED LENGTH IS 0 - Returning null, will show a flashcard.');
          await plugin.app.registerCSS(queueLayoutFixId, '');
          // We still increment the counter so the next attempt isn't immediate.
          sessionItemCounter++; 
          return null;
        }

        // 2. SECOND, if we have items, THEN perform the random swaps.
        const sortingRandomness = await getSortingRandomness(plugin);
        const num_random_swaps = sortingRandomness * filtered.length; // Use filtered.length
        for (let i = 0; i < num_random_swaps; i++) {
          const idx1 = Math.floor(Math.random() * filtered.length);
          const idx2 = Math.floor(Math.random() * filtered.length);
          // Simple swap
          [filtered[idx1], filtered[idx2]] = [filtered[idx2], filtered[idx1]];
        }

        // 3. THIRD, now that we know the array is not empty, safely select the first item.
        console.log('✅ Filtered has items, selecting first IncRem');
        let first = filtered[0];

        // 4. FINALLY, verify the rem still exists before returning it.
        // This while-loop is a safeguard against deleted rems.
        while (!(await getIncrementalRemInfo(plugin, await plugin.rem.findOne(first.remId)))) {
            filtered.shift();
            if (filtered.length === 0) {
            console.log('❌ All filtered items were invalid after verification - Returning null');
            return null;
        }
          first = filtered[0];
        }
        await plugin.app.registerCSS(queueLayoutFixId, QUEUE_LAYOUT_FIX_CSS);
        await plugin.storage.setSession(seenRemInSessionKey, [...seenRemIds, first.remId]);
        
        // NEW: Store queue mode and start time for review tracking
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
        // CONDITION IS FALSE - SHOWING FLASHCARD
        console.log('🎴 FLASHCARD TURN:', {
          sessionItemCounter,
          intervalBetweenIncRem,
          calculation: `(${sessionItemCounter} + 1) % ${intervalBetweenIncRem} = ${(sessionItemCounter + 1) % intervalBetweenIncRem}`,
          nextIncRemAt: typeof intervalBetweenIncRem === 'number' 
            ? intervalBetweenIncRem - ((sessionItemCounter + 1) % intervalBetweenIncRem)
            : 'N/A'
        });
        sessionItemCounter++;
        await plugin.app.registerCSS(queueLayoutFixId, '');
        return null;
      }
    }
  );
};
