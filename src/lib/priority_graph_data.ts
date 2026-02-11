import { RNPlugin } from '@remnote/plugin-sdk';
import { IncrementalRem } from './incremental_rem';
import { CardPriorityInfo } from './card_priority';
import {
    allIncrementalRemKey,
    allCardPriorityInfoKey,
    PRIORITY_GRAPH_DATA_KEY_PREFIX,
} from './consts';
import { calculateAllPercentiles } from './utils';
import { buildDocumentScope } from './scope_helpers';

export interface GraphDataPoint {
    range: string;
    incRem: number;
    card: number;
}

export interface PriorityGraphData {
    bins: GraphDataPoint[];
    binsKbRelative: GraphDataPoint[];
    lastUpdated: string;
}

/**
 * Creates 20 empty bins covering priority ranges 0-5, 5-10, ..., 95-100.
 */
function createBins(): GraphDataPoint[] {
    return Array(20).fill(0).map((_, i) => ({
        range: `${i * 5}-${(i + 1) * 5}`,
        incRem: 0,
        card: 0,
    }));
}

/**
 * Computes graph bins for a document's priority distribution.
 *
 * - Absolute bins: items binned by their raw priority value (0-100)
 * - KB-Relative bins: same document items but binned by their percentile
 *   across the ENTIRE KB (not just the document scope)
 *
 * @param docIncRems IncRems scoped to the document
 * @param docCardInfos Card infos scoped to the document
 * @param allKbIncRems All IncRems in the KB (for percentile calculation)
 * @param allKbCardInfos All card infos in the KB (for percentile calculation)
 */
export function computePriorityGraphData(
    docIncRems: IncrementalRem[],
    docCardInfos: CardPriorityInfo[],
    allKbIncRems: IncrementalRem[],
    allKbCardInfos: CardPriorityInfo[],
): PriorityGraphData {
    // Calculate percentiles against the ENTIRE KB
    const kbIncRemPercentiles = calculateAllPercentiles(allKbIncRems);
    const kbCardPercentiles = calculateAllPercentiles(allKbCardInfos);

    const binsAbsolute = createBins();
    const binsKbRelative = createBins();

    // Fill bins from document-scoped IncRems
    for (const item of docIncRems) {
        const pAbs = Math.max(0, Math.min(100, item.priority));
        const absIndex = Math.min(Math.floor(pAbs / 5), 19);
        binsAbsolute[absIndex].incRem++;

        // KB-wide percentile for this item
        const pKb = Math.max(0, Math.min(100, kbIncRemPercentiles[item.remId] ?? 100));
        const kbIndex = Math.min(Math.floor(pKb / 5), 19);
        binsKbRelative[kbIndex].incRem++;
    }

    // Fill bins from document-scoped Cards
    for (const item of docCardInfos) {
        const pAbs = Math.max(0, Math.min(100, item.priority));
        const absIndex = Math.min(Math.floor(pAbs / 5), 19);
        binsAbsolute[absIndex].card++;

        const pKb = Math.max(0, Math.min(100, kbCardPercentiles[item.remId] ?? 100));
        const kbIndex = Math.min(Math.floor(pKb / 5), 19);
        binsKbRelative[kbIndex].card++;
    }

    return {
        bins: binsAbsolute,
        binsKbRelative,
        lastUpdated: new Date().toISOString(),
    };
}

/**
 * End-to-end: computes priority distribution data for a document scope
 * and stores it in synced storage keyed by the graph Rem's ID.
 *
 * @param plugin Plugin instance
 * @param documentId The document whose scope to analyze
 * @param graphRemId The Rem ID of the graph widget (used as storage key)
 */
export async function generateAndStoreGraphData(
    plugin: RNPlugin,
    documentId: string,
): Promise<PriorityGraphData> {
    // 1. Build the document scope
    const documentScope = await buildDocumentScope(plugin as any, documentId);

    // 2. Get ALL IncRems and card infos from the KB cache
    const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
    const allCardInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];

    // 3. Filter to document scope
    const docIncRems = allIncRems.filter(r => documentScope.has(r.remId));
    const docCardInfos = allCardInfos.filter(c => documentScope.has(c.remId));

    // 4. Compute the graph data (doc-scoped items, KB-wide percentiles)
    const graphData = computePriorityGraphData(docIncRems, docCardInfos, allIncRems, allCardInfos);

    // 5. Store in synced storage keyed by DOCUMENT ID
    // We reuse the same prefix but append documentId, ensuring unique storage per document
    await plugin.storage.setSynced(PRIORITY_GRAPH_DATA_KEY_PREFIX + documentId, graphData);

    return graphData;
}


