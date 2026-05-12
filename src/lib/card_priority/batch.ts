import { RNPlugin } from '@remnote/plugin-sdk';
import {
  allCardPriorityInfoKey,
  cardPriorityShieldHistoryKey,
  documentCardPriorityShieldHistoryKey,
  seenCardInSessionKey,
} from '../consts';
import { CardPriorityInfo } from './types';
import { calculateNewPriority, setCardPriority } from './index';
import * as _ from 'remeda';
import { PluginRem } from '@remnote/plugin-sdk';

export async function removeAllCardPriorityTags(plugin: RNPlugin) {
  const confirmed = confirm(
    '⚠️ Remove All CardPriority Data\n\n' +
    'This will permanently remove ALL cardPriority tags and their data from your entire knowledge base.\n\n' +
    'This action cannot be undone.\n\n' +
    'Are you sure you want to proceed?'
  );

  if (!confirmed) {
    console.log('CardPriority cleanup cancelled by user');
    await plugin.app.toast('CardPriority cleanup cancelled');
    return;
  }

  console.log('Starting CardPriority cleanup...');
  await plugin.app.toast('Starting CardPriority cleanup...');

  // Suppress GlobalRemChanged listener during bulk writes
  await plugin.storage.setSession('plugin_operation_active', true);

  try {
    const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
    const taggedRems = (await cardPriorityPowerup?.taggedRem()) || [];

    if (taggedRems.length === 0) {
      await plugin.app.toast('No CardPriority tags found to remove');
      console.log('No CardPriority tags found');
      return;
    }

    let removed = 0;
    const total = taggedRems.length;
    const batchSize = 50;

    console.log(`Found ${total} rems with CardPriority tags. Starting removal...`);
    await plugin.app.toast(`Found ${total} CardPriority tags to remove...`);

    for (let i = 0; i < taggedRems.length; i += batchSize) {
      const batch = taggedRems.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (rem) => {
          try {
            await rem.setPowerupProperty('cardPriority', 'priority', []);
            await rem.setPowerupProperty('cardPriority', 'prioritySource', []);
            await rem.setPowerupProperty('cardPriority', 'lastUpdated', []);
          } catch (e) {
            console.log(`Warning: Could not clear slots for rem ${rem._id}:`, e);
          }

          await rem.removePowerup('cardPriority');
        })
      );

      removed += batch.length;

      const progress = Math.round((removed / total) * 100);
      if (progress % 10 === 0 || removed === total) {
        await plugin.app.toast(`Cleanup progress: ${progress}% (${removed}/${total})`);
        console.log(`Cleanup progress: ${progress}% (${removed}/${total})`);
      }
    }

    console.log('Clearing session storage...');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
    await plugin.storage.setSession(seenCardInSessionKey, []);

    console.log('Clearing synced storage...');
    await plugin.storage.setSynced(cardPriorityShieldHistoryKey, {});
    await plugin.storage.setSynced(documentCardPriorityShieldHistoryKey, {});

    await plugin.app.toast(`✅ Cleanup complete! Removed ${removed} CardPriority tags.`);
    console.log(`CardPriority cleanup finished. Successfully removed ${removed} tags from knowledge base.`);

    const shouldRefresh = confirm(
      'Cleanup successful!\n\n' + 'Would you like to refresh the page to ensure a clean state?'
    );

    if (shouldRefresh) {
      window.location.reload();
    }
  } catch (error) {
    console.error('Error during CardPriority cleanup:', error);
    await plugin.app.toast('❌ Error during cleanup. Check console for details.');
    alert(
      'An error occurred during cleanup.\n\n' +
      'Some tags may not have been removed.\n' +
      'Please check the console for details.'
    );
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}

