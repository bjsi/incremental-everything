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
  priorityCalcScopeRemIdsKey,
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
    let priorityChanged = 0; // Track how many had their priority value changed
    let skippedManual = 0;
    let errors = 0;
    const errorDetails: Array<{ remId: string; reason: string; error?: any }> = []; // Track error details
    
    const batchSize = 50; // Process in batches to avoid overwhelming the system
    
    for (let i = 0; i < uniqueRemIds.length; i += batchSize) {
      const batch = uniqueRemIds.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (remId) => {
        try {
          const rem = await plugin.rem.findOne(remId);
          if (!rem) {
            errors++;
            errorDetails.push({ 
              remId, 
              reason: 'Rem not found - may have been deleted' 
            });
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
          
          // Store the old priority value (if any)
          const oldPriorityValue = existingPriority ? existingPriority.priority : null;
          
          // Use autoAssignCardPriority which handles all the logic:
          // - Checks for incremental rem
          // - Searches ancestors using findClosestAncestorWithPriority
          // - Sets default if needed
          // - Saves the priority with appropriate source
          await autoAssignCardPriority(plugin, rem);
          tagged++;
          
          // Check if priority value actually changed
          if (oldPriorityValue !== null) {
            const newPriority = await getCardPriority(plugin, rem);
            if (newPriority && newPriority.priority !== oldPriorityValue) {
              priorityChanged++;
            }
          }
          
          processed++;
          
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Error processing rem ${remId}:`, error);
          errors++;
          errorDetails.push({ 
            remId, 
            reason: `Exception during processing: ${errorMessage}`,
            error: error 
          });
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
          `Tagged: ${tagged}, Changed: ${priorityChanged}, Skipped manual: ${skippedManual}, Errors: ${errors}`
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
    
    // Analyze error types
    let errorBreakdown = '';
    if (errorDetails.length > 0) {
      const notFoundErrors = errorDetails.filter(e => e.reason.includes('not found')).length;
      const exceptionErrors = errorDetails.filter(e => e.reason.includes('Exception')).length;
      
      errorBreakdown = `\n• Error breakdown:\n` +
        `  - Rem not found: ${notFoundErrors}\n` +
        `  - Processing exceptions: ${exceptionErrors}`;
      
      // Log detailed errors to console
      console.log('\n=== DETAILED ERROR LOG ===');
      console.log(`Total errors: ${errorDetails.length}\n`);
      errorDetails.forEach((err, index) => {
        console.log(`\nError ${index + 1}/${errorDetails.length}:`);
        console.log(`  RemId: ${err.remId}`);
        console.log(`  Reason: ${err.reason}`);
        if (err.error) {
          console.log(`  Details:`, err.error);
        }
      });
      console.log('\n=== END ERROR LOG ===\n');
      
      // Also provide a simple list of failed RemIds for easy copying
      console.log('=== FAILED REM IDs (for investigation) ===');
      console.log(errorDetails.map(e => e.remId).join('\n'));
      console.log('=== END FAILED REM IDs ===\n');
    }
    
    // Final report
    const message = 
      `✅ Pre-computation complete!\n\n` +
      `• Total rems processed: ${processed}\n` +
      `• Newly tagged: ${tagged}${priorityChanged > 0 ? ` (${priorityChanged} with changed priority)` : ''}\n` +
      `• Preserved manual priorities: ${skippedManual}\n` +
      `• Errors: ${errors}${errorBreakdown}\n` +
      `• Total time: ${totalTime}s\n` +
      `• Cache build time: ${cacheTime}s\n\n` +
      `${errors > 0 ? 'Check console for detailed error log.\n\n' : ''}` +
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


/**
 * Check if a rem is a Priority Review Document by checking for the tag
 */
async function isPriorityReviewDocument(plugin: RNPlugin, rem: Rem): Promise<boolean> {
  const tags = await rem.getTagRems();
  if (!tags || tags.length === 0) return false;
  
  // Check if any tag has the name "Priority Review Queue"
  for (const tag of tags) {
    // Use the text property directly from RemObject
    const tagText = tag.text;
    if (tagText) {
      // Convert RichTextInterface to string
      const tagTextString = typeof tagText === 'string' ? tagText : tagText.join('');
      if (tagTextString.includes('Priority Review Queue')) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Extract the original scope rem from a Priority Review Document's title
 * The title format is: "Priority Review - [RemReference] - [Timestamp]"
 */
async function extractOriginalScopeFromPriorityReview(
  plugin: RNPlugin, 
  reviewDocRem: Rem
): Promise<string | null> {
  const richText = reviewDocRem.text;
  if (!richText || richText.length === 0) return null;
  
  // Search for a rem reference in the rich text
  for (const element of richText) {
    if (typeof element === 'object' && element !== null) {
      // Check if it's a rem reference (portal)
      if ('i' in element && element.i === 'q' && '_id' in element) {
        // This is a rem reference, return the referenced rem ID
        return element._id as string;
      }
    }
  }
  
  // No rem reference found - might be "Full Knowledge Base"
  const textContent = richText.join('');
  if (textContent.includes('Full Knowledge Base')) {
    // Return null to indicate full KB scope
    return null;
  }
  
  // Could not determine scope
  console.warn('Could not extract scope from Priority Review Document title');
  return null;
}


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
  console.log('   • Press Ctrl+P (or Cmd+P)');
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

  const hideCardPriorityTagId = 'hide-card-priority-tag';
  const HIDE_CARD_PRIORITY_CSS = `
    [data-rem-tags~="cardpriority"] .hierarchy-editor__tag-bar__tag {
    display: none; }
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

  plugin.settings.registerBooleanSetting({
    id: 'hideCardPriorityTag',
    title: 'Hide CardPriority Tag in Editor',
    description:
      'If enabled, this will hide the "CardPriority" powerup tag in the editor to reduce clutter. You can still set priority with (Alt+P). After changing this setting, reload RemNote.',
    defaultValue: true,
  });

  // Apply the CSS hide setting on startup
  const shouldHide = await plugin.settings.getSetting('hideCardPriorityTag');
  if (shouldHide) {
    await plugin.app.registerCSS(hideCardPriorityTagId, HIDE_CARD_PRIORITY_CSS);
  }
  
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

  plugin.settings.registerDropdownSetting({
    id: 'performanceMode',
    title: 'Performance Mode',
    description: 'Choose performance level. "Light" is recommended for web/mobile.',
    defaultValue: 'full',
    options: [
      {
        key: 'full',
        label: 'Full (All Features, High Resource Use)',
        value: 'full'
      },
      {
        key: 'light',
        label: 'Light (Faster, No Relative Priority/Shield)',
        value: 'light'
      }
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
  
    // --- NEW: Get the effective scope that was determined at QueueEnter ---
    const originalScopeId = await plugin.storage.getSession<string | null>('originalScopeId');
    
    // IMPORTANT: Get the scope BEFORE clearing it
    const docScopeRemIds = await plugin.storage.getSession<RemId[] | null>(priorityCalcScopeRemIdsKey);
    console.log('[QueueExit] IncRem shield - Priority calculation scope:', docScopeRemIds?.length || 0, 'rems');
    console.log('Original scope ID for history:', originalScopeId);
    
    // ---
    // --- ⬇️ HERE IS THE MODIFICATION ⬇️ ---
    // ---
    
    // Get the performance mode setting
    const performanceMode = await plugin.settings.getSetting('performanceMode') || 'full';

    // Only run history calculations in 'full' mode
    if (performanceMode === 'full') {
      console.log('[QueueExit] Full mode. Saving Priority Shield history...');
      
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
        console.log('[QueueExit] Saved KB IncRem history:', kbFinalStatus);
        
        // Save Document-level priority shield using PRIORITY CALCULATION scope
        if (docScopeRemIds && docScopeRemIds.length > 0) {
          console.log('[QueueExit] Processing IncRem document shield with PRIORITY CALC scope:', docScopeRemIds.length, 'rems');
          
          const scopedRems = allRems.filter((rem) => docScopeRemIds.includes(rem.remId));
          console.log('[QueueExit] Found', scopedRems.length, 'incremental rems in priority calculation scope');
          
          const unreviewedDueInScope = scopedRems.filter(
            (rem) => Date.now() >= rem.nextRepDate
          );
          console.log('[QueueExit] Found', unreviewedDueInScope.length, 'due IncRems in priority calculation scope');
          
          let docFinalStatus = {
            absolute: null as number | null,
            percentile: 100,
          };
          
          if (unreviewedDueInScope.length > 0) {
            const topMissedInDoc = _.minBy(unreviewedDueInScope, (rem) => rem.priority);
            if (topMissedInDoc) {
              docFinalStatus.absolute = topMissedInDoc.priority;
              docFinalStatus.percentile = calculateRelativePriority(scopedRems, topMissedInDoc.remId);
              console.log('[QueueExit] IncRem doc shield - Priority:', docFinalStatus.absolute, 'Percentile:', docFinalStatus.percentile + '%');
            }
          }
          
        // --- CRITICAL CHANGE: Use originalScopeId for history storage ---
        const historyKey = originalScopeId || subQueueId || await plugin.storage.getSession<string>(currentSubQueueIdKey);
        
        if (historyKey) {
          // Save document history with the ORIGINAL scope ID as key, not the Priority Review Doc ID
          const docHistory = (await plugin.storage.getSynced(documentPriorityShieldHistoryKey)) || {};
          if (!docHistory[historyKey]) {
            docHistory[historyKey] = {};
          }
          docHistory[historyKey][today] = docFinalStatus;
          await plugin.storage.setSynced(documentPriorityShieldHistoryKey, docHistory);
          console.log('Saved document history for original scope', historyKey, ':', docFinalStatus);
        } else {
          console.log('Warning: No scope ID available for saving document history');
        }
      } else {
        console.log('No document scope RemIds found or empty - skipping document history save');
      }
    }

      // --- NEW: Card Priority Shield Logic (with same Priority Review Document handling) ---
      const allCardInfos = await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey);

      if (allCardInfos && allCardInfos.length > 0) {
          const today = dayjs().format('YYYY-MM-DD');
          const seenCardIds = (await plugin.storage.getSession<string[]>(seenCardInSessionKey)) || [];

          // Calculate final KB card shield from the cache
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
          console.log('Saved KB card history:', kbCardFinalStatus);

          // ✅ Calculate final Doc card shield - USE PRIORITY CALCULATION SCOPE
          const historyKey = originalScopeId || subQueueId || await plugin.storage.getSession<string>(currentSubQueueIdKey);
          
          // Get the PRIORITY CALCULATION scope, not the item selection scope
          const priorityCalcScopeRemIds = await plugin.storage.getSession<RemId[]>(priorityCalcScopeRemIdsKey);
          
          if (historyKey && priorityCalcScopeRemIds && priorityCalcScopeRemIds.length > 0) {
              console.log('[QueueExit] Calculating card shield using PRIORITY CALC scope:', priorityCalcScopeRemIds.length, 'rems');
              
              // Filter cards using the priority calculation scope (not item selection scope!)
              const docCardInfos = allCardInfos.filter(ci => priorityCalcScopeRemIds.includes(ci.remId));
              console.log('[QueueExit] Found', docCardInfos.length, 'cards in priority calculation scope');

              // Find unreviewed due cards in scope
              const unreviewedDueDoc = docCardInfos.filter(c => c.dueCards > 0 && !seenCardIds.includes(c.remId));
              let docCardFinalStatus = { absolute: null as number | null, percentile: 100 };

              if (unreviewedDueDoc.length > 0) {
                  const topMissed = _.minBy(unreviewedDueDoc, c => c.priority);
                  if (topMissed) {
                      docCardFinalStatus.absolute = topMissed.priority;
                      // Calculate percentile against the priority calculation scope
                      docCardFinalStatus.percentile = calculateRelativeCardPriority(docCardInfos, topMissed.remId);
                      console.log('[QueueExit] Doc card shield - Priority:', docCardFinalStatus.absolute, 'Percentile:', docCardFinalStatus.percentile + '%');
                  }
              }
              
              // Save to history under the original scope key
              const docCardHistory = (await plugin.storage.getSynced(documentCardPriorityShieldHistoryKey)) || {};
              if (!docCardHistory[historyKey]) {
                  docCardHistory[historyKey] = {};
              }
              docCardHistory[historyKey][today] = docCardFinalStatus;
              await plugin.storage.setSynced(documentCardPriorityShieldHistoryKey, docCardHistory);
              console.log('Saved card document history for original scope', historyKey, ':', docCardFinalStatus);
          } else {
              console.log('[QueueExit] Skipping card document shield - no priority calc scope available');
          }
      }
    } else {
      console.log('[QueueExit] Light mode. Skipping Priority Shield history save.');
    }
    
    // ---
    // --- ⬆️ END OF MODIFICATION ⬆️ ---
    // ---

    // Reset session-specific state AFTER we've used the data (runs in both modes)
    await plugin.storage.setSession(seenRemInSessionKey, []);
    await plugin.storage.setSession(seenCardInSessionKey, []);
    sessionItemCounter = 0;
    await plugin.storage.setSession(currentScopeRemIdsKey, null);
    await plugin.storage.setSession(priorityCalcScopeRemIdsKey, null);
    await plugin.storage.setSession(currentSubQueueIdKey, null);
    await plugin.storage.setSession('effectiveScopeId', null);
    await plugin.storage.setSession('originalScopeId', null);
    await plugin.storage.setSession(queueSessionCacheKey, null);
    console.log('Session state reset complete');
  });

  // Updated QueueEnter listener with dual scope handling

  plugin.event.addListener(AppEvents.QueueEnter, undefined, async ({ subQueueId }) => {
    console.log('QUEUE ENTER: Starting session pre-calculation for subQueueId:', subQueueId);

    // 1. Reset all session-specific state for a clean start.
    await plugin.storage.setSession(seenRemInSessionKey, []);
    await plugin.storage.setSession(seenCardInSessionKey, []);
    sessionItemCounter = 0;
    await plugin.storage.setSession(currentScopeRemIdsKey, null);
    
    // --- NEW: Priority Review Document Detection with DUAL SCOPE ---
    let scopeForPriorityCalc = subQueueId || null;  // Scope for priority calculations
    let scopeForItemSelection = subQueueId || null; // Scope for GetNextCard item selection
    let originalScopeId = subQueueId || null;       // For history storage
    let isPriorityReviewDoc = false;
    
    if (subQueueId) {
      const queueRem = await plugin.rem.findOne(subQueueId);
      if (queueRem) {
        isPriorityReviewDoc = await isPriorityReviewDocument(plugin, queueRem);
        
        if (isPriorityReviewDoc) {
          console.log('QUEUE ENTER: Priority Review Document detected!');
          
          // Extract the original scope for priority calculations ONLY
          const extractedScopeId = await extractOriginalScopeFromPriorityReview(plugin, queueRem);
          
          if (extractedScopeId !== undefined) {
            // For priority calculations, use the original scope
            scopeForPriorityCalc = extractedScopeId;
            originalScopeId = extractedScopeId;
            
            // For item selection, KEEP using the Priority Review Document itself
            scopeForItemSelection = subQueueId;
            
            console.log(`QUEUE ENTER: Priority Review Document setup:`);
            console.log(`  - Item selection from: Priority Review Doc (${subQueueId})`);
            console.log(`  - Priority calculations for: ${extractedScopeId ? `Original scope (${extractedScopeId})` : 'Full KB'}`);
          } else {
            console.warn('QUEUE ENTER: Could not extract scope from Priority Review Document');
          }
        }
      }
    }
    
    // Store the scopes appropriately
    await plugin.storage.setSession(currentSubQueueIdKey, subQueueId || null);
    await plugin.storage.setSession('originalScopeId', originalScopeId);
    await plugin.storage.setSession('isPriorityReviewDoc', isPriorityReviewDoc);
    // --- END NEW ---

    // Get the performance mode
    const performanceMode = await plugin.settings.getSetting('performanceMode') || 'full';

    // --- CARD PRIORITY PRE-CALCULATION ---
    const allCardInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
    
    if (allCardInfos.length === 0) {
      console.warn('QUEUE ENTER: Card priority cache is empty! Flashcard calculations will be skipped.');
    }

    const dueCardsInKB = (performanceMode === 'full') ? allCardInfos.filter(info => info.dueCards > 0) : [];

    let docPercentiles: Record<RemId, number> = {};
    let dueCardsInScope: CardPriorityInfo[] = [];

    // --- INCREMENTAL REM PRE-CALCULATION ---
    const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
    
    if (allIncRems.length === 0) {
      console.warn('QUEUE ENTER: Incremental Rem cache is empty! IncRem calculations will be skipped.');
    }
    
    const dueIncRemsInKB = allIncRems?.filter(rem => Date.now() >= rem.nextRepDate) || [];
    let dueIncRemsInScope: IncrementalRem[] = [];
    let incRemDocPercentiles: Record<RemId, number> = {};

    // --- DUAL SCOPE CALCULATION ---
    // For Priority Review Documents, we need TWO different scopes:
    // 1. Item selection scope (the Priority Review Document's actual contents)
    // 2. Priority calculation scope (the original document's comprehensive scope)
    
    if (scopeForItemSelection) {
      console.log('QUEUE ENTER: Setting up scopes...');
      
      // SCOPE 1: Item Selection Scope (for GetNextCard)
      // This determines which items actually appear in the queue
      let itemSelectionScope: Set<RemId>;
      
      if (isPriorityReviewDoc) {
        // For Priority Review Docs: Use the SAME comprehensive gathering method
        // This will automatically resolve portals and get the actual referenced rems
        const reviewDocRem = await plugin.rem.findOne(scopeForItemSelection);
        if (reviewDocRem) {
          const startTime = Date.now();
          
          // Use the exact same comprehensive scope calculation
          const descendants = await reviewDocRem.getDescendants();
          const allRemsInContext = await reviewDocRem.allRemInDocumentOrPortal();
          const folderQueueRems = await reviewDocRem.allRemInFolderQueue();
          const sources = await reviewDocRem.getSources();
          
          const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
            powerupCode,
            nextRepDateSlotCode
          );
          
          const referencingRems = ((await reviewDocRem.remsReferencingThis()) || []).map((rem) => {
            if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
              return rem.parent;
            } else {
              return rem._id;
            }
          }).filter(id => id !== null && id !== undefined) as RemId[];
          
          itemSelectionScope = new Set<RemId>([
            reviewDocRem._id,
            ...descendants.map(r => r._id),
            ...allRemsInContext.map(r => r._id),
            ...folderQueueRems.map(r => r._id),
            ...sources.map(r => r._id),
            ...referencingRems
          ]);
          
          const elapsed = Date.now() - startTime;
          console.log(`QUEUE ENTER: Priority Review Doc scope: ${itemSelectionScope.size} items for selection (${elapsed}ms)`);
          
          // Store this scope for GetNextCard to use
          await plugin.storage.setSession(currentScopeRemIdsKey, Array.from(itemSelectionScope));
        }
      } else {
        // For regular documents: Calculate comprehensive scope for BOTH selection and priorities
        const scopeRem = await plugin.rem.findOne(scopeForItemSelection);
        if (scopeRem) {
          // ... (existing comprehensive scope calculation code)
          const startTime = Date.now();
          
          const descendants = await scopeRem.getDescendants();
          const allRemsInContext = await scopeRem.allRemInDocumentOrPortal();
          const folderQueueRems = await scopeRem.allRemInFolderQueue();
          const sources = await scopeRem.getSources();
          
          const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
            powerupCode,
            nextRepDateSlotCode
          );
          
          const referencingRems = ((await scopeRem.remsReferencingThis()) || []).map((rem) => {
            if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
              return rem.parent;
            } else {
              return rem._id;
            }
          }).filter(id => id !== null && id !== undefined) as RemId[];
          
          itemSelectionScope = new Set<RemId>([
            scopeRem._id,
            ...descendants.map(r => r._id),
            ...allRemsInContext.map(r => r._id),
            ...folderQueueRems.map(r => r._id),
            ...sources.map(r => r._id),
            ...referencingRems
          ]);
          
          const elapsed = Date.now() - startTime;
          console.log(`QUEUE ENTER: Regular document comprehensive scope: ${itemSelectionScope.size} items (${elapsed}ms)`);
          
          // Store comprehensive scope for GetNextCard
          await plugin.storage.setSession(currentScopeRemIdsKey, Array.from(itemSelectionScope));
        }
      }
      
      // SCOPE 2: Priority Calculation Scope
      // This determines percentiles and priority shields
      let priorityCalcScope: Set<RemId>;
      
      if (isPriorityReviewDoc && scopeForPriorityCalc) {
        // Calculate comprehensive scope for the ORIGINAL document
        const originalScopeRem = await plugin.rem.findOne(scopeForPriorityCalc);
        if (originalScopeRem) {
          const descendants = await originalScopeRem.getDescendants();
          const allRemsInContext = await originalScopeRem.allRemInDocumentOrPortal();
          const folderQueueRems = await originalScopeRem.allRemInFolderQueue();
          const sources = await originalScopeRem.getSources();
          
          const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
            powerupCode,
            nextRepDateSlotCode
          );
          
          const referencingRems = ((await originalScopeRem.remsReferencingThis()) || []).map((rem) => {
            if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
              return rem.parent;
            } else {
              return rem._id;
            }
          }).filter(id => id !== null && id !== undefined) as RemId[];
          
          priorityCalcScope = new Set<RemId>([
            originalScopeRem._id,
            ...descendants.map(r => r._id),
            ...allRemsInContext.map(r => r._id),
            ...folderQueueRems.map(r => r._id),
            ...sources.map(r => r._id),
            ...referencingRems
          ]);
          
          console.log(`QUEUE ENTER: Original document scope for priorities: ${priorityCalcScope.size} items`);
    
          // ✅ NEW: Store the priority calculation scope separately
          await plugin.storage.setSession(priorityCalcScopeRemIdsKey, Array.from(priorityCalcScope));
          
        } else {
          // Full KB scope
          priorityCalcScope = new Set<RemId>();
        }
      } else {
        // For regular documents, both scopes are the same
        priorityCalcScope = itemSelectionScope || new Set<RemId>();
      }

      // ---
      // --- ⬇️ HERE IS THE MODIFICATION ⬇️ ---
      // ---

      // We still check if a scope exists
      if (priorityCalcScope.size > 0) {
        
        // Storing the scope ID list is fast and needed for QueueExit, so we do it in both modes.
        await plugin.storage.setSession(priorityCalcScopeRemIdsKey, Array.from(priorityCalcScope));
        
        // ✅ NOW, check performance mode before running expensive calculations
        if (performanceMode === 'full') {
          console.log('QUEUE ENTER: Full mode. Calculating session cache...');
          
          // FLASHCARD SCOPE CALCULATIONS
          const docCardInfos = allCardInfos.filter(info => priorityCalcScope.has(info.remId));
          const sortedDocCards = _.sortBy(docCardInfos, (info) => info.priority);
          
          sortedDocCards.forEach((info, index) => {
            docPercentiles[info.remId] = Math.round(((index + 1) / sortedDocCards.length) * 100);
          });
          
          // Due cards in scope (for priority shield)
          dueCardsInScope = dueCardsInKB.filter(info => priorityCalcScope.has(info.remId));
          
          // INCREMENTAL REM SCOPE CALCULATIONS
          const scopedIncRems = allIncRems.filter(rem => priorityCalcScope.has(rem.remId));
          const sortedIncRems = _.sortBy(scopedIncRems, (rem) => rem.priority);
          
          sortedIncRems.forEach((rem, index) => {
            incRemDocPercentiles[rem.remId] = Math.round(((index + 1) / sortedIncRems.length) * 100);
          });
          
          // Due IncRems in scope (for priority shield)
          dueIncRemsInScope = dueIncRemsInKB.filter(rem => priorityCalcScope.has(rem.remId));
          
          console.log(`QUEUE ENTER: Priority calculations complete:`);
          console.log(`  - Cards in priority scope: ${docCardInfos.length}`);
          console.log(`  - Due cards in priority scope: ${dueCardsInScope.length}`);
          console.log(`  - IncRems in priority scope: ${scopedIncRems.length}`);
          console.log(`  - Due IncRems in priority scope: ${dueIncRemsInScope.length}`);
        
        } else {
          // In 'light' mode, we skip all these calculations.
          console.log('QUEUE ENTER: Light mode. Skipping session cache calculation.');
        }
      }
      
      // ---
      // --- ⬆️ END OF MODIFICATION ⬆️ ---
      // ---

    } // end of if (scopeForItemSelection)

    // 6. Assemble the complete session cache object.
    // (In 'light' mode, the arrays/objects will be empty, which is correct)
    const sessionCache: QueueSessionCache = {
      docPercentiles,
      dueCardsInScope,
      dueCardsInKB,
      dueIncRemsInScope,
      dueIncRemsInKB,
      incRemDocPercentiles,
    };

    // 7. Save the newly created session cache.
    await plugin.storage.setSession(queueSessionCacheKey, sessionCache);
    console.log('QUEUE ENTER: Pre-calculation complete. Session cache has been saved.');
    
    // 8. Update the queue counter CSS
    // For Priority Review Docs, show count of items actually in the document
    let dueIncRemCount: number;
    
    if (isPriorityReviewDoc) {
      // Count the actual IncRems in the Priority Review Document
      const scopeRemIds = await plugin.storage.getSession<RemId[]>(currentScopeRemIdsKey) || [];
      dueIncRemCount = allIncRems.filter(rem => 
        scopeRemIds.includes(rem.remId) && Date.now() >= rem.nextRepDate
      ).length;

    } else if (scopeForItemSelection) {
          // Regular document - LOGIC MUST DIVERGE
          
          if (performanceMode === 'full') {
            // FULL MODE: Use the pre-calculated cache (fast)
            dueIncRemCount = sessionCache.dueIncRemsInScope.length;
          } else {
            // LIGHT MODE: Manually calculate the count, just like GetNextCard
            // This is necessary because sessionCache.dueIncRemsInScope is empty.
            console.log('QUEUE ENTER: Light mode - manually calculating due IncRem count...');
            const scopeRemIds = await plugin.storage.getSession<RemId[]>(currentScopeRemIdsKey) || [];
            if (scopeRemIds) {
              dueIncRemCount = allIncRems.filter(rem => 
                Date.now() >= rem.nextRepDate && // isDue
                scopeRemIds.includes(rem.remId)   // isInScope
                // We assume seenRemIds is [] at the start of the queue
              ).length;
            } else {
              dueIncRemCount = 0; // Scope not ready, though it should be
            }
            console.log(`QUEUE ENTER: Light mode - found ${dueIncRemCount} due IncRems`);
          }

        } else {
          // Full KB
          // This is fine, as dueIncRemsInKB is populated in both modes
          dueIncRemCount = sessionCache.dueIncRemsInKB.length;
        }

    plugin.app.registerCSS(
      queueCounterId,
      `
      .rn-queue__card-counter {
        /*visibility: hidden;*/
      }

      .light .rn-queue__card-counter:after {
        content: ' + ${dueIncRemCount}';
      }

      .dark .rn-queue__card-counter:after {
        content: ' + ${dueIncRemCount}';
      }`.trim()
    );

    console.log(`QUEUE ENTER: Queue counter updated to show ${dueIncRemCount} due IncRems`);
  });

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

      // ---
      // --- ⬇️ MODIFIED LOGIC ⬇️ ---
      // ---

      // Check if session cache is ready
      let docScopeRemIds = await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey);

      // If in document queue but cache not ready, STOP.
      if (queueInfo.subQueueId && docScopeRemIds === null) {
        console.log('⏳ GetNextCard: Session cache not ready yet, waiting for QueueEnter. Returning null.');
        
        // Hide the counter temporarily - QueueEnter will update it when ready
        await plugin.app.registerCSS(queueCounterId, '');
        
        // Return null immediately. DO NOT run the fallback calculation.
        return null;
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

  // Command to jump to rem by ID using a popup widget
  plugin.app.registerCommand({
    id: 'jump-to-rem-by-id',
    name: 'Jump to Rem by ID',
    action: async () => {
      // Open the popup widget for input
      await plugin.widget.openPopup('jump_to_rem_input');
    },
  });

  // Register the review document creator widget
  plugin.app.registerWidget('review_document_creator', WidgetLocation.Popup, {
    dimensions: {
      width: 500,
      height: 'auto',
    },
  });

  // Register the jump to rem input widget
  plugin.app.registerWidget('jump_to_rem_input', WidgetLocation.Popup, {
    dimensions: {
      width: 400,
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

  // Test console function availability (useful for debugging)
  await plugin.app.registerCommand({
    id: 'test-console-function',
    name: 'Test Console Function',
    description: 'Check if jumpToRemById() is available in console',
    action: async () => {
      // Check if function exists on window
      const isOnWindow = typeof (window as any).jumpToRemById === 'function';
      
      // Log detailed debugging info
      console.log('=== CONSOLE FUNCTION DEBUG ===');
      console.log('typeof (window as any).jumpToRemById:', typeof (window as any).jumpToRemById);
      console.log('typeof window.jumpToRemById:', typeof (window as any).jumpToRemById);
      console.log('Function defined on window:', isOnWindow);
      console.log('window object:', window);
      console.log('Top window === current window:', window === window.top);
      
      // Try to log the function itself
      if (isOnWindow) {
        console.log('Function reference:', (window as any).jumpToRemById);
      }
      
      // Check if we're in an iframe
      const inIframe = window !== window.top;
      if (inIframe) {
        console.warn('⚠️ Plugin is running in an iframe!');
        console.log('To use the function in console, you need to:');
        console.log('1. Open DevTools (F12)');
        console.log('2. Look for the context dropdown (usually says "top")');
        console.log('3. Select the RemNote iframe context');
        console.log('OR use: window.jumpToRemById("rem-id")');
      }
      
      console.log('==============================');
      
      if (isOnWindow) {
        await plugin.app.toast('✅ Function is defined. Check console for details.');
        console.log('✅ jumpToRemById() is available!');
        console.log('If you get "not defined" error, try:');
        console.log('  window.jumpToRemById(\'your-rem-id-here\')');
      } else {
        await plugin.app.toast('❌ jumpToRemById() is NOT available');
        console.error('❌ jumpToRemById() is NOT available');
        console.log('This might indicate the plugin needs to be rebuilt');
      }
    },
  });

  // Run the cache build in the background without blocking plugin initialization.

  // Get the performance mode setting
  const performanceMode = await plugin.settings.getSetting('performanceMode') || 'full';

  if (performanceMode === 'full') {
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