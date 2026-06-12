import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import {
  allCardPriorityInfoKey,
  cardPriorityShieldHistoryKey,
  documentCardPriorityShieldHistoryKey,
  seenCardInSessionKey,
} from '../consts';
import { CardPriorityInfo } from './types';
import { calculateNewPriority, setCardPriority } from './index';
import * as _ from 'remeda';
import { safeRemTextToString } from '../pdfUtils';

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

export interface RogueTagResult {
  id: string;
  name: string;
  parentId?: string;
  parentName?: string;
}

/**
 * Scans a Rem's children to find Rems that have the CardPriority powerup but no flashcards natively.
 */
export async function getSpuriousCardPriorityTags(plugin: RNPlugin, rem: PluginRem, recursive: boolean = false) {
  const guaranteedRogue: RogueTagResult[] = [];
  const suspicious: RogueTagResult[] = [];

  // Fetch slot DEFINITION Rems (templates, not instances) — this is read-only and safe.
  // Each slot definition has an _id that RemNote uses to tag the actual slot instances on rems.
  const slotDefs = [
    { powerup: 'incremental', slot: 'repHist' },
    { powerup: 'incremental', slot: 'originalIncDate' },
    { powerup: 'incremental', slot: 'nextRepDate' },
    { powerup: 'incremental', slot: 'priority' },
    { powerup: 'cardPriority', slot: 'priority' },
    { powerup: 'cardPriority', slot: 'prioritySource' },
    { powerup: 'cardPriority', slot: 'lastUpdated' },
    { powerup: 'videoExtract', slot: 'videoUrl' },
    { powerup: 'videoExtract', slot: 'startTime' },
    { powerup: 'videoExtract', slot: 'endTime' },
    { powerup: 'dismissed', slot: 'dismissedHistory' },
    { powerup: 'dismissed', slot: 'dismissedDate' },
  ];

  const ownSlotDefinitionIds = new Set<string>();
  for (const { powerup, slot } of slotDefs) {
    const defRem = await plugin.powerup.getPowerupSlotByCode(powerup, slot);
    if (defRem) {
      ownSlotDefinitionIds.add(defRem._id);
    }
  }

  async function scanRem(target: PluginRem) {
    const children = await target.getChildrenRem();
    const targetName = await safeRemTextToString(plugin, target.text);

    for (const child of children) {
      const hasPowerup = await child.hasPowerup('cardPriority');
      if (hasPowerup) {
        const isProp = await child.isProperty();
        const isPowerupProp = await child.isPowerupProperty();
        
        // ONLY target property nodes. Structural rems (folders/documents) used for inheritance MUST be preserved.
        if (isProp || isPowerupProp) {
          const cards = await child.getCards();
          if (!cards || cards.length === 0) {
            const textRaw = await child.text;
            const textString = await safeRemTextToString(plugin, textRaw);
            
            // Check if this child's text references one of our own slot definitions.
            // RemNote links slot instances to their definitions via a reference in the
            // rich text content: text[0]._id points to the slot definition Rem.
            const isOwnSlot = textRaw 
              && textRaw.length > 0 
              && typeof textRaw[0] === 'object' 
              && (textRaw[0] as any)?._id 
              && ownSlotDefinitionIds.has((textRaw[0] as any)._id);
            
            if (isOwnSlot) {
              guaranteedRogue.push({ id: child._id, name: textString, parentId: target._id, parentName: targetName });
            } else {
              suspicious.push({ id: child._id, name: textString, parentId: target._id, parentName: targetName });
            }
          }
        }
      }
      if (recursive) {
        await scanRem(child);
      }
    }
  }

  await scanRem(rem);
  return { guaranteedRogue, suspicious };
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
    return { success: false, error, cleanedCount: 0 };
  } finally {
    setTimeout(async () => {
      await plugin.storage.setSession('plugin_operation_active', false);
    }, 100);
  }
}

