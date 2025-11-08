import {
  AppEvents,
  declareIndexPlugin,
  PluginCommandMenuLocation,
  PropertyLocation,
  PropertyType,
  QueueItemType,
  ReactRNPlugin,
  PluginRem,
  RemId,
  RNPlugin,
  SelectionType,
  SpecialPluginCallback,
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
  queueLayoutFixId,
  currentScopeRemIdsKey,
  defaultPriorityId,
  seenRemInSessionKey,
  displayPriorityShieldId,
  priorityShieldHistoryMenuItemId,
  currentSubQueueIdKey,
  seenCardInSessionKey,
  cardPriorityShieldHistoryKey,
  documentCardPriorityShieldHistoryKey,
  allCardPriorityInfoKey,
  remnoteEnvironmentId,
  pageRangeWidgetId,
  noIncRemTimerKey,
  noIncRemMenuItemId,
  currentIncRemKey,
  alwaysUseLightModeOnMobileId,
  alwaysUseLightModeOnWebId,
  pdfHighlightColorId
} from '../lib/consts';
import * as _ from 'remeda';
import { getSortingRandomness, getCardsPerRem } from '../lib/sorting';
import { IncrementalRem } from '../lib/types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getIncrementalRemInfo, handleHextRepetitionClick } from '../lib/incremental_rem';
import { getDailyDocReferenceForDate } from '../lib/date';
import { getCurrentIncrementalRem, setCurrentIncrementalRem } from '../lib/currentRem';
import { getInitialPriority } from '../lib/priority_inheritance';
import { findPDFinRem, safeRemTextToString } from '../lib/pdfUtils';
import { 
  handleMobileDetectionOnStartup,
  getOperatingSystem,
  isMobileDevice,
  shouldUseLightMode,
  getEffectivePerformanceMode,
  getPlatform,              // NEW
  isWebPlatform,            // NEW
  getFriendlyOSName,
  getFriendlyPlatformName   // NEW
} from '../lib/mobileUtils';
import { 
  autoAssignCardPriority, 
  getCardPriority, 
  CardPriorityInfo,
  setCardPriority,
  calculateNewPriority
} from '../lib/cardPriority';
import { updateCardPriorityInCache } from '../lib/cache';
import {
  registerQueueExitListener,
  registerQueueEnterListener,
  registerURLChangeListener,
  registerQueueCompleteCardListener,
  registerGlobalRemChangedListener,
} from './events';
dayjs.extend(relativeTime);

let sessionItemCounter = 0;

const hideCardPriorityTagId = 'hide-card-priority-tag';
const HIDE_CARD_PRIORITY_CSS = `
  [data-rem-tags~="cardpriority"] .hierarchy-editor__tag-bar__tag {
  display: none; }
`;

async function registerPluginPowerups(plugin: ReactRNPlugin) {
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
}

