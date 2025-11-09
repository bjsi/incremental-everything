import {
  declareIndexPlugin,
  PluginCommandMenuLocation,
  QueueItemType,
  ReactRNPlugin,
  RemId,
  RNPlugin,
  SpecialPluginCallback,
} from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import {
  allIncrementalRemKey,
  powerupCode,
  queueCounterId,
  queueLayoutFixId,
  currentScopeRemIdsKey,
  seenRemInSessionKey,
  priorityShieldHistoryMenuItemId,
  currentSubQueueIdKey,
  allCardPriorityInfoKey,
  noIncRemTimerKey,
  noIncRemMenuItemId,
  pdfHighlightColorId
} from '../lib/consts';
import * as _ from 'remeda';
import { getSortingRandomness, getCardsPerRem } from '../lib/sorting';
import { IncrementalRem } from '../lib/types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { safeRemTextToString } from '../lib/pdfUtils';
import { handleMobileDetectionOnStartup, shouldUseLightMode } from '../lib/mobileUtils';
import { 
  autoAssignCardPriority, 
  getCardPriority, 
  CardPriorityInfo,
  setCardPriority,
  calculateNewPriority
} from '../lib/cardPriority';
import {
  registerQueueExitListener,
  registerQueueEnterListener,
  registerURLChangeListener,
  registerQueueCompleteCardListener,
  registerGlobalRemChangedListener,
} from './events';
import { registerPluginPowerups, initIncrementalRem } from './powerups';
import { registerPluginSettings } from './settings';
import { registerWidgets } from './widgets';
import { registerCommands } from './commands';
dayjs.extend(relativeTime);

let sessionItemCounter = 0;

// CARD PRIORITIES CACHING FUNCTION - With deferred loading for untagged cards
async function cacheAllCardPriorities(plugin: RNPlugin) {
  console.log('CACHE: Starting intelligent cache build with deferred loading...');
  
  const startTime = Date.now();
  
  const allCards = await plugin.card.getAll();
  const cardRemIds = allCards ? _.uniq(allCards.map(c => c.remId)) : [];
  console.log(`CACHE: Found ${cardRemIds.length} rems with cards`);
  
  // CRITICAL FIX: Also get rems that are tagged with cardPriority for inheritance
  const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
  const taggedForInheritanceRems = (await cardPriorityPowerup?.taggedRem()) || [];
  const inheritanceRemIds = taggedForInheritanceRems.map(r => r._id);
  console.log(`CACHE: Found ${inheritanceRemIds.length} rems tagged with cardPriority powerup`);
  
  // Combine both sets of remIds (cards + inheritance-only)
  const uniqueRemIds = _.uniq([...cardRemIds, ...inheritanceRemIds]);
  console.log(`CACHE: Total ${uniqueRemIds.length} rems to process (${cardRemIds.length} with cards + ${inheritanceRemIds.length - cardRemIds.length} inheritance-only)`);
  
  if (uniqueRemIds.length === 0) {
    console.log('CACHE: No cards or cardPriority tags found. Setting empty cache.');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
    return;
  }
    
  // Step 1: Quickly load all pre-tagged cards for immediate use
  console.log('CACHE: Phase 1 - Loading pre-tagged cards...');
  const taggedPriorities: CardPriorityInfo[] = [];
  const untaggedRemIds: string[] = [];
  
  // Process in batches to check what's tagged
  const checkBatchSize = 100;
  for (let i = 0; i < uniqueRemIds.length; i += checkBatchSize) {
    const batch = uniqueRemIds.slice(i, i + checkBatchSize);
    
    await Promise.all(batch.map(async (remId) => {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) return;
      
      const hasPowerup = await rem.hasPowerup('cardPriority');
      if (hasPowerup) {
        // It's tagged - get the info quickly
        const cardInfo = await getCardPriority(plugin, rem);
        if (cardInfo) {
          taggedPriorities.push(cardInfo);
        }
      } else {
        // Not tagged - queue for deferred processing
        untaggedRemIds.push(remId);
      }
    }));
  }

  // --- PERCENTILE CALCULATION LOGIC ---
  console.log(`CACHE: Found ${taggedPriorities.length} tagged entries. Calculating percentiles...`);
  const sortedInfos = _.sortBy(taggedPriorities, (info) => info.priority);
  const totalItems = sortedInfos.length;
  const enrichedTaggedPriorities = sortedInfos.map((info, index) => {
    const percentile = totalItems > 0 ? Math.round(((index + 1) / totalItems) * 100) : 0;
    return { ...info, kbPercentile: percentile };
  });
  
  // Set the initial cache with tagged cards (instant availability)
  await plugin.storage.setSession(allCardPriorityInfoKey, enrichedTaggedPriorities);
  
  const phase1Time = Math.round((Date.now() - startTime) / 1000);
  console.log(`CACHE: Phase 1 complete. Loaded and enriched ${enrichedTaggedPriorities.length} tagged cards in ${phase1Time}s`);
  console.log(`CACHE: Found ${untaggedRemIds.length} untagged cards for deferred processing`);
  
  if (enrichedTaggedPriorities.length > 0) {
    await plugin.app.toast(`✅ Loaded ${enrichedTaggedPriorities.length} card priorities instantly`);
  }
  
  if (untaggedRemIds.length > 0) {
    const untaggedPercentage = Math.round((untaggedRemIds.length / uniqueRemIds.length) * 100);
    if (untaggedPercentage > 20) {
      await plugin.app.toast(
        `⏳ Processing ${untaggedRemIds.length} untagged cards in background... ` +
        `Consider running 'Pre-compute Card Priorities' for instant startups!`
      );
    }
    
    setTimeout(async () => {
      await processDeferredCards(plugin, untaggedRemIds);
    }, 3000);
  } else {
    console.log('CACHE: All cards are pre-tagged! No deferred processing needed.');
    await plugin.app.toast('✅ All card priorities loaded instantly!');
  }
}

