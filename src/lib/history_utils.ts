import { RemId, RNPlugin } from '@remnote/plugin-sdk';

export interface IncrementalHistoryData {
    key: number;
    remId: RemId;
    time: number;
    open?: boolean;
    kbId?: string;
    text?: string;
    _v?: number;
    /** 'reviewed' = a review session; 'created' = the rem was first made Incremental; 'dismissed' = dismissed outside a review */
    eventType?: 'reviewed' | 'created' | 'dismissed';
    /** Set on a 'reviewed' entry when the same action also dismissed the rem */
    wasDismissed?: boolean;
}

const HISTORY_KEY = 'incrementalHistoryData';
const MAX_HISTORY_ITEMS = 200;

export async function addToIncrementalHistory(
    plugin: RNPlugin,
    remId: RemId,
    opts?: { dismissed?: boolean }
) {
    if (!remId) return;

    const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
    const kbId = currentKb._id;

    const historyRaw = (await plugin.storage.getSynced<IncrementalHistoryData[]>(HISTORY_KEY)) || [];

    // Remove existing non-creation entry for this remId so it bumps to the top
    const existingIndex = historyRaw.findIndex((x) => x.remId === remId && x.eventType !== 'created');
    if (existingIndex !== -1) {
        historyRaw.splice(existingIndex, 1);
    }

    const newEntry: IncrementalHistoryData = {
        key: Math.random(),
        remId,
        time: Date.now(),
        kbId,
        _v: 1,
        eventType: 'reviewed',
        ...(opts?.dismissed ? { wasDismissed: true } : {}),
        // Text will be backfilled by the widget to keep this function fast
    };

    historyRaw.unshift(newEntry);

    if (historyRaw.length > MAX_HISTORY_ITEMS) {
        historyRaw.length = MAX_HISTORY_ITEMS;
    }

    await plugin.storage.setSynced(HISTORY_KEY, historyRaw);
}

/**
 * Logs a standalone dismissal (e.g. Ctrl+D in the editor) with no preceding
 * review. The widget renders only the red "Dismissed" badge for these.
 */
export async function addDismissalToIncrementalHistory(plugin: RNPlugin, remId: RemId) {
    if (!remId) return;

    const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
    const kbId = currentKb._id;

    const historyRaw = (await plugin.storage.getSynced<IncrementalHistoryData[]>(HISTORY_KEY)) || [];

    // Bump any prior non-creation entry for this rem to keep the timeline tidy
    const existingIndex = historyRaw.findIndex((x) => x.remId === remId && x.eventType !== 'created');
    if (existingIndex !== -1) {
        historyRaw.splice(existingIndex, 1);
    }

    const newEntry: IncrementalHistoryData = {
        key: Math.random(),
        remId,
        time: Date.now(),
        kbId,
        _v: 1,
        eventType: 'dismissed',
    };

    historyRaw.unshift(newEntry);

    if (historyRaw.length > MAX_HISTORY_ITEMS) {
        historyRaw.length = MAX_HISTORY_ITEMS;
    }

    await plugin.storage.setSynced(HISTORY_KEY, historyRaw);
}

/**
 * Adds a "created" event to the incremental history log.
 * Unlike the review helper, this never deduplicates — creation is a one-time event.
 */
export async function addCreationToIncrementalHistory(plugin: RNPlugin, remId: RemId) {
    if (!remId) return;

    const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
    const kbId = currentKb._id;

    const historyRaw = (await plugin.storage.getSynced<IncrementalHistoryData[]>(HISTORY_KEY)) || [];

    // Skip if a creation entry for this remId already exists (idempotent guard)
    if (historyRaw.some((x) => x.remId === remId && x.eventType === 'created')) return;

    const newEntry: IncrementalHistoryData = {
        key: Math.random(),
        remId,
        time: Date.now(),
        kbId,
        _v: 1,
        eventType: 'created',
    };

    historyRaw.unshift(newEntry);

    // Limit size
    if (historyRaw.length > MAX_HISTORY_ITEMS) {
        historyRaw.length = MAX_HISTORY_ITEMS;
    }

    await plugin.storage.setSynced(HISTORY_KEY, historyRaw);
}
