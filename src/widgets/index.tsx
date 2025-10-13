import {
  AppEvents,
  declareIndexPlugin,
  PluginCommandMenuLocation,
  PropertyLocation,
  PropertyType,
  QueueItemType,
  ReactRNPlugin,
  Rem,
  RemId,
  RNPlugin,
  SelectionType,
  SpecialPluginCallback,
  StorageEvents,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import {
  allIncrementalRemKey,
  initialIntervalId,
  multiplierId,
  nextRepDateSlotCode,
  powerupCode,
  prioritySlotCode,
  repHistorySlotCode,
  collapseQueueTopBar,
  scrollToHighlightId,
  collapseTopBarId,
  queueCounterId,
  hideIncEverythingId,
  nextRepCommandId,
  shouldHideIncEverythingKey,
  collapseTopBarKey,
  queueLayoutFixId,
  incrementalQueueActiveKey,
  activeHighlightIdKey,
  currentScopeRemIdsKey,
  defaultPriorityId,
  seenRemInSessionKey,
  displayPriorityShieldId,
  priorityShieldHistoryKey,
  priorityShieldHistoryMenuItemId,
  documentPriorityShieldHistoryKey,
  currentSubQueueIdKey,
  seenCardInSessionKey,
  cardPriorityShieldHistoryKey,
  documentCardPriorityShieldHistoryKey,
  allCardPriorityInfoKey,
  remnoteEnvironmentId,
  pageRangeWidgetId,
  noIncRemTimerKey,
  noIncRemMenuItemId,
  noIncRemTimerWidgetId,
  currentIncRemKey,
  queueSessionCacheKey,
} from '../lib/consts';
import * as _ from 'remeda';
import { getSortingRandomness, getCardsPerRem } from '../lib/sorting';
import { IncrementalRem } from '../lib/types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getIncrementalRemInfo, handleHextRepetitionClick } from '../lib/incremental_rem';
import { calculateRelativePriority } from '../lib/priority';
import { getDailyDocReferenceForDate } from '../lib/date';
import { getCurrentIncrementalRem, setCurrentIncrementalRem } from '../lib/currentRem';
import { getInitialPriority } from '../lib/priority_inheritance';
import { findPDFinRem, safeRemTextToString } from '../lib/pdfUtils';
import { 
  autoAssignCardPriority, 
  getCardPriority, 
  getDueCardsWithPriorities, 
  CardPriorityInfo,
  setCardPriority,
  calculateRelativeCardPriority,
  QueueSessionCache
} from '../lib/cardPriority';
import { updateCardPriorityInCache, flushCacheUpdatesNow } from '../lib/cache';
dayjs.extend(relativeTime);

// CLEANUP FUNCTION - Removes all CardPriority tags and data
async function removeAllCardPriorityTags(plugin: RNPlugin) {
  const confirmed = confirm(
    "⚠️ Remove All CardPriority Data\n\n" +
    "This will permanently remove ALL cardPriority tags and their data from your entire knowledge base.\n\n" +
    "This action cannot be undone.\n\n" +
    "Are you sure you want to proceed?"
  );
  
  if (!confirmed) {
    console.log("CardPriority cleanup cancelled by user");
    await plugin.app.toast("CardPriority cleanup cancelled");
    return;
  }
  
  console.log("Starting CardPriority cleanup...");
  await plugin.app.toast("Starting CardPriority cleanup...");
  
  try {
    // --- THIS IS THE CORRECTED LOGIC ---
    // 1. Get the powerup object by its code.
    const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
    
    // 2. Then, get all Rems tagged with that powerup.
    const taggedRems = (await cardPriorityPowerup?.taggedRem()) || [];
    // ------------------------------------

    if (taggedRems.length === 0) {
      await plugin.app.toast("No CardPriority tags found to remove");
      console.log("No CardPriority tags found");
      return;
    }
    
    let removed = 0;
    const total = taggedRems.length;
    const batchSize = 50;
    
    console.log(`Found ${total} rems with CardPriority tags. Starting removal...`);
    await plugin.app.toast(`Found ${total} CardPriority tags to remove...`);
    
    for (let i = 0; i < taggedRems.length; i += batchSize) {
      const batch = taggedRems.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (rem) => {
        try {
          // First, explicitly clear each slot value (defensive programming)
          await rem.setPowerupProperty('cardPriority', 'priority', []);
          await rem.setPowerupProperty('cardPriority', 'prioritySource', []);
          await rem.setPowerupProperty('cardPriority', 'lastUpdated', []);
        } catch (e) {
          // Slots might not exist on some rems, that's ok
          console.log(`Warning: Could not clear slots for rem ${rem._id}:`, e);
        }
        
        // Then remove the powerup entirely
        await rem.removePowerup('cardPriority');
      }));
      
      removed += batch.length;
      
      // Show progress every 10% or at milestones
      const progress = Math.round((removed / total) * 100);
      if (progress % 10 === 0 || removed === total) {
        await plugin.app.toast(`Cleanup progress: ${progress}% (${removed}/${total})`);
        console.log(`Cleanup progress: ${progress}% (${removed}/${total})`);
      }
    }
    
    // Clear all related session storage
    console.log("Clearing session storage...");
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
    await plugin.storage.setSession(seenCardInSessionKey, []);
    
    // Clear all related synced storage
    console.log("Clearing synced storage...");
    await plugin.storage.setSynced(cardPriorityShieldHistoryKey, {});
    await plugin.storage.setSynced(documentCardPriorityShieldHistoryKey, {});
    
    // Success message
    await plugin.app.toast(`✅ Cleanup complete! Removed ${removed} CardPriority tags.`);
    console.log(`CardPriority cleanup finished. Successfully removed ${removed} tags from knowledge base.`);
    
    // Optional: Suggest page refresh for clean state
    const shouldRefresh = confirm(
      "Cleanup successful!\n\n" +
      "Would you like to refresh the page to ensure a clean state?"
    );
    
    if (shouldRefresh) {
      window.location.reload();
    }
    
  } catch (error) {
    console.error("Error during CardPriority cleanup:", error);
    await plugin.app.toast("❌ Error during cleanup. Check console for details.");
    alert(
      "An error occurred during cleanup.\n\n" +
      "Some tags may not have been removed.\n" +
      "Please check the console for details."
    );
  }
}

