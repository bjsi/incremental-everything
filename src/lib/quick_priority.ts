import { ReactRNPlugin, SelectionType } from '@remnote/plugin-sdk';
import {
    currentIncRemKey,
    powerupCode,
    priorityStepSizeId,
    pendingPriorityDeltaQueueKey,
} from './consts';
import {
    getCurrentIncrementalRem,
} from './incremental_rem';

// Module-level promise chain used as a mutex for the session-storage append.
// All concurrent invocations of handleQuickPriorityChange chain onto this
// promise, so each read-modify-write executes strictly after the previous one
// completes — eliminating the TOCTOU race between rapid keystrokes.
let appendLock: Promise<void> = Promise.resolve();

// Shape of each entry pushed to the delta queue.
// The tracker reads the live DB value and applies all accumulated deltas atomically,
// so rapid keypresses compose correctly (3× decrease = −30 total).
export interface PriorityDeltaEntry {
    remId: string;
    // Non-zero means the keypress targeted that priority type.
    incDelta: number;
    cardDelta: number;
    // Whether the rem has the powerups (so the tracker can skip unnecessary checks).
    hasIncPowerup: boolean;
    hasCards: boolean;
    hasCardPriorityPowerup: boolean;
}

export async function handleQuickPriorityChange(
    plugin: ReactRNPlugin,
    direction: 'increase' | 'decrease'
) {
    // 1. Get Step Size
    const stepSize = await plugin.settings.getSetting<number>(priorityStepSizeId) || 10;

    // Up Arrow → Number Increase (+step) → Less Important
    // Down Arrow → Number Decrease (−step) → More Important
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

    // 3. Quick eligibility check — determine which priority types apply to this rem.
    //    We only check powerup presence here (fast); the tracker reads the actual values.
    const hasIncPowerup = await rem.hasPowerup(powerupCode);
    const hasCards = (await rem.getCards()).length > 0;
    const hasCardPriorityPowerup = await rem.hasPowerup('cardPriority');

    const targetsInc = hasIncPowerup;
    const targetsCard = hasCards || hasCardPriorityPowerup;

    if (!targetsInc && !targetsCard) {
        await plugin.app.toast('Element is neither an Incremental Rem nor has Cards.');
        return;
    }

    // 4. Serialize the append via the module-level lock so concurrent invocations
    //    (e.g. 2 keystrokes fired 5 ms apart) never race on the same queue slot.
    const doAppend = async () => {
        const existing = await plugin.storage.getSession<PriorityDeltaEntry[]>(pendingPriorityDeltaQueueKey) || [];
        const entry: PriorityDeltaEntry = {
            remId,
            incDelta: targetsInc ? delta : 0,
            cardDelta: targetsCard ? delta : 0,
            hasIncPowerup,
            hasCards,
            hasCardPriorityPowerup,
        };
        existing.push(entry);
        await plugin.storage.setSession(pendingPriorityDeltaQueueKey, existing);
        console.log(`[QuickPriority] Queued delta ${delta} for remId ${remId} (queue length: ${existing.length})`);
    };
    // Chain: appendLock = appendLock.then(doAppend) ensures serial execution.
    // We also await so that any error surfaces to the caller.
    appendLock = appendLock.then(doAppend).catch((err) => {
        console.error('[QuickPriority] Failed to push delta entry:', err);
    });

    // 5. Notify user with a directional hint (no raw numbers — those are applied by the tracker).
    const arrow = delta < 0 ? '🔽' : '🔺';
    const importanceMsg = delta < 0 ? 'more important' : 'less important';
    await plugin.app.toast(`Priority ${arrow} (${importanceMsg})`);
}
