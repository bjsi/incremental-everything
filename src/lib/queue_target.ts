import { RNPlugin, SelectionType } from '@remnote/plugin-sdk';
import { currentIncRemKey } from './consts';

/**
 * What a queue command should act on.
 *
 * Commands invoked inside the queue (`Ctrl+D`, `Ctrl+Shift+J`, …) can mean two
 * different things: "do this to the item I am reviewing" or "do this to the Rem
 * I have selected / opened in the previewer (`P`)". Resolving that consistently
 * matters because the two cases must record different things — only the item
 * actually being reviewed has a review in progress to attribute time to.
 */
export interface QueueCommandTarget {
    /** Rem the command should act on. Undefined when nothing could be resolved. */
    remId?: string;
    /** Rem id of the flashcard on screen, if the current turn is a flashcard. */
    currentCardRemId?: string;
    /**
     * The Incremental Rem the queue is showing, if this is an IncRem turn.
     * Undefined on flashcard turns — where `currentIncRemKey` still holds the
     * PREVIOUSLY injected IncRem and must never be trusted on its own.
     */
    incRemTurnRemId?: string;
    /** True when the queue is on the resolved target's own Incremental turn. */
    isActiveIncRemTurn: boolean;
    /** True when the resolved target IS the current queue item (card or IncRem). */
    isTargetingQueueContext: boolean;
}

/**
 * Resolve what a queue command should act on, preferring an explicit selection
 * over the queue item.
 *
 * The queue is on an IncRem turn only when the SDK reports no current card
 * (Plugin queue items have none) AND the session points at an injected IncRem.
 * Both halves are required — see `incRemTurnRemId` above.
 */
export async function resolveQueueCommandTarget(plugin: RNPlugin): Promise<QueueCommandTarget> {
    const card = await plugin.queue.getCurrentCard();
    const sel = await plugin.editor.getSelection();
    const selType = sel?.type;

    const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
    const incRemTurnRemId = !card ? currentIncRemId || undefined : undefined;

    // The Rem behind whatever the queue is showing right now.
    const queueItemRemId = card ? card.remId : incRemTurnRemId;

    let selectionRemIds: string[] = [];
    if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
        selectionRemIds = sel.remIds;
    } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
        selectionRemIds = [sel.remId];
    }

    // No selection at all means the user is looking at the queue item itself.
    const isTargetingQueueContext =
        !selType || (!!queueItemRemId && selectionRemIds.includes(queueItemRemId));

    const remId = isTargetingQueueContext ? queueItemRemId : selectionRemIds[0];

    return {
        remId,
        currentCardRemId: card?.remId,
        incRemTurnRemId,
        isActiveIncRemTurn: !!incRemTurnRemId && !!remId && remId === incRemTurnRemId,
        isTargetingQueueContext,
    };
}