// PRE-TAGGING FUNCTION - Pre-compute and tag all card priorities
async function precomputeAllCardPriorities(plugin: RNPlugin) {
  const confirmed = confirm(
    "📊 Pre-compute All Card Priorities\n\n" +
    "This will analyze all flashcards in your knowledge base and pre-compute their priorities based on inheritance from their ancestors priorities.\n\n" +
    "Your manually set card priorities will not be affected.\n\n" +
    "This is a one-time optimization that will significantly speed up future plugin startups.\n\n" +
    "This may take several minutes for large collections. Continue?"
  );
  
  if (!confirmed) {
    console.log("Pre-computation cancelled by user");
    await plugin.app.toast("Pre-computation cancelled");
    return;
  }
  
  console.log("Starting card priority pre-computation...");
  await plugin.app.toast("Starting card priority pre-computation. This may take a few minutes...");
  
  try {
    const startTime = Date.now();
    
    // Get all cards in the knowledge base
    const allCards = await plugin.card.getAll();
    const uniqueRemIds = _.uniq(allCards.map(c => c.remId));
    
    if (uniqueRemIds.length === 0) {
      await plugin.app.toast("No flashcards found in knowledge base");
      return;
    }
    
    console.log(`Found ${uniqueRemIds.length} rems with flashcards to process`);
    await plugin.app.toast(`Found ${uniqueRemIds.length} rems with flashcards. Processing...`);
    
    let processed = 0;
    let tagged = 0;
    let skippedManual = 0;
    let errors = 0;
    
    const batchSize = 50; // Process in batches to avoid overwhelming the system
    
    for (let i = 0; i < uniqueRemIds.length; i += batchSize) {
      const batch = uniqueRemIds.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (remId) => {
        try {
          const rem = await plugin.rem.findOne(remId);
          if (!rem) {
            errors++;
            return;
          }
          
          // Check if rem already has cardPriority powerup
          const existingPriority = await getCardPriority(plugin, rem);
          
          if (existingPriority && existingPriority.source === 'manual') {
            // Don't override manual priorities
            skippedManual++;
            processed++;
            return;
          }
          
          // Use autoAssignCardPriority which handles all the logic:
          // - Checks for incremental rem
          // - Searches ancestors using findClosestAncestorWithPriority
          // - Sets default if needed
          // - Saves the priority with appropriate source
          await autoAssignCardPriority(plugin, rem);
          tagged++;
          processed++;
          
        } catch (error) {
          console.error(`Error processing rem ${remId}:`, error);
          errors++;
        }
      }));
      
      // Show progress every 10% or at milestones
      const progress = Math.round((processed / uniqueRemIds.length) * 100);
      if (progress % 10 === 0 || processed === uniqueRemIds.length) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        await plugin.app.toast(
          `Progress: ${progress}% (${processed}/${uniqueRemIds.length}) - ${elapsed}s elapsed`
        );
        console.log(
          `Progress: ${processed}/${uniqueRemIds.length} (${progress}%) - ` +
          `Tagged: ${tagged}, Skipped manual: ${skippedManual}, Errors: ${errors}`
        );
      }
      
      // Small delay between batches to keep UI responsive
      if (i + batchSize < uniqueRemIds.length) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    
    // Build new cache immediately after tagging
    console.log("Building optimized cache from tagged priorities...");
    await plugin.app.toast("Building optimized cache...");
    
    const cacheStartTime = Date.now();
    await buildOptimizedCache(plugin);
    const cacheTime = Math.round((Date.now() - cacheStartTime) / 1000);
    
    // Final report
    const message = 
      `✅ Pre-computation complete!\n\n` +
      `• Total rems processed: ${processed}\n` +
      `• Newly tagged: ${tagged}\n` +
      `• Preserved manual priorities: ${skippedManual}\n` +
      `• Errors: ${errors}\n` +
      `• Total time: ${totalTime}s\n` +
      `• Cache build time: ${cacheTime}s\n\n` +
      `Future startups will be much faster!`;
    
    console.log(message);
    await plugin.app.toast("✅ Pre-computation complete! See console for details.");
    alert(message);
    
  } catch (error) {
    console.error("Error during pre-computation:", error);
    await plugin.app.toast("❌ Error during pre-computation. Check console for details.");
    alert(
      "An error occurred during pre-computation.\n\n" +
      "Please check the console for details:\n" +
      error
    );
  }
}