export async function updateAllCardPriorities(plugin: RNPlugin) {
  const confirmed = confirm(
    '📊 Update All Inherited Card Priorities\n\n' +
    'This will analyze all flashcards in your knowledge base and update all priorities that are inherited from their ancestors.\n\n' +
    'Your manually set card priorities will not be affected.\n\n' +
    'This ensures that manual prioritization inputs made to ancestors are properly spread to their descendants.\n\n' +
    'This may take several minutes for large collections. Continue?'
  );

  if (!confirmed) {
    console.log('Card Priorities Update cancelled by user');
    await plugin.app.toast('Card Priorities Update cancelled');
    return;
  }

  console.log('Starting Card Priorities Update...');
  await plugin.app.toast('Starting Card Priorities Update. This may take a few minutes...');

  // Suppress GlobalRemChanged listener during bulk writes
  await plugin.storage.setSession('plugin_operation_active', true);

  try {
    const startTime = Date.now();

    const allCards = await plugin.card.getAll();
    const cardRemIds = new Set(allCards.map((c) => c.remId));

    // Also include rems that have the cardPriority powerup but no cards
    // (e.g. IncRems with cardPriority set for inheritance purposes)
    const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
    const taggedRems = (await cardPriorityPowerup?.taggedRem()) || [];
    for (const rem of taggedRems) {
      cardRemIds.add(rem._id);
    }

    const uniqueRemIds = Array.from(cardRemIds);

    if (uniqueRemIds.length === 0) {
      await plugin.app.toast('No flashcards or cardPriority rems found in knowledge base');
      return;
    }

    console.log(`Found ${uniqueRemIds.length} rems to process (${allCards.length} from cards, ${taggedRems.length} from cardPriority powerup)`);
    await plugin.app.toast(`Found ${uniqueRemIds.length} rems to process...`);

    let processed = 0;
    let tagged = 0;
    let priorityChanged = 0;
    let skippedManual = 0;
    let errors = 0;
    const errorDetails: Array<{ remId: string; reason: string; error?: any }> = [];

    const batchSize = 50;

    for (let i = 0; i < uniqueRemIds.length; i += batchSize) {
      const batch = uniqueRemIds.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (remId) => {
          try {
            const rem = await plugin.rem.findOne(remId);
            if (!rem) {
              errors++;
              errorDetails.push({
                remId,
                reason: 'Rem not found - may have been deleted',
              });
              return;
            }

            const hasPowerupTag = await rem.hasPowerup('cardPriority');

            let existingPriority: CardPriorityInfo | null = null;
            if (hasPowerupTag) {
              const priorityValue = await rem.getPowerupProperty('cardPriority', 'priority');
              const source = await rem.getPowerupProperty('cardPriority', 'prioritySource');

              if (priorityValue && (source === 'manual' || source === 'incremental')) {
                skippedManual++;
                processed++;
                return;
              }

              if (priorityValue) {
                existingPriority = {
                  remId: rem._id,
                  priority: parseInt(priorityValue),
                  source: source as any,
                  lastUpdated: 0,
                  cardCount: 0,
                  dueCards: 0,
                };
              }
            }

            const oldPriorityValue = existingPriority ? existingPriority.priority : null;
            const oldPrioritySource = existingPriority ? existingPriority.source : null;

            const calculatedPriority = await calculateNewPriority(plugin, rem, existingPriority);

            if (
              !hasPowerupTag ||
              calculatedPriority.priority !== oldPriorityValue ||
              calculatedPriority.source !== oldPrioritySource
            ) {

              await setCardPriority(plugin, rem, calculatedPriority.priority, calculatedPriority.source);
              tagged++;

              if (hasPowerupTag && oldPriorityValue !== null && calculatedPriority.priority !== oldPriorityValue) {
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
              error: error,
            });
          }
        })
      );

      const progress = Math.round((processed / uniqueRemIds.length) * 100);
      if (progress % 10 === 0 || processed === uniqueRemIds.length) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        await plugin.app.toast(`Progress: ${progress}% (${processed}/${uniqueRemIds.length}) - ${elapsed}s elapsed`);
        console.log(
          `Progress: ${processed}/${uniqueRemIds.length} (${progress}%) - ` +
          `Tagged: ${tagged}, Changed: ${priorityChanged}, Skipped manual: ${skippedManual}, Errors: ${errors}`
        );
      }

      if (i + batchSize < uniqueRemIds.length) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const totalTime = Math.round((Date.now() - startTime) / 1000);

    console.log('Building optimized cache from tagged priorities...');
    await plugin.app.toast('Building optimized cache...');

    const cacheStartTime = Date.now();
    const { buildOptimizedCardPriorityCache } = await import('./cache');
    await buildOptimizedCardPriorityCache(plugin);
    const cacheTime = Math.round((Date.now() - cacheStartTime) / 1000);

    let errorBreakdown = '';
    const notFoundRemIds: string[] = [];
    if (errorDetails.length > 0) {
      const notFoundErrors = errorDetails.filter((e) => e.reason.includes('not found')).length;
      const exceptionErrors = errorDetails.filter((e) => e.reason.includes('Exception')).length;

      errorBreakdown =
        `\n• Error breakdown:\n` +
        `  - Rem not found: ${notFoundErrors}\n` +
        `  - Processing exceptions: ${exceptionErrors}`;

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

      console.log('=== FAILED REM IDs (for investigation) ===');
      console.log(errorDetails.map((e) => e.remId).join('\n'));
      console.log('=== END FAILED REM IDs ===\n');

      // Collect the remIds that were not found (potential orphan cards)
      for (const e of errorDetails) {
        if (e.reason.includes('not found')) {
          notFoundRemIds.push(e.remId);
        }
      }
    }

    const message =
      `✅ Card Priorities Update complete!\n\n` +
      `• Total rems processed: ${processed}\n` +
      `• Newly tagged: ${tagged}${priorityChanged > 0 ? ` (${priorityChanged} with changed priority)` : ''}\n` +
      `• Preserved manual priorities: ${skippedManual}\n` +
      `• Errors: ${errors}${errorBreakdown}\n` +
      `• Total time: ${totalTime}s\n` +
      `• Cache build time: ${cacheTime}s\n\n` +
      `${errors > 0 ? 'Check console for detailed error log.\n\n' : ''}`;

    console.log(message);
    await plugin.app.toast('✅ Card Priorities Update complete! See console for details.');
    alert(message);

    // Offer to clean up orphan cards whose parent Rem no longer exists
    if (notFoundRemIds.length > 0) {
      await removeOrphanCards(plugin, notFoundRemIds);
    }
  } catch (error) {
    console.error('Error during Card Priorities Update:', error);
    await plugin.app.toast('❌ Error during Card Priorities Update. Check console for details.');
    alert(
      'An error occurred during Card Priorities Update.\n\n' + 'Please check the console for details:\n' + String(error)
    );
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}

