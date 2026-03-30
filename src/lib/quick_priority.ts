import { ReactRNPlugin, SelectionType } from '@remnote/plugin-sdk';
import {
    currentIncRemKey,
    powerupCode,
    prioritySlotCode,
    priorityStepSizeId,
    pendingPrioritySaveKey,
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
import { shouldUseLightMode } from './mobileUtils';

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
        const sel = await plugin.editor.getSelection();
        const selType = sel?.type;

        let isTargetingQueueContext = false;

        if (!selType) {
            isTargetingQueueContext = true;
        } else if (card) {
            if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(card.remId)) {
                isTargetingQueueContext = true;
            } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === card.remId) {
                isTargetingQueueContext = true;
            }
        } else {
            const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
            if (currentIncRemId) {
                if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(currentIncRemId)) {
                    isTargetingQueueContext = true;
                } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === currentIncRemId) {
                    isTargetingQueueContext = true;
                }
            }
        }

        if (isTargetingQueueContext) {
            if (card) {
                remId = card.remId;
            } else {
                remId = await plugin.storage.getSession<string>(currentIncRemKey) || undefined;
            }
        } else {
            if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
                remId = sel.remIds[0];
            } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
                remId = sel.remId;
            }
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
    let jobIncPriority: number | null = null;
    let jobCardPriority: number | null = null;
    let needsAddPowerup = false;
    let incPriorityCascadeNeeded = false;
    let cardPriorityCascadeNeeded = false;

    // --- A. Incremental Rem Priority ---
    const hasIncPowerup = await rem.hasPowerup(powerupCode);
    if (hasIncPowerup) {
        const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
        if (incRemInfo) {
            const oldPriority = incRemInfo.priority;
            const newPriority = Math.max(0, Math.min(100, oldPriority + delta));

            if (oldPriority !== newPriority) {
                jobIncPriority = newPriority;
                // Optimistic cache update
                await updateIncrementalRemCache(plugin, { ...incRemInfo, priority: newPriority });
                incPriorityCascadeNeeded = true;

                const arrow = newPriority < oldPriority ? '🔺' : '🔽';
                const importanceMsg = newPriority < oldPriority ? 'made more important' : 'made less important';
                messages.push(`IncRem priority ${oldPriority} ➡️ ${newPriority} (${importanceMsg} ${arrow})`);
            }
        }
    }

    // --- B. Card Priority ---
    const hasCards = (await rem.getCards()).length > 0;
    const hasCardPriorityPowerup = await rem.hasPowerup('cardPriority');

    if (hasCards || hasCardPriorityPowerup) {
        const cardInfo = await getCardPriority(plugin, rem);
        if (cardInfo) {
            const oldPriority = cardInfo.priority;
            const newPriority = Math.max(0, Math.min(100, oldPriority + delta));

            if (oldPriority !== newPriority) {
                jobCardPriority = newPriority;
                needsAddPowerup = !hasCardPriorityPowerup;
                
                // Optimistic cache update
                await updateCardPriorityCache(plugin, rem._id, true, { remId: rem._id, priority: newPriority, source: 'manual' } as any);
                await flushLightCacheUpdates(plugin);
                cardPriorityCascadeNeeded = true;

                const arrow = newPriority < oldPriority ? '🔺' : '🔽';
                const importanceMsg = newPriority < oldPriority ? 'made more important' : 'made less important';
                messages.push(`cardPriority ${oldPriority} ➡️ ${newPriority} (${importanceMsg} ${arrow})`);
            }
        } else {
            const oldPriority = 50; 
            const newPriority = Math.max(0, Math.min(100, oldPriority + delta));

            jobCardPriority = newPriority;
            needsAddPowerup = !hasCardPriorityPowerup;
            
            // Optimistic cache update
            await updateCardPriorityCache(plugin, rem._id, true, { remId: rem._id, priority: newPriority, source: 'manual' } as any);
            await flushLightCacheUpdates(plugin);
            cardPriorityCascadeNeeded = true;

            const arrow = newPriority < oldPriority ? '🔺' : '🔽';
            const importanceMsg = newPriority < oldPriority ? 'made more important' : 'made less important';
            messages.push(`cardPriority ${oldPriority} ➡️ ${newPriority} (${importanceMsg} ${arrow})`);
        }
    }

    // 🌲 Delegate SDK Writes and Inheritance to Background Tracker
    if (jobIncPriority !== null || jobCardPriority !== null) {
        // Global context survivor for manual edits
        try {
            const manualRems = await plugin.storage.getSession<string[]>('manual_priority_pending_rems') || [];
            if (!manualRems.includes(rem._id)) {
                manualRems.push(rem._id);
                await plugin.storage.setSession('manual_priority_pending_rems', manualRems);
            }
        } catch (err) {
            console.error(err);
        }

        plugin.storage.setSession(pendingPrioritySaveKey, {
            remId: rem._id,
            incPriority: jobIncPriority,
            cardPriority: jobCardPriority,
            cardSource: 'manual',
            needsAddPowerup: needsAddPowerup,
            triggerCascade: incPriorityCascadeNeeded || cardPriorityCascadeNeeded
        }).catch(console.error);
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