// DEFERRED PROCESSING FUNCTION - Processes untagged cards in the background
async function processDeferredCards(plugin: RNPlugin, untaggedRemIds: string[]) {
  console.log(`DEFERRED: Starting background processing of ${untaggedRemIds.length} untagged cards...`);
  const startTime = Date.now();
  
  let processed = 0;
  let errorCount = 0;
  const batchSize = 30; // Small batches to avoid blocking UI
  const delayBetweenBatches = 100; // 100ms delay between batches
  
  try {
    for (let i = 0; i < untaggedRemIds.length; i += batchSize) {
      const batch = untaggedRemIds.slice(i, i + batchSize);
      const newPriorities: CardPriorityInfo[] = [];
      
      // Process this batch
      await Promise.all(batch.map(async (remId) => {
        try {
          const rem = await plugin.rem.findOne(remId);
          if (!rem) {
            errorCount++;
            return;
          }
          
          // Auto-assign priority (this will tag the rem)
          await autoAssignCardPriority(plugin, rem);
          
          // Get the newly assigned priority info
          const cardInfo = await getCardPriority(plugin, rem);
          if (cardInfo) {
            newPriorities.push(cardInfo);
          }
          
          processed++;
        } catch (error) {
          console.error(`DEFERRED: Error processing rem ${remId}:`, error);
          errorCount++;
        }
      }));
      
      // Update the cache incrementally
      if (newPriorities.length > 0) {
        const currentCache = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey) || [];
        const mergedCache = [...currentCache, ...newPriorities];

        // --- NEW: Re-calculate all percentiles for the updated cache ---
        const sortedMergedCache = _.sortBy(mergedCache, (info) => info.priority);
        const totalItems = sortedMergedCache.length;
        const enrichedCache = sortedMergedCache.map((info, index) => {
            const percentile = totalItems > 0 ? Math.round(((index + 1) / totalItems) * 100) : 0;
            return { ...info, kbPercentile: percentile };
        });
        
        await plugin.storage.setSession(allCardPriorityInfoKey, enrichedCache);
      }
      
      // Progress logging every 20% or 500 cards
      if (processed % Math.max(500, Math.floor(untaggedRemIds.length * 0.2)) === 0 || 
          processed === untaggedRemIds.length) {
        const progress = Math.round((processed / untaggedRemIds.length) * 100);
        console.log(`DEFERRED: Progress ${progress}% (${processed}/${untaggedRemIds.length})`);
      }
      
      // Yield to UI between batches (only if not the last batch)
      if (i + batchSize < untaggedRemIds.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }
    
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `DEFERRED: Background processing complete! ` +
      `Processed ${processed} cards in ${totalTime}s ` +
      `(${errorCount} errors)`
    );
    
    // Final notification
    await plugin.app.toast(
      `✅ Background processing complete! All ${processed} card priorities are now cached.`
    );
    
    // If there were many untagged cards, suggest pre-computation again
    if (untaggedRemIds.length > 1000) {
      setTimeout(() => {
        plugin.app.toast(
          `💡 Tip: Run 'Pre-compute Card Priorities' to avoid background processing in future sessions`
        );
      }, 2000);
    }
    
  } catch (error) {
    console.error('DEFERRED: Fatal error during background processing:', error);
    await plugin.app.toast('⚠️ Background processing encountered an error. Some cards may not be cached.');
  }
}

