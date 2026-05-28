import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    BuiltInPowerupCodes,
    Card,
    PluginRem,
    QueueInteractionScore,
    renderWidget,
    usePlugin,
    useRunAsync,
    WidgetLocation,
} from '@remnote/plugin-sdk';
import { IncrementalRep } from '../lib/incremental_rem/types';
import {
    dismissedHistorySlotCode,
    dismissedPowerupCode,
    powerupCode,
    repHistorySlotCode,
    studyDashboardLastPeriodKey,
} from '../lib/consts';
import { CARD_PRIORITY_CODE } from '../lib/card_priority/types';
import { buildComprehensiveScope } from '../lib/scope_helpers';
import { formatDuration, tryParseJson } from '../lib/utils';
import { Period, resolvePeriod, parseDateInput, formatDateForDisplay } from '../lib/period';
import { resolveRemTextSegments } from '../lib/richTextRemRefs';
import { RemText, RemTextSegments } from '../components';
import '../style.css';
import '../App.css';

// ---------------------------------------------------------------------------
// Style helpers (mirroring the statistics plugin's chartHelpers)
// ---------------------------------------------------------------------------
const ACCENT_COLOR = '#3362f0';
function getBoxStyle(): React.CSSProperties {
    return {
        backgroundColor: 'var(--rn-clr-background-secondary)',
        borderColor: 'var(--rn-clr-border-primary)',
        color: 'var(--rn-clr-content-primary)',
    };
}
function getInputStyle(): React.CSSProperties {
    return {
        backgroundColor: 'var(--rn-clr-background-primary)',
        borderColor: 'var(--rn-clr-border-primary)',
        color: 'var(--rn-clr-content-primary)',
    };
}
function getButtonStyle(isSelected: boolean): React.CSSProperties {
    return {
        backgroundColor: isSelected ? ACCENT_COLOR : 'var(--rn-clr-background-primary)',
        color: isSelected ? '#fff' : 'var(--rn-clr-content-secondary)',
        border: isSelected ? 'none' : '1px solid var(--rn-clr-border-primary)',
        boxShadow: isSelected ? '0 2px 8px rgba(0,0,0,0.15)' : '0 1px 2px 0 rgba(0,0,0,0.05)',
        fontWeight: isSelected ? 600 : 400,
        transform: isSelected ? 'scale(1.02)' : 'scale(1)',
        transition: 'all 0.2s ease-in-out',
    };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContextMode = 'global' | 'document';
type ScopeMode = 'descendants' | 'comprehensive';

interface CardData {
    id: string;
    remId: string;
    history: any[]; // card.repetitionHistory
}

interface RemData {
    id: string;
    parentId: string | null;
    remText: any;
    isInc: boolean;
    isDism: boolean;
    incHistory: IncrementalRep[];
    dismHistory: IncrementalRep[];
    cards: CardData[]; // cards directly attached to this rem
}

interface PeriodStats {
    incRemReps: number;
    incRemTimeSec: number;
    cardReps: number;
    cardTimeMs: number;
    cardForgot: number;
    // Distinct-card counts (for "items with reps")
    cardsWithRepsCount: number;
}

interface SummaryStats {
    incTaggedCount: number;
    incTaggedWithRepsCount: number;
    incReps: number;
    incTimeSec: number;

    dismTaggedCount: number;
    dismTaggedWithRepsCount: number;
    dismReps: number;
    dismTimeSec: number;

    cardsCount: number;
    cardsWithRepsCount: number;
    cardReps: number;
    cardTimeMs: number;
    cardForgot: number;
}

interface TreeNode {
    id: string; // rem id
    childrenIds: string[];
    // selfData null = structural-only ancestor
    selfData: RemData | null;
    // aggregate stats for self + descendants in the period
    aggr: PeriodStats;
    // counts for self + descendants
    aggrIncTagged: number;
    aggrDismTagged: number;
    aggrIncTaggedWithReps: number;
    aggrDismTaggedWithReps: number;
    aggrCardsCount: number;
    // text loaded lazily by component
    remText?: any;
}

interface BuiltTree {
    nodes: Record<string, TreeNode>;
    rootIds: string[];
}

interface DashboardData {
    // For document mode: the full tree (already built)
    tree?: BuiltTree;
    // For global mode: per-top-level pre-computed aggregates, subtrees built on expand
    topLevels?: Array<{
        topId: string;
        aggr: PeriodStats;
        aggrIncTagged: number;
        aggrDismTagged: number;
        aggrIncTaggedWithReps: number;
        aggrDismTaggedWithReps: number;
        aggrCardsCount: number;
    }>;
    summary: SummaryStats;
}

interface ProgressState {
    running: boolean;
    percent: number;
    label: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_RESPONSE_TIME_LIMIT_SEC = 180;
const FLASHCARD_RESPONSE_TIME_LIMIT_SETTING = 'flashcard_response_time_limit';

function isRealIncRep(et: IncrementalRep['eventType']): boolean {
    return (
        et === undefined ||
        et === 'rep' ||
        et === 'executeRepetition' ||
        et === 'rescheduledInQueue'
    );
}

function isRealCardScore(score: number | undefined): boolean {
    if (score === undefined) return false;
    return (
        score === QueueInteractionScore.AGAIN ||
        score === QueueInteractionScore.HARD ||
        score === QueueInteractionScore.GOOD ||
        score === QueueInteractionScore.EASY
    );
}

// When the "Ignore reps before last RESET" toggle is active, drop everything
// up to and including the last RESET in each card's history. Useful after
// importing documents whose foreign repetition history would otherwise pollute
// retention / CPM / time metrics. Pre-RESET history is preserved on disk —
// this is purely a presentation-time filter.
function effectiveCardHistory(
    history: any[] | undefined,
    ignorePreReset: boolean
): any[] {
    if (!history || history.length === 0) return [];
    if (!ignorePreReset) return history;
    let lastResetIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i] && history[i].score === QueueInteractionScore.RESET) {
            lastResetIdx = i;
            break;
        }
    }
    if (lastResetIdx === -1) return history;
    return history.slice(lastResetIdx + 1);
}


function emptyStats(): PeriodStats {
    return {
        incRemReps: 0,
        incRemTimeSec: 0,
        cardReps: 0,
        cardTimeMs: 0,
        cardForgot: 0,
        cardsWithRepsCount: 0,
    };
}

function addStats(a: PeriodStats, b: PeriodStats): PeriodStats {
    return {
        incRemReps: a.incRemReps + b.incRemReps,
        incRemTimeSec: a.incRemTimeSec + b.incRemTimeSec,
        cardReps: a.cardReps + b.cardReps,
        cardTimeMs: a.cardTimeMs + b.cardTimeMs,
        cardForgot: a.cardForgot + b.cardForgot,
        cardsWithRepsCount: a.cardsWithRepsCount + b.cardsWithRepsCount,
    };
}

function statsFromRem(
    rem: RemData,
    startMs: number,
    endMs: number,
    cardCapMs: number,
    ignorePreReset: boolean
): { self: PeriodStats; hasIncReps: boolean; hasDismReps: boolean } {
    const s = emptyStats();
    let hasIncReps = false;
    let hasDismReps = false;
    for (const rep of rem.incHistory) {
        if (!rep || typeof rep.date !== 'number') continue;
        if (rep.date < startMs || rep.date >= endMs) continue;
        if (!isRealIncRep(rep.eventType)) continue;
        s.incRemReps += 1;
        s.incRemTimeSec += rep.reviewTimeSeconds || 0;
        hasIncReps = true;
    }
    for (const rep of rem.dismHistory) {
        if (!rep || typeof rep.date !== 'number') continue;
        if (rep.date < startMs || rep.date >= endMs) continue;
        if (!isRealIncRep(rep.eventType)) continue;
        s.incRemReps += 1;
        s.incRemTimeSec += rep.reviewTimeSeconds || 0;
        hasDismReps = true;
    }
    for (const card of rem.cards) {
        let cardHasReps = false;
        for (const rep of effectiveCardHistory(card.history, ignorePreReset)) {
            if (!rep || typeof rep.date !== 'number') continue;
            if (rep.date < startMs || rep.date >= endMs) continue;
            if (!isRealCardScore(rep.score)) continue;
            const t = Math.min(Math.max(0, rep.responseTime || 0), cardCapMs);
            s.cardReps += 1;
            s.cardTimeMs += t;
            if (rep.score === QueueInteractionScore.AGAIN) s.cardForgot += 1;
            cardHasReps = true;
        }
        if (cardHasReps) s.cardsWithRepsCount += 1;
    }
    return { self: s, hasIncReps, hasDismReps };
}

