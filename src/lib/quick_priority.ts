import { ReactRNPlugin } from '@remnote/plugin-sdk';
import {
    powerupCode,
    priorityStepSizeId,
    pendingPriorityDeltaQueueKey,
} from './consts';
import { withQueueMutex } from './mutex';
import { getIESetting } from './settings';
import { resolveQueueCommandTarget } from './queue_target';
import { captureQueuePress, createTurnTargetResolver } from './queue_turn';
import { showMessageDialog } from './message_dialog';
import { PriorityChangeEvent } from './priority_history';

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
    /**
     * Which gesture queued this delta, recorded in both priority histories.
     * The keyboard shortcut and the Priority Editor's ± buttons share this queue
     * but are different gestures, so each names itself rather than inheriting a
     * default from the drain side.
     */
    event?: PriorityChangeEvent;
}

// The Rem a queue keypress acts on: a live selection that is not the card wins
// (the previewer), else the card or IncRem on screen. Resolved once per queue
// turn and shared by every press of that turn, so a burst of presses that reaches
// the plugin late still lands on the card it was pressed on.
const resolveQueueTarget = createTurnTargetResolver<string>(
    async (plugin) => (await resolveQueueCommandTarget(plugin)).remId
);

export async function handleQuickPriorityChange(
    plugin: ReactRNPlugin,
    direction: 'increase' | 'decrease'
) {
    // Before any await: which queue turn this keypress belongs to (lib/queue_turn).
    const press = captureQueuePress();

    // 1. Detect Context & Get Rem ID. The queue target is asked for alongside the
    //    URL, not after it: each bridge call is a chance for the queue to move first.
    let remId: string | undefined;
    const queueTarget = resolveQueueTarget(plugin, press);
    queueTarget.catch(() => undefined); // only awaited in the queue
    const url = await plugin.window.getURL();
    const isQueue = url.includes('/flashcards');

    if (isQueue) {
        const resolution = await queueTarget;
        if (resolution.status === 'moved') {
            console.log('[QuickPriority] The queue moved on before this press was resolved; nothing changed.');
            await showMessageDialog(plugin, {
                title: 'Priority not changed',
                message:
                    'The queue moved to the next card before this shortcut could tell which card it was meant for, so it changed nothing.',
                detail: 'Press it again on the card you want, or change that card from its Rem.',
                tone: 'info',
            });
            return;
        }
        remId = resolution.value;
    } else {
        // Editor context
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
    }

    // 2. Step Size
    const stepSize = await getIESetting(plugin, priorityStepSizeId);

    // Up Arrow → Number Increase (+step) → Less Important
    // Down Arrow → Number Decrease (−step) → More Important
    const delta = direction === 'increase' ? stepSize : -stepSize;

    if (!remId) {
        await plugin.app.toast('No Rem found to update priority.');
        return;
    }

    const targetRemId = remId;
    const rem = await plugin.rem.findOne(targetRemId);
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
            remId: targetRemId,
            incDelta: targetsInc ? delta : 0,
            cardDelta: targetsCard ? delta : 0,
            hasIncPowerup,
            hasCards,
            hasCardPriorityPowerup,
            event: 'quick',
        };
        existing.push(entry);
        await plugin.storage.setSession(pendingPriorityDeltaQueueKey, existing);
        console.log(`[QuickPriority] Queued delta ${delta} for remId ${targetRemId} (queue length: ${existing.length})`);
    };

    // Use the shared mutex
    withQueueMutex(doAppend).catch((err) => {
        console.error('[QuickPriority] Failed to push delta entry:', err);
    });

    // 5. Notify user with a directional hint (no raw numbers — those are applied by the tracker).
    const arrow = delta < 0 ? '🔽' : '🔺';
    const importanceMsg = delta < 0 ? 'more important' : 'less important';
    await plugin.app.toast(`Priority ${arrow} (${importanceMsg})`);
}