// CARD PRIORITIES CACHING FUNCTION - With deferred loading for untagged cards
async function cacheAllCardPriorities(plugin: RNPlugin) {
  console.log('CACHE: Starting intelligent cache build with deferred loading...');
  
  const startTime = Date.now();
  
  const allCards = await plugin.card.getAll();
  if (!allCards || allCards.length === 0) {
    console.log('CACHE: No cards found. Setting empty cache.');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
    return;
  }
  
  const uniqueRemIds = _.uniq(allCards.map(c => c.remId));
  console.log(`CACHE: Found ${uniqueRemIds.length} rems with cards`);
  
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

async function buildOptimizedCache(plugin: RNPlugin) {
  console.log('CACHE: Building optimized cache from pre-tagged priorities...');

  const allCards = await plugin.card.getAll();
  if (!allCards || allCards.length === 0) {
    console.log('CACHE: No cards found. Setting empty cache.');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
    return;
  }

  const uniqueRemIds = _.uniq(allCards.map(c => c.remId));
  const cardPriorityInfos: CardPriorityInfo[] = [];
  const batchSize = 100;

  for (let i = 0; i < uniqueRemIds.length; i += batchSize) {
    const batch = uniqueRemIds.slice(i, i + batchSize);

    const batchResults = await Promise.all(batch.map(async (remId) => {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) return null;

      // This is fast because it's just reading the powerup property
      const cardInfo = await getCardPriority(plugin, rem);
      return cardInfo;
    }));

    cardPriorityInfos.push(...(batchResults.filter(info => info !== null) as CardPriorityInfo[]));

    // Log progress for large collections
    if (i % 1000 === 0) {
      console.log(`CACHE: Processed ${i}/${uniqueRemIds.length} rems...`);
    }
  }

  // --- NEW PERCENTILE CALCULATION LOGIC ---
  console.log(`CACHE: Found ${cardPriorityInfos.length} raw entries. Calculating percentiles...`);

  // 1. Sort the entire list by priority just once.
  const sortedInfos = _.sortBy(cardPriorityInfos, (info) => info.priority);

  // 2. Map over the sorted list to calculate and add the percentile to each object.
  const totalItems = sortedInfos.length;
  const enrichedInfos = sortedInfos.map((info, index) => {
    // Handle the case of an empty list to avoid division by zero.
    const percentile = totalItems > 0 ? Math.round(((index + 1) / totalItems) * 100) : 0;
    return {
      ...info,
      kbPercentile: percentile,
    };
  });
  // --- END NEW LOGIC ---

  console.log(`CACHE: Successfully built and enriched cache with ${enrichedInfos.length} entries.`);
  // Save the new, enriched data to the session
  await plugin.storage.setSession(allCardPriorityInfoKey, enrichedInfos);
}