/**
 * Walks ALL descendants of `rem` and returns content Rems (not properties/slots)
 * that have the cardPriority powerup but no flashcards. IncRems are excluded.
 *
 * Complements getSpuriousCardPriorityTags (which only inspects property/slot
 * nodes among direct children) by catching real content Rems anywhere in the
 * subtree that picked up a spurious cardPriority tag (e.g. from a cascade run).
 */
export async function findNonFlashcardDescendantsWithCardPriority(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<RogueTagResult[]> {
  const results: RogueTagResult[] = [];
  const descendants = await rem.getDescendants();
  console.log(`[NonFlashcardDescendants] Scanning ${descendants.length} descendants of ${rem._id}`);

  // Build an authoritative set of remIds that own cards by querying the global
  // card index once. rem.getCards() returns [] for rems whose cards are disabled
  // or sit inside a paused deck (see wiki: Priority-Review-Document → Card-State
  // Reference), whereas plugin.card.getAll() returns every card regardless of
  // state. The Card API Comparison in the Debug widget surfaces this discrepancy.
  // Using card.getAll() avoids false positives where a real flashcard-bearing
  // Rem (e.g. one inside a paused deck) would be wrongly flagged for removal.
  const allCards = (await plugin.card.getAll()) || [];
  const remIdsWithCards = new Set<string>();
  for (const c of allCards) {
    if (c.remId) remIdsWithCards.add(c.remId);
  }
  console.log(`[NonFlashcardDescendants] Indexed ${remIdsWithCards.size} card-bearing Rems out of ${allCards.length} total cards`);

  for (const descendant of descendants) {
    const hasCardPriority = await descendant.hasPowerup('cardPriority');
    if (!hasCardPriority) continue;

    // Skip property/slot rems — handled by the existing Sanitize Rogue Tags flow.
    const isProp = await descendant.isProperty();
    const isPowerupProp = await descendant.isPowerupProperty();
    if (isProp || isPowerupProp) continue;

    // Authoritative card check: skip if either index reports a card for this rem.
    if (remIdsWithCards.has(descendant._id)) continue;
    const cards = await descendant.getCards();
    if (cards && cards.length > 0) continue;

    // Preserve legitimate inheritance anchors: a card-less tag with a manual or
    // incremental source is intentional (user-set, or left by a dismissed
    // IncRem so its descendants keep inheriting) and must NOT be removed. This
    // also covers card-less IncRems, whose tag mirrors their inc priority as an
    // anchor — only inherited/default/empty sources are cascade artifacts.
    const source = ((await descendant.getPowerupProperty('cardPriority', 'prioritySource')) || '').toLowerCase();
    if (INTENTIONAL_PRIORITY_SOURCES.has(source)) continue;

    const name = await safeRemTextToString(plugin, descendant.text);
    results.push({
      id: descendant._id,
      name: (name || '(untitled)').slice(0, 120),
    });
  }

  console.log(`[NonFlashcardDescendants] Found ${results.length} non-flashcard descendants with cardPriority`);
  return results;
}

/**
 * Resolve the definition-Rem ids for the three cardPriority slots. RemNote tags
 * each concrete slot instance on a rem with the corresponding slot DEFINITION,
 * so these ids let us recognise (and count) cardPriority slot children.
 */
export async function getCardPrioritySlotDefIds(plugin: RNPlugin): Promise<{
  priority?: string;
  source?: string;
  lastUpdated?: string;
  all: Set<string>;
}> {
  const [prioritySlot, sourceSlot, updatedSlot] = await Promise.all([
    plugin.powerup.getPowerupSlotByCode('cardPriority', 'priority'),
    plugin.powerup.getPowerupSlotByCode('cardPriority', 'prioritySource'),
    plugin.powerup.getPowerupSlotByCode('cardPriority', 'lastUpdated'),
  ]);
  const all = new Set<string>(
    [prioritySlot?._id, sourceSlot?._id, updatedSlot?._id].filter(Boolean) as string[]
  );
  return { priority: prioritySlot?._id, source: sourceSlot?._id, lastUpdated: updatedSlot?._id, all };
}

/**
 * Count how many children of `rem` are cardPriority `priority`-slot instances.
 * A healthy rem has exactly one. This is purely diagnostic — surfaced in the
 * structure dump so we can verify whether true duplicate slots ever occur.
 * (In observed data this is always ≤1; the "multiple Priority rows" seen in the
 * RemNote UI are separate slot-rems each carrying their own cardPriority tag,
 * not duplicate slots on one rem.)
 */
async function countDuplicatePrioritySlots(
  rem: PluginRem,
  prioritySlotDefId: string | undefined
): Promise<number> {
  if (!prioritySlotDefId) return 0;
  const children = await rem.getChildrenRem();
  let count = 0;
  for (const child of children) {
    const tags = await child.getTagRems();
    if (tags.some((t) => t._id === prioritySlotDefId)) count++;
  }
  return count;
}

export interface RemPriorityStructureNode {
  id: string;
  text: string;
  depth: number;
  hasBackText: boolean;
  hasCardPriority: boolean;
  authoritativeCardCount: number; // from plugin.card.getAll()
  remGetCardsCount: number; // from rem.getCards()
  duplicatePrioritySlots: number;
  cardPrioritySource: string | null;
  cardPriorityValue: string | null;
  flags: {
    isProperty: boolean;
    isPowerupProperty: boolean;
    isPowerupSlot: boolean;
    isPowerup: boolean;
    isPowerupEnum: boolean;
    isPowerupPropertyListItem: boolean;
    isSlot: boolean;
    isCardItem: boolean;
    isListItem: boolean;
    enablePractice: boolean;
    practiceDirection: string;
  };
  tags: string[];
  classification: 'ok-card' | 'inheritance-anchor' | 'rogue-no-card';
}

/**
 * DIAGNOSTIC: walk `rem` + all descendants and capture the full structural
 * fingerprint of every node that either carries cardPriority or owns cards.
 * Logs a table to the console and returns the structured rows so the debug
 * widget can render them. This is the tool to confirm WHICH structure is being
 * mistaken for a flashcard and which process tagged it.
 */
export async function dumpRemPriorityStructure(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<RemPriorityStructureNode[]> {
  const slotDefs = await getCardPrioritySlotDefIds(plugin);
  const allCards = (await plugin.card.getAll()) || [];
  const cardCountByRem = new Map<string, number>();
  for (const c of allCards) {
    if (c.remId) cardCountByRem.set(c.remId, (cardCountByRem.get(c.remId) || 0) + 1);
  }

  const rows: RemPriorityStructureNode[] = [];

  const safeBool = async (fn?: () => Promise<boolean>): Promise<boolean> => {
    try { return fn ? !!(await fn()) : false; } catch { return false; }
  };
  const safeStr = async (fn?: () => Promise<any>, fallback = ''): Promise<string> => {
    try { return fn ? String(await fn()) : fallback; } catch { return fallback; }
  };

  const visit = async (node: PluginRem, depth: number) => {
    const hasCardPriority = await node.hasPowerup('cardPriority');
    const authoritativeCardCount = cardCountByRem.get(node._id) || 0;

    // Only record nodes that are interesting: carry cardPriority, or own cards.
    let remGetCardsCount = 0;
    try { remGetCardsCount = (await node.getCards())?.length || 0; } catch { /* ignore */ }

    if (hasCardPriority || authoritativeCardCount > 0 || remGetCardsCount > 0) {
      const r = node as any;
      const flags = {
        isProperty: await safeBool(r.isProperty?.bind(r)),
        isPowerupProperty: await safeBool(r.isPowerupProperty?.bind(r)),
        isPowerupSlot: await safeBool(r.isPowerupSlot?.bind(r)),
        isPowerup: await safeBool(r.isPowerup?.bind(r)),
        isPowerupEnum: await safeBool(r.isPowerupEnum?.bind(r)),
        isPowerupPropertyListItem: await safeBool(r.isPowerupPropertyListItem?.bind(r)),
        isSlot: await safeBool(r.isSlot?.bind(r)),
        isCardItem: await safeBool(r.isCardItem?.bind(r)),
        isListItem: await safeBool(r.isListItem?.bind(r)),
        enablePractice: await safeBool(r.getEnablePractice?.bind(r)),
        practiceDirection: await safeStr(r.getPracticeDirection?.bind(r), 'none'),
      };

      const duplicatePrioritySlots = hasCardPriority
        ? await countDuplicatePrioritySlots(node, slotDefs.priority)
        : 0;

      let cardPrioritySource: string | null = null;
      let cardPriorityValue: string | null = null;
      if (hasCardPriority) {
        try { cardPrioritySource = (await node.getPowerupProperty('cardPriority', 'prioritySource')) || null; } catch { /* ignore */ }
        try { cardPriorityValue = (await node.getPowerupProperty('cardPriority', 'priority')) || null; } catch { /* ignore */ }
      }

      const hasCards = authoritativeCardCount > 0 || remGetCardsCount > 0;
      const structural = flags.isProperty || flags.isPowerupProperty || flags.isPowerupSlot ||
        flags.isPowerup || flags.isPowerupEnum || flags.isPowerupPropertyListItem || flags.isSlot;

      // Mirror scanCandidatesForRogueCardPriority exactly so the dump labels
      // match what the sanitizer will actually do:
      //   has cards / no powerup                       → ok-card (ignored)
      //   no cards, structural node                    → rogue-no-card (strips)
      //   no cards, intentional source (manual/incr.)  → inheritance-anchor (asks)
      //   no cards, inherited/default/empty source     → rogue-no-card (strips)
      const cpSource = (cardPrioritySource || '').toLowerCase();
      let classification: RemPriorityStructureNode['classification'];
      if (!hasCardPriority || hasCards) {
        classification = 'ok-card';
      } else if (structural) {
        classification = 'rogue-no-card';
      } else if (INTENTIONAL_PRIORITY_SOURCES.has(cpSource)) {
        classification = 'inheritance-anchor';
      } else {
        classification = 'rogue-no-card';
      }

      const tags = await node.getTagRems();
      const tagNames = await Promise.all(tags.map((t) => safeRemTextToString(plugin, t.text)));

      const textRaw = node.text;
      rows.push({
        id: node._id,
        // safeRemTextToString now resolves rem references, so reference values
        // (e.g. `[Vocabulary]`) show the referenced text rather than "Untitled".
        text: (await safeRemTextToString(plugin, textRaw)).slice(0, 120),
        depth,
        hasBackText: !!(node as any).backText,
        hasCardPriority,
        authoritativeCardCount,
        remGetCardsCount,
        duplicatePrioritySlots,
        cardPrioritySource,
        cardPriorityValue,
        flags,
        tags: tagNames,
        classification,
      });
    }

    const children = await node.getChildrenRem();
    for (const child of children) {
      await visit(child, depth + 1);
    }
  };

  await visit(rem, 0);

  console.log(`\n=========== CARD PRIORITY STRUCTURE DUMP: ${rem._id} ===========`);
  console.log(`Captured ${rows.length} node(s) carrying cardPriority and/or cards.`);
  console.table(
    rows.map((r) => ({
      depth: r.depth,
      text: r.text,
      class: r.classification,
      cp: r.hasCardPriority,
      dupSlots: r.duplicatePrioritySlots,
      cardsAll: r.authoritativeCardCount,
      cardsGet: r.remGetCardsCount,
      backText: r.hasBackText,
      prop: r.flags.isProperty,
      pwProp: r.flags.isPowerupProperty,
      pwSlot: r.flags.isPowerupSlot,
      source: r.cardPrioritySource,
      id: r.id,
    }))
  );
  console.log(`Full rows:`, rows);
  console.log(`================================================================\n`);

  return rows;
}

export interface KbRogueScanResult {
  /** Tagged rems with NO cards whose source is a cascade artifact
   *  (inherited/default/empty) — safe to strip. */
  rogueNoCard: RogueTagResult[];
  /** Tagged rems with NO cards but an INTENTIONAL source (manual or incremental)
   *  — legitimate inheritance anchors. PRESERVED: reported for transparency but
   *  NEVER offered for deletion by the sanitizer. */
  preservedAnchors: RogueTagResult[];
}

/**
 * Sources that represent a DELIBERATE priority assignment and therefore make a
 * card-less cardPriority tag a legitimate inheritance anchor (NOT rogue):
 *  - `manual`      — the user set the priority directly.
 *  - `incremental` — left behind when an IncRem was dismissed, so its
 *                    descendants keep inheriting that priority. Second only to
 *                    `manual` in importance.
 * `inherited` / `default` / empty are NOT here: on a card-less rem those are
 * cascade artifacts (descendants inherit dynamically without a physical tag).
 */
const INTENTIONAL_PRIORITY_SOURCES = new Set(['manual', 'incremental']);

/**
 * Shared classification core for rogue cardPriority tags. Given candidate rems,
 * returns the rogue / preserved-anchor buckets using the authoritative card
 * index. Candidates without the cardPriority powerup are ignored (so callers can
 * pass raw subtrees). Classification is purely card-index + source based — the
 * structure dump established that the SDK structural predicates return false even
 * for real tag slots, so node-type flags would only add false negatives:
 *
 *  - has cards                                → healthy, ignored
 *  - 0 cards + intentional source (manual/incremental) → preservedAnchors (never deleted)
 *  - 0 cards + inherited / default / empty source      → rogueNoCard (strip; cascade artifact)
 */
async function scanCandidatesForRogueCardPriority(
  plugin: RNPlugin,
  candidates: PluginRem[]
): Promise<KbRogueScanResult> {
  const allCards = (await plugin.card.getAll()) || [];
  const remIdsWithCards = new Set<string>();
  for (const c of allCards) {
    if (c.remId) remIdsWithCards.add(c.remId);
  }

  const rogueNoCard: RogueTagResult[] = [];
  const preservedAnchors: RogueTagResult[] = [];

  for (const rem of candidates) {
    if (!(await rem.hasPowerup('cardPriority'))) continue;

    // Authoritative card check (both indexes; getCards catches a few card.getAll misses).
    let hasCards = remIdsWithCards.has(rem._id);
    if (!hasCards) {
      try { hasCards = ((await rem.getCards())?.length || 0) > 0; } catch { /* ignore */ }
    }
    if (hasCards) continue; // legitimate card-bearing rem

    const source = ((await rem.getPowerupProperty('cardPriority', 'prioritySource')) || '').toLowerCase();

    // safeRemTextToString now resolves rem references, so rem-reference slot
    // values like `Decks In — [Vocabulary]` show the referenced text instead of
    // "Untitled".
    const name = await safeRemTextToString(plugin, rem.text);
    const parent = await rem.getParentRem();
    const parentName = parent ? await safeRemTextToString(plugin, parent.text) : undefined;
    const base: RogueTagResult = { id: rem._id, name: name.slice(0, 120), parentId: parent?._id, parentName };

    if (INTENTIONAL_PRIORITY_SOURCES.has(source)) {
      // manual / incremental = deliberate inheritance anchor. Preserve — never
      // offered for deletion (manual = user-set; incremental = left by a
      // dismissed IncRem so descendants keep inheriting).
      preservedAnchors.push(base);
    } else {
      // inherited / default / empty on a card-less rem = cascade artifact.
      rogueNoCard.push(base);
    }
  }

  return { rogueNoCard, preservedAnchors };
}

export async function findAllRogueCardPriorityRems(plugin: RNPlugin): Promise<KbRogueScanResult> {
  const cardPriorityPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
  const taggedRems = (await cardPriorityPowerup?.taggedRem()) || [];
  return scanCandidatesForRogueCardPriority(plugin, taggedRems);
}

/**
 * Subtree-scoped version of findAllRogueCardPriorityRems: scans `rootRem` and all
 * its descendants. Used by the per-rem "Sanitize Rogue Tags" debug button so it
 * uses the same authoritative card-based detection as the global command (the
 * old per-rem path relied on slot-definition references, which — per the
 * structure dump — never matched these rogue nodes, so it never cured the rem).
 */
export async function findRogueCardPriorityRemsInSubtree(
  plugin: RNPlugin,
  rootRem: PluginRem
): Promise<KbRogueScanResult> {
  const descendants = await rootRem.getDescendants();
  return scanCandidatesForRogueCardPriority(plugin, [rootRem, ...descendants]);
}

export async function sanitizeAllRogueCardPriorityTags(plugin: RNPlugin) {
  await plugin.app.toast('Scanning knowledge base for rogue CardPriority tags...');

  const { rogueNoCard, preservedAnchors } = await findAllRogueCardPriorityRems(plugin);

  console.log(
    `[Sanitize] KB scan: ${rogueNoCard.length} rogue no-card rem(s); ` +
    `${preservedAnchors.length} manual/incremental anchor(s) preserved (not touched).`
  );
  if (preservedAnchors.length > 0) {
    console.log('[Sanitize] Preserved inheritance anchors:', preservedAnchors);
  }

  if (rogueNoCard.length === 0) {
    await plugin.app.toast(
      preservedAnchors.length > 0
        ? `No rogue tags found. (${preservedAnchors.length} manual/incremental anchor(s) preserved.)`
        : 'No rogue tags found. Your database is clean!'
    );
    return;
  }

  let totalCleaned = 0;
  const CHUNK_SIZE = 20;

  // 1) Strip rogue no-card tags (cascade artifacts: tagged slots, property
  //    values and list items that never had cards).
  if (rogueNoCard.length > 0) {
    for (let i = 0; i < rogueNoCard.length; i += CHUNK_SIZE) {
      const chunk = rogueNoCard.slice(i, i + CHUNK_SIZE);
      const listString = chunk.map((r) => `- ${r.name} (${r.id})`).join('\n');
      const chunkMsg = rogueNoCard.length > CHUNK_SIZE
        ? `(Batch ${Math.floor(i / CHUNK_SIZE) + 1} of ${Math.ceil(rogueNoCard.length / CHUNK_SIZE)})`
        : '';

      const confirmed = confirm(
        `Found ${rogueNoCard.length} ROGUE CardPriority tag(s) on rems with NO flashcards ` +
        `(inherited/default source — manual & incremental anchors are kept). This will remove ` +
        `the powerup from ${chunk.length} of them ${chunkMsg}:\n\n` +
        `${listString}\n\nContinue?`
      );
      if (!confirmed) {
        if (totalCleaned > 0) await plugin.app.toast(`Sanitize aborted. Cleaned ${totalCleaned} tag(s) total.`);
        return;
      }

      await plugin.app.toast(`Stripping ${chunk.length} rogue tag(s)...`);
      const result = await removeCardPriorityFromSpecificRems(plugin, chunk.map((r) => r.id));
      if (result.success) {
        totalCleaned += result.cleanedCount;
      } else {
        await plugin.app.toast('Sanitize failed during batch. Check console.');
        return;
      }
    }
  }

  // Manual/incremental card-less anchors are legitimate (user-set, or left by a
  // dismissed IncRem so descendants keep inheriting) and are intentionally NOT
  // offered for deletion — they're only reported (above, to the console). To
  // remove one deliberately, use the per-rem "Clear Card Priority" control.

  const anchorNote = preservedAnchors.length > 0
    ? ` (${preservedAnchors.length} manual/incremental anchor(s) preserved)`
    : '';
  await plugin.app.toast(`Sanitized! Cleaned ${totalCleaned} rogue tag(s) across your KB${anchorNote}.`);
}