/**
 * Finds all cards that belong to Rems that no longer exist (orphan cards),
 * asks the user for confirmation, and removes them.
 *
 * @param plugin     The RNPlugin instance.
 * @param orphanRemIds  RemIds that were not found during the priority update
 *                      (i.e. `rem not found` errors).
 */
async function removeOrphanCards(plugin: RNPlugin, orphanRemIds: string[]): Promise<void> {
  await plugin.app.toast('🔍 Scanning for orphan cards...');
  console.log(`\n=== ORPHAN CARD CLEANUP ===`);
  console.log(`Checking ${orphanRemIds.length} missing remIds for associated orphan cards...`);

  // Build a fast lookup set
  const orphanRemIdSet = new Set(orphanRemIds);

  // Get every card in the knowledge base and filter to those whose rem is in our orphan set
  const allCards = await plugin.card.getAll();
  const candidateCards = allCards.filter((card) => orphanRemIdSet.has(card.remId));

  if (candidateCards.length === 0) {
    console.log('No orphan cards found — nothing to clean up.');
    await plugin.app.toast('ℹ️ No orphan cards found.');
    return;
  }

  console.log(`Found ${candidateCards.length} candidate orphan cards across ${orphanRemIds.length} missing remIds.`);

  // Double-check: re-verify that each remId truly doesn't exist right now
  // (the rem might have been loaded lazily or was a transient error)
  const confirmedOrphanCards: typeof candidateCards = [];
  for (const card of candidateCards) {
    const remCheck = await plugin.rem.findOne(card.remId);
    if (!remCheck) {
      confirmedOrphanCards.push(card);
    } else {
      console.log(`  ⚠️ Card ${card._id} skipped — rem ${card.remId} now resolves (transient error).`);
    }
  }

  if (confirmedOrphanCards.length === 0) {
    console.log('All candidate orphan cards resolved to valid rems — nothing to remove.');
    await plugin.app.toast('ℹ️ No confirmed orphan cards after re-check.');
    return;
  }

  // Group confirmed orphan cards by remId for a readable summary
  const byRemId: Record<string, number> = {};
  for (const card of confirmedOrphanCards) {
    byRemId[card.remId] = (byRemId[card.remId] || 0) + 1;
  }

  // ── Batched confirmation ─────────────────────────────────────────────
  // Show native confirm() in pages of 25 entries so the dialog stays
  // short enough to fit on screen without needing to scroll.
  const confirmPageSize = 25;
  const entries = Object.entries(byRemId); // [ [remId, count], ... ]
  const totalPages = Math.ceil(entries.length / confirmPageSize);

  // First: a summary dialog so the user knows the total scope
  const overviewOk = confirm(
    `🗑️ Remove Orphan Cards\n\n` +
    `Found ${confirmedOrphanCards.length} card(s) across ${entries.length} missing Rem(s).\n\n` +
    `These cards are no longer reviewable and take up space in your queue.\n\n` +
    `⚠️ This action cannot be undone.\n\n` +
    `You will be shown the list ${totalPages > 1 ? `in ${totalPages} pages of ${confirmPageSize}` : 'now'} to confirm.\n\n` +
    `Continue?`
  );

  if (!overviewOk) {
    console.log('Orphan card removal cancelled by user (overview).');
    await plugin.app.toast('Orphan card removal cancelled.');
    return;
  }

  // Page-by-page detail confirmation
  for (let p = 0; p < totalPages; p++) {
    const pageEntries = entries.slice(p * confirmPageSize, (p + 1) * confirmPageSize);
    const lines = pageEntries
      .map(([remId, count]) => `  • ${count} card(s) — Rem: ${remId}`)
      .join('\n');

    const pageHeader = totalPages > 1
      ? `Page ${p + 1} of ${totalPages}:\n\n`
      : '';

    const pageOk = confirm(
      `🗑️ Remove Orphan Cards — ${pageHeader}` +
      `${lines}\n\n` +
      `Confirm removal of these ${pageEntries.reduce((s, [, c]) => s + c, 0)} card(s)?`
    );

    if (!pageOk) {
      console.log(`Orphan card removal cancelled by user at page ${p + 1}.`);
      await plugin.app.toast('Orphan card removal cancelled.');
      return;
    }
  }

  // ── Removal ──────────────────────────────────────────────────────────
  // Suppress GlobalRemChanged listener during bulk writes
  await plugin.storage.setSession('plugin_operation_active', true);

  let removed = 0;
  let removalErrors = 0;
  const batchSize = 25;

  try {
    for (let i = 0; i < confirmedOrphanCards.length; i += batchSize) {
      const batch = confirmedOrphanCards.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (card) => {
          try {
            await card.remove();
            removed++;
            console.log(`  ✅ Removed orphan card ${card._id} (remId: ${card.remId})`);
          } catch (err) {
            removalErrors++;
            console.error(`  ❌ Failed to remove card ${card._id}:`, err);
          }
        })
      );

      const progress = Math.round(((i + batch.length) / confirmedOrphanCards.length) * 100);
      await plugin.app.toast(`Removing orphan cards: ${progress}% (${i + batch.length}/${confirmedOrphanCards.length})`);
    }
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }

  const resultMessage =
    `🗑️ Orphan Card Cleanup Complete\n\n` +
    `• Removed: ${removed} card(s)\n` +
    `${removalErrors > 0 ? `• Failed: ${removalErrors} card(s) — check console\n` : ''}` +
    `\nThese cards belonged to Rems that no longer exist in your knowledge base.`;

  console.log(`\n=== ORPHAN CARD CLEANUP COMPLETE ===`);
  console.log(`Removed: ${removed}, Failed: ${removalErrors}`);
  console.log(`=== END ORPHAN CARD CLEANUP ===\n`);

  await plugin.app.toast(`🗑️ Removed ${removed} orphan card(s).`);
  alert(resultMessage);
}