async function onActivate(plugin: ReactRNPlugin) {
  //Debug
  console.log('🚀 INCREMENTAL EVERYTHING onActivate CALLED');
  console.log('Plugin type:', typeof plugin);
  console.log('Plugin methods:', Object.keys(plugin));
  console.log('Plugin.app methods:', Object.keys(plugin.app));
  console.log('Plugin.storage methods:', Object.keys(plugin.storage));

  let sessionItemCounter = 0;

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


  // New, corrected registerPowerup format with a single object (since plugin-sdk@0.0.39)
  // `slots` is nested inside `options`
  await plugin.app.registerPowerup({
    name: 'Incremental',
    code: powerupCode,
    description: 'Incremental Everything Powerup',
    options: {
      slots: [
        {
          code: prioritySlotCode,
          name: 'Priority',
          propertyType: PropertyType.NUMBER,
          propertyLocation: PropertyLocation.BELOW,
        },
        {
          code: nextRepDateSlotCode,
          name: 'Next Rep Date',
          propertyType: PropertyType.DATE,
          propertyLocation: PropertyLocation.BELOW,
        },
        {
          code: repHistorySlotCode,
          name: 'History',
          hidden: true,
        },
      ],
    },
  });

  // Create Separate Flashcard Priority Powerup

  await plugin.app.registerPowerup({
    name: 'CardPriority',
    code: 'cardPriority',
    description: 'Priority system for flashcards',
    options: {
      slots: [
        {
          code: 'priority',
          name: 'Priority',
          propertyType: PropertyType.NUMBER,
          propertyLocation: PropertyLocation.BELOW,
        },
        {
          code: 'prioritySource',
          name: 'Priority Source',
          propertyType: PropertyType.TEXT,
          propertyLocation: PropertyLocation.BELOW,
        },
        {
          code: 'lastUpdated',
          name: 'Last Updated',
          propertyType: PropertyType.NUMBER,  // Timestamp
          hidden: true,
        }
      ],
    },
  });

  plugin.settings.registerNumberSetting({
    id: initialIntervalId,
    title: 'Initial Interval',
    description: 'Sets the number of days until the first repetition.',
    defaultValue: 1,
  });

  plugin.settings.registerNumberSetting({
    id: multiplierId,
    title: 'Multiplier',
    description:
      'Sets the multiplier to calculate the next interval. Multiplier * previous interval = next interval.',
    defaultValue: 1.5,
  });

  plugin.settings.registerBooleanSetting({
    id: collapseQueueTopBar,
    title: 'Collapse Queue Top Bar',
    description:
      'Create extra space by collapsing the top bar in the queue. You can hover over the collapsed bar to open it.',
    defaultValue: true,
  });
  
  // Register the new setting as a number input, as sliders are not supported.
  plugin.settings.registerNumberSetting({
    id: defaultPriorityId,
    title: 'Default Priority',
    description: 'Sets the default priority for new incremental rem (0-100, Lower = more important). Default: 10',
    defaultValue: 10,
    // Use validators to enforce the range and type.
    validators: [
      {
        type: "int" as const // Ensures the input is a whole number
      },
      {
        type: "gte" as const, // "Greater than or equal to"
        arg: 0,
      },
      {
        type: "lte" as const, // "Less than or equal to"
        arg: 100,
      },
    ]
  });

  plugin.settings.registerNumberSetting({
    id: 'defaultCardPriority',
    title: 'Default Card Priority',
    description: 'Default priority for flashcards without inherited priority (0-100, Lower = more important).  Default: 50',
    defaultValue: 50,
    validators: [
      { type: "int" as const },
      { type: "gte" as const, arg: 0 },
      { type: "lte" as const, arg: 100 },
    ]
  });

  plugin.settings.registerBooleanSetting({
    id: displayPriorityShieldId,
    title: 'Display Priority Shield in Queue',
    description: 'If enabled, shows a real-time status of your highest-priority due items in the queue top bar.',
    defaultValue: true,
  });

  plugin.settings.registerDropdownSetting({
    id: remnoteEnvironmentId,
    title: 'RemNote Environment',
    description: 'Choose which RemNote environment to open documents in (beta.remnote.com or www.remnote.com)',
    defaultValue: 'www',
    options: [
      { 
        key: 'beta', 
        label: 'Beta (beta.remnote.com)',
        value: 'beta'
      },
      { 
        key: 'www', 
        label: 'Regular (www.remnote.com)',
        value: 'www'
      }
    ]
  });


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

  // TODO: some handling to include extracts created in current queue in the queue?
  // or unnecessary due to init interval? could append to this list

  plugin.event.addListener(AppEvents.QueueExit, undefined, async ({ subQueueId }) => {
    // Flush any pending cache updates immediately
    await flushCacheUpdatesNow(plugin);
    console.log('QueueExit triggered, subQueueId:', subQueueId);
    
    // IMPORTANT: Get the scope BEFORE clearing it
    const docScopeRemIds = await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey);
    console.log('Document scope RemIds at exit:', docScopeRemIds);
    
    const allRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];

    if (allRems.length > 0) {
      const today = dayjs().format('YYYY-MM-DD');
      
      // Save KB-level priority shield
      const unreviewedDueRems = allRems.filter(
        (rem) => Date.now() >= rem.nextRepDate
      );

      let kbFinalStatus = {
        absolute: null as number | null,
        percentile: 100,
      };

      if (unreviewedDueRems.length > 0) {
        const topMissedInKb = _.minBy(unreviewedDueRems, (rem) => rem.priority);
        if (topMissedInKb) {
          kbFinalStatus.absolute = topMissedInKb.priority;
          kbFinalStatus.percentile = calculateRelativePriority(allRems, topMissedInKb.remId);
        }
      }
      
      // Save KB history
      const kbHistory = (await plugin.storage.getSynced(priorityShieldHistoryKey)) || {};
      kbHistory[today] = kbFinalStatus;
      await plugin.storage.setSynced(priorityShieldHistoryKey, kbHistory);
      console.log('Saved KB history:', kbFinalStatus);
      
      // Save Document-level priority shield if we have scope data
      // Note: We check docScopeRemIds (which we got BEFORE clearing) instead of subQueueId
      if (docScopeRemIds && docScopeRemIds.length > 0) {
        console.log('Processing document-level shield with', docScopeRemIds.length, 'scoped rems');
        
        const scopedRems = allRems.filter((rem) => docScopeRemIds.includes(rem.remId));
        console.log('Found', scopedRems.length, 'incremental rems in document scope');
        
        const unreviewedDueInScope = scopedRems.filter(
          (rem) => Date.now() >= rem.nextRepDate
        );
        console.log('Found', unreviewedDueInScope.length, 'due rems in document scope');
        
        let docFinalStatus = {
          absolute: null as number | null,
          percentile: 100,
        };
        
        if (unreviewedDueInScope.length > 0) {
          const topMissedInDoc = _.minBy(unreviewedDueInScope, (rem) => rem.priority);
          if (topMissedInDoc) {
            docFinalStatus.absolute = topMissedInDoc.priority;
            docFinalStatus.percentile = calculateRelativePriority(scopedRems, topMissedInDoc.remId);
          }
        }
        
        // Get the stored subQueueId since the parameter might not always be passed
        const storedSubQueueId = subQueueId || await plugin.storage.getSession<string>(currentSubQueueIdKey);
        
        if (storedSubQueueId) {
          // Save document history with subQueueId as key
          const docHistory = (await plugin.storage.getSynced(documentPriorityShieldHistoryKey)) || {};
          if (!docHistory[storedSubQueueId]) {
            docHistory[storedSubQueueId] = {};
          }
          docHistory[storedSubQueueId][today] = docFinalStatus;
          await plugin.storage.setSynced(documentPriorityShieldHistoryKey, docHistory);
          console.log('Saved document history for', storedSubQueueId, ':', docFinalStatus);
        } else {
          console.log('Warning: No subQueueId available for saving document history');
        }
      } else {
        console.log('No document scope RemIds found or empty - skipping document history save');
      }
    }

    // --- NEW: Card Priority Shield Logic ---
    const allCardInfos = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey);

    if (allCardInfos && allCardInfos.length > 0) {
        const today = dayjs().format('YYYY-MM-DD');
        const subQueueIdForExit = subQueueId || await plugin.storage.getSession<string>(currentSubQueueIdKey);
        const seenCardIds = (await plugin.storage.getSession<string[]>(seenCardInSessionKey)) || [];

        // --- Calculate final KB card shield from the cache ---
        const unreviewedDueKb = allCardInfos.filter(c => c.dueCards > 0 && !seenCardIds.includes(c.remId));
        let kbCardFinalStatus = { absolute: null as number | null, percentile: 100 };
        if (unreviewedDueKb.length > 0) {
            const topMissed = _.minBy(unreviewedDueKb, c => c.priority);
            if (topMissed) {
                kbCardFinalStatus.absolute = topMissed.priority;
                kbCardFinalStatus.percentile = calculateRelativeCardPriority(allCardInfos, topMissed.remId);
            }
        }
        const cardKbHistory = (await plugin.storage.getSynced(cardPriorityShieldHistoryKey)) || {};
        cardKbHistory[today] = kbCardFinalStatus;
        await plugin.storage.setSynced(cardPriorityShieldHistoryKey, cardKbHistory);

        // --- Calculate final Doc card shield from the cache ---
        if (subQueueIdForExit) {
            const scopeRem = await plugin.rem.findOne(subQueueIdForExit);
            if (scopeRem) {
                const scopeDescendants = await scopeRem.getDescendants();
                const scopeIds = new Set([scopeRem._id, ...scopeDescendants.map(d => d._id)]);
                const docCardInfos = allCardInfos.filter(ci => scopeIds.has(ci.remId));

                const unreviewedDueDoc = docCardInfos.filter(c => c.dueCards > 0 && !seenCardIds.includes(c.remId));
                let docCardFinalStatus = { absolute: null as number | null, percentile: 100 };

                if (unreviewedDueDoc.length > 0) {
                    const topMissed = _.minBy(unreviewedDueDoc, c => c.priority);
                    if (topMissed) {
                        docCardFinalStatus.absolute = topMissed.priority;
                        docCardFinalStatus.percentile = calculateRelativeCardPriority(docCardInfos, topMissed.remId);
                    }
                }
                const docCardHistory = (await plugin.storage.getSynced(documentCardPriorityShieldHistoryKey)) || {};
                if (!docCardHistory[subQueueIdForExit]) {
                    docCardHistory[subQueueIdForExit] = {};
                }
                docCardHistory[subQueueIdForExit][today] = docCardFinalStatus;
                await plugin.storage.setSynced(documentCardPriorityShieldHistoryKey, docCardHistory);
            }
        }
    }

    // Reset session-specific state AFTER we've used the data
    await plugin.storage.setSession(seenRemInSessionKey, []);
    await plugin.storage.setSession(seenCardInSessionKey, []);
    sessionItemCounter = 0;
    await plugin.storage.setSession(currentScopeRemIdsKey, null);
    await plugin.storage.setSession(currentSubQueueIdKey, null);
    await plugin.storage.setSession(queueSessionCacheKey, null);
    console.log('Session state reset complete');
  });

  plugin.event.addListener(AppEvents.QueueEnter, undefined, async ({ subQueueId }) => {
    console.log('QUEUE ENTER: Starting session pre-calculation for subQueueId:', subQueueId);

    // 1. Reset all session-specific state for a clean start.
    await plugin.storage.setSession(seenRemInSessionKey, []);
    await plugin.storage.setSession(seenCardInSessionKey, []);
    sessionItemCounter = 0;
    await plugin.storage.setSession(currentScopeRemIdsKey, null); // Still useful for other parts of the plugin
    await plugin.storage.setSession(currentSubQueueIdKey, subQueueId || null);

    // 2. Get the main card priority cache, which is our source of all data.
    const allCardInfos = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey);

    if (!allCardInfos || allCardInfos.length === 0) {
      console.log('QUEUE ENTER: Main cache is empty, skipping pre-calculation.');
      return;
    }

    // 3. Pre-calculate the list of all due cards in the entire KB.
    const dueCardsInKB = allCardInfos.filter(info => info.dueCards > 0);

    // 4. Initialize variables for the document-specific cache.
    let docPercentiles: Record<RemId, number> = {};
    let dueCardsInScope: CardPriorityInfo[] = [];

    // 5. If we are in a document queue (subQueueId is not null), perform the heavy calculations.
    if (subQueueId) {
      console.log('QUEUE ENTER: Document queue detected. Starting document-scope calculations...');
      // This is the one-time, slow operation to get all Rem IDs in the document.
      const scopeRem = await plugin.rem.findOne(subQueueId);
      if (scopeRem) {
        const docDescendants = await scopeRem.getDescendants();
        const docScopeRemIds = new Set([scopeRem._id, ...docDescendants.map(r => r._id)]);
        
        // Save the scope for other parts of the plugin that might need it.
        await plugin.storage.setSession(currentScopeRemIdsKey, Array.from(docScopeRemIds));

        // a) Pre-calculate the list of due cards within this specific document.
        dueCardsInScope = dueCardsInKB.filter(info => docScopeRemIds.has(info.remId));

        // b) Pre-calculate the relative document percentile for every card in the scope.
        const docCardInfos = allCardInfos.filter(info => docScopeRemIds.has(info.remId));
        const sortedDocCards = _.sortBy(docCardInfos, (info) => info.priority);
        const totalDocCards = sortedDocCards.length;
        
        sortedDocCards.forEach((info, index) => {
          const percentile = totalDocCards > 0 ? Math.round(((index + 1) / totalDocCards) * 100) : 0;
          docPercentiles[info.remId] = percentile;
        });
        
        console.log(`QUEUE ENTER: Finished document-scope calculations. Found ${dueCardsInScope.length} due cards and calculated ${Object.keys(docPercentiles).length} percentiles.`);
      }
    }

    // 6. Assemble the complete session cache object.
    const sessionCache: QueueSessionCache = {
      docPercentiles,
      dueCardsInScope,
      dueCardsInKB,
    };

    // 7. Save the newly created session cache.
    await plugin.storage.setSession(queueSessionCacheKey, sessionCache);
    console.log('QUEUE ENTER: Pre-calculation complete. Session cache has been saved.');
  });

  const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
    powerupCode,
    nextRepDateSlotCode
  );

  plugin.app.registerCommand({
    id: nextRepCommandId,
    name: 'Next Repetition',
    action: async () => {
      const rem = await getCurrentIncrementalRem(plugin);
      const url = await plugin.window.getURL();
      debugger;
      if (!rem || !url.includes('/flashcards')) {
        return;
      }
      const incRem = await getIncrementalRemInfo(plugin, rem);
      await handleHextRepetitionClick(plugin, incRem);
    },
  });

  const unregisterQueueCSS = async (plugin: RNPlugin) => {
    await plugin.app.registerCSS(collapseTopBarId, '');
  };

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

      // --- REFACTORED LOGIC START ---
      // Read the scope directly from session storage, making it the single source of truth.
      let docScopeRemIds = await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey);

      // If we are in a document queue but the scope hasn't been calculated yet for this session (it's null)...
      if (queueInfo.subQueueId && docScopeRemIds === null) {
        const subQueueRem = await plugin.rem.findOne(queueInfo.subQueueId);
        // Special handling for studying a daily doc.
        const referencedRemIds = _.compact(
          ((await subQueueRem?.remsReferencingThis()) || []).map((rem) => {
            if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
              return rem.parent;
            } else {
              return rem._id;
            }
          })
        );
        
        // Calculate the new scope.
        const newScope = ((await subQueueRem?.allRemInFolderQueue()) || [])
          .map((x) => x._id)
          .concat(((await subQueueRem?.getSources()) || []).map((x) => x._id))
          .concat(referencedRemIds)
          .concat(queueInfo.subQueueId);
        
        // Update our variable for this run AND save to storage for other parts of the plugin.
        docScopeRemIds = newScope;
        await plugin.storage.setSession(currentScopeRemIdsKey, docScopeRemIds);
      }
      // --- REFACTORED LOGIC END ---

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
        subQueueId: queueInfo.subQueueId
      });

      plugin.app.registerCSS(
        queueCounterId,
        `
        .rn-queue__card-counter {
          /*visibility: hidden;*/
        }

        .light .rn-queue__card-counter:after {
          content: ' + ${filtered.length}';
          /* visibility: visible;
          background-color: #f0f0f0;
          display: inline-block;
          padding: 0.5rem 1rem;
          font-size: 0.875rem;
          border-radius: 0.25rem; */
        }

        .dark .rn-queue__card-counter:after {
          content: ' + ${filtered.length}';
          /* visibility: visible;
          background-color: #34343c;
          font-color: #d4d4d0;
          display: inline-block;
          padding: 0.5rem 1rem;
          font-size: 0.875rem;
          border-radius: 0.25rem; */
        }`.trim()
              );

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

  async function initIncrementalRem(rem: Rem) {
    // First, check if the Rem has already been initialized.
    const isAlreadyIncremental = await rem.hasPowerup(powerupCode);

    // Only set the default values if it's a new incremental Rem.
    if (!isAlreadyIncremental) {
      const initialInterval = (await plugin.settings.getSetting<number>(initialIntervalId)) || 0;
      
      // Get the default priority from settings
      const defaultPrioritySetting = (await plugin.settings.getSetting<number>(defaultPriorityId)) || 10;
      const defaultPriority = Math.min(100, Math.max(0, defaultPrioritySetting));
      
      // Try to inherit priority from closest incremental ancestor
      const initialPriority = await getInitialPriority(plugin, rem, defaultPriority);

      await rem.addPowerup(powerupCode);

      const nextRepDate = new Date(Date.now() + (initialInterval * 24 * 60 * 60 * 1000));
      const dateRef = await getDailyDocReferenceForDate(plugin, nextRepDate);
      if (!dateRef) {
        return;
      }

      await rem.setPowerupProperty(powerupCode, nextRepDateSlotCode, dateRef);
      await rem.setPowerupProperty(powerupCode, prioritySlotCode, [initialPriority.toString()]);

      // Initialize the history property to prevent validation errors.
      await rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify([])]);


      const newIncRem = await getIncrementalRemInfo(plugin, rem);
      if (!newIncRem) {
        return;
      }

      const allIncrementalRem: IncrementalRem[] =
        (await plugin.storage.getSession(allIncrementalRemKey)) || [];
      const updatedAllRem = allIncrementalRem
        .filter((x) => x.remId !== newIncRem.remId)
        .concat(newIncRem);
      await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
    }
  } 

  // Priority widget registration to handle both IncRem and Cards
  plugin.app.registerWidget('priority', WidgetLocation.Popup, {
    dimensions: {
      width: '500px',
      height: 'auto',
    },
  });

  // Register the priority editor widget for the right side of editor

  // NEW LOG: Check if the registration code is being reached.
  console.log('Attempting to register priority_editor widget...');
  
  plugin.app.registerWidget('priority_editor', WidgetLocation.RightSideOfEditor, {
    dimensions: {
      height: 'auto',
      width: 'auto',
    },
  });

  // NEW LOG: Confirm that the registration call completed without error.
  console.log('SUCCESS: priority_editor widget registered.');

  plugin.app.registerWidget('batch_priority', WidgetLocation.Popup, {
    dimensions: {
      width: 1000,
      height: 950,
    },
  });

  plugin.app.registerWidget('reschedule', WidgetLocation.Popup, {
    dimensions: {
    width: '100%',
    height: 'auto',
    },
  });

  plugin.app.registerWidget(pageRangeWidgetId, WidgetLocation.Popup, {
    dimensions: {
      width: 600, 
      height: 900,
    },
  });

  const createExtract = async () => {
    const selection = await plugin.editor.getSelection();
    if (!selection) {
      return;
    }
    // TODO: extract within extract support
    if (selection.type === SelectionType.Text) {
      const focused = await plugin.focus.getFocusedRem();
      if (!focused) {
        return;
      }
      await initIncrementalRem(focused);
      return focused;
    } else if (selection.type === SelectionType.Rem) {
      const rems = (await plugin.rem.findMany(selection.remIds)) || [];
      await Promise.all(rems.map(initIncrementalRem));
    } else {
      const highlight = await plugin.reader.addHighlight();
      if (!highlight) {
        return;
      }
      await initIncrementalRem(highlight);
      return highlight;
    }
  };

  await plugin.app.registerCommand({
    id: 'extract-with-priority',
    name: 'Extract with Priority',
    keyboardShortcut: 'opt+shift+x',
    action: async () => {
      const rem = await createExtract();
      if (!rem) {
        return;
      }
      await plugin.widget.openPopup('priority', {
        remId: rem._id,
      });
    },
  });

  plugin.app.registerCommand({
    id: 'set-priority',
    name: 'Set Priority',
    keyboardShortcut: 'opt+p',
    action: async () => {
      console.log("--- Set Priority Command Triggered ---");
      let remId: string | undefined;
      const url = await plugin.window.getURL();
      console.log("Current URL:", url);

      // Check if we are in the queue
      if (url.includes('/flashcards')) {
        console.log("In flashcards view.");
        // First, try to get the current native flashcard. This works for regular cards.
        const card = await plugin.queue.getCurrentCard();
        console.log("Result of getCurrentCard():", card);

        if (card) {
          remId = card.remId;
          console.log("Found native card. remId:", remId);
        } else {
          console.log("Not a native card. Checking session storage for incremental rem...");
          // If it's not a native card, it's our plugin's queue view.
          // The source of truth is the remId stored in session by queue.tsx.
          remId = await plugin.storage.getSession(currentIncRemKey);
          console.log("remId from session storage (currentIncRemKey):", remId);
        }
      } else {
        console.log("Not in flashcards view. Getting focused editor rem.");
        // If not in the queue, get the focused Rem from the editor
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
        console.log("Focused editor remId:", remId);
      }

      console.log("Final remId to be used:", remId);

      if (!remId) {
        console.log("Set Priority: No focused Rem or card in queue found. Aborting.");
        await plugin.app.toast("Could not find a Rem to set priority for.");
        return;
      }
      
      console.log(`Opening 'priority' popup for remId: ${remId}`);
      await plugin.widget.openPopup('priority', {
        remId: remId,
      });
    },
  });

  plugin.app.registerCommand({
    id: 'batch-priority-change',
    name: 'Batch Priority Change',
    keyboardShortcut: 'opt+shift+p',
    action: async () => {
      const focusedRem = await plugin.focus.getFocusedRem();
      if (!focusedRem) {
        await plugin.app.toast('Please focus on a rem to perform batch priority changes');
        return;
      }
      
      // Store the focused rem ID in session for the popup to access
      await plugin.storage.setSession('batchPriorityFocusedRem', focusedRem._id);
      
      // Open the popup
      await plugin.widget.openPopup('batch_priority', {
        remId: focusedRem._id,
      });
    },
  });
    

  plugin.app.registerCommand({
    id: 'pdf-control-panel',
    name: 'PDF Control Panel',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }

      // 1. Find the associated PDF Rem within the focused Rem or its descendants
      const pdfRem = await findPDFinRem(plugin, rem);

      // 2. If no PDF is found, inform the user and stop.
      if (!pdfRem) {
        await plugin.app.toast('No PDF found in the focused Rem or its children.');
        return;
      }

      // 3. Ensure the focused Rem is an incremental Rem, initializing it if necessary.
      if (!(await rem.hasPowerup(powerupCode))) {
        await initIncrementalRem(rem);
      }

      // 4. Prepare the context for the popup widget, similar to how the Reader does it.
      //    This context tells the popup which incremental Rem and which PDF to work with.
      const context = {
        incrementalRemId: rem._id,
        pdfRemId: pdfRem._id,
        totalPages: undefined, // Not available in the editor context
        currentPage: undefined, // Not available in the editor context
      };

      // 5. Store the context in session storage so the popup can access it.
      await plugin.storage.setSession('pageRangeContext', context);

      // 6. Open the popup widget.
      await plugin.widget.openPopup(pageRangeWidgetId, {
        remId: rem._id, // Pass remId for consistency, though the widget relies on session context.
      });
    },
  });

  plugin.app.registerCommand({
    id: 'incremental-everything',
    keyboardShortcut: 'opt+x',
    name: 'Incremental Everything',
    action: async () => {
      createExtract();
    },
  });

  plugin.app.registerCommand({
    id: 'untag-incremental-everything',
    name: 'Untag Incremental Everything',
    action: async () => {
      const selection = await plugin.editor.getSelection();
      if (!selection) {
        return;
      }
      if (selection.type === SelectionType.Text) {
        const focused = await plugin.focus.getFocusedRem();
        if (!focused) {
          return;
        }
        await focused.removePowerup(powerupCode);
      } else if (selection.type === SelectionType.Rem) {
        const rems = (await plugin.rem.findMany(selection.remIds)) || [];
        await Promise.all(rems.map((r) => r.removePowerup(powerupCode)));
      }
    },
  });


  plugin.app.registerWidget('debug', WidgetLocation.Popup, {
    dimensions: {
      width: '350px',
      height: 'auto',
    },
  });

  plugin.app.registerCommand({
    id: 'debug-incremental-everything',
    name: 'Debug Incremental Everything',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }
      if (!(await rem.hasPowerup(powerupCode))) {
        return;
      }
      await plugin.widget.openPopup('debug', {
        remId: rem._id,
      });
    },
  });

  plugin.event.addListener(AppEvents.URLChange, undefined, async () => {
    const url = await plugin.window.getURL();
    if (!url.includes('/flashcards')) {
      plugin.app.unregisterMenuItem(scrollToHighlightId);
      plugin.app.registerCSS(collapseTopBarId, '');
      plugin.app.registerCSS(queueCounterId, '');
      plugin.app.registerCSS(hideIncEverythingId, '');
      setCurrentIncrementalRem(plugin, undefined);
    } else {
    }
  });

 // Event listeners for assigning priority when cards are created and update due status when cards are rated
  
  let recentlyProcessedCards = new Set<string>();

  plugin.event.addListener(
    AppEvents.QueueCompleteCard,
    undefined,
    async (data: { cardId: RemId }) => {
      console.log('🎴 CARD COMPLETED:', data);
      
      if (!data || !data.cardId) {
        console.error('LISTENER: Event fired but did not contain a cardId. Aborting.');
        return;
      }
      
      const card = await plugin.card.findOne(data.cardId);
      const remId = card?.remId;
      const rem = remId ? await plugin.rem.findOne(remId) : null;
      const isIncRem = rem ? await rem.hasPowerup(powerupCode) : false;
      
      console.log(`🎴 Card from ${isIncRem ? 'INCREMENTAL REM' : 'regular card'}, remId: ${remId}`);

      if (remId) {
        recentlyProcessedCards.add(remId);
        setTimeout(() => recentlyProcessedCards.delete(remId), 2000);

        // Call the cache update with the 'isLightUpdate' flag set to true.
        console.log('LISTENER: Calling LIGHT updateCardPriorityInCache...');
        await updateCardPriorityInCache(plugin, remId, true); // Pass true here
      } else {
        console.error(`LISTENER: Could not find a parent Rem for the completed cardId ${data.cardId}`);
      }
    }
  );

  // Define a variable outside the listener to hold our timer.
  let remChangeDebounceTimer: NodeJS.Timeout;

  plugin.event.addListener(
    AppEvents.GlobalRemChanged,
    undefined,
    (data) => {
      // Every time a change happens, clear the previous timer.
      clearTimeout(remChangeDebounceTimer);

      // Start a new timer.
      remChangeDebounceTimer = setTimeout(async () => {
        // This code will only run after the user has stopped typing for 1 second.
        
        // --- NEW LOGIC START ---
        // Check if we are currently in a queue session.
        const inQueue = !!(await plugin.storage.getSession(currentSubQueueIdKey));
        if (inQueue) {
          console.log('LISTENER: (Debounced) GlobalRemChanged fired, but skipping processing because user is in the queue.');
          return; // Exit early and do nothing
        }
        // --- NEW LOGIC END ---

        console.log(`LISTENER: (Debounced) GlobalRemChanged fired for RemId: ${data.remId}`);
              
        if (recentlyProcessedCards.has(data.remId)) {
          console.log('LISTENER: Skipping - recently processed by QueueCompleteCard');
          return;
        }
        
        const rem = await plugin.rem.findOne(data.remId);
        if (!rem) {
          return;
        }
        
        const cards = await rem.getCards();
        if (cards && cards.length > 0) {
          const existingPriority = await getCardPriority(plugin, rem);
          if (!existingPriority) {
            await autoAssignCardPriority(plugin, rem);
          }
        }
        
        // The default here is a HEAVY update, which is now safe because we know we are NOT in the queue.
        await updateCardPriorityInCache(plugin, data.remId);
        console.log('LISTENER: (Debounced) Finished processing event.');

      }, 1000);
    }
  );


  plugin.app.registerWidget('queue', WidgetLocation.Flashcard, {
    powerupFilter: powerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    queueItemTypeFilter: QueueItemType.Plugin,
  });
  console.log('✅ Widget registered with powerupFilter:', powerupCode, 'queueItemTypeFilter:', QueueItemType.Plugin);
  
  plugin.app.registerWidget('answer_buttons', WidgetLocation.FlashcardAnswerButtons, {
    powerupFilter: powerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    queueItemTypeFilter: QueueItemType.Plugin,
  });

  plugin.app.registerWidget('sorting_criteria', WidgetLocation.Popup, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  plugin.app.registerMenuItem({
    id: 'sorting_criteria_menuitem',
    location: PluginCommandMenuLocation.QueueMenu,
    name: 'Sorting Criteria',
    action: async () => {
      await plugin.widget.openPopup('sorting_criteria');
    },
  });

  plugin.app.registerWidget('priority_shield_graph', WidgetLocation.Popup, {
    dimensions: {
      width: 1000,
      height: 1050,
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
        await initIncrementalRem(rem);
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
      if (!rem) {
        return;
      }

      const isIncremental = await rem.hasPowerup(powerupCode);

      if (isIncremental) {
        // If it's already incremental, just remove the powerup.
        await rem.removePowerup(powerupCode);
        await plugin.app.toast('Untagged as Incremental Rem');
      } else {
        // If it's not incremental, initialize it and open the priority popup.
        await initIncrementalRem(rem);
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

  // No Inc Rem Timer

  // Register the timer indicator widget (add this with other widget registrations)
  plugin.app.registerWidget('no_inc_timer_indicator', WidgetLocation.QueueToolbar, {
    dimensions: {
      width: 'auto',
      height: 'auto',
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

  // Update the cancel command to use synced storage
  plugin.app.registerCommand({
    id: 'cancel-no-inc-rem-timer',
    name: 'Cancel No Inc Rem Timer',
    action: async () => {
      const timerEnd = await plugin.storage.getSynced<number>(noIncRemTimerKey);
      if (timerEnd && timerEnd > Date.now()) {
        await plugin.storage.setSynced(noIncRemTimerKey, null);
        await plugin.app.toast('Incremental rem timer cancelled. Normal queue behavior resumed.');
        // Force queue refresh
        await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
      } else {
        await plugin.app.toast('No active timer to cancel.');
      }
    },
  });

  // Register command to create priority review document
  plugin.app.registerCommand({
    id: 'create-priority-review',
    name: 'Create Priority Review Document',
    keyboardShortcut: 'opt+shift+r',
    action: async () => {
      const focused = await plugin.focus.getFocusedRem();
      
      await plugin.storage.setSession('reviewDocContext', {
        scopeRemId: focused?._id || null,
        scopeName: focused ? await safeRemTextToString(plugin, focused.text) : 'Full KB'
      });
      
      await plugin.widget.openPopup('review_document_creator');
    }
  });

  // Command to manually refresh the card priority cache ---
  plugin.app.registerCommand({
    id: 'refresh-card-priority-cache',
    name: 'Refresh Card Priority Cache',
    action: async () => {
      await cacheAllCardPriorities(plugin);
    },
  });

  // Register the review document creator widget
  plugin.app.registerWidget('review_document_creator', WidgetLocation.Popup, {
    dimensions: {
      width: 500,
      height: 'auto',
    },
  });

  plugin.app.registerWidget('card_priority_display', WidgetLocation.FlashcardUnder, {
    powerupFilter: 'cardPriority',
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    queueItemTypeFilter: QueueItemType.Flashcard,
  });

  plugin.app.registerWidget('video_debug', WidgetLocation.Popup, {
    dimensions: {
      width: '500px',
      height: 'auto',
    },
  });

  plugin.app.registerCommand({
    id: 'debug-video',
    name: 'Debug Video Detection',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        await plugin.app.toast('Please focus on a rem first');
        return;
      }
      await plugin.widget.openPopup('video_debug', {
        remId: rem._id,
      });
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

  // Pre-computation command
  await plugin.app.registerCommand({
    id: 'precompute-card-priorities',
    name: 'Pre-compute Card Priorities',
    description: 'Pre-compute and tag all card priorities for faster plugin startups (run once)',
    action: async () => {
      await precomputeAllCardPriorities(plugin);
    },
  });
  
  // Cleanup command
  await plugin.app.registerCommand({
    id: 'cleanup-card-priority',
    name: 'Remove All CardPriority Tags',
    description: 'Completely remove all CardPriority powerup tags and data from your knowledge base',
    action: async () => {
      await removeAllCardPriorityTags(plugin);
    },
  });

  // Run the cache build in the background without blocking plugin initialization.
  cacheAllCardPriorities(plugin);

  
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);