// Fast tag/history fetch (avoids the heavier getIncrementalRemFromRem)
async function readIncHistoryRaw(rem: PluginRem): Promise<IncrementalRep[]> {
    try {
        const raw = await rem.getPowerupProperty(powerupCode, repHistorySlotCode);
        const parsed = tryParseJson(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}
async function readDismHistoryRaw(rem: PluginRem): Promise<IncrementalRep[]> {
    try {
        const raw = await rem.getPowerupProperty(dismissedPowerupCode, dismissedHistorySlotCode);
        const parsed = tryParseJson(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

const CHUNK = 50;
async function chunked<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    onProgress?: (done: number, total: number) => void
): Promise<R[]> {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += CHUNK) {
        const slice = items.slice(i, i + CHUNK);
        const out = await Promise.all(slice.map(fn));
        results.push(...out);
        if (onProgress) onProgress(Math.min(i + CHUNK, items.length), items.length);
    }
    return results;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadRemData(
    _plugin: ReturnType<typeof usePlugin>,
    rem: PluginRem
): Promise<RemData> {
    const [isInc, isDism, cards] = await Promise.all([
        rem.hasPowerup(powerupCode),
        rem.hasPowerup(dismissedPowerupCode),
        rem.getCards().catch(() => [] as Card[]),
    ]);
    const incHistory = isInc ? await readIncHistoryRaw(rem) : [];
    const dismHistory = isDism ? await readDismHistoryRaw(rem) : [];
    return {
        id: rem._id,
        parentId: rem.parent || null,
        remText: rem.text,
        isInc,
        isDism,
        incHistory,
        dismHistory,
        cards: (cards || []).map((c) => ({
            id: c._id,
            remId: c.remId,
            history: (c as any).repetitionHistory || [],
        })),
    };
}

// Period-independent loaded data for Document mode. Cached per (rootRemId, scope).
interface LoadedDocumentData {
    rootRemId: string;
    scope: ScopeMode;
    remDataList: RemData[];
    remDataById: Record<string, RemData>;
    stubData: Record<string, { parentId: string | null; remText: any }>;
    childMap: Record<string, string[]>;
    rawRootIds: string[]; // unfiltered roots — period filter applied at aggregate time
}

async function loadDocumentData(
    plugin: ReturnType<typeof usePlugin>,
    rootRem: PluginRem,
    scope: ScopeMode,
    onProgress: (p: number, label: string) => void
): Promise<LoadedDocumentData> {
    onProgress(0.02, 'Fetching tagged rems…');

    // Same bulk strategy as Global: pull inc/dism/cardPriority taggedRems plus all
    // cards once, then iterate the scope without per-rem hasPowerup / getCards calls.
    const [incPup, dismPup, cpPup] = await Promise.all([
        plugin.powerup.getPowerupByCode(powerupCode),
        plugin.powerup.getPowerupByCode(dismissedPowerupCode),
        plugin.powerup.getPowerupByCode(CARD_PRIORITY_CODE),
    ]);
    const [incRems, dismRems, cpRems, allCards] = await Promise.all([
        (incPup?.taggedRem() as Promise<PluginRem[] | undefined>) || Promise.resolve([]),
        (dismPup?.taggedRem() as Promise<PluginRem[] | undefined>) || Promise.resolve([]),
        (cpPup?.taggedRem() as Promise<PluginRem[] | undefined>) || Promise.resolve([]),
        plugin.card.getAll(),
    ]);

    // pluginRemById: every PluginRem we already have (no findOne needed for these).
    const pluginRemById = new Map<string, PluginRem>();
    for (const r of cpRems || []) pluginRemById.set(r._id, r);
    for (const r of incRems || []) pluginRemById.set(r._id, r);
    for (const r of dismRems || []) pluginRemById.set(r._id, r);

    const incSet = new Set((incRems || []).map((r) => r._id));
    const dismSet = new Set((dismRems || []).map((r) => r._id));

    const cardsByRem = new Map<string, CardData[]>();
    for (const c of allCards || []) {
        const cd: CardData = {
            id: c._id,
            remId: c.remId,
            history: (c as any).repetitionHistory || [],
        };
        let arr = cardsByRem.get(c.remId);
        if (!arr) {
            arr = [];
            cardsByRem.set(c.remId, arr);
        }
        arr.push(cd);
    }

    onProgress(0.12, 'Gathering scope…');

    let scopeIds: string[];
    if (scope === 'descendants') {
        const descendants = await rootRem.getDescendants();
        const all = [rootRem, ...descendants];
        for (const r of all) {
            if (!pluginRemById.has(r._id)) pluginRemById.set(r._id, r);
        }
        scopeIds = all.map((r) => r._id);
    } else {
        const set = await buildComprehensiveScope(plugin, rootRem._id);
        scopeIds = Array.from(set);
    }

    onProgress(0.3, `Resolving ${scopeIds.length} rems…`);

    // Any scope ids whose PluginRem we don't already have — fetch in parallel.
    // For typical KBs this is a small minority since cardPriority covers most.
    const missingIds: string[] = [];
    for (const id of scopeIds) {
        if (!pluginRemById.has(id)) missingIds.push(id);
    }
    if (missingIds.length > 0) {
        await chunked(
            missingIds,
            async (id) => {
                const r = await plugin.rem.findOne(id);
                if (r) pluginRemById.set(id, r);
                return null;
            },
            (done, total) =>
                onProgress(0.3 + 0.2 * (done / Math.max(1, total)), `Loading rems (${done}/${total})`)
        );
    }

    onProgress(0.5, 'Classifying…');

    // Classify scope rems: data-bearing (inc/dism tagged or has cards) vs structural-only.
    const remDataList: RemData[] = [];
    const remDataById: Record<string, RemData> = {};
    const stubData: Record<string, { parentId: string | null; remText: any }> = {};
    const taggedScopeIds: string[] = []; // need history reads

    for (const id of scopeIds) {
        const rem = pluginRemById.get(id);
        if (!rem) continue;
        const isInc = incSet.has(id);
        const isDism = dismSet.has(id);
        const cards = cardsByRem.get(id) || [];
        if (isInc || isDism) {
            taggedScopeIds.push(id);
        } else if (cards.length > 0) {
            // Card-only rem: no history to fetch — populate immediately.
            const rd: RemData = {
                id,
                parentId: rem.parent || null,
                remText: rem.text,
                isInc: false,
                isDism: false,
                incHistory: [],
                dismHistory: [],
                cards,
            };
            remDataById[id] = rd;
            remDataList.push(rd);
        } else {
            // No data — keep as structural node so the tree stays connected.
            stubData[id] = { parentId: rem.parent || null, remText: rem.text };
        }
    }

    onProgress(0.55, `Reading histories for ${taggedScopeIds.length} tagged rems…`);

    // Read histories only for tagged-in-scope rems — orders of magnitude less than
    // running loadRemData on every scope rem.
    await chunked(
        taggedScopeIds,
        async (id) => {
            const rem = pluginRemById.get(id);
            if (!rem) return null;
            const isInc = incSet.has(id);
            const isDism = dismSet.has(id);
            const cards = cardsByRem.get(id) || [];
            const [incHistory, dismHistory] = await Promise.all([
                isInc ? readIncHistoryRaw(rem) : Promise.resolve([] as IncrementalRep[]),
                isDism ? readDismHistoryRaw(rem) : Promise.resolve([] as IncrementalRep[]),
            ]);
            const rd: RemData = {
                id,
                parentId: rem.parent || null,
                remText: rem.text,
                isInc,
                isDism,
                incHistory,
                dismHistory,
                cards,
            };
            remDataById[id] = rd;
            remDataList.push(rd);
            return null;
        },
        (done, total) =>
            onProgress(0.55 + 0.3 * (done / Math.max(1, total)), `Histories (${done}/${total})`)
    );

    onProgress(0.87, 'Resolving ancestors…');

    // Walk every in-scope node's parent chain — both data-bearing rems AND structural
    // stubs — and add any unseen ancestors as new structural stubs. Doing this for both
    // scope modes (not just comprehensive) protects against fragmented trees when a
    // rem's `.parent` points outside whatever the scope-builder gathered.
    const ancestorIds = new Set<string>();
    const inScopeSet = new Set<string>([...Object.keys(remDataById), ...Object.keys(stubData)]);
    const startingIds: string[] = [...Object.keys(remDataById), ...Object.keys(stubData)];
    for (const id of startingIds) {
        let p = (remDataById[id]?.parentId ?? stubData[id]?.parentId) || null;
        while (p && !inScopeSet.has(p) && !ancestorIds.has(p)) {
            ancestorIds.add(p);
            let ancestor = pluginRemById.get(p);
            if (!ancestor) {
                ancestor = (await plugin.rem.findOne(p)) || undefined;
                if (ancestor) pluginRemById.set(p, ancestor);
            }
            if (!ancestor) break;
            p = ancestor.parent || null;
        }
    }
    for (const id of ancestorIds) {
        const r = pluginRemById.get(id);
        if (r) stubData[id] = { parentId: r.parent || null, remText: r.text };
    }

    onProgress(0.95, 'Building tree…');

    // Build child map (period-independent — just the static hierarchy).
    const allNodeIds = new Set<string>([...Object.keys(remDataById), ...Object.keys(stubData)]);
    const childMap: Record<string, string[]> = {};
    const rawRootIds: string[] = [];

    for (const id of allNodeIds) {
        const parentId = (remDataById[id]?.parentId ?? stubData[id]?.parentId) || null;
        if (parentId && allNodeIds.has(parentId)) {
            (childMap[parentId] ||= []).push(id);
        } else {
            rawRootIds.push(id);
        }
    }

    onProgress(1, 'Loaded');

    return {
        rootRemId: rootRem._id,
        scope,
        remDataList,
        remDataById,
        stubData,
        childMap,
        rawRootIds,
    };
}

// Aggregate already-loaded document data for a specific period. Pure in-memory work.
function aggregateDocumentData(
    data: LoadedDocumentData,
    startMs: number,
    endMs: number,
    cardCapMs: number,
    ignorePreReset: boolean,
    onProgress: (p: number, label: string) => void
): { tree: BuiltTree; summary: SummaryStats } {
    const { remDataList, remDataById, stubData, childMap, rawRootIds } = data;
    onProgress(0.05, 'Aggregating…');

    const nodes: Record<string, TreeNode> = {};
    function compute(id: string): TreeNode {
        if (nodes[id]) return nodes[id];
        const d = remDataById[id] || null;
        const rawChildrenIds = childMap[id] || [];

        const self = d ? statsFromRem(d, startMs, endMs, cardCapMs, ignorePreReset) : null;
        let aggr = self ? self.self : emptyStats();
        let aggrIncTagged = d && d.isInc ? 1 : 0;
        let aggrDismTagged = d && d.isDism ? 1 : 0;
        let aggrIncTaggedWithReps = d && d.isInc && self && self.hasIncReps ? 1 : 0;
        let aggrDismTaggedWithReps = d && d.isDism && self && self.hasDismReps ? 1 : 0;
        let aggrCardsCount = d ? d.cards.length : 0;

        const childrenIds: string[] = [];
        for (const c of rawChildrenIds) {
            const child = compute(c);
            aggr = addStats(aggr, child.aggr);
            aggrIncTagged += child.aggrIncTagged;
            aggrDismTagged += child.aggrDismTagged;
            aggrIncTaggedWithReps += child.aggrIncTaggedWithReps;
            aggrDismTaggedWithReps += child.aggrDismTaggedWithReps;
            aggrCardsCount += child.aggrCardsCount;
            if (child.aggr.incRemReps > 0 || child.aggr.cardReps > 0) {
                childrenIds.push(c);
            }
        }

        nodes[id] = {
            id,
            childrenIds,
            selfData: d,
            aggr,
            aggrIncTagged,
            aggrDismTagged,
            aggrIncTaggedWithReps,
            aggrDismTaggedWithReps,
            aggrCardsCount,
            remText: d?.remText ?? stubData[id]?.remText,
        };
        return nodes[id];
    }

    for (const rid of rawRootIds) compute(rid);

    // Drop roots whose entire subtree has no reps in the selected period, then
    // sort by total time descending (same convention as Global mode).
    const filteredRootIds = rawRootIds
        .filter((id) => {
            const n = nodes[id];
            return n && (n.aggr.incRemReps > 0 || n.aggr.cardReps > 0);
        })
        .sort((a, b) => {
            const na = nodes[a].aggr;
            const nb = nodes[b].aggr;
            const tA = na.cardTimeMs + na.incRemTimeSec * 1000;
            const tB = nb.cardTimeMs + nb.incRemTimeSec * 1000;
            return tB - tA;
        });

    // Also sort each node's filtered children by total time descending.
    for (const id of Object.keys(nodes)) {
        const node = nodes[id];
        if (node.childrenIds.length > 1) {
            node.childrenIds.sort((a, b) => {
                const na = nodes[a].aggr;
                const nb = nodes[b].aggr;
                const tA = na.cardTimeMs + na.incRemTimeSec * 1000;
                const tB = nb.cardTimeMs + nb.incRemTimeSec * 1000;
                return tB - tA;
            });
        }
    }

    // Summary — walk remDataList directly.
    const summary: SummaryStats = {
        incTaggedCount: 0,
        incTaggedWithRepsCount: 0,
        incReps: 0,
        incTimeSec: 0,
        dismTaggedCount: 0,
        dismTaggedWithRepsCount: 0,
        dismReps: 0,
        dismTimeSec: 0,
        cardsCount: 0,
        cardsWithRepsCount: 0,
        cardReps: 0,
        cardTimeMs: 0,
        cardForgot: 0,
    };

    for (const rd of remDataList) {
        const { hasIncReps, hasDismReps } = statsFromRem(rd, startMs, endMs, cardCapMs, ignorePreReset);
        if (rd.isInc) {
            summary.incTaggedCount += 1;
            if (hasIncReps) summary.incTaggedWithRepsCount += 1;
            let incReps = 0;
            let incTime = 0;
            for (const rep of rd.incHistory) {
                if (!rep || typeof rep.date !== 'number') continue;
                if (rep.date < startMs || rep.date >= endMs) continue;
                if (!isRealIncRep(rep.eventType)) continue;
                incReps += 1;
                incTime += rep.reviewTimeSeconds || 0;
            }
            summary.incReps += incReps;
            summary.incTimeSec += incTime;
        }
        if (rd.isDism) {
            summary.dismTaggedCount += 1;
            if (hasDismReps) summary.dismTaggedWithRepsCount += 1;
            let dismReps = 0;
            let dismTime = 0;
            for (const rep of rd.dismHistory) {
                if (!rep || typeof rep.date !== 'number') continue;
                if (rep.date < startMs || rep.date >= endMs) continue;
                if (!isRealIncRep(rep.eventType)) continue;
                dismReps += 1;
                dismTime += rep.reviewTimeSeconds || 0;
            }
            summary.dismReps += dismReps;
            summary.dismTimeSec += dismTime;
        }
        for (const card of rd.cards) {
            summary.cardsCount += 1;
            let cardHasReps = false;
            for (const rep of effectiveCardHistory(card.history, ignorePreReset)) {
                if (!rep || typeof rep.date !== 'number') continue;
                if (rep.date < startMs || rep.date >= endMs) continue;
                if (!isRealCardScore(rep.score)) continue;
                const t = Math.min(Math.max(0, rep.responseTime || 0), cardCapMs);
                summary.cardReps += 1;
                summary.cardTimeMs += t;
                if (rep.score === QueueInteractionScore.AGAIN) summary.cardForgot += 1;
                cardHasReps = true;
            }
            if (cardHasReps) summary.cardsWithRepsCount += 1;
        }
    }

    onProgress(1, 'Done');
    return { tree: { nodes, rootIds: filteredRootIds }, summary };
}

// Period-independent loaded data — fetched once per (re)load and reused across
// period changes. Caches survive between aggregations so subsequent aggregations
// hit zero RPCs.
interface LoadedGlobalData {
    remDataById: Map<string, RemData>;
    parentChainCache: Map<string, string[]>;
    remTextCache: Map<string, any>;
    // Pre-populated parent map sourced from taggedRem PluginRems (free `.parent` access).
    // Covers Incremental + Dismissed + cardPriority rems — typically ~all rems-with-data
    // in a healthy KB, so chain walks need almost no `findOne` RPCs.
    parentByRemId: Map<string, string | null>;
}

async function loadGlobalData(
    plugin: ReturnType<typeof usePlugin>,
    onProgress: (p: number, label: string) => void
): Promise<LoadedGlobalData> {
    onProgress(0.02, 'Fetching tagged rems…');

    const [incPup, dismPup, cpPup] = await Promise.all([
        plugin.powerup.getPowerupByCode(powerupCode),
        plugin.powerup.getPowerupByCode(dismissedPowerupCode),
        plugin.powerup.getPowerupByCode(CARD_PRIORITY_CODE),
    ]);
    const [incRems, dismRems, cpRems, allCards] = await Promise.all([
        (incPup?.taggedRem() as Promise<PluginRem[] | undefined>) || Promise.resolve([]),
        (dismPup?.taggedRem() as Promise<PluginRem[] | undefined>) || Promise.resolve([]),
        (cpPup?.taggedRem() as Promise<PluginRem[] | undefined>) || Promise.resolve([]),
        plugin.card.getAll(),
    ]);
    const incList = incRems || [];
    const dismList = dismRems || [];
    const cpList = cpRems || [];

    onProgress(
        0.08,
        `Inc: ${incList.length}, Dism: ${dismList.length}, CardPri: ${cpList.length}, Cards: ${allCards?.length || 0}`
    );

    // Pre-populate parent and text caches from every taggedRem PluginRem we have.
    // For ~all rems-with-data in a healthy KB this eliminates the need to call
    // `findOne` during chain walking — chains become essentially in-memory.
    const parentByRemId = new Map<string, string | null>();
    const remTextCache = new Map<string, any>();
    const seedParent = (r: PluginRem) => {
        if (!parentByRemId.has(r._id)) parentByRemId.set(r._id, r.parent || null);
        if (!remTextCache.has(r._id)) remTextCache.set(r._id, r.text);
    };
    for (const r of cpList) seedParent(r);
    for (const r of incList) seedParent(r);
    for (const r of dismList) seedParent(r);

    // Index unique inc/dism tagged rems — we need to read their histories.
    const taggedById = new Map<string, PluginRem>();
    for (const r of incList) taggedById.set(r._id, r);
    for (const r of dismList) taggedById.set(r._id, r);

    // Read inc/dism histories
    const taggedDataById = new Map<string, RemData>();
    const taggedArr = Array.from(taggedById.values());
    await chunked(
        taggedArr,
        async (r) => {
            const data = await loadRemData(plugin, r);
            // For globally tagged rems we don't need .cards from this path — overwrite later via allCards.
            data.cards = [];
            taggedDataById.set(r._id, data);
            return null;
        },
        (done, total) =>
            onProgress(0.08 + 0.55 * (done / Math.max(1, total)), `History (${done}/${total})`)
    );

    onProgress(0.65, 'Processing cards…');

    // Group cards by remId. We use plugin.card.getAll() rather than per-rem fetches.
    const cardsByRem = new Map<string, CardData[]>();
    for (const c of allCards || []) {
        const cd: CardData = {
            id: c._id,
            remId: c.remId,
            history: (c as any).repetitionHistory || [],
        };
        let arr = cardsByRem.get(c.remId);
        if (!arr) {
            arr = [];
            cardsByRem.set(c.remId, arr);
        }
        arr.push(cd);
    }

    // Build a unified rem-data map: tagged rems + rems that own cards.
    const remDataById = new Map<string, RemData>(taggedDataById);
    for (const [remId, cards] of cardsByRem) {
        const existing = remDataById.get(remId);
        if (existing) {
            existing.cards = cards;
        } else {
            // Card-only rem. Pull parent/text from the cardPriority-seeded map if
            // present; otherwise leave null and ancestorChain will findOne lazily.
            remDataById.set(remId, {
                id: remId,
                parentId: parentByRemId.has(remId) ? parentByRemId.get(remId) || null : null,
                remText: remTextCache.get(remId) ?? null,
                isInc: false,
                isDism: false,
                incHistory: [],
                dismHistory: [],
                cards,
            });
        }
    }

    onProgress(0.7, 'Walking ancestor chains…');

    // Parent-chain cache: remId -> [self, parent, grandparent, ..., topAncestor]
    const parentChainCache = new Map<string, string[]>();
    // In-flight chain promises so concurrent callers share work for shared ancestors.
    const inFlightChains = new Map<string, Promise<string[]>>();
    const buildChain = async (id: string): Promise<string[]> => {
        let parentId: string | null;
        if (parentByRemId.has(id)) {
            // We already know the parent (from a taggedRem PluginRem) — no RPC needed.
            parentId = parentByRemId.get(id) || null;
        } else {
            const r: PluginRem | undefined = await plugin.rem.findOne(id);
            if (!r) {
                const chain = [id];
                parentChainCache.set(id, chain);
                return chain;
            }
            parentId = r.parent || null;
            parentByRemId.set(id, parentId);
            if (!remTextCache.has(id)) remTextCache.set(id, r.text);
        }
        const parentChain = parentId ? await ancestorChain(parentId) : [];
        const chain = [id, ...parentChain];
        parentChainCache.set(id, chain);
        return chain;
    };
    async function ancestorChain(id: string): Promise<string[]> {
        const cached = parentChainCache.get(id);
        if (cached) return cached;
        const pending = inFlightChains.get(id);
        if (pending) return pending;
        const p = buildChain(id);
        inFlightChains.set(id, p);
        try {
            return await p;
        } finally {
            inFlightChains.delete(id);
        }
    }

    // Walk chains for every rem-with-data. With parentByRemId mostly populated this is
    // dominated by in-memory work; only un-tagged ancestors (rare) trigger findOne.
    const remEntries = Array.from(remDataById.values());
    const WALK_CHUNK = 50;
    let walked = 0;
    for (let i = 0; i < remEntries.length; i += WALK_CHUNK) {
        const chunk = remEntries.slice(i, i + WALK_CHUNK);
        await Promise.all(
            chunk.map(async (rd) => {
                await ancestorChain(rd.id);
                // Fill in parentId / remText if we now have them and didn't before.
                if (rd.parentId === null && parentByRemId.has(rd.id)) {
                    rd.parentId = parentByRemId.get(rd.id) || null;
                }
                if (!rd.remText && remTextCache.has(rd.id)) {
                    rd.remText = remTextCache.get(rd.id);
                }
            })
        );
        walked += chunk.length;
        onProgress(
            0.7 + 0.28 * (walked / Math.max(1, remEntries.length)),
            `Resolving (${walked}/${remEntries.length})`
        );
    }

    onProgress(1, 'Loaded');
    return { remDataById, parentChainCache, remTextCache, parentByRemId };
}

// Aggregate already-loaded data for a specific period. Pure in-memory work —
// no RPC calls. Safe to call repeatedly on period changes.
function aggregateGlobalData(
    data: LoadedGlobalData,
    startMs: number,
    endMs: number,
    cardCapMs: number,
    ignorePreReset: boolean,
    onProgress: (p: number, label: string) => void
): {
    topLevels: DashboardData['topLevels'];
    summary: SummaryStats;
    subtreesByTop: Map<string, BuiltTree>;
} {
    const { remDataById, parentChainCache, remTextCache } = data;
    onProgress(0.05, 'Aggregating…');

    // For every rem with data in the period, attribute to its top ancestor.
    const summary: SummaryStats = {
        incTaggedCount: 0,
        incTaggedWithRepsCount: 0,
        incReps: 0,
        incTimeSec: 0,
        dismTaggedCount: 0,
        dismTaggedWithRepsCount: 0,
        dismReps: 0,
        dismTimeSec: 0,
        cardsCount: 0,
        cardsWithRepsCount: 0,
        cardReps: 0,
        cardTimeMs: 0,
        cardForgot: 0,
    };

    // Per-top-level aggregates
    const topAggrs = new Map<
        string,
        {
            aggr: PeriodStats;
            aggrIncTagged: number;
            aggrDismTagged: number;
            aggrIncTaggedWithReps: number;
            aggrDismTaggedWithReps: number;
            aggrCardsCount: number;
        }
    >();
    const ensureTop = (id: string) => {
        let t = topAggrs.get(id);
        if (!t) {
            t = {
                aggr: emptyStats(),
                aggrIncTagged: 0,
                aggrDismTagged: 0,
                aggrIncTaggedWithReps: 0,
                aggrDismTaggedWithReps: 0,
                aggrCardsCount: 0,
            };
            topAggrs.set(id, t);
        }
        return t;
    };

    // Walk remDataById in-memory — all chains were resolved during loadGlobalData,
    // so this is pure CPU work (no awaits).
    const remEntries = Array.from(remDataById.values());
    for (let i = 0; i < remEntries.length; i++) {
        const rd = remEntries[i];
        const chain = parentChainCache.get(rd.id) || [rd.id];
        const topId = chain[chain.length - 1] || rd.id;
        const { self, hasIncReps, hasDismReps } = statsFromRem(rd, startMs, endMs, cardCapMs, ignorePreReset);
        const top = ensureTop(topId);
        top.aggr = addStats(top.aggr, self);
        if (rd.isInc) {
            top.aggrIncTagged += 1;
            summary.incTaggedCount += 1;
            if (hasIncReps) {
                top.aggrIncTaggedWithReps += 1;
                summary.incTaggedWithRepsCount += 1;
            }
            let incReps = 0;
            let incTime = 0;
            for (const rep of rd.incHistory) {
                if (!rep || typeof rep.date !== 'number') continue;
                if (rep.date < startMs || rep.date >= endMs) continue;
                if (!isRealIncRep(rep.eventType)) continue;
                incReps += 1;
                incTime += rep.reviewTimeSeconds || 0;
            }
            summary.incReps += incReps;
            summary.incTimeSec += incTime;
        }
        if (rd.isDism) {
            top.aggrDismTagged += 1;
            summary.dismTaggedCount += 1;
            if (hasDismReps) {
                top.aggrDismTaggedWithReps += 1;
                summary.dismTaggedWithRepsCount += 1;
            }
            let dismReps = 0;
            let dismTime = 0;
            for (const rep of rd.dismHistory) {
                if (!rep || typeof rep.date !== 'number') continue;
                if (rep.date < startMs || rep.date >= endMs) continue;
                if (!isRealIncRep(rep.eventType)) continue;
                dismReps += 1;
                dismTime += rep.reviewTimeSeconds || 0;
            }
            summary.dismReps += dismReps;
            summary.dismTimeSec += dismTime;
        }
        top.aggrCardsCount += rd.cards.length;
        summary.cardsCount += rd.cards.length;
        for (const card of rd.cards) {
            let cardHasReps = false;
            for (const rep of effectiveCardHistory(card.history, ignorePreReset)) {
                if (!rep || typeof rep.date !== 'number') continue;
                if (rep.date < startMs || rep.date >= endMs) continue;
                if (!isRealCardScore(rep.score)) continue;
                const t = Math.min(Math.max(0, rep.responseTime || 0), cardCapMs);
                summary.cardReps += 1;
                summary.cardTimeMs += t;
                if (rep.score === QueueInteractionScore.AGAIN) summary.cardForgot += 1;
                cardHasReps = true;
            }
            if (cardHasReps) summary.cardsWithRepsCount += 1;
        }
    }

    onProgress(0.7, 'Building subtrees…');

    // Pre-build a subtree per top-level using already-gathered data. No new RPC calls.
    // For each rem-with-data, its parent chain (already cached) gives us its position in
    // the hierarchy. We walk those chains in-memory to assemble parent→children links
    // and aggregate stats bottom-up. Structural ancestors (chain entries not in
    // remDataById) become tree-backbone nodes carrying only their text.
    const topToChildMap = new Map<string, Map<string, Set<string>>>();
    const topToNodeIds = new Map<string, Set<string>>();

    for (const rd of remDataById.values()) {
        const chain = parentChainCache.get(rd.id) || [rd.id];
        if (chain.length === 0) continue;
        const topId = chain[chain.length - 1];

        let nodeIds = topToNodeIds.get(topId);
        if (!nodeIds) {
            nodeIds = new Set();
            topToNodeIds.set(topId, nodeIds);
        }
        let childMap = topToChildMap.get(topId);
        if (!childMap) {
            childMap = new Map();
            topToChildMap.set(topId, childMap);
        }
        for (let i = 0; i < chain.length; i++) {
            const id = chain[i];
            nodeIds.add(id);
            if (i < chain.length - 1) {
                const parentId = chain[i + 1];
                let cset = childMap.get(parentId);
                if (!cset) {
                    cset = new Set();
                    childMap.set(parentId, cset);
                }
                cset.add(id);
            }
        }
    }

    const subtreesByTop = new Map<string, BuiltTree>();
    for (const [topId] of topToNodeIds) {
        const childMap = topToChildMap.get(topId) || new Map<string, Set<string>>();
        const nodes: Record<string, TreeNode> = {};

        const compute = (id: string): TreeNode => {
            if (nodes[id]) return nodes[id];
            const data = remDataById.get(id) || null;
            const rawChildrenIds = Array.from(childMap.get(id) || []);

            const self = data ? statsFromRem(data, startMs, endMs, cardCapMs, ignorePreReset) : null;
            let aggr = self ? self.self : emptyStats();
            let aggrIncTagged = data && data.isInc ? 1 : 0;
            let aggrDismTagged = data && data.isDism ? 1 : 0;
            let aggrIncTaggedWithReps = data && data.isInc && self && self.hasIncReps ? 1 : 0;
            let aggrDismTaggedWithReps = data && data.isDism && self && self.hasDismReps ? 1 : 0;
            let aggrCardsCount = data ? data.cards.length : 0;

            const childrenIds: string[] = [];
            for (const c of rawChildrenIds) {
                const child = compute(c);
                aggr = addStats(aggr, child.aggr);
                aggrIncTagged += child.aggrIncTagged;
                aggrDismTagged += child.aggrDismTagged;
                aggrIncTaggedWithReps += child.aggrIncTaggedWithReps;
                aggrDismTaggedWithReps += child.aggrDismTaggedWithReps;
                aggrCardsCount += child.aggrCardsCount;
                if (child.aggr.incRemReps > 0 || child.aggr.cardReps > 0) {
                    childrenIds.push(c);
                }
            }

            nodes[id] = {
                id,
                childrenIds,
                selfData: data,
                aggr,
                aggrIncTagged,
                aggrDismTagged,
                aggrIncTaggedWithReps,
                aggrDismTaggedWithReps,
                aggrCardsCount,
                remText: data?.remText ?? remTextCache.get(id),
            };
            return nodes[id];
        };
        compute(topId);

        // Sort each node's children by total time descending.
        for (const nid of Object.keys(nodes)) {
            const n = nodes[nid];
            if (n.childrenIds.length > 1) {
                n.childrenIds.sort((a, b) => {
                    const na = nodes[a].aggr;
                    const nb = nodes[b].aggr;
                    const tA = na.cardTimeMs + na.incRemTimeSec * 1000;
                    const tB = nb.cardTimeMs + nb.incRemTimeSec * 1000;
                    return tB - tA;
                });
            }
        }

        subtreesByTop.set(topId, { nodes, rootIds: [topId] });
    }

    const topLevels = Array.from(topAggrs.entries())
        .map(([topId, v]) => ({ topId, ...v }))
        .filter((t) => t.aggr.incRemReps > 0 || t.aggr.cardReps > 0)
        .sort((a, b) => b.aggr.cardTimeMs + b.aggr.incRemTimeSec * 1000 - (a.aggr.cardTimeMs + a.aggr.incRemTimeSec * 1000));

    onProgress(1, 'Done');
    return { topLevels, summary, subtreesByTop };
}

// ---------------------------------------------------------------------------
// UI components
// ---------------------------------------------------------------------------

function PeriodPicker({
    period,
    onChange,
    customStart,
    customEnd,
    onCustomChange,
}: {
    period: Period;
    onChange: (p: Period) => void;
    customStart: string;
    customEnd: string;
    onCustomChange: (s: string, e: string) => void;
}) {
    const inputStyle = getInputStyle();
    const renderPresetBtn = (label: string, id: Period) => (
        <button
            onClick={() => onChange(id)}
            className="w-full h-full rounded px-2 py-1 text-xs transition-all hover:opacity-90 flex items-center justify-center"
            style={getButtonStyle(id === period)}
        >
            {label}
        </button>
    );

    // Local draft state for custom date text inputs — typing does NOT trigger
    // recomputation. Only blur or Enter commits the parsed value.
    const [draftStart, setDraftStart] = useState(formatDateForDisplay(customStart));
    const [draftEnd, setDraftEnd] = useState(formatDateForDisplay(customEnd));

    // Sync drafts when canonical values change externally (preset selected).
    useEffect(() => {
        setDraftStart(formatDateForDisplay(customStart));
    }, [customStart]);
    useEffect(() => {
        setDraftEnd(formatDateForDisplay(customEnd));
    }, [customEnd]);

    const commitStart = () => {
        const parsed = parseDateInput(draftStart);
        // Editing Start Date while in 'since' keeps the period as 'since' —
        // for all other modes (including 'custom'), it switches to 'custom'.
        const nextPeriod: Period = period === 'since' ? 'since' : 'custom';
        if (parsed) {
            setDraftStart(formatDateForDisplay(parsed));
            if (parsed !== customStart) {
                onCustomChange(parsed, customEnd);
                onChange(nextPeriod);
            }
        } else if (draftStart === '') {
            if (customStart !== '') {
                onCustomChange('', customEnd);
                onChange(nextPeriod);
            }
        } else {
            setDraftStart(formatDateForDisplay(customStart));
        }
    };

    const commitEnd = () => {
        // 'since' has no end date — editing End Date always switches to 'custom'.
        const parsed = parseDateInput(draftEnd);
        if (parsed) {
            setDraftEnd(formatDateForDisplay(parsed));
            if (parsed !== customEnd) {
                onCustomChange(customStart, parsed);
                onChange('custom');
            }
        } else if (draftEnd === '') {
            if (customEnd !== '') {
                onCustomChange(customStart, '');
                onChange('custom');
            }
        } else {
            setDraftEnd(formatDateForDisplay(customEnd));
        }
    };

    const isStartInvalid = draftStart !== '' && !parseDateInput(draftStart);
    const isEndInvalid = draftEnd !== '' && !parseDateInput(draftEnd);

    return (
        <div>
            {/* 5x3 grid matching the statistics plugin */}
            <div className="grid gap-1 md:gap-1.5 grid-cols-3 sm:grid-cols-5">
                <div style={{ gridColumn: '1', gridRow: '1 / 3' }}>
                    {renderPresetBtn('Today', 'today')}
                </div>
                <div style={{ gridColumn: '1', gridRow: '3' }}>
                    {renderPresetBtn('Yesterday', 'yesterday')}
                </div>

                <div style={{ gridColumn: '2', gridRow: '1' }}>{renderPresetBtn('Week', 'week')}</div>
                <div style={{ gridColumn: '2', gridRow: '2' }}>{renderPresetBtn('This Week', 'thisWeek')}</div>
                <div style={{ gridColumn: '2', gridRow: '3' }}>{renderPresetBtn('Last Week', 'lastWeek')}</div>

                <div style={{ gridColumn: '3', gridRow: '1' }}>{renderPresetBtn('Month', 'month')}</div>
                <div style={{ gridColumn: '3', gridRow: '2' }}>{renderPresetBtn('This Month', 'thisMonth')}</div>
                <div style={{ gridColumn: '3', gridRow: '3' }}>{renderPresetBtn('Last Month', 'lastMonth')}</div>

                <div style={{ gridColumn: '4', gridRow: '1' }}>{renderPresetBtn('Year', 'year')}</div>
                <div style={{ gridColumn: '4', gridRow: '2' }}>{renderPresetBtn('This Year', 'thisYear')}</div>
                <div style={{ gridColumn: '4', gridRow: '3' }}>{renderPresetBtn('Last Year', 'lastYear')}</div>

                <div style={{ gridColumn: '5', gridRow: '1 / 3' }}>
                    <button
                        onClick={() => onChange('all')}
                        className="w-full h-full rounded px-2 py-1 text-xs transition-all hover:opacity-90 flex items-center justify-center font-bold"
                        style={getButtonStyle(period === 'all')}
                    >
                        All
                    </button>
                </div>
                <div style={{ gridColumn: '5', gridRow: '3' }}>
                    <button
                        onClick={() => onChange('since')}
                        title="From this day on (start date below; end = now)"
                        className="w-full h-full rounded px-2 py-1 text-xs transition-all hover:opacity-90 flex items-center justify-center"
                        style={getButtonStyle(period === 'since')}
                    >
                        Since…
                    </button>
                </div>
            </div>

            <div className="flex flex-wrap gap-2 md:gap-4 items-end mt-3">
                <div className="flex flex-col flex-1 min-w-[120px]">
                    <span className="text-xs opacity-70 mb-1">Start Date</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <input
                            type="text"
                            placeholder="DD/MM/YYYY"
                            value={draftStart}
                            onChange={(e) => setDraftStart(e.target.value)}
                            onBlur={commitStart}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitStart(); }}
                            className="border rounded px-2 py-1 text-sm w-full"
                            style={{
                                ...inputStyle,
                                borderColor: isStartInvalid ? '#ef4444' : inputStyle.borderColor,
                            }}
                        />
                        <input
                            type="date"
                            className="date-picker-icon-only"
                            value={customStart}
                            onChange={(e) => {
                                const v = e.target.value;
                                setDraftStart(formatDateForDisplay(v));
                                onCustomChange(v, customEnd);
                                onChange('custom');
                            }}
                            title="Pick from calendar"
                            tabIndex={-1}
                        />
                    </div>
                </div>
                <div className="flex flex-col flex-1 min-w-[120px]">
                    <span className="text-xs opacity-70 mb-1">End Date</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <input
                            type="text"
                            placeholder="DD/MM/YYYY"
                            value={draftEnd}
                            onChange={(e) => setDraftEnd(e.target.value)}
                            onBlur={commitEnd}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitEnd(); }}
                            className="border rounded px-2 py-1 text-sm w-full"
                            style={{
                                ...inputStyle,
                                borderColor: isEndInvalid ? '#ef4444' : inputStyle.borderColor,
                            }}
                        />
                        <input
                            type="date"
                            className="date-picker-icon-only"
                            value={customEnd}
                            onChange={(e) => {
                                const v = e.target.value;
                                setDraftEnd(formatDateForDisplay(v));
                                onCustomChange(customStart, v);
                                onChange('custom');
                            }}
                            title="Pick from calendar"
                            tabIndex={-1}
                        />
                    </div>
                </div>
                {(period === 'custom' || period === 'since') && (
                    <button
                        onClick={() => onChange('today')}
                        className="text-xs hover:underline mb-2 ml-auto"
                        style={{ color: ACCENT_COLOR }}
                    >
                        Clear Filter
                    </button>
                )}
            </div>
        </div>
    );
}

