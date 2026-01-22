import { ReactRNPlugin } from '@remnote/plugin-sdk';
import {
    currentIncRemKey,
    powerupCode,
    prioritySlotCode,
    priorityStepSizeId,
} from './consts';
import {
    getIncrementalRemFromRem,
    getCurrentIncrementalRem,
} from './incremental_rem';
import { updateIncrementalRemCache } from './incremental_rem/cache';
import {
    getCardPriority,
    setCardPriority,
} from './card_priority';
import { updateCardPriorityCache, flushLightCacheUpdates } from './card_priority/cache';

export async function handleQuickPriorityChange(
    plugin: ReactRNPlugin,
    direction: 'increase' | 'decrease'
) {
    // 1. Get Step Size
    const stepSize = await plugin.settings.getSetting<number>(priorityStepSizeId) || 10;

    // Determine numerical change:
    // Direction 'increase' (Ctrl+Shift+Up) -> Quick Increase -> Number UP? 
    // Wait, user request: "quick increase (Ctrl+Shift+Up Arrow) and decrease (Ctrl+Shift+Down Arrow) absolute priority number"
    // "Ctrl+Shift+Up Arrow would change the absolute priority from 12 to 22" -> Number +10
    // "red arrows when the absolute priority decrease (importance increase)"
    // So:
    // Up Arrow -> Number Increase (+Step) -> Less Important
    // Down Arrow -> Number Decrease (-Step) -> More Important

    const delta = direction === 'increase' ? stepSize : -stepSize;

    // 2. Detect Context & Get Rem ID
    let remId: string | undefined;
    const url = await plugin.window.getURL();
    const isQueue = url.includes('/flashcards');

    if (isQueue) {
        const card = await plugin.queue.getCurrentCard();
        if (card) {
            remId = card.remId;
        } else {
            // Fallback for non-native queue (our IncRem queue)
            remId = await plugin.storage.getSession(currentIncRemKey);
        }
    } else {
        // Editor context
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
    }

    if (!remId) {
        await plugin.app.toast('No Rem found to update priority.');
        return;
    }

    const rem = await plugin.rem.findOne(remId);
    if (!rem) return;

    // 3. Identify Targets & Apply Changes
    const messages: string[] = [];

    // --- A. Incremental Rem Priority ---
    const hasIncPowerup = await rem.hasPowerup(powerupCode);
    if (hasIncPowerup) {
        const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
        if (incRemInfo) {
            const oldPriority = incRemInfo.priority;
            const newPriority = Math.max(0, Math.min(100, oldPriority + delta));

            if (oldPriority !== newPriority) {
                await rem.setPowerupProperty(powerupCode, prioritySlotCode, [newPriority.toString()]);
                await updateIncrementalRemCache(plugin, { ...incRemInfo, priority: newPriority }); // Optimistic update if valid?
                // Actually getIncrementalRemFromRem returns object, we need to re-fetch or construct valid object for cache.
                // Easier to just re-fetch for cache validity
                const updatedIncRem = await getIncrementalRemFromRem(plugin, rem);
                if (updatedIncRem) {
                    await updateIncrementalRemCache(plugin, updatedIncRem);
                }

                const arrow = newPriority < oldPriority ? '🔺' : '🔽';
                const importanceMsg = newPriority < oldPriority ? 'made more important' : 'made less important';
                messages.push(`IncRem priority ${oldPriority} ➡️ ${newPriority} (${importanceMsg} ${arrow})`);
            }
        }
    }

    // --- B. Card Priority ---
    // Check if it has cards OR has card priority powerup
    const hasCards = (await rem.getCards()).length > 0;
    const hasCardPriorityPowerup = await rem.hasPowerup('cardPriority');

    if (hasCards || hasCardPriorityPowerup) {
        const cardInfo = await getCardPriority(plugin, rem);
        if (cardInfo) {
            const oldPriority = cardInfo.priority;
            const newPriority = Math.max(0, Math.min(100, oldPriority + delta));

            if (oldPriority !== newPriority) {
                // Signal events.ts to allow this update even if in queue (Global Context Survivor)
                plugin.storage.setSession('manual_priority_update_pending', true).catch(console.error);

                // Only set if changed
                await setCardPriority(plugin, rem, newPriority, 'manual');
                await updateCardPriorityCache(plugin, rem._id, true, { remId: rem._id, priority: newPriority, source: 'manual' } as any);
                await flushLightCacheUpdates(plugin);

                const arrow = newPriority < oldPriority ? '🔺' : '🔽';
                const importanceMsg = newPriority < oldPriority ? 'made more important' : 'made less important';
                messages.push(`cardPriority ${oldPriority} ➡️ ${newPriority} (${importanceMsg} ${arrow})`);
            }
        } else {
            // If no card info exists yet (e.g. inheritance), start from default (50?) or consider it 50.
            // getCardPriority usually returns something if we ask it, falling back to defaults/inheritance.
            // If we want to set it manually now:
            const oldPriority = 50; // Or fetch default?
            const newPriority = Math.max(0, Math.min(100, oldPriority + delta));

            // Signal events.ts to allow this update even if in queue (Global Context Survivor)
            plugin.storage.setSession('manual_priority_update_pending', true).catch(console.error);

            await setCardPriority(plugin, rem, newPriority, 'manual');
            await updateCardPriorityCache(plugin, rem._id, true, { remId: rem._id, priority: newPriority, source: 'manual' } as any);
            await flushLightCacheUpdates(plugin);

            const arrow = newPriority < oldPriority ? '🔺' : '🔽';
            const importanceMsg = newPriority < oldPriority ? 'made more important' : 'made less important';
            messages.push(`cardPriority ${oldPriority} ➡️ ${newPriority} (${importanceMsg} ${arrow})`);
        }
    }

    // 4. Notify User
    if (messages.length > 0) {
        await plugin.app.toast(messages.join('; '));
    } else {
        // If we found a rem but nothing was updated (maybe neither IncRem nor Card?)
        // Or maybe priorities were already at bounds (0 or 100)
        // We should probably inform if we detected nothing to update.
        if (!hasIncPowerup && !hasCards && !hasCardPriorityPowerup) {
            await plugin.app.toast('Element is neither an Incremental Rem nor has Cards.');
        } else {
            // Hit bounds
            await plugin.app.toast('Priority already at limit.');
        }
    }
}
