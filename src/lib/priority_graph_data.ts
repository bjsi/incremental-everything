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
    /** IncRems with nextRepDate <= now */
    incRemDue: number;
    /** IncRems scheduled forward (already processed for now) */
    incRemNotDue: number;
    /** Rems with cards where dueCards > 0 */
    cardDue: number;
    /** Rems with cards where dueCards === 0 (all cards scheduled forward) */
    cardNotDue: number;
}

export interface PriorityGraphData {
    bins: GraphDataPoint[];
    binsKbRelative: GraphDataPoint[];
    lastUpdated: string;
}

/**
 * Creates 20 empty bins covering priority ranges 0-5, 5-10, ..., 95-100.
 */
type BinLabelStyle = 'integer' | 'range';

/**
 * @param style 'integer' for discrete priority values (`0-4, 5-9, ..., 95-100`),
 *              'range' for continuous percentile space with half-open bins
 *              (`0-5, 5-10, ..., 95-100`).
 */
function createBins(style: BinLabelStyle = 'integer'): GraphDataPoint[] {
    return Array(20).fill(0).map((_, i) => ({
        range: style === 'integer'
            // Discrete integer labels. Last bucket spans [95, 100] inclusive
            // because priority is clamped to 100 when binning.
            ? (i === 19 ? '95-100' : `${i * 5}-${i * 5 + 4}`)
            // Continuous half-open ranges for percentile-space binning.
            : `${i * 5}-${(i + 1) * 5}`,
        incRemDue: 0,
        incRemNotDue: 0,
        cardDue: 0,
        cardNotDue: 0,
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
    // Filter out inheritance-only rems (cardCount === 0) before percentile calculation
    const validKbCardInfos = allKbCardInfos.filter(c => c.cardCount === undefined || c.cardCount > 0);
    const kbIncRemPercentiles = calculateAllPercentiles(allKbIncRems);
    const kbCardPercentiles = calculateAllPercentiles(validKbCardInfos);

    const binsAbsolute = createBins('integer');
    const binsKbRelative = createBins('range');
    const now = Date.now();

    // Fill bins from document-scoped IncRems
    for (const item of docIncRems) {
        const isDue = item.nextRepDate <= now;
        const pAbs = Math.max(0, Math.min(100, item.priority));
        const absIndex = Math.min(Math.floor(pAbs / 5), 19);
        if (isDue) binsAbsolute[absIndex].incRemDue++;
        else binsAbsolute[absIndex].incRemNotDue++;

        // KB-wide percentile for this item
        const pKb = Math.max(0, Math.min(100, kbIncRemPercentiles[item.remId] ?? 100));
        const kbIndex = Math.min(Math.floor(pKb / 5), 19);
        if (isDue) binsKbRelative[kbIndex].incRemDue++;
        else binsKbRelative[kbIndex].incRemNotDue++;
    }

    // Fill bins from document-scoped Cards
    // Filter out inheritance-only rems (cardCount === 0) that hold the powerup
    // only for child inheritance but have no actual cards themselves.
    for (const item of docCardInfos) {
        if (item.cardCount !== undefined && item.cardCount <= 0) continue;
        const isDue = (item.dueCards ?? 0) > 0;
        const pAbs = Math.max(0, Math.min(100, item.priority));
        const absIndex = Math.min(Math.floor(pAbs / 5), 19);
        if (isDue) binsAbsolute[absIndex].cardDue++;
        else binsAbsolute[absIndex].cardNotDue++;

        const pKb = Math.max(0, Math.min(100, kbCardPercentiles[item.remId] ?? 100));
        const kbIndex = Math.min(Math.floor(pKb / 5), 19);
        if (isDue) binsKbRelative[kbIndex].cardDue++;
        else binsKbRelative[kbIndex].cardNotDue++;
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