export async function removeCardPriorityFromRem(plugin: RNPlugin, rem: PluginRem) {
  console.log(`\n======================================================`);
  console.log(`[CardPriority Cleanup] Starting cleanup for rem: ${rem._id}`);
  
  // Set flag to block GlobalRemChanged overriding us
  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
    const cpPowerupId = cardPriorityPowerup?._id;

    const prioritySlot = await plugin.powerup.getPowerupSlotByCode('cardPriority', 'priority');
    const sourceSlot = await plugin.powerup.getPowerupSlotByCode('cardPriority', 'prioritySource');
    const updatedSlot = await plugin.powerup.getPowerupSlotByCode('cardPriority', 'lastUpdated');

    const slotIds = new Set(
      [prioritySlot?._id, sourceSlot?._id, updatedSlot?._id].filter(Boolean)
    );
    console.log(`[CardPriority Cleanup] Extracted slot IDs:`, Array.from(slotIds), `Powerup ID:`, cpPowerupId);

    const children = await rem.getChildrenRem();
    console.log(`[CardPriority Cleanup] Found ${children.length} total children on rem ${rem._id}`);

    let removedSlotsCount = 0;
    const removedChildIds: string[] = [];

    // First pass: identify and delete all explicit CardPriority properties
    for (const child of children) {
      const isProp = await child.isProperty();
      const isPowerupProp = await child.isPowerupProperty();
      
      // CRITICAL: Do not touch regular children (e.g. descendant flashcards)
      if (!isPowerupProp && !isProp) {
        continue;
      }

      const tags = await child.getTagRems();
      const tagIds = tags.map(t => t._id);
      
      const textRaw = await child.text;
      const textString = textRaw ? await plugin.richText.toString(textRaw) : '';
      const tagsMapped = await Promise.all(tags.map(async t => t.text ? await plugin.richText.toString(t.text) : t._id));
      
      const hasSlotTag = tagIds.some(id => slotIds.has(id));
      const hasPowerupTag = cpPowerupId ? tagIds.includes(cpPowerupId) : false;
      
      console.log(`[CardPriority Cleanup] Child ${child._id}: text="${textString}", isProp=${isProp}, isPowerupProp=${isPowerupProp}, tags=[${tagsMapped.join(', ')}], hasSlotTag=${hasSlotTag}`);
      
      if (hasSlotTag || hasPowerupTag) {
        console.log(`[CardPriority Cleanup] Deleting known CardPriority property child: ${child._id} (text: "${textString}")`);
        await child.remove();
        removedSlotsCount++;
        removedChildIds.push(child._id);
      } else if (isPowerupProp && tagIds.length === 0) {
        // Look closely at untagged properties to see if they look like priority values (e.g. "12", "14")
        const text = await child.text;
        const isNumericValue = text && text.length === 1 && typeof text[0] === 'string' && !isNaN(Number(text[0])) && text[0].trim() !== '';
        const isTextValue = text && text.length === 1 && typeof text[0] === 'string' && ['manual', 'incremental', 'default', 'inherited'].includes(text[0].trim().toLowerCase());
        
        if (isNumericValue || isTextValue) {
          console.log(`[CardPriority Cleanup] Deleting untagged zombie property child: ${child._id} (Value: "${text![0]}")`);
          await child.remove();
          removedSlotsCount++;
          removedChildIds.push(child._id);
        } else {
          console.log(`[CardPriority Cleanup] WARNING: Ignored untagged powerup property ${child._id} (Value did not look like CardPriority data)`);
        }
      }
    }

    console.log(`[CardPriority Cleanup] Deleting cardPriority powerup tag from parent...`);
    await rem.removePowerup('cardPriority');
    
    console.log(`[CardPriority Cleanup] Emptying properties via setPowerupProperty as fallback...`);
    try {
      await rem.setPowerupProperty('cardPriority', 'priority', []);
      await rem.setPowerupProperty('cardPriority', 'prioritySource', []);
      await rem.setPowerupProperty('cardPriority', 'lastUpdated', []);
    } catch (e) {}
    
    console.log(`[CardPriority Cleanup] SUCCESS. Removed powerup and ${removedSlotsCount} slots: [${removedChildIds.join(', ')}]`);
    console.log(`[CardPriority Cleanup] NOTE: GlobalRemChanged will likely recreate the powerup instantly because the rem has cards. This is EXPECTED and will result in a clean powerup. `);
    console.log(`======================================================\n`);
    
    return { success: true, removedSlotsCount, removedChildIds };
  } catch (error) {
    console.error(`[CardPriority Cleanup] ERROR removing cardPriority from rem ${rem._id}:`, error);
    console.log(`======================================================\n`);
    return { success: false, error };
  } finally {
    setTimeout(async () => {
      await plugin.storage.setSession('plugin_operation_active', false);
      console.log(`[CardPriority Cleanup] Released plugin_operation_active flag.`);
    }, 100);
  }
}

