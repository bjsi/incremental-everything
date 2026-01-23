import { RemId, RNPlugin } from '@remnote/plugin-sdk';

export interface IncrementalHistoryData {
    key: number;
    remId: RemId;
    time: number;
    open?: boolean;
    kbId?: string;
    text?: string;
    _v?: number;
}

const HISTORY_KEY = 'incrementalHistoryData';
const MAX_HISTORY_ITEMS = 200;

export async function addToIncrementalHistory(plugin: RNPlugin, remId: RemId) {
    if (!remId) return;

    const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
    const kbId = currentKb._id;

    const historyRaw = (await plugin.storage.getSynced<IncrementalHistoryData[]>(HISTORY_KEY)) || [];

    // Remove existing entry for this remId if it exists to bump it to the top
    const existingIndex = historyRaw.findIndex((x) => x.remId === remId);
    if (existingIndex !== -1) {
        historyRaw.splice(existingIndex, 1);
    }

    // Add new entry
    const newEntry: IncrementalHistoryData = {
        key: Math.random(),
        remId,
        time: Date.now(),
        kbId,
        _v: 1,
        // Text will be backfilled by the widget to keep this function fast
    };

    historyRaw.unshift(newEntry);

    // Limit size
    if (historyRaw.length > MAX_HISTORY_ITEMS) {
        historyRaw.length = MAX_HISTORY_ITEMS;
    }

    await plugin.storage.setSynced(HISTORY_KEY, historyRaw);
}