function formatMs(ms: number): string {
    return formatDuration(Math.round(ms / 1000)) || '0s';
}

function retentionColor(rate: number): string {
    if (rate >= 90) return '#16a34a';
    if (rate < 80) return '#ef4444';
    return '#ca8a04';
}

function speedColor(cpm: number): string {
    if (cpm <= 0) return 'var(--rn-clr-content-tertiary)';
    let hue: number;
    if (cpm < 1.5) hue = 0;
    else if (cpm >= 4) hue = 120;
    else hue = Math.floor(((cpm - 1.5) / (4 - 1.5)) * 120);
    return `hsl(${hue}, 90%, 35%)`;
}

function SummaryCard({ summary }: { summary: SummaryStats }) {
    const totalIncDism = summary.incTaggedCount + summary.dismTaggedCount;
    const incPct = totalIncDism > 0 ? Math.round((summary.incTaggedCount / totalIncDism) * 100) : 0;
    const dismPct =
        totalIncDism > 0 ? Math.round((summary.dismTaggedCount / totalIncDism) * 100) : 0;

    const cpm =
        summary.cardTimeMs > 0 ? summary.cardReps / (summary.cardTimeMs / 60000) : 0;
    const remembered = Math.max(0, summary.cardReps - summary.cardForgot);
    const retention = summary.cardReps > 0 ? (remembered / summary.cardReps) * 100 : 0;

    const headerStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: '1.7fr 0.9fr 0.9fr 0.7fr 0.9fr 0.9fr 0.9fr',
        fontSize: 10,
        fontWeight: 600,
        color: 'var(--rn-clr-content-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        padding: '6px 8px',
    };
    const rowStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: '1.7fr 0.9fr 0.9fr 0.7fr 0.9fr 0.9fr 0.9fr',
        padding: '6px 8px',
        borderTop: '1px solid var(--rn-clr-border-secondary)',
        fontSize: 12,
        alignItems: 'center',
    };

    return (
        <div
            style={{
                border: '1px solid var(--rn-clr-border-primary)',
                borderRadius: 8,
                background: 'var(--rn-clr-background-primary)',
            }}
        >
            <div style={headerStyle}>
                <div>Type</div>
                <div style={{ textAlign: 'right' }}>Items</div>
                <div style={{ textAlign: 'right' }}>w/ Reps</div>
                <div style={{ textAlign: 'right' }}>Reps</div>
                <div style={{ textAlign: 'right' }}>Time</div>
                <div style={{ textAlign: 'right' }}>Ret.</div>
                <div style={{ textAlign: 'right' }}>Speed</div>
            </div>
            <div style={rowStyle}>
                <div style={{ color: '#22c55e', fontWeight: 500 }}>
                    Incremental{totalIncDism > 0 ? ` (${incPct}%)` : ''}
                </div>
                <div style={{ textAlign: 'right' }}>{summary.incTaggedCount}</div>
                <div style={{ textAlign: 'right' }}>{summary.incTaggedWithRepsCount}</div>
                <div style={{ textAlign: 'right' }}>{summary.incReps || '-'}</div>
                <div style={{ textAlign: 'right' }}>
                    {summary.incTimeSec ? formatDuration(summary.incTimeSec) : '-'}
                </div>
                <div style={{ textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>-</div>
                <div style={{ textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>-</div>
            </div>
            <div style={rowStyle}>
                <div style={{ color: '#f59e0b', fontWeight: 500 }}>
                    Dismissed{totalIncDism > 0 ? ` (${dismPct}%)` : ''}
                </div>
                <div style={{ textAlign: 'right' }}>{summary.dismTaggedCount}</div>
                <div style={{ textAlign: 'right' }}>{summary.dismTaggedWithRepsCount}</div>
                <div style={{ textAlign: 'right' }}>{summary.dismReps || '-'}</div>
                <div style={{ textAlign: 'right' }}>
                    {summary.dismTimeSec ? formatDuration(summary.dismTimeSec) : '-'}
                </div>
                <div style={{ textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>-</div>
                <div style={{ textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>-</div>
            </div>
            <div style={rowStyle}>
                <div style={{ color: '#3b82f6', fontWeight: 500 }}>Flashcards</div>
                <div style={{ textAlign: 'right' }}>{summary.cardsCount}</div>
                <div style={{ textAlign: 'right' }}>{summary.cardsWithRepsCount}</div>
                <div style={{ textAlign: 'right' }}>{summary.cardReps || '-'}</div>
                <div style={{ textAlign: 'right' }}>
                    {summary.cardTimeMs ? formatMs(summary.cardTimeMs) : '-'}
                </div>
                <div style={{ textAlign: 'right' }}>
                    {summary.cardReps > 0 ? (
                        <span style={{ color: retentionColor(retention), fontWeight: 600 }}>
                            {retention.toFixed(0)}%
                        </span>
                    ) : (
                        <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>-</span>
                    )}
                </div>
                <div style={{ textAlign: 'right' }}>
                    {summary.cardReps > 0 ? (
                        <span style={{ color: speedColor(cpm), fontWeight: 600 }}>
                            {cpm.toFixed(1)}
                            <span style={{ fontSize: 10, marginLeft: 2, color: 'var(--rn-clr-content-tertiary)' }}>cpm</span>
                        </span>
                    ) : (
                        <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>-</span>
                    )}
                </div>
            </div>
            {(() => {
                const totalItems =
                    summary.incTaggedCount + summary.dismTaggedCount + summary.cardsCount;
                const totalWithReps =
                    summary.incTaggedWithRepsCount +
                    summary.dismTaggedWithRepsCount +
                    summary.cardsWithRepsCount;
                const totalReps = summary.incReps + summary.dismReps + summary.cardReps;
                // Sum on a common scale (seconds): inc/dism are seconds, cards are ms.
                const totalTimeSec =
                    summary.incTimeSec + summary.dismTimeSec + Math.round(summary.cardTimeMs / 1000);
                return (
                    <div
                        style={{
                            ...rowStyle,
                            background: 'var(--rn-clr-background-secondary)',
                            fontWeight: 600,
                        }}
                    >
                        <div>Total</div>
                        <div style={{ textAlign: 'right' }}>{totalItems}</div>
                        <div style={{ textAlign: 'right' }}>{totalWithReps}</div>
                        <div style={{ textAlign: 'right' }}>{totalReps || '-'}</div>
                        <div style={{ textAlign: 'right' }}>
                            {totalTimeSec ? formatDuration(totalTimeSec) : '-'}
                        </div>
                        <div style={{ textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>-</div>
                        <div style={{ textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>-</div>
                    </div>
                );
            })()}
        </div>
    );
}

const HierarchyHeader = () => (
    <div
        style={{
            display: 'grid',
            gridTemplateColumns: '2.4fr 0.9fr 1fr 1fr 0.7fr 0.7fr 24px',
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--rn-clr-content-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            padding: '6px 8px',
            borderBottom: '1px solid var(--rn-clr-border-secondary)',
        }}
    >
        <div>Rem</div>
        <div style={{ textAlign: 'right' }}>Total Time</div>
        <div style={{ textAlign: 'right' }}>Cards</div>
        <div style={{ textAlign: 'right' }}>Inc. Rems</div>
        <div style={{ textAlign: 'right' }}>Ret.</div>
        <div style={{ textAlign: 'right' }}>Speed</div>
        <div />
    </div>
);

function HierarchyRow({
    node,
    depth,
    expanded,
    hasChildren,
    onToggle,
}: {
    node: TreeNode;
    depth: number;
    expanded: boolean;
    hasChildren: boolean;
    onToggle: () => void;
}) {
    const plugin = usePlugin();
    const nameSegments = useRunAsync(async () => {
        if (!node.remText) return [];
        return await resolveRemTextSegments(plugin, node.remText);
    }, [node.remText]);

    const a = node.aggr;
    const totalTimeMs = a.cardTimeMs + a.incRemTimeSec * 1000;
    const cpm = a.cardTimeMs > 0 ? a.cardReps / (a.cardTimeMs / 60000) : 0;
    const remembered = Math.max(0, a.cardReps - a.cardForgot);
    const retention = a.cardReps > 0 ? (remembered / a.cardReps) * 100 : 0;
    const isStructural = !node.selfData;

    // Subtle per-level shading so the eye can follow the hierarchy. Uses a neutral
    // grey with alpha so it works in both light and dark themes. Caps at depth 6 to
    // avoid the background getting too dark for very deep nesting.
    const shadeAlpha = depth === 0 ? 0 : Math.min(0.04 + (depth - 1) * 0.025, 0.16);
    const rowBg = shadeAlpha > 0 ? `rgba(127, 127, 127, ${shadeAlpha})` : 'transparent';

    return (
        <div
            style={{
                display: 'grid',
                gridTemplateColumns: '2.4fr 0.9fr 1fr 1fr 0.7fr 0.7fr 24px',
                padding: '4px 8px',
                paddingLeft: 8 + depth * 14,
                fontSize: 12,
                borderBottom: '1px solid var(--rn-clr-border-secondary)',
                cursor: hasChildren ? 'pointer' : 'default',
                alignItems: 'center',
                opacity: isStructural ? 0.8 : 1,
                background: rowBg,
            }}
            onClick={(e) => {
                if (hasChildren) {
                    e.stopPropagation();
                    onToggle();
                }
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    overflow: 'hidden',
                    minWidth: 0,
                }}
            >
                <div
                    style={{
                        width: 14,
                        marginRight: 4,
                        opacity: 0.5,
                        textAlign: 'center',
                    }}
                >
                    {hasChildren ? (expanded ? '▼' : '▶') : '•'}
                </div>
                {node.selfData?.isInc && (
                    <span style={{ color: '#22c55e', marginRight: 4 }}>●</span>
                )}
                {node.selfData?.isDism && (
                    <span style={{ color: '#f59e0b', marginRight: 4 }}>●</span>
                )}
                <div
                    style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontStyle: isStructural ? 'italic' : 'normal',
                        color: isStructural ? 'var(--rn-clr-content-tertiary)' : undefined,
                    }}
                >
                    {nameSegments === undefined ? (
                        'Loading…'
                    ) : nameSegments.length > 0 ? (
                        <RemTextSegments segments={nameSegments} />
                    ) : (
                        'Untitled'
                    )}
                </div>
            </div>
            <div style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                {totalTimeMs > 0 ? formatMs(totalTimeMs) : '-'}
            </div>
            <div style={{ textAlign: 'right' }}>
                {a.cardReps > 0 ? (
                    <>
                        <span style={{ fontWeight: 600 }}>{a.cardReps}</span>{' '}
                        <span style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary)' }}>
                            ({formatMs(a.cardTimeMs)})
                        </span>
                    </>
                ) : (
                    '-'
                )}
            </div>
            <div style={{ textAlign: 'right' }}>
                {a.incRemReps > 0 ? (
                    <>
                        <span style={{ fontWeight: 600 }}>{a.incRemReps}</span>{' '}
                        <span style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary)' }}>
                            ({formatDuration(a.incRemTimeSec) || '0s'})
                        </span>
                    </>
                ) : (
                    '-'
                )}
            </div>
            <div style={{ textAlign: 'right' }}>
                {a.cardReps > 0 ? (
                    <span style={{ color: retentionColor(retention), fontWeight: 600 }}>
                        {retention.toFixed(0)}%
                    </span>
                ) : (
                    '-'
                )}
            </div>
            <div style={{ textAlign: 'right' }}>
                {a.cardReps > 0 ? (
                    <span style={{ color: speedColor(cpm), fontWeight: 600 }}>
                        {cpm.toFixed(1)}
                    </span>
                ) : (
                    '-'
                )}
            </div>
            <button
                onClick={async (e) => {
                    e.stopPropagation();
                    const rem = await plugin.rem.findOne(node.id);
                    if (!rem) return;
                    const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
                    const isPdfExtract = await rem.hasPowerup(BuiltInPowerupCodes.UploadedFile);
                    if (isPdfHighlight || isPdfExtract) {
                        await rem.openRemAsPage();
                    } else {
                        await plugin.window.openRem(rem);
                    }
                    await plugin.widget.closePopup();
                }}
                style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    opacity: 0.5,
                    fontSize: 12,
                }}
                title="Open Rem"
            >
                ↗
            </button>
        </div>
    );
}

function HierarchyTree({ tree }: { tree: BuiltTree }) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const toggle = (id: string) =>
        setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

    function renderNode(id: string, depth: number): React.ReactNode[] {
        const node = tree.nodes[id];
        if (!node) return [];
        const hasChildren = node.childrenIds.length > 0;
        const isOpen = !!expanded[id];
        const rows: React.ReactNode[] = [
            <HierarchyRow
                key={id}
                node={node}
                depth={depth}
                expanded={isOpen}
                hasChildren={hasChildren}
                onToggle={() => toggle(id)}
            />,
        ];
        if (isOpen) {
            for (const c of node.childrenIds) {
                rows.push(...renderNode(c, depth + 1));
            }
        }
        return rows;
    }

    return (
        <div>
            <HierarchyHeader />
            {tree.rootIds.map((rid) => renderNode(rid, 0))}
        </div>
    );
}

// Global top-level row, rendering a pre-built subtree synchronously.
function GlobalTopLevelRow({
    topId,
    pre,
    subtree,
}: {
    topId: string;
    pre: NonNullable<DashboardData['topLevels']>[number];
    subtree: BuiltTree | null;
}) {
    const [expanded, setExpanded] = useState(false);

    // Use the pre-built tree's root node when available — its remText was populated
    // from remTextCache during the build pass — otherwise fall back to a pseudo node.
    const rootNode = subtree?.nodes[topId];
    const displayNode: TreeNode = rootNode ?? {
        id: topId,
        childrenIds: [],
        selfData: null,
        aggr: pre.aggr,
        aggrIncTagged: pre.aggrIncTagged,
        aggrDismTagged: pre.aggrDismTagged,
        aggrIncTaggedWithReps: pre.aggrIncTaggedWithReps,
        aggrDismTaggedWithReps: pre.aggrDismTaggedWithReps,
        aggrCardsCount: pre.aggrCardsCount,
        remText: null,
    };
    const hasChildren = (rootNode?.childrenIds.length ?? 0) > 0;

    return (
        <div>
            <HierarchyRow
                node={displayNode}
                depth={0}
                expanded={expanded}
                hasChildren={hasChildren}
                onToggle={() => setExpanded((v) => !v)}
            />
            {expanded && subtree && (
                <SubtreeRenderer tree={subtree} startDepth={0} hideRoot={true} />
            )}
        </div>
    );
}

function SubtreeRenderer({
    tree,
    startDepth = 0,
    hideRoot = false,
}: {
    tree: BuiltTree;
    startDepth?: number;
    hideRoot?: boolean;
}) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const toggle = (id: string) =>
        setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

    function renderNode(id: string, depth: number): React.ReactNode[] {
        const node = tree.nodes[id];
        if (!node) return [];
        const hasChildren = node.childrenIds.length > 0;
        const isOpen = !!expanded[id];
        const rows: React.ReactNode[] = [];
        const isRoot = depth === startDepth;
        if (!(isRoot && hideRoot)) {
            rows.push(
                <HierarchyRow
                    key={id}
                    node={node}
                    depth={depth}
                    expanded={isOpen || (isRoot && hideRoot)}
                    hasChildren={hasChildren}
                    onToggle={() => toggle(id)}
                />
            );
        }
        const showChildren = isOpen || (isRoot && hideRoot);
        if (showChildren) {
            for (const c of node.childrenIds) {
                rows.push(...renderNode(c, depth + 1));
            }
        }
        return rows;
    }

    return <div>{tree.rootIds.map((rid) => renderNode(rid, startDepth))}</div>;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function StudyDashboardPopup() {
    const plugin = usePlugin();

    const ctx = useRunAsync(async () => {
        try {
            return await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
        } catch {
            return null;
        }
    }, []);
    const ctxRemId: string | undefined = (ctx as any)?.contextData?.remId;

    // Default to Global: it's the most common entry point and avoids surprising
    // the user by silently scoping to whatever rem they happened to have focused.
    // The user can switch to Document at any time (still allowed only when ctxRemId is present).
    // Mirror of the same toggle in the Card Priority × Memory Analytics widget.
    // Default OFF → use full history (matches existing behavior). When ON, drop
    // every rep up to and including the last RESET on each card — useful after
    // importing documents whose foreign repetition history would otherwise
    // skew retention, time, and CPM.
    const [ignorePreReset, setIgnorePreReset] = useState<boolean>(false);
    const [contextMode, setContextMode] = useState<ContextMode>('global');
    const [scope, setScope] = useState<ScopeMode>('comprehensive');
    const [period, setPeriod] = useState<Period>('thisYear');
    const [customStart, setCustomStart] = useState('');
    const [customEnd, setCustomEnd] = useState('');

    const { startMs, endMs } = useMemo(
        () => resolvePeriod(period, customStart, customEnd),
        [period, customStart, customEnd]
    );

    // Reflect the resolved range in the Start/End date inputs when a preset is picked.
    // - 'custom' leaves them as typed.
    // - 'since' is driven by customStart; we leave both inputs alone (the user
    //   picked the start, end is implicitly "now").
    // - 'all' clears the inputs (no meaningful start).
    useEffect(() => {
        if (period === 'custom' || period === 'since') return;
        if (period === 'all') {
            if (customStart !== '') setCustomStart('');
            if (customEnd !== '') setCustomEnd('');
            return;
        }
        const toIsoDate = (ms: number) => {
            const d = new Date(ms);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        const newStart = toIsoDate(startMs);
        // endMs is exclusive (start of the day after the last included day);
        // subtract 1ms so the input shows the inclusive last day.
        const newEnd = toIsoDate(endMs - 1);
        if (newStart !== customStart) setCustomStart(newStart);
        if (newEnd !== customEnd) setCustomEnd(newEnd);
    }, [period, startMs, endMs]);

    // Hydrate prefs (period + ignorePreReset) from device-local storage on
    // mount, then persist whenever the user changes them. The ref gate
    // prevents the persist effect from firing with the defaults before
    // hydration completes.
    const periodHydratedRef = useRef(false);
    useEffect(() => {
        let cancelled = false;
        plugin.storage
            .getLocal<{
                period?: Period;
                customStart?: string;
                customEnd?: string;
                ignorePreReset?: boolean;
            } | null>(studyDashboardLastPeriodKey)
            .then((saved) => {
                if (cancelled) return;
                if (saved?.period) setPeriod(saved.period);
                if (saved?.customStart !== undefined) setCustomStart(saved.customStart);
                if (saved?.customEnd !== undefined) setCustomEnd(saved.customEnd);
                if (typeof saved?.ignorePreReset === 'boolean') {
                    setIgnorePreReset(saved.ignorePreReset);
                }
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) periodHydratedRef.current = true;
            });
        return () => {
            cancelled = true;
        };
    }, [plugin]);

    useEffect(() => {
        if (!periodHydratedRef.current) return;
        plugin.storage
            .setLocal(studyDashboardLastPeriodKey, {
                period,
                customStart,
                customEnd,
                ignorePreReset,
            })
            .catch(() => {});
    }, [plugin, period, customStart, customEnd, ignorePreReset]);

    const cardCapMs = useRunAsync(async () => {
        const v = await plugin.settings.getSetting<number>(FLASHCARD_RESPONSE_TIME_LIMIT_SETTING);
        return ((v ?? DEFAULT_RESPONSE_TIME_LIMIT_SEC) as number) * 1000;
    }, []);

    const [progress, setProgress] = useState<ProgressState>({
        running: false,
        percent: 0,
        label: '',
    });
    const [docTree, setDocTree] = useState<BuiltTree | null>(null);
    const [globalTops, setGlobalTops] = useState<DashboardData['topLevels']>(undefined);
    const [globalSubtreesByTop, setGlobalSubtreesByTop] = useState<Map<string, BuiltTree>>(
        new Map()
    );
    const [summary, setSummary] = useState<SummaryStats | null>(null);
    const runIdRef = useRef(0);
    // Cached global-mode raw data — survives across period changes.
    // Invalidated only when the context switches into Global from scratch (per session).
    const globalDataRef = useRef<LoadedGlobalData | null>(null);
    // Cached document-mode raw data — survives across period changes for the same
    // (rootRemId, scope). Different rem or scope invalidates and reloads.
    const docDataRef = useRef<LoadedDocumentData | null>(null);

    const run = useCallback(async () => {
        if (cardCapMs == null) return;
        const runId = ++runIdRef.current;
        setProgress({ running: true, percent: 0, label: 'Starting…' });
        setDocTree(null);
        setGlobalTops(undefined);
        setSummary(null);

        try {
            if (contextMode === 'document' && ctxRemId) {
                const rootRem = await plugin.rem.findOne(ctxRemId);
                if (!rootRem) {
                    if (runId !== runIdRef.current) return;
                    setProgress({ running: false, percent: 0, label: '' });
                    return;
                }
                // Reuse cached document data when the rem + scope match; period
                // changes hit only the aggregate path.
                const cached = docDataRef.current;
                if (!cached || cached.rootRemId !== rootRem._id || cached.scope !== scope) {
                    const loaded = await loadDocumentData(plugin, rootRem, scope, (p, label) => {
                        if (runId !== runIdRef.current) return;
                        setProgress({ running: true, percent: 0.8 * p, label });
                    });
                    if (runId !== runIdRef.current) return;
                    docDataRef.current = loaded;
                }
                const { tree, summary: s } = aggregateDocumentData(
                    docDataRef.current!,
                    startMs,
                    endMs,
                    cardCapMs,
                    ignorePreReset,
                    (p, label) => {
                        if (runId !== runIdRef.current) return;
                        setProgress({ running: true, percent: 0.8 + 0.2 * p, label });
                    }
                );
                if (runId !== runIdRef.current) return;
                setDocTree(tree);
                setSummary(s);
            } else {
                // Load raw data once and cache. Period changes only re-aggregate (in-memory).
                if (!globalDataRef.current) {
                    const loaded = await loadGlobalData(plugin, (p, label) => {
                        if (runId !== runIdRef.current) return;
                        // Loading occupies the first 80% of the progress bar.
                        setProgress({ running: true, percent: 0.8 * p, label });
                    });
                    if (runId !== runIdRef.current) return;
                    globalDataRef.current = loaded;
                }
                const r = aggregateGlobalData(
                    globalDataRef.current,
                    startMs,
                    endMs,
                    cardCapMs,
                    ignorePreReset,
                    (p, label) => {
                        if (runId !== runIdRef.current) return;
                        setProgress({ running: true, percent: 0.8 + 0.2 * p, label });
                    }
                );
                if (runId !== runIdRef.current) return;
                setGlobalTops(r.topLevels);
                setGlobalSubtreesByTop(r.subtreesByTop);
                setSummary(r.summary);
            }
        } catch (err) {
            console.error('[study_dashboard] compute failed', err);
        } finally {
            if (runId === runIdRef.current) {
                setProgress({ running: false, percent: 1, label: '' });
            }
        }
    }, [plugin, contextMode, ctxRemId, scope, startMs, endMs, cardCapMs, ignorePreReset]);

    useEffect(() => {
        if (cardCapMs == null) return;
        run();
    }, [run, cardCapMs]);

    const containerStyle: React.CSSProperties = {
        width: '900px',
        height: '850px',
        backgroundColor: 'var(--rn-clr-background-primary)',
        borderRadius: 12,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
    };

    return (
        <div style={containerStyle} className="statisticsBody">
            {/* Header */}
            <div
                style={{ flex: '0 0 auto', padding: '1rem', borderBottom: '1px solid var(--rn-clr-border-primary)' }}
                className="md:px-6"
            >
                <div className="flex items-center justify-between gap-2 md:gap-3">
                    <div className="flex items-center gap-2 md:gap-3">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="w-6 h-6 md:w-7 md:h-7"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{ color: ACCENT_COLOR }}
                        >
                            <line x1="18" y1="20" x2="18" y2="10"></line>
                            <line x1="12" y1="20" x2="12" y2="4"></line>
                            <line x1="6" y1="20" x2="6" y2="14"></line>
                        </svg>
                        <div>
                            <div
                                className="font-bold text-lg md:text-2xl"
                                style={{ color: 'var(--rn-clr-content-primary)' }}
                            >
                                Study Dashboard
                            </div>
                            <div className="text-xs md:text-sm opacity-60 hidden sm:block">
                                Filterable summary of Incremental, Dismissed, and Flashcard activity
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={() => plugin.widget.closePopup()}
                        className="flex items-center justify-center p-2 rounded-lg transition-all hover:opacity-80"
                        style={{
                            backgroundColor: 'var(--rn-clr-background-secondary)',
                            border: '1px solid var(--rn-clr-border-primary)',
                            cursor: 'pointer',
                        }}
                        title="Close"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
            </div>

            {/* Scrollable body */}
            <div className="custom-scroll" style={{ flex: '1 1 0', overflowY: 'auto', overflowX: 'hidden', padding: '1rem' }}>
                {/* --- Controls section --- */}
                <div
                    className="mb-6 p-4 md:p-6 border rounded-lg shadow-sm fade-in"
                    style={{ ...getBoxStyle(), borderRadius: '12px' }}
                >
                    <div className="flex flex-col md:flex-row gap-6">
                        {/* Context column */}
                        <div className="flex-1 md:pr-6 flex flex-col pb-4 md:pb-0">
                            <div className="flex items-center gap-2 mb-2 md:mb-3">
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    className="w-4 h-4"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    style={{ opacity: 0.7 }}
                                >
                                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                                </svg>
                                <h4 className="font-bold text-xs md:text-sm uppercase tracking-wide opacity-70">
                                    Context
                                </h4>
                            </div>
                            <div className="flex flex-col gap-1.5 md:gap-2">
                                <label className="flex items-center space-x-2 cursor-pointer text-sm md:text-base">
                                    <input
                                        type="radio"
                                        checked={contextMode === 'global'}
                                        onChange={() => setContextMode('global')}
                                        className="form-radio w-4 h-4"
                                        style={{ accentColor: ACCENT_COLOR }}
                                    />
                                    <span>Global</span>
                                </label>
                                <label
                                    className="flex items-center space-x-2 cursor-pointer text-sm md:text-base"
                                    style={{ opacity: ctxRemId ? 1 : 0.5, cursor: ctxRemId ? 'pointer' : 'not-allowed' }}
                                >
                                    <input
                                        type="radio"
                                        disabled={!ctxRemId}
                                        checked={contextMode === 'document'}
                                        onChange={() => setContextMode('document')}
                                        className="form-radio w-4 h-4"
                                        style={{ accentColor: ACCENT_COLOR }}
                                    />
                                    <span
                                        className="truncate"
                                        style={{ maxWidth: '28ch', display: 'inline-block', verticalAlign: 'bottom' }}
                                        title={ctxRemId ? undefined : 'No rem context — open the dashboard from an editor or queue card to enable Document mode.'}
                                    >
                                        {ctxRemId ? <RemText remId={ctxRemId} /> : 'Document'}
                                    </span>
                                </label>
                            </div>

                            {contextMode === 'document' && (
                                <div className="mt-2 pl-6 flex flex-col gap-1">
                                    <div className="text-xs opacity-50 uppercase tracking-wide mb-1">Scope</div>
                                    <label className="flex items-center space-x-2 cursor-pointer text-xs">
                                        <input
                                            type="radio"
                                            checked={scope === 'descendants'}
                                            onChange={() => setScope('descendants')}
                                            className="form-radio h-3 w-3"
                                            style={{ accentColor: ACCENT_COLOR }}
                                        />
                                        <span>Descendants Only</span>
                                    </label>
                                    <label className="flex items-center space-x-2 cursor-pointer text-xs">
                                        <input
                                            type="radio"
                                            checked={scope === 'comprehensive'}
                                            onChange={() => setScope('comprehensive')}
                                            className="form-radio h-3 w-3"
                                            style={{ accentColor: ACCENT_COLOR }}
                                        />
                                        <span>Comprehensive</span>
                                        <span
                                            className="opacity-50 hover:opacity-100 cursor-help transition-opacity"
                                            title="Descendants, Rems that reference or are tagged with this rem and its descendants, Sources, Portals and Table Views"
                                        >
                                            <svg
                                                xmlns="http://www.w3.org/2000/svg"
                                                width="14"
                                                height="14"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                            >
                                                <circle cx="12" cy="12" r="10"></circle>
                                                <line x1="12" y1="16" x2="12" y2="12"></line>
                                                <line x1="12" y1="8" x2="12.01" y2="8"></line>
                                            </svg>
                                        </span>
                                    </label>
                                </div>
                            )}
                        </div>

                        {/* Period column */}
                        <div className="flex-[3] flex flex-col gap-2 md:gap-3">
                            <div className="flex items-center gap-2 mb-2 md:mb-3">
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    className="w-4 h-4"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    style={{ opacity: 0.7 }}
                                >
                                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                    <line x1="16" y1="2" x2="16" y2="6"></line>
                                    <line x1="8" y1="2" x2="8" y2="6"></line>
                                    <line x1="3" y1="10" x2="21" y2="10"></line>
                                </svg>
                                <h4 className="font-bold text-xs md:text-sm uppercase tracking-wide opacity-70">
                                    Period
                                </h4>
                            </div>
                            <PeriodPicker
                                period={period}
                                onChange={setPeriod}
                                customStart={customStart}
                                customEnd={customEnd}
                                onCustomChange={(s, e) => {
                                    setCustomStart(s);
                                    setCustomEnd(e);
                                }}
                            />
                        </div>
                    </div>

                    {/* Filter row — toggle for ignoring pre-RESET history. */}
                    <div
                        className="mt-3 pt-3 flex items-center gap-2 text-xs"
                        style={{ borderTop: '1px solid var(--rn-clr-background-secondary)' }}
                    >
                        <label
                            className="flex items-center gap-2 cursor-pointer"
                            title="Useful after importing documents with foreign repetition history: only count card reps after the last RESET on each card."
                        >
                            <input
                                type="checkbox"
                                checked={ignorePreReset}
                                onChange={(e) => setIgnorePreReset(e.target.checked)}
                                className="form-checkbox h-3.5 w-3.5"
                                style={{ accentColor: ACCENT_COLOR }}
                            />
                            <span className="opacity-80">Ignore card reps before last RESET</span>
                        </label>
                        <span className="opacity-50" style={{ fontSize: '10px' }}>
                            (recomputes stats; does not modify stored history)
                        </span>
                    </div>
                </div>

                {/* Progress / Summary / Hierarchy */}
                {progress.running && (
                    <div style={{ padding: '12px 16px' }}>
                        <div
                            style={{
                                height: 6,
                                background: 'var(--rn-clr-background-secondary)',
                                borderRadius: 3,
                                overflow: 'hidden',
                            }}
                        >
                            <div
                                style={{
                                    width: `${Math.round(progress.percent * 100)}%`,
                                    height: '100%',
                                    background: '#3b82f6',
                                    transition: 'width 0.2s ease',
                                }}
                            />
                        </div>
                        <div
                            style={{
                                fontSize: 11,
                                color: 'var(--rn-clr-content-tertiary)',
                                marginTop: 4,
                            }}
                        >
                            {progress.label}
                        </div>
                    </div>
                )}

                {summary && (
                    <div style={{ padding: '12px 16px' }}>
                        <div
                            style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: 'var(--rn-clr-content-tertiary)',
                                textTransform: 'uppercase',
                                marginBottom: 6,
                            }}
                        >
                            Summary
                        </div>
                        <SummaryCard summary={summary} />
                    </div>
                )}

                {/* Hierarchy */}
                <div style={{ padding: '0 16px 16px' }}>
                    <div
                        style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: 'var(--rn-clr-content-tertiary)',
                            textTransform: 'uppercase',
                            marginBottom: 6,
                        }}
                    >
                        Hierarchy
                    </div>
                    {!progress.running && contextMode === 'document' && docTree && (
                        <HierarchyTree tree={docTree} />
                    )}
                    {!progress.running && contextMode === 'global' && globalTops && (
                        <div>
                            <HierarchyHeader />
                            {globalTops.length === 0 && (
                                <div
                                    style={{
                                        padding: 16,
                                        textAlign: 'center',
                                        color: 'var(--rn-clr-content-tertiary)',
                                        fontSize: 12,
                                    }}
                                >
                                    No activity in the selected period.
                                </div>
                            )}
                            {globalTops.map((t) => (
                                <GlobalTopLevelRow
                                    key={t.topId}
                                    topId={t.topId}
                                    pre={t}
                                    subtree={globalSubtreesByTop.get(t.topId) || null}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

renderWidget(StudyDashboardPopup);