/**
 * Scans a Rem's children to find Rems that have the CardPriority powerup but no flashcards natively.
 */
export async function getSpuriousCardPriorityTags(plugin: RNPlugin, rem: PluginRem, recursive: boolean = false) {
  const rogueRems: { id: string; name: string }[] = [];

  async function scanRem(target: PluginRem) {
    const children = await target.getChildrenRem();
    for (const child of children) {
      const hasPowerup = await child.hasPowerup('cardPriority');
      if (hasPowerup) {
        const cards = await child.getCards();
        if (!cards || cards.length === 0) {
          const textRaw = await child.text;
          const textString = textRaw ? await plugin.richText.toString(textRaw) : 'Untitled';
          rogueRems.push({ id: child._id, name: textString || 'Untitled' });
        }
      }
      if (recursive) {
        await scanRem(child);
      }
    }
  }

  await scanRem(rem);
  return rogueRems;
}

/**
 * Removes the CardPriority powerup from a specific list of Rem IDs.
 */
export async function removeCardPriorityFromSpecificRems(plugin: RNPlugin, remIds: string[]) {
  let cleanedCount = 0;
  
  console.log(`\n======================================================`);
  console.log(`[Sanitize] Starting safe sanitize for ${remIds.length} Rems`);
  await plugin.storage.setSession('plugin_operation_active', true);

  try {
    for (const id of remIds) {
      const child = await plugin.rem.findOne(id);
      if (child) {
        console.log(`[Sanitize] Removing CardPriority from non-flashcard rem: ${child._id}`);
        await child.removePowerup('cardPriority');
        cleanedCount++;
      }
    }
    console.log(`[Sanitize] Completed. Cleaned: ${cleanedCount}`);
    return { success: true, cleanedCount };
  } catch (error) {
    console.error(`[Sanitize] Error:`, error);
    return { success: false, error };
  } finally {
    setTimeout(async () => {
      await plugin.storage.setSession('plugin_operation_active', false);
    }, 100);
  }
}