async function registerPluginSettings(plugin: ReactRNPlugin) {
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
    description: 'Choose performance level. "Light" is recommended for web/mobile. "Full" can bring significant computational overhead (best used in the Desktop App); it will also automatically start a pretagging process of all flashcards, that can make RemNote slow untill everything is tagged/synced/wired/cached!',
    defaultValue: 'light',
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
    id: alwaysUseLightModeOnMobileId,
    title: 'Always use Light Mode on Mobile',
    description: 'Automatically switch to Light performance mode when using RemNote on iOS or Android. This prevents crashes and improves performance on mobile devices. Recommended: enabled.',
    defaultValue: true,
  });

  plugin.settings.registerBooleanSetting({
    id: alwaysUseLightModeOnWebId,
    title: 'Always use Light Mode on Web Browser',
    description: 'Automatically switch to Light performance mode when using RemNote on the web browser. Full Mode can be slow or unstable on web browsers. Recommended: enabled.',
    defaultValue: true,
  });
  
  plugin.settings.registerBooleanSetting({
    id: displayPriorityShieldId,
    title: 'Display Priority Shield in Queue',
    description: 'If enabled, shows a real-time status of your highest-priority due items in the queue (below the Answer Buttons for IncRems, and in the card priority widget under the flashcard in case of regular cards).',
    defaultValue: true,
  });

  plugin.settings.registerDropdownSetting({
    id: 'priorityEditorDisplayMode', // ID for the new setting
    title: 'Priority Editor in Editor',
    description:
      'Controls when to show the priority widget in the right-hand margin of the editor.',
    defaultValue: 'all',
    options: [
      {
        key: 'all',
        label: 'Show for IncRem and Cards',
        value: 'all',
      },
      {
        key: 'incRemOnly',
        label: 'Show only for IncRem',
        value: 'incRemOnly',
      },
      {
        key: 'disable',
        label: 'Disable',
        value: 'disable',
      },
    ],
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

  plugin.settings.registerDropdownSetting({
    id: pdfHighlightColorId,
    title: 'Incremental PDF Highlight Color',
    description: 'Choose the highlight color for PDF highlights tagged as Incremental Rem. When toggling OFF (removing Incremental tag), the highlight will be reset to Yellow.',
    defaultValue: 'Blue',
    options: [
      { key: 'Red', label: 'Red', value: 'Red' },
      { key: 'Orange', label: 'Orange', value: 'Orange' },
      { key: 'Green', label: 'Green', value: 'Green' },
      { key: 'Blue', label: 'Blue', value: 'Blue' },
      { key: 'Purple', label: 'Purple', value: 'Purple' }
    ]
  });
}


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
          
          // Check if rem actually has the cardPriority powerup tag
          const hasPowerupTag = await rem.hasPowerup('cardPriority');

          let existingPriority: CardPriorityInfo | null = null;
          if (hasPowerupTag) {
            // Only get the priority if the tag exists
            const priorityValue = await rem.getPowerupProperty('cardPriority', 'priority');
            const source = await rem.getPowerupProperty('cardPriority', 'prioritySource');
            
            if (priorityValue && source === 'manual') {
              // Don't override manual priorities
              skippedManual++;
              processed++;
              return;
            }
            
            if (priorityValue) {
              existingPriority = {
                remId: rem._id,
                priority: parseInt(priorityValue),
                source: source as PrioritySource,
                lastUpdated: 0, // We don't care about this for comparison
                cardCount: 0,
                dueCards: 0
              };
            }
          }

          // Store the old priority value (if any)
          const oldPriorityValue = existingPriority ? existingPriority.priority : null;
          const oldPrioritySource = existingPriority ? existingPriority.source : null;

          // Calculate what the new priority SHOULD be (without saving yet)
          const calculatedPriority = await calculateNewPriority(plugin, rem, existingPriority);

          // Only update if:
          // 1. Rem doesn't have the powerup tag yet (needs to be tagged), OR
          // 2. The priority value changed, OR
          // 3. The source type changed
          if (!hasPowerupTag ||
              calculatedPriority.priority !== oldPriorityValue || 
              calculatedPriority.source !== oldPrioritySource) {
            // Priority changed or needs initial tagging - save it
            await setCardPriority(plugin, rem, calculatedPriority.priority, calculatedPriority.source);
            tagged++;
            
            if (hasPowerupTag && oldPriorityValue !== null && calculatedPriority.priority !== oldPriorityValue) {
              priorityChanged++;
            }
          }
          // If priority unchanged AND already tagged, we simply skip the update

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

async function buildOptimizedCache(plugin: RNPlugin) {
  console.log('CACHE: Building optimized cache from pre-tagged priorities...');

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
async function isPriorityReviewDocument(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
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
  reviewDocRem: PluginRem
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

  registerQueueExitListener(plugin, () => {
    sessionItemCounter = 0;
  });

  registerQueueEnterListener(plugin, {
    resetSessionItemCounter: () => {
      sessionItemCounter = 0;
    },
    priorityReviewHelpers: {
      isPriorityReviewDocument,
      extractOriginalScopeFromPriorityReview,
    },
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

  async function initIncrementalRem(rem: PluginRem) {
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

  plugin.app.registerWidget('batch_card_priority', WidgetLocation.Popup, {
    dimensions: {
      width: 600,
      height: 'auto',
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

  // Reschedule Command for Incremental Rems
  // Add this command registration in index.tsx after the set-priority command (around line 1973)

  plugin.app.registerCommand({
    id: 'reschedule-incremental',
    name: 'Reschedule Incremental Rem',
    keyboardShortcut: 'ctrl+j', // Will be Ctrl+J on Mac also!
    action: async () => {
      console.log("--- Reschedule Incremental Rem Command Triggered ---");
      let remId: string | undefined;
      const url = await plugin.window.getURL();
      console.log("Current URL:", url);

      // Check if we are in the queue
      if (url.includes('/flashcards')) {
        console.log("In flashcards view.");
        // First, try to get the current native flashcard
        const card = await plugin.queue.getCurrentCard();
        console.log("Result of getCurrentCard():", card);

        if (card) {
          remId = card.remId;
          console.log("Found native card. remId:", remId);
        } else {
          console.log("Not a native card. Checking session storage for incremental rem...");
          // If it's not a native card, it might be our plugin's queue view
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
        console.log("Reschedule: No focused Rem or card in queue found. Aborting.");
        await plugin.app.toast("Could not find a Rem to reschedule.");
        return;
      }

      // Check if the Rem is an Incremental Rem
      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        console.log("Reschedule: PluginRem not found. Aborting.");
        await plugin.app.toast("Could not find the Rem.");
        return;
      }

      // Check if it has the Incremental powerup
      const hasIncrementalPowerup = await rem.hasPowerup(powerupCode);
      if (!hasIncrementalPowerup) {
        console.log("Reschedule: PluginRem is not tagged as Incremental. Aborting.");
        await plugin.app.toast("This command only works with Incremental Rems.");
        return;
      }

      // Verify it's actually an Incremental Rem with valid data
      const incRemInfo = await getIncrementalRemInfo(plugin, rem);
      if (!incRemInfo) {
        console.log("Reschedule: Could not get Incremental Rem info. Aborting.");
        await plugin.app.toast("Could not retrieve Incremental Rem information.");
        return;
      }

      console.log(`Opening 'reschedule' popup for remId: ${remId}`);
      await plugin.widget.openPopup('reschedule', {
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

  // Register command for batch card priority assignment
  plugin.app.registerCommand({
    id: 'batch-card-priority',
    name: 'Batch Assign Card Priority for tagged rems',
    keyboardShortcut: 'opt+shift+c',
    action: async () => {
      const focused = await plugin.focus.getFocusedRem();
      
      if (!focused) {
        await plugin.app.toast('Please focus on a tag rem first');
        return;
      }
      
      // Check if this rem is actually being used as a tag
      const taggedRems = await focused.taggedRem();
      if (!taggedRems || taggedRems.length === 0) {
        await plugin.app.toast('The focused rem is not used as a tag. No rems are tagged with it.');
        return;
      }
      
      // Store the tag rem ID in session storage
      await plugin.storage.setSession('batchCardPriorityTagRem', focused._id);
      
      // Open the batch card priority widget
      await plugin.widget.openPopup('batch_card_priority');
    }
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

  registerURLChangeListener(plugin);
  registerQueueCompleteCardListener(plugin);
  registerGlobalRemChangedListener(plugin);


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
      width: 1075,
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
      if (!rem) return;

      const isIncremental = await rem.hasPowerup(powerupCode);

      if (isIncremental) {
        await rem.removePowerup(powerupCode);
        await rem.setHighlightColor('Yellow'); // Reset to default
        await plugin.app.toast('❌ Removed Incremental tag');
      } else {
        await initIncrementalRem(rem);
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

    // Register editor review popup
  plugin.app.registerWidget(
    'editor_review',
    WidgetLocation.Popup,
    {
      dimensions: { height: 'auto', width: '500px' },
    }
  );
  
  // Register editor review timer widget
  plugin.app.registerWidget(
    'editor_review_timer',
    WidgetLocation.DocumentAboveToolbar,
    {
      dimensions: { height: 'auto', width: '100%' },
    }
  );

  plugin.app.registerCommand({
    id: 'review-increm-in-editor',
    name: 'Execute Incremental Rem Repetition (Review in Editor)',
    keyboardShortcut: 'ctrl+shift+j', 
    action: async () => {
      console.log("--- Review Incremental Rem in Editor Command Triggered ---");
      
      // Get focused Rem
      const focusedRem = await plugin.focus.getFocusedRem();
      if (!focusedRem) {
        await plugin.app.toast("No Rem focused");
        return;
      }
      
      // Check if it's an Incremental Rem
      const hasIncPowerup = await focusedRem.hasPowerup(powerupCode);
      if (!hasIncPowerup) {
        await plugin.app.toast("This Rem is not tagged as an Incremental Rem");
        return;
      }
      
      // Open the editor review popup
      await plugin.widget.openPopup('editor_review', {
        remId: focusedRem._id,
      });
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


  // Mobile and Web Browser Light Mode Features
  await handleMobileDetectionOnStartup(plugin);
  console.log('Mobile detection completed');

  plugin.app.registerCommand({
    id: 'test-mobile-detection',
    name: '🧪 Test Mobile & Platform Detection',
    action: async () => {
      // Get all the detection info
      const os = await getOperatingSystem(plugin);
      const platform = await getPlatform(plugin);
      const isMobile = await isMobileDevice(plugin);
      const isWeb = await isWebPlatform(plugin);
      const shouldLight = await shouldUseLightMode(plugin);
      const effective = await getEffectivePerformanceMode(plugin);
      
      // Get settings
      const setting = await plugin.settings.getSetting<string>('performanceMode');
      const autoSwitchMobile = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnMobileId);
      const autoSwitchWeb = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnWebId);
      
      // Get friendly names
      const friendlyOS = getFriendlyOSName(os);
      const friendlyPlatform = getFriendlyPlatformName(platform);
      
      // Log detailed info to console
      console.log('╔═══════════════════════════════════════════════╗');
      console.log('║   Mobile & Platform Detection Test Results   ║');
      console.log('╠═══════════════════════════════════════════════╣');
      console.log('║ ENVIRONMENT DETECTION:                        ║');
      console.log(`║   Operating System: ${friendlyOS.padEnd(26)} ║`);
      console.log(`║   Platform: ${friendlyPlatform.padEnd(32)} ║`);
      console.log(`║   Is Mobile Device: ${(isMobile ? 'Yes' : 'No').padEnd(26)} ║`);
      console.log(`║   Is Web Browser: ${(isWeb ? 'Yes' : 'No').padEnd(28)} ║`);
      console.log('║                                               ║');
      console.log('║ SETTINGS:                                     ║');
      console.log(`║   Performance Mode Setting: ${setting.padEnd(18)} ║`);
      console.log(`║   Auto Light on Mobile: ${(autoSwitchMobile !== false ? 'Enabled' : 'Disabled').padEnd(22)} ║`);
      console.log(`║   Auto Light on Web: ${(autoSwitchWeb !== false ? 'Enabled' : 'Disabled').padEnd(25)} ║`);
      console.log('║                                               ║');
      console.log('║ RESULT:                                       ║');
      console.log(`║   Should Use Light Mode: ${(shouldLight ? 'YES' : 'NO').padEnd(21)} ║`);
      console.log(`║   Effective Mode: ${effective.padEnd(26)} ║`);
      console.log('╚═══════════════════════════════════════════════╝');
      
      // Show concise toast
      await plugin.app.toast(
        `${isWeb ? '🌐' : isMobile ? '📱' : '💻'} ${friendlyPlatform} on ${friendlyOS} → ${effective.toUpperCase()} MODE`
      );
      
      // Optionally, trigger the full startup detection to see the startup toast
      console.log('\nRe-running startup detection...');
      await handleMobileDetectionOnStartup(plugin);
    },
  });

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