// OPTIMIZED CACHE BUILDER - Uses pre-tagged priorities for fast loading
// in index.tsx

async function onActivate(plugin: ReactRNPlugin) {
  //Debug
  console.log('🚀 INCREMENTAL EVERYTHING onActivate CALLED');
  console.log('Plugin type:', typeof plugin);
  console.log('Plugin methods:', Object.keys(plugin));
  console.log('Plugin.app methods:', Object.keys(plugin.app));
  console.log('Plugin.storage methods:', Object.keys(plugin.storage));

  // Store plugin reference globally for helper functions
  (window as any).__plugin = plugin;

  // Define console helper function (works only within plugin's iframe context)
  // For easier access, use the "Jump to Rem by ID" plugin command instead (Ctrl+P)
  const jumpToRemByIdFunction = async function(remId: string) {
    if (!remId || typeof remId !== 'string' || remId.trim() === '') {
      console.error('❌ Invalid RemId provided');
      console.log('Usage: jumpToRemById(\'your-rem-id-here\')');
      console.log('Example: jumpToRemById(\'abc123xyz\')');
      return;
    }
    
    try {
      const plugin = (window as any).__plugin;
      if (!plugin) {
        console.error('❌ Plugin not found. Make sure the Incremental Everything plugin is loaded.');
        console.log('Try reloading the plugin from RemNote Settings → Plugins');
        return;
      }
      
      console.log(`🔍 Searching for rem: ${remId}...`);
      const rem = await plugin.rem.findOne(remId.trim());
      
      if (!rem) {
        console.error(`❌ Rem not found: ${remId}`);
        console.log('💡 Possible reasons:');
        console.log('   • The rem was deleted');
        console.log('   • The RemId is incorrect');
        console.log('   • The rem is from a different knowledge base');
        return;
      }
      
      const remText = await rem.text;
      const textPreview = remText ? (typeof remText === 'string' ? remText : '[Complex content]') : '[No text]';
      const preview = textPreview.length > 100 ? textPreview.substring(0, 100) + '...' : textPreview;
      
      console.log(`✅ Found rem: "${preview}"`);
      console.log('📍 Opening rem in RemNote...');
      await plugin.window.openRem(rem);
      
    } catch (error) {
      console.error('❌ Error finding rem:', error);
      console.log('💡 Try reloading the plugin if this error persists.');
    }
  };

  // Attach to window object (works only in iframe context)
  (window as any).jumpToRemById = jumpToRemByIdFunction;

  // Log availability information
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💡 Jump to Rem by ID - Available Methods:');
  console.log('');
  console.log('   RECOMMENDED: Use plugin command');
  console.log('   • Press Ctrl+/ (or Cmd+/)');
  console.log('   • Type: "Jump to Rem by ID"');
  console.log('   • Enter your RemId');
  console.log('');
  console.log('   ADVANCED: Console function (iframe context only)');
  console.log('   • Only works if console context is set to plugin iframe');
  console.log('   • Usage: jumpToRemById(\'your-rem-id-here\')');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   Usage: jumpToRemById(\'your-rem-id-here\')');
  console.log('   Example: jumpToRemById(\'abc123xyz\')');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

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

  const COLLAPSE_TOP_BAR_CSS = `
    .spacedRepetitionContent { height: 100%; box-sizing: border-box; }
    .queue__title { max-height: 0; overflow: hidden; transition: max-height 0.3s ease; }
    .queue__title:hover { max-height: 999px; }
  `.trim();


  await registerPluginPowerups(plugin);
  await registerPluginSettings(plugin);

  registerQueueExitListener(plugin, () => {
    sessionItemCounter = 0;
  });

  registerQueueEnterListener(plugin, () => {
    sessionItemCounter = 0;
  });

  registerURLChangeListener(plugin);
  registerQueueCompleteCardListener(plugin);
  registerGlobalRemChangedListener(plugin);


  // Note: doesn't handle rem just tagged with incremental rem powerup because they don't have powerup slots yet
  // so added special handling in initIncrementalRem
  plugin.track(async (rp) => {
    console.log('TRACKER: Incremental Rem tracker starting...');
    const powerup = await rp.powerup.getPowerupByCode(powerupCode);
    const taggedRem = (await powerup?.taggedRem()) || [];
    console.log(`TRACKER: Found ${taggedRem.length} Incremental Rems. Starting batch processing...`);

    const updatedAllRem: IncrementalRem[] = [];
    // CHANGED: Reduced batch size and increased delay.
    const batchSize = 500;
    const delayBetweenBatches = 100; // milliseconds
    const numBatches = Math.ceil(taggedRem.length / batchSize);

    for (let i = 0; i < taggedRem.length; i += batchSize) {
      const batch = taggedRem.slice(i, i + batchSize);
      console.log(`TRACKER: Processing IncRem batch ${Math.floor(i / batchSize) + 1} of ${numBatches}...`);
      
      const batchInfos = (
        await Promise.all(batch.map((rem) => getIncrementalRemInfo(plugin, rem)))
      ).filter(Boolean) as IncrementalRem[];

      updatedAllRem.push(...batchInfos);
      
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
    }
    
    console.log(`TRACKER: Processing complete. Final IncRem cache size is ${updatedAllRem.length}.`);
    await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
    console.log('TRACKER: Incremental Rem cache has been saved.');
  });

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

 
  registerWidgets(plugin);

  await registerCommands(plugin, {
    cacheAllCardPriorities,
  });

  plugin.app.registerMenuItem({
    id: 'sorting_criteria_menuitem',
    location: PluginCommandMenuLocation.QueueMenu,
    name: 'Sorting Criteria',
    action: async () => {
      await plugin.widget.openPopup('sorting_criteria');
    },
  });

  plugin.app.registerMenuItem({
    id: priorityShieldHistoryMenuItemId,
    name: 'Priority Shield History',
    location: PluginCommandMenuLocation.QueueMenu,
    action: async () => {
      // Get the stored subQueueId from session
      const subQueueId = await plugin.storage.getSession<string | null>(currentSubQueueIdKey);
      console.log('Opening Priority Shield Graph with subQueueId:', subQueueId);
      
      await plugin.widget.openPopup('priority_shield_graph', {
        subQueueId: subQueueId
      });
    },
  });

  plugin.app.registerMenuItem({
    id: 'tag_rem_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Toggle tag as Incremental Rem',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        return;
      }
      const isIncremental = await rem.hasPowerup(powerupCode);
      if (isIncremental) {
        await rem.removePowerup(powerupCode);
      } else {
        await initIncrementalRem(plugin, rem);
      }
      const msg = isIncremental ? 'Untagged as Incremental Rem' : 'Tagged as Incremental Rem';
      await plugin.app.toast(msg);
    },
  });


  plugin.app.registerMenuItem({
    id: 'tag_highlight',
    location: PluginCommandMenuLocation.PDFHighlightPopupLocation,
    name: 'Toggle Incremental Rem',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) return;

      const isIncremental = await rem.hasPowerup(powerupCode);

      if (isIncremental) {
        await rem.removePowerup(powerupCode);
        await rem.setHighlightColor('Yellow'); // Reset to default
        await plugin.app.toast('❌ Removed Incremental tag');
      } else {
        await initIncrementalRem(plugin, rem);
        // Get the user-configured highlight color from settings
        const highlightColor = (await plugin.settings.getSetting(pdfHighlightColorId)) as 'Red' | 'Orange' | 'Yellow' | 'Green' | 'Blue' | 'Purple' || 'Blue';
        await rem.setHighlightColor(highlightColor);
        await plugin.app.toast('✅ Tagged as Incremental Rem');
        await plugin.widget.openPopup('priority', {
          remId: rem._id,
        });
      }
    },
  });

  plugin.app.registerMenuItem({
    id: 'batch_priority_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Batch Priority Change',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        return;
      }
      
      // Store the rem ID in session for the popup to access
      await plugin.storage.setSession('batchPriorityFocusedRem', args.remId);
      
      // Open the popup
      await plugin.widget.openPopup('batch_priority', {
        remId: args.remId,
      });
    },
  });

  // Add menu item for batch card priority assignment
  plugin.app.registerMenuItem({
    id: 'batch_card_priority_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Batch Assign Card Priority for tagged Rems',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        await plugin.app.toast('Could not find the rem');
        return;
      }
      
      // Check if this rem is actually being used as a tag
      const taggedRems = await rem.taggedRem();
      if (!taggedRems || taggedRems.length === 0) {
        await plugin.app.toast('This rem is not used as a tag. No rems are tagged with it.');
        return;
      }
      
      // Store the tag rem ID in session storage for the widget to access
      await plugin.storage.setSession('batchCardPriorityTagRem', rem._id);
      
      // Open the batch card priority widget
      await plugin.widget.openPopup('batch_card_priority');
    },
  });
  // Update the menu item registration to use synced storage
  plugin.app.registerMenuItem({
    id: noIncRemMenuItemId,
    name: 'No Inc Rem for 15 min',
    location: PluginCommandMenuLocation.QueueMenu,
    action: async () => {
      // Check if timer is already active
      const currentTimer = await plugin.storage.getSynced<number>(noIncRemTimerKey);
      if (currentTimer && currentTimer > Date.now()) {
        const remainingMinutes = Math.ceil((currentTimer - Date.now()) / 60000);
        await plugin.app.toast(`Timer already active: ${remainingMinutes} minutes remaining`);
        return;
      }
      
      // Set timer for 15 minutes from now using SYNCED storage
      const endTime = Date.now() + (15 * 60 * 1000);
      await plugin.storage.setSynced(noIncRemTimerKey, endTime);
      
      await plugin.app.toast('Incremental rems disabled for 15 minutes. Only flashcards will be shown.');
      
      // Force queue refresh
      await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
    },
  });

  // Add menu item for quick access
  plugin.app.registerMenuItem({
    id: 'create_priority_review_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Create Priority Review Document',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) return;
      
      const remName = await safeRemTextToString(plugin, rem.text);
      
      await plugin.storage.setSession('reviewDocContext', {
        scopeRemId: rem._id,
        scopeName: remName
      });
      
      await plugin.widget.openPopup('review_document_creator');
    },
  });

  // Also add to Queue Menu for easy access while in queue
  plugin.app.registerMenuItem({
    id: 'create_priority_review_queue_menuitem',
    location: PluginCommandMenuLocation.QueueMenu,
    name: 'Create Priority Review Document',
    action: async () => {
      // When called from queue menu, use current queue scope if available
      const subQueueId = await plugin.storage.getSession<string>(currentSubQueueIdKey);
      
      if (subQueueId) {
        const rem = await plugin.rem.findOne(subQueueId);
        const remName = rem ? await safeRemTextToString(plugin, rem.text) : 'Queue Scope';
        
        await plugin.storage.setSession('reviewDocContext', {
          scopeRemId: subQueueId,
          scopeName: remName
        });
      } else {
        await plugin.storage.setSession('reviewDocContext', {
          scopeRemId: null,
          scopeName: 'Full KB'
        });
      }
      
      await plugin.widget.openPopup('review_document_creator');
    },
  });

  // Mobile and Web Browser Light Mode Features
  await handleMobileDetectionOnStartup(plugin);
  console.log('Mobile detection completed');




  // Run the cache build in the background without blocking plugin initialization.

  // Get the performance mode
  const useLightMode = await shouldUseLightMode(plugin);
  if (!useLightMode) {
    // Run the full, expensive cache build
    cacheAllCardPriorities(plugin);
  } else {
    // In 'light' mode, just set an empty cache.
    console.log('CACHE: Light mode enabled. Skipping card priority cache build.');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
  }

  
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