export async function cleanUpDuplicateCardPrioritySlots(plugin: RNPlugin) {
  const confirmed = confirm(
    '⚠️ Clean Up Duplicate CardPriority Slots\n\n' +
    'This will detect and remove the cardPriority powerup and all its slots from any Rem that has duplicate slots.\n\n' +
    'You can then run "Update all inherited Card Priorities" to recalculate them.\n\n' +
    'Continue?'
  );

  if (!confirmed) return;

  await plugin.app.toast('Scanning for duplicate slots...');
  await plugin.storage.setSession('plugin_operation_active', true);

  try {
    const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
    const taggedRems = (await cardPriorityPowerup?.taggedRem()) || [];

    const prioritySlot = await plugin.powerup.getPowerupSlotByCode('cardPriority', 'priority');
    const sourceSlot = await plugin.powerup.getPowerupSlotByCode('cardPriority', 'prioritySource');
    const updatedSlot = await plugin.powerup.getPowerupSlotByCode('cardPriority', 'lastUpdated');

    const slotIds = new Set(
      [prioritySlot?._id, sourceSlot?._id, updatedSlot?._id].filter(Boolean)
    );

    let remsWithDuplicates = 0;
    const cpPowerupId = cardPriorityPowerup?._id;

    for (const rem of taggedRems) {
      const children = await rem.getChildrenRem();
      const slotCounts = new Map<string, number>();

      for (const child of children) {
        const isProp = await child.isProperty();
        const isPowerupProp = await child.isPowerupProperty();
        
        if (isProp || isPowerupProp) {
          const tags = await child.getTagRems();
          const tagIds = tags.map(t => t._id);
          for (const tagId of tagIds) {
            if (slotIds.has(tagId) || tagId === cpPowerupId) {
              const countKey = slotIds.has(tagId) ? tagId : 'general_powerup_tag';
              slotCounts.set(countKey, (slotCounts.get(countKey) || 0) + 1);
            }
          }
        }
      }

      const hasDuplicates = Array.from(slotCounts.values()).some((count) => count > 1);

      if (hasDuplicates) {
        await removeCardPriorityFromRem(plugin, rem);
        remsWithDuplicates++;
      }
    }

    if (remsWithDuplicates > 0) {
      await plugin.app.toast(`✅ Cleaned up ${remsWithDuplicates} rems with duplicate slots.`);
    } else {
      await plugin.app.toast('No duplicate slots found. Your database is clean!');
    }
  } catch (error) {
    console.error('Error during duplicate slots cleanup:', error);
    await plugin.app.toast('❌ Error during cleanup. Check console for details.');
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}
