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
} from '../lib/consts';
import { buildComprehensiveScope } from '../lib/scope_helpers';
import { formatDuration, tryParseJson } from '../lib/utils';
import { resolveRemTextSegments } from '../lib/richTextRemRefs';
import { RemTextSegments } from '../components';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContextMode = 'global' | 'document';
type ScopeMode = 'descendants' | 'comprehensive';
type Period =
    | 'today'
    | 'yesterday'
    | 'week'
    | 'thisWeek'
    | 'lastWeek'
    | 'month'
    | 'thisMonth'
    | 'lastMonth'
    | 'year'
    | 'thisYear'
    | 'lastYear'
    | 'all'
    | 'custom';

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

function getStartOfDay(date: Date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
function getStartOfWeek(date: Date) {
    const d = new Date(date);
    const day = d.getDay();
    d.setDate(d.getDate() - day);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
function getStartOfMonth(date: Date) {
    const d = new Date(date);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
function getStartOfYear(date: Date) {
    const d = new Date(date);
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function resolvePeriod(
    p: Period,
    customStart: string,
    customEnd: string
): { startMs: number; endMs: number } {
    const now = new Date();
    const sodToday = getStartOfDay(now);
    const sodTomorrow = sodToday + 86400000;
    const sodYesterday = sodToday - 86400000;
    const sow = getStartOfWeek(now);
    const sowLast = sow - 7 * 86400000;
    const som = getStartOfMonth(now);
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const somLast = getStartOfMonth(lastMonth);
    const soy = getStartOfYear(now);
    const lastYear = new Date(now);
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    const soyLast = getStartOfYear(lastYear);

    switch (p) {
        case 'today':
            return { startMs: sodToday, endMs: sodTomorrow };
        case 'yesterday':
            return { startMs: sodYesterday, endMs: sodToday };
        case 'week':
            return { startMs: now.getTime() - 7 * 86400000, endMs: now.getTime() };
        case 'thisWeek':
            return { startMs: sow, endMs: now.getTime() };
        case 'lastWeek':
            return { startMs: sowLast, endMs: sow };
        case 'month':
            return { startMs: now.getTime() - 30 * 86400000, endMs: now.getTime() };
        case 'thisMonth':
            return { startMs: som, endMs: now.getTime() };
        case 'lastMonth':
            return { startMs: somLast, endMs: som };
        case 'year':
            return { startMs: now.getTime() - 365 * 86400000, endMs: now.getTime() };
        case 'thisYear':
            return { startMs: soy, endMs: now.getTime() };
        case 'lastYear':
            return { startMs: soyLast, endMs: soy };
        case 'all':
            return { startMs: 0, endMs: now.getTime() + 86400000 };
        case 'custom': {
            const s = new Date(customStart);
            const e = new Date(customEnd);
            const sMs = isNaN(s.getTime()) ? 0 : getStartOfDay(s);
            const eMs = isNaN(e.getTime()) ? now.getTime() + 86400000 : getStartOfDay(e) + 86400000;
            return { startMs: sMs, endMs: eMs };
        }
    }
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
    cardCapMs: number
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
        for (const rep of card.history || []) {
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

async function buildDocumentTree(
    plugin: ReturnType<typeof usePlugin>,
    rootRem: PluginRem,
    scope: ScopeMode,
    startMs: number,
    endMs: number,
    cardCapMs: number,
    onProgress: (p: number, label: string) => void
): Promise<{ tree: BuiltTree; summary: SummaryStats }> {
    onProgress(0.05, 'Gathering rems…');

    let inScopeIds: Set<string>;
    let inScopeRems: PluginRem[];

    if (scope === 'descendants') {
        const descendants = await rootRem.getDescendants();
        const all = [rootRem, ...descendants];
        inScopeIds = new Set(all.map((r) => r._id));
        inScopeRems = all;
    } else {
        const scopeIds = await buildComprehensiveScope(plugin, rootRem._id);
        inScopeIds = new Set(scopeIds);
        const fetched = await chunked(
            Array.from(scopeIds),
            async (id) => plugin.rem.findOne(id),
            (done, total) =>
                onProgress(0.05 + 0.15 * (done / Math.max(1, total)), `Loading rems (${done}/${total})`)
        );
        inScopeRems = fetched.filter((r): r is PluginRem => !!r);
    }

    onProgress(0.2, `Reading history for ${inScopeRems.length} rems…`);

    const remDataList: RemData[] = await chunked(
        inScopeRems,
        (r) => loadRemData(plugin, r),
        (done, total) =>
            onProgress(0.2 + 0.6 * (done / Math.max(1, total)), `History (${done}/${total})`)
    );
    const remDataById: Record<string, RemData> = {};
    for (const rd of remDataList) remDataById[rd.id] = rd;

    onProgress(0.85, 'Building tree…');

    // For comprehensive: include structural ancestors not in scope so each in-scope
    // rem connects upward to a root. We walk parents and add them as ancestor stubs.
    const ancestorIds = new Set<string>();
    if (scope === 'comprehensive') {
        for (const rd of remDataList) {
            let p = rd.parentId;
            while (p && !inScopeIds.has(p) && !ancestorIds.has(p)) {
                ancestorIds.add(p);
                const ancestor = await plugin.rem.findOne(p);
                if (!ancestor) break;
                p = ancestor.parent || null;
            }
        }
    }

    // Materialise ancestor stubs
    const stubData: Record<string, { parentId: string | null; remText: any }> = {};
    if (ancestorIds.size > 0) {
        const ids = Array.from(ancestorIds);
        await chunked(ids, async (id) => {
            const r = await plugin.rem.findOne(id);
            if (r) stubData[id] = { parentId: r.parent || null, remText: r.text };
            return null;
        });
    }

    // Build child map
    const allNodeIds = new Set<string>([...Object.keys(remDataById), ...Object.keys(stubData)]);
    const childMap: Record<string, string[]> = {};
    const rootIds: string[] = [];

    for (const id of allNodeIds) {
        const parentId =
            (remDataById[id]?.parentId ?? stubData[id]?.parentId) || null;
        if (parentId && allNodeIds.has(parentId)) {
            (childMap[parentId] ||= []).push(id);
        } else {
            rootIds.push(id);
        }
    }

    // Compute per-node selfStats and totals, then aggregate bottom-up via DFS.
    const nodes: Record<string, TreeNode> = {};

    function compute(id: string): TreeNode {
        if (nodes[id]) return nodes[id];
        const data = remDataById[id] || null;
        const childrenIds = childMap[id] || [];

        const self = data ? statsFromRem(data, startMs, endMs, cardCapMs) : null;
        let aggr = self ? self.self : emptyStats();
        let aggrIncTagged = data && data.isInc ? 1 : 0;
        let aggrDismTagged = data && data.isDism ? 1 : 0;
        let aggrIncTaggedWithReps =
            data && data.isInc && self && self.hasIncReps ? 1 : 0;
        let aggrDismTaggedWithReps =
            data && data.isDism && self && self.hasDismReps ? 1 : 0;
        let aggrCardsCount = data ? data.cards.length : 0;

        for (const c of childrenIds) {
            const child = compute(c);
            aggr = addStats(aggr, child.aggr);
            aggrIncTagged += child.aggrIncTagged;
            aggrDismTagged += child.aggrDismTagged;
            aggrIncTaggedWithReps += child.aggrIncTaggedWithReps;
            aggrDismTaggedWithReps += child.aggrDismTaggedWithReps;
            aggrCardsCount += child.aggrCardsCount;
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
            remText: data?.remText ?? stubData[id]?.remText,
        };
        return nodes[id];
    }

    for (const rid of rootIds) compute(rid);

    // Summary from root totals: sum aggrs across roots
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

    // Walk all rem-data (not ancestor stubs) to compute summary directly — cleaner than
    // splitting inc vs dism after-the-fact from aggregated stats.
    for (const rd of remDataList) {
        const { self, hasIncReps, hasDismReps } = statsFromRem(rd, startMs, endMs, cardCapMs);
        if (rd.isInc) {
            summary.incTaggedCount += 1;
            if (hasIncReps) summary.incTaggedWithRepsCount += 1;
            // Inc/Dism reps shown separately in summary, so attribute only inc-history reps here.
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
            for (const rep of card.history || []) {
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
        // Unused variable: self — kept above just to compute hasIncReps/hasDismReps.
        void self;
    }

    onProgress(1, 'Done');

    return { tree: { nodes, rootIds }, summary };
}

async function buildGlobalDashboard(
    plugin: ReturnType<typeof usePlugin>,
    startMs: number,
    endMs: number,
    cardCapMs: number,
    onProgress: (p: number, label: string) => void
): Promise<{
    topLevels: DashboardData['topLevels'];
    summary: SummaryStats;
    // also keep a parent-chain cache so subtree expansion is faster
    parentChainCache: Map<string, string[]>;
    // map of remId -> RemData for any rem we've already loaded (incremental / dismissed / card-bearing)
    remDataById: Map<string, RemData>;
}> {
    onProgress(0.02, 'Fetching tagged rems…');

    const incPup = await plugin.powerup.getPowerupByCode(powerupCode);
    const dismPup = await plugin.powerup.getPowerupByCode(dismissedPowerupCode);
    const [incRems, dismRems, allCards] = await Promise.all([
        (incPup?.taggedRem() as Promise<PluginRem[] | undefined>) || Promise.resolve([]),
        (dismPup?.taggedRem() as Promise<PluginRem[] | undefined>) || Promise.resolve([]),
        plugin.card.getAll(),
    ]);
    const incList = incRems || [];
    const dismList = dismRems || [];

    onProgress(
        0.1,
        `Inc: ${incList.length}, Dism: ${dismList.length}, Cards: ${allCards?.length || 0}`
    );

    // Index unique tagged rems
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
            onProgress(0.1 + 0.4 * (done / Math.max(1, total)), `History (${done}/${total})`)
    );

    onProgress(0.55, 'Processing cards…');

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
            remDataById.set(remId, {
                id: remId,
                parentId: null, // resolved later when computing parent chain
                remText: null,
                isInc: false,
                isDism: false,
                incHistory: [],
                dismHistory: [],
                cards,
            });
        }
    }

    onProgress(0.65, 'Walking ancestor chains…');

    // Parent-chain cache: remId -> [self, parent, grandparent, ..., topAncestor]
    const parentChainCache = new Map<string, string[]>();
    async function ancestorChain(id: string): Promise<string[]> {
        const cached = parentChainCache.get(id);
        if (cached) return cached;
        const chain: string[] = [];
        let cur: string | null = id;
        while (cur) {
            if (parentChainCache.has(cur)) {
                chain.push(...parentChainCache.get(cur)!);
                break;
            }
            chain.push(cur);
            const r: PluginRem | undefined = await plugin.rem.findOne(cur);
            if (!r) break;
            cur = r.parent || null;
        }
        parentChainCache.set(id, chain);
        return chain;
    }

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

    const remEntries = Array.from(remDataById.values());
    let processed = 0;
    for (const rd of remEntries) {
        // Build ancestor chain for this rem (parent + above). Need parent info — look up if missing.
        if (rd.parentId === null && !parentChainCache.has(rd.id)) {
            const r = await plugin.rem.findOne(rd.id);
            rd.parentId = r?.parent || null;
            if (r) rd.remText = rd.remText ?? r.text;
        }
        const chain = await ancestorChain(rd.id);
        const topId = chain[chain.length - 1] || rd.id;

        const { self, hasIncReps, hasDismReps } = statsFromRem(rd, startMs, endMs, cardCapMs);
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
            for (const rep of card.history || []) {
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

        processed += 1;
        if (processed % 100 === 0) {
            onProgress(0.65 + 0.3 * (processed / Math.max(1, remEntries.length)), `Aggregating (${processed}/${remEntries.length})`);
        }
    }

    onProgress(0.97, 'Sorting…');

    const topLevels = Array.from(topAggrs.entries())
        .map(([topId, v]) => ({ topId, ...v }))
        .filter(
            (t) =>
                t.aggrIncTagged > 0 ||
                t.aggrDismTagged > 0 ||
                t.aggrCardsCount > 0
        )
        .sort((a, b) => b.aggr.cardTimeMs + b.aggr.incRemTimeSec * 1000 - (a.aggr.cardTimeMs + a.aggr.incRemTimeSec * 1000));

    onProgress(1, 'Done');
    return { topLevels, summary, parentChainCache, remDataById };
}

// Build subtree for a given top-level rem on demand (Global mode).
async function buildSubtreeForTop(
    plugin: ReturnType<typeof usePlugin>,
    topId: string,
    startMs: number,
    endMs: number,
    cardCapMs: number,
    remDataCache: Map<string, RemData>
): Promise<BuiltTree> {
    const topRem = await plugin.rem.findOne(topId);
    if (!topRem) return { nodes: {}, rootIds: [] };

    const descendants = await topRem.getDescendants();
    const all = [topRem, ...descendants];

    // For each rem, load data unless cached
    const remDataList: RemData[] = await chunked(all, async (r) => {
        const cached = remDataCache.get(r._id);
        if (cached) {
            // ensure parent/text are filled
            if (!cached.remText) cached.remText = r.text;
            if (cached.parentId === null) cached.parentId = r.parent || null;
            return cached;
        }
        const data = await loadRemData(plugin, r);
        remDataCache.set(r._id, data);
        return data;
    });
    const remDataById: Record<string, RemData> = {};
    for (const rd of remDataList) remDataById[rd.id] = rd;

    const ids = Object.keys(remDataById);
    const childMap: Record<string, string[]> = {};
    const present = new Set(ids);
    let rootId: string | null = null;
    for (const id of ids) {
        const p = remDataById[id].parentId;
        if (p && present.has(p)) (childMap[p] ||= []).push(id);
        else rootId = id; // top-level inside this subtree
    }
    if (!rootId) rootId = topId;

    const nodes: Record<string, TreeNode> = {};
    function compute(id: string): TreeNode {
        if (nodes[id]) return nodes[id];
        const data = remDataById[id];
        const childrenIds = childMap[id] || [];

        const self = data ? statsFromRem(data, startMs, endMs, cardCapMs) : null;
        let aggr = self ? self.self : emptyStats();
        let aggrIncTagged = data && data.isInc ? 1 : 0;
        let aggrDismTagged = data && data.isDism ? 1 : 0;
        let aggrIncTaggedWithReps =
            data && data.isInc && self && self.hasIncReps ? 1 : 0;
        let aggrDismTaggedWithReps =
            data && data.isDism && self && self.hasDismReps ? 1 : 0;
        let aggrCardsCount = data ? data.cards.length : 0;

        for (const c of childrenIds) {
            const child = compute(c);
            aggr = addStats(aggr, child.aggr);
            aggrIncTagged += child.aggrIncTagged;
            aggrDismTagged += child.aggrDismTagged;
            aggrIncTaggedWithReps += child.aggrIncTaggedWithReps;
            aggrDismTaggedWithReps += child.aggrDismTaggedWithReps;
            aggrCardsCount += child.aggrCardsCount;
        }

        nodes[id] = {
            id,
            childrenIds,
            selfData: data || null,
            aggr,
            aggrIncTagged,
            aggrDismTagged,
            aggrIncTaggedWithReps,
            aggrDismTaggedWithReps,
            aggrCardsCount,
            remText: data?.remText,
        };
        return nodes[id];
    }
    compute(rootId);

    return { nodes, rootIds: [rootId] };
}

// ---------------------------------------------------------------------------
// UI components
// ---------------------------------------------------------------------------

const periodPresets: { id: Period; label: string }[][] = [
    [
        { id: 'today', label: 'Today' },
        { id: 'week', label: 'Week' },
        { id: 'month', label: 'Month' },
        { id: 'year', label: 'Year' },
        { id: 'all', label: 'All' },
    ],
    [
        { id: 'yesterday', label: 'Yesterday' },
        { id: 'thisWeek', label: 'This Week' },
        { id: 'thisMonth', label: 'This Month' },
        { id: 'thisYear', label: 'This Year' },
    ],
    [
        { id: 'lastWeek', label: 'Last Week' as any },
        { id: 'lastMonth', label: 'Last Month' },
        { id: 'lastYear', label: 'Last Year' },
    ],
];

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
    const btn = (id: Period, label: string) => {
        const active = id === period;
        return (
            <button
                key={id}
                onClick={() => onChange(id)}
                style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--rn-clr-border-primary)',
                    background: active ? 'var(--rn-clr-blue-500, #3b82f6)' : 'transparent',
                    color: active ? '#fff' : 'var(--rn-clr-content-primary)',
                    fontSize: 12,
                    cursor: 'pointer',
                    minWidth: 90,
                }}
            >
                {label}
            </button>
        );
    };
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {periodPresets.map((row, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {row.map((p) => btn(p.id, p.label))}
                </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary)' }}>Start</span>
                    <input
                        type="date"
                        value={customStart}
                        onChange={(e) => {
                            onCustomChange(e.target.value, customEnd);
                            onChange('custom');
                        }}
                        style={{ fontSize: 12, padding: '4px 6px' }}
                    />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary)' }}>End</span>
                    <input
                        type="date"
                        value={customEnd}
                        onChange={(e) => {
                            onCustomChange(customStart, e.target.value);
                            onChange('custom');
                        }}
                        style={{ fontSize: 12, padding: '4px 6px' }}
                    />
                </div>
                {period === 'custom' && (
                    <button
                        onClick={() => onChange('today')}
                        style={{
                            fontSize: 11,
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--rn-clr-blue-500, #3b82f6)',
                            cursor: 'pointer',
                        }}
                    >
                        Clear
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

// Global top-level row with lazy subtree.
function GlobalTopLevelRow({
    topId,
    pre,
    startMs,
    endMs,
    cardCapMs,
    remDataCache,
}: {
    topId: string;
    pre: NonNullable<DashboardData['topLevels']>[number];
    startMs: number;
    endMs: number;
    cardCapMs: number;
    remDataCache: Map<string, RemData>;
}) {
    const plugin = usePlugin();
    const [expanded, setExpanded] = useState(false);
    const [subtree, setSubtree] = useState<BuiltTree | null>(null);
    const [loading, setLoading] = useState(false);
    const [text, setText] = useState<any>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const rem = await plugin.rem.findOne(topId);
            if (!cancelled && rem) setText(rem.text);
        })();
        return () => {
            cancelled = true;
        };
    }, [topId, plugin]);

    // Synthetic node for the top-level row's display
    const pseudoNode: TreeNode = {
        id: topId,
        childrenIds: [], // we don't render children here; the subtree handles it
        selfData: null,
        aggr: pre.aggr,
        aggrIncTagged: pre.aggrIncTagged,
        aggrDismTagged: pre.aggrDismTagged,
        aggrIncTaggedWithReps: pre.aggrIncTaggedWithReps,
        aggrDismTaggedWithReps: pre.aggrDismTaggedWithReps,
        aggrCardsCount: pre.aggrCardsCount,
        remText: text,
    };

    const onToggle = async () => {
        if (expanded) {
            setExpanded(false);
            return;
        }
        setExpanded(true);
        if (subtree) return;
        setLoading(true);
        try {
            const t = await buildSubtreeForTop(plugin, topId, startMs, endMs, cardCapMs, remDataCache);
            setSubtree(t);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div>
            <HierarchyRow
                node={pseudoNode}
                depth={0}
                expanded={expanded}
                hasChildren={true}
                onToggle={onToggle}
            />
            {expanded && (
                <div>
                    {loading && (
                        <div
                            style={{
                                fontSize: 11,
                                color: 'var(--rn-clr-content-tertiary)',
                                padding: '6px 8px',
                                paddingLeft: 30,
                            }}
                        >
                            Loading subtree…
                        </div>
                    )}
                    {subtree && (
                        <div style={{ paddingLeft: 0 }}>
                            <SubtreeRenderer tree={subtree} startDepth={1} hideRoot={true} />
                        </div>
                    )}
                </div>
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

    const [contextMode, setContextMode] = useState<ContextMode>(
        ctxRemId ? 'document' : 'global'
    );
    const [scope, setScope] = useState<ScopeMode>('comprehensive');
    const [period, setPeriod] = useState<Period>('today');
    const [customStart, setCustomStart] = useState('');
    const [customEnd, setCustomEnd] = useState('');

    useEffect(() => {
        // Update default context once ctx loads
        if (ctxRemId && contextMode !== 'document') {
            setContextMode('document');
        }
    }, [ctxRemId]);

    const { startMs, endMs } = useMemo(
        () => resolvePeriod(period, customStart, customEnd),
        [period, customStart, customEnd]
    );

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
    const [globalRemDataCache, setGlobalRemDataCache] = useState<Map<string, RemData>>(
        new Map()
    );
    const [summary, setSummary] = useState<SummaryStats | null>(null);
    const runIdRef = useRef(0);

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
                const { tree, summary: s } = await buildDocumentTree(
                    plugin,
                    rootRem,
                    scope,
                    startMs,
                    endMs,
                    cardCapMs,
                    (p, label) => {
                        if (runId !== runIdRef.current) return;
                        setProgress({ running: true, percent: p, label });
                    }
                );
                if (runId !== runIdRef.current) return;
                setDocTree(tree);
                setSummary(s);
            } else {
                const r = await buildGlobalDashboard(plugin, startMs, endMs, cardCapMs, (p, label) => {
                    if (runId !== runIdRef.current) return;
                    setProgress({ running: true, percent: p, label });
                });
                if (runId !== runIdRef.current) return;
                setGlobalTops(r.topLevels);
                setGlobalRemDataCache(r.remDataById);
                setSummary(r.summary);
            }
        } catch (err) {
            console.error('[study_dashboard] compute failed', err);
        } finally {
            if (runId === runIdRef.current) {
                setProgress({ running: false, percent: 1, label: '' });
            }
        }
    }, [plugin, contextMode, ctxRemId, scope, startMs, endMs, cardCapMs]);

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
        <div style={containerStyle}>
            {/* Header */}
            <div
                style={{
                    padding: '12px 16px',
                    borderBottom: '1px solid var(--rn-clr-border-primary)',
                    background: 'var(--rn-clr-background-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>📊</span>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>Study Dashboard</span>
                </div>
                <button
                    onClick={() => plugin.widget.closePopup()}
                    style={{
                        background: 'none',
                        border: 'none',
                        fontSize: 18,
                        cursor: 'pointer',
                        opacity: 0.6,
                    }}
                    title="Close"
                >
                    ✕
                </button>
            </div>

            {/* Filters */}
            <div
                style={{
                    padding: '12px 16px',
                    borderBottom: '1px solid var(--rn-clr-border-primary)',
                    background: 'var(--rn-clr-background-secondary)',
                    display: 'flex',
                    gap: 24,
                    flexWrap: 'wrap',
                }}
            >
                <div>
                    <div
                        style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: 'var(--rn-clr-content-tertiary)',
                            textTransform: 'uppercase',
                            marginBottom: 6,
                        }}
                    >
                        Context
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label
                            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}
                        >
                            <input
                                type="radio"
                                checked={contextMode === 'global'}
                                onChange={() => setContextMode('global')}
                            />
                            Global
                        </label>
                        <label
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                fontSize: 12,
                                cursor: ctxRemId ? 'pointer' : 'not-allowed',
                                opacity: ctxRemId ? 1 : 0.5,
                            }}
                        >
                            <input
                                type="radio"
                                disabled={!ctxRemId}
                                checked={contextMode === 'document'}
                                onChange={() => setContextMode('document')}
                            />
                            Document
                        </label>
                    </div>
                    {contextMode === 'document' && (
                        <div style={{ marginTop: 8 }}>
                            <div
                                style={{
                                    fontSize: 10,
                                    fontWeight: 600,
                                    color: 'var(--rn-clr-content-tertiary)',
                                    textTransform: 'uppercase',
                                    marginBottom: 4,
                                }}
                            >
                                Scope
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <label style={{ fontSize: 12, cursor: 'pointer' }}>
                                    <input
                                        type="radio"
                                        checked={scope === 'descendants'}
                                        onChange={() => setScope('descendants')}
                                    />{' '}
                                    Descendants Only
                                </label>
                                <label style={{ fontSize: 12, cursor: 'pointer' }}>
                                    <input
                                        type="radio"
                                        checked={scope === 'comprehensive'}
                                        onChange={() => setScope('comprehensive')}
                                    />{' '}
                                    Comprehensive
                                </label>
                            </div>
                        </div>
                    )}
                </div>
                <div style={{ flex: 1 }}>
                    <div
                        style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: 'var(--rn-clr-content-tertiary)',
                            textTransform: 'uppercase',
                            marginBottom: 6,
                        }}
                    >
                        Period
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

            {/* Progress / Summary / Hierarchy */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
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
                                    startMs={startMs}
                                    endMs={endMs}
                                    cardCapMs={cardCapMs || DEFAULT_RESPONSE_TIME_LIMIT_SEC * 1000}
                                    remDataCache={globalRemDataCache}
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
