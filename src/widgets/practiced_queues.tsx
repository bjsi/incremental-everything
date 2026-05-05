import React, { useEffect, useState, useMemo, useRef, useCallback } from "react";
import {
    RemViewer,
    renderWidget,
    usePlugin,
    useSyncedStorageState,
    useSessionStorageState,
} from "@remnote/plugin-sdk";
import '../style.css';
import '../App.css';
import { timeSince } from "../lib/utils";
import {
    DAILY_AGGREGATES_KEY,
    DailyAggregate,
    PeriodStats,
    aggregatePeriodStats,
    bucketSession,
    filterAggregatesForKb,
    getAggregatedIdsSet,
    getLocalDateKey,
    rawCutoffDateKey,
    totalAggregatedSessionCount,
} from "../lib/queue_aggregates";

export interface PracticedQueueSession {
    id: string;
    startTime: number;
    endTime?: number;
    queueId?: string;
    scopeName?: string;
    kbId?: string;

    totalTime: number;
    flashcardsCount: number;
    flashcardsTime: number;
    incRemsCount: number;
    incRemsTime: number;
    againCount: number;
    currentCardFirstRep?: number;
    currentCardTotalTime?: number;
    currentCardRepCount?: number;
    currentCardInterval?: number;

    prevCardFirstRep?: number;
    prevCardTotalTime?: number;
    prevCardRepCount?: number;
    prevCardInterval?: number;
    prevCardNextRepTime?: number;

    currentCardId?: string;
    prevCardId?: string;
}

interface AggregatedStats {
    label: string;
    totalTime: number;
    cardsCount: number;
    cardsTime: number;
    incRemsCount: number;
    incRemsTime: number;
    retentionRate: number;
    avgSpeed: number;
}

const NUM_TO_LOAD_IN_BATCH = 20;

const formatTimeShort = (ms: number) => {
    if (!ms) return "0s";
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
};

function getStartOfDay(date: Date) {
    const newDate = new Date(date);
    newDate.setHours(0, 0, 0, 0);
    return newDate.getTime();
}

function getStartOfWeek(date: Date) {
    const newDate = new Date(date);
    const day = newDate.getDay();
    const first = newDate.getDate() - day;
    newDate.setDate(first);
    newDate.setHours(0, 0, 0, 0);
    return newDate.getTime();
}

function getStartOfMonth(date: Date) {
    const newDate = new Date(date);
    newDate.setDate(1);
    newDate.setHours(0, 0, 0, 0);
    return newDate.getTime();
}

function getStartOfYear(date: Date) {
    const newDate = new Date(date);
    newDate.setMonth(0, 1);
    newDate.setHours(0, 0, 0, 0);
    return newDate.getTime();
}

function buildRow(
    label: string,
    rawSessions: PracticedQueueSession[],
    aggregates: DailyAggregate[],
    startMs: number,
    endMs?: number
): AggregatedStats {
    const s: PeriodStats = aggregatePeriodStats(rawSessions, aggregates, startMs, endMs);
    const remembered = Math.max(0, s.cardsCount - s.forgotCount);
    const retentionRate = s.cardsCount > 0 ? (remembered / s.cardsCount) * 100 : 0;
    const cardsTimeMin = s.cardsTime / 1000 / 60;
    const avgSpeed = cardsTimeMin > 0 ? s.cardsCount / cardsTimeMin : 0;
    return {
        label,
        totalTime: s.totalTime,
        cardsCount: s.cardsCount,
        cardsTime: s.cardsTime,
        incRemsCount: s.incRemsCount,
        incRemsTime: s.incRemsTime,
        retentionRate,
        avgSpeed,
    };
}

function SummaryTable({
    allSessions,
    allAggregates,
}: {
    allSessions: PracticedQueueSession[];
    allAggregates: DailyAggregate[];
}) {
    const stats = useMemo(() => {
        const now = new Date();
        const startOfToday = getStartOfDay(now);
        const startOfYesterday = startOfToday - 86400000;
        const startOfWeek = getStartOfWeek(now);
        const startOfLastWeek = startOfWeek - (7 * 24 * 60 * 60 * 1000);
        const startOfMonth = getStartOfMonth(now);
        const startOfYear = getStartOfYear(now);

        const lastMonthDate = new Date(now);
        lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
        const startOfLastMonth = getStartOfMonth(lastMonthDate);

        const lastYearDate = new Date(now);
        lastYearDate.setFullYear(lastYearDate.getFullYear() - 1);
        const startOfLastYear = getStartOfYear(lastYearDate);

        return [
            buildRow("Today", allSessions, allAggregates, startOfToday),
            buildRow("Yesterday", allSessions, allAggregates, startOfYesterday, startOfToday),
            buildRow("This Week", allSessions, allAggregates, startOfWeek),
            buildRow("Last Week", allSessions, allAggregates, startOfLastWeek, startOfWeek),
            buildRow("This Month", allSessions, allAggregates, startOfMonth),
            buildRow("Last Month", allSessions, allAggregates, startOfLastMonth, startOfMonth),
            buildRow("This Year", allSessions, allAggregates, startOfYear),
            buildRow("Last Year", allSessions, allAggregates, startOfLastYear, startOfYear),
            buildRow("Ever", allSessions, allAggregates, 0),
        ];
    }, [allSessions, allAggregates]);

    return (
        <div className="mb-6 overflow-x-auto">
            <h2 className="text-sm font-bold uppercase rn-clr-content-tertiary mb-2 tracking-wider">Summary</h2>
            <div className="border rounded-lg overflow-hidden text-xs rn-clr-border-opaque">
                <table className="w-full text-left rn-clr-background-primary">
                    <thead className="rn-clr-background-secondary border-b rn-clr-border-opaque">
                        <tr>
                            <th className="p-2 font-bold rn-clr-content-secondary">Period</th>
                            <th className="p-2 font-bold rn-clr-content-secondary text-right">Time</th>
                            <th className="p-2 font-bold rn-clr-content-secondary text-right">Cards</th>
                            <th className="p-2 font-bold rn-clr-content-secondary text-right">Inc. Rems</th>
                            <th className="p-2 font-bold rn-clr-content-secondary text-right">Ret.</th>
                            <th className="p-2 font-bold rn-clr-content-secondary text-right">Speed</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y rn-clr-divide-opaque">
                        {stats.map((row) => (
                            <tr key={row.label} className="hover:rn-clr-background-secondary transition-colors">
                                <td className="p-2 font-medium rn-clr-content-primary">{row.label}</td>
                                <td className="p-2 text-right font-mono rn-clr-content-secondary">
                                    {row.totalTime > 0 ? formatTimeShort(row.totalTime) : "-"}
                                </td>
                                <td className="p-2 text-right">
                                    {row.cardsCount > 0 ? (
                                        <div>
                                            <span className="font-bold rn-clr-content-primary">{row.cardsCount}</span>
                                            <span className="rn-clr-content-tertiary text-[10px] ml-1">({formatTimeShort(row.cardsTime)})</span>
                                        </div>
                                    ) : <span className="rn-clr-content-tertiary">-</span>}
                                </td>
                                <td className="p-2 text-right">
                                    {row.incRemsCount > 0 ? (
                                        <div>
                                            <span className="font-bold rn-clr-content-primary">{row.incRemsCount}</span>
                                            <span className="rn-clr-content-tertiary text-[10px] ml-1">({formatTimeShort(row.incRemsTime)})</span>
                                        </div>
                                    ) : <span className="rn-clr-content-tertiary">-</span>}
                                </td>
                                <td className="p-2 text-right">
                                    {row.cardsCount > 0 ? (
                                        <span className={row.retentionRate >= 90 ? "text-green-600 font-bold" : (row.retentionRate < 80 ? "text-red-500 font-bold" : "text-yellow-600 font-bold")}>
                                            {row.retentionRate.toFixed(0)}%
                                        </span>
                                    ) : <span className="rn-clr-content-tertiary">-</span>}
                                </td>
                                <td className="p-2 text-right">
                                    {row.cardsCount > 0 ? (
                                        <span><span className="rn-clr-content-primary">{row.avgSpeed.toFixed(1)}</span> <span className="rn-clr-content-tertiary text-[10px]">cpm</span></span>
                                    ) : <span className="rn-clr-content-tertiary">-</span>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function PracticedQueues() {
    const plugin = usePlugin();
    const [historyRaw, setHistory] = useSyncedStorageState<PracticedQueueSession[]>(
        "practicedQueuesHistory",
        []
    );
    const [aggregatesRaw, setAggregates] = useSyncedStorageState<DailyAggregate[]>(
        DAILY_AGGREGATES_KEY,
        []
    );
    const [activeSession] = useSessionStorageState<PracticedQueueSession | null>("activeQueueSession", null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [currentKbId, setCurrentKbId] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        plugin.kb.getCurrentKnowledgeBaseData().then((kb) => {
            if (!cancelled) setCurrentKbId(kb._id);
        });
        return () => {
            cancelled = true;
        };
    }, [plugin]);

    // Defensive: skip null entries (synced storage can leave nulls when a
    // partial write hits the storage quota — see queue_aggregates rollover).
    const filteredData = useMemo(() => {
        if (!currentKbId) return [];
        return historyRaw.filter((item) => {
            if (!item) return false;
            if (!item.kbId) return true;
            return item.kbId === currentKbId;
        });
    }, [historyRaw, currentKbId]);

    const filteredAggregates = useMemo(() => {
        if (!currentKbId) return [];
        return filterAggregatesForKb(aggregatesRaw, currentKbId);
    }, [aggregatesRaw, currentKbId]);

    const totalAllKbsCount = useMemo(() => {
        const rawCount = (historyRaw || []).filter(Boolean).length;
        const bucketCount = totalAggregatedSessionCount(aggregatesRaw);
        return rawCount + bucketCount;
    }, [historyRaw, aggregatesRaw]);

    const [numLoaded, setNumLoaded] = React.useState(1);

    useEffect(() => {
        setNumLoaded(1);
    }, [filteredData.length]);

    const numUnloaded = Math.max(
        0,
        filteredData.length - NUM_TO_LOAD_IN_BATCH * numLoaded
    );

    const deleteItem = (id: string) => {
        const next = historyRaw.filter((x) => x && x.id !== id);
        if (next.length !== historyRaw.length) {
            setHistory(next);
        }
    };

    const handleExport = useCallback(() => {
        const envelope = {
            version: 2,
            exportedAt: new Date().toISOString(),
            sessionCount: (historyRaw || []).filter(Boolean).length,
            aggregatedCount: totalAggregatedSessionCount(aggregatesRaw),
            sessions: (historyRaw || []).filter(Boolean),
            dailyAggregates: aggregatesRaw || [],
        };
        const json = JSON.stringify(envelope, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const dateStr = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `practiced-queues-backup-${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        const total = envelope.sessionCount + envelope.aggregatedCount;
        plugin.app.toast(`Exported ${total} sessions (${envelope.sessionCount} raw, ${envelope.aggregatedCount} aggregated)`);
    }, [historyRaw, aggregatesRaw, plugin]);

    const handleImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const text = event.target?.result as string;
                const data = JSON.parse(text);

                if (!data || !Array.isArray(data.sessions)) {
                    plugin.app.toast("Invalid backup file: missing 'sessions' array.");
                    return;
                }

                const incoming = data.sessions as PracticedQueueSession[];

                const valid = incoming.filter(
                    (s: any) => s && typeof s.id === "string" && typeof s.startTime === "number"
                );
                if (valid.length === 0) {
                    plugin.app.toast("No valid sessions found in backup file.");
                    return;
                }

                const localAggregates = aggregatesRaw || [];
                const localAggregatedIds = getAggregatedIdsSet(localAggregates);
                const localRawIds = new Set(
                    (historyRaw || []).filter(Boolean).map((s) => s.id)
                );

                const newSessions = valid.filter(
                    (s) => !localRawIds.has(s.id) && !localAggregatedIds.has(s.id)
                );
                const duplicateCount = valid.length - newSessions.length;

                // Split incoming into recent (raw window) vs old (bucket).
                const cutoffKey = rawCutoffDateKey();
                const recentNew: PracticedQueueSession[] = [];
                const oldNew: PracticedQueueSession[] = [];
                for (const s of newSessions) {
                    if (getLocalDateKey(s.startTime) >= cutoffKey) recentNew.push(s);
                    else oldNew.push(s);
                }

                // Optionally seed local aggregates from a v2 backup, but only
                // when the local aggregate set is empty — merging two
                // independent aggregate snapshots without per-bucket id lists
                // would risk double-counting. v2 backups carry ids in each
                // bucket so a fresh restore is fully accurate.
                let aggregatesAfterImport = localAggregates;
                let seededFromFile = 0;
                if (
                    data.version === 2 &&
                    Array.isArray(data.dailyAggregates) &&
                    localAggregates.length === 0
                ) {
                    aggregatesAfterImport = (data.dailyAggregates as DailyAggregate[]).filter(
                        (b): b is DailyAggregate => !!b && Array.isArray(b.ids)
                    );
                    seededFromFile = totalAggregatedSessionCount(aggregatesAfterImport);
                }

                // Now bucket the import's old sessions (those not already covered
                // by the seeded buckets). We deep-clone to avoid mutating the
                // hook-returned reference.
                let bucketedFromImport = 0;
                if (oldNew.length > 0) {
                    aggregatesAfterImport = aggregatesAfterImport.map((a) => ({
                        ...a,
                        ids: [...(a.ids || [])],
                    }));
                    const idsSet = getAggregatedIdsSet(aggregatesAfterImport);
                    for (const s of oldNew) {
                        if (bucketSession(aggregatesAfterImport, s, idsSet)) bucketedFromImport++;
                    }
                }

                if (
                    recentNew.length === 0 &&
                    bucketedFromImport === 0 &&
                    seededFromFile === 0
                ) {
                    plugin.app.toast(
                        `All ${duplicateCount} sessions already exist. Nothing imported.`
                    );
                    return;
                }

                if (
                    aggregatesAfterImport !== localAggregates ||
                    bucketedFromImport > 0 ||
                    seededFromFile > 0
                ) {
                    setAggregates(aggregatesAfterImport);
                }

                if (recentNew.length > 0) {
                    const mergedHistory = [
                        ...((historyRaw || []).filter(Boolean) as PracticedQueueSession[]),
                        ...recentNew,
                    ].sort((a, b) => b.startTime - a.startTime);
                    setHistory(mergedHistory);
                }

                const importedTotal =
                    recentNew.length + bucketedFromImport + seededFromFile;
                let msg = `Imported ${importedTotal} session${importedTotal === 1 ? "" : "s"}`;
                const parts: string[] = [];
                if (recentNew.length > 0) parts.push(`${recentNew.length} recent`);
                if (bucketedFromImport > 0)
                    parts.push(`${bucketedFromImport} aggregated`);
                if (seededFromFile > 0)
                    parts.push(`${seededFromFile} from backup aggregates`);
                if (parts.length > 0) msg += ` (${parts.join(", ")})`;
                if (duplicateCount > 0)
                    msg += ` — ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} skipped`;
                if (
                    data.version === 2 &&
                    Array.isArray(data.dailyAggregates) &&
                    localAggregates.length > 0 &&
                    seededFromFile === 0
                ) {
                    msg +=
                        ". Backup's historical aggregates were skipped — local aggregates already exist.";
                }
                plugin.app.toast(msg);
            } catch (err) {
                plugin.app.toast("Failed to parse backup file. Is it valid JSON?");
                console.error("Import error:", err);
            }
        };
        reader.readAsText(file);

        e.target.value = "";
    }, [historyRaw, aggregatesRaw, setHistory, setAggregates, plugin]);

    useEffect(() => {
        plugin.event.addListener(
            "trigger_export_sessions",
            undefined,
            () => handleExport()
        );
        plugin.event.addListener(
            "trigger_import_sessions",
            undefined,
            () => fileInputRef.current?.click()
        );
    }, [handleExport, plugin]);

    return (
        <div className="h-full w-full overflow-y-auto rn-clr-background-primary">
            <div className="p-4">
                <h1 className="text-xl font-bold mb-4">Practiced Queues History</h1>

                {activeSession && (
                    <div className="mb-6">
                        <div className="uppercase text-xs font-bold rn-clr-content-tertiary mb-2 tracking-wider flex items-center gap-2">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                            </span>
                            Active Session
                        </div>
                        <QueueSessionItem
                            session={activeSession}
                            isLive={true}
                            onDelete={() => { }}
                        />
                        <div className="h-px w-full rn-clr-background-elevation-10 mt-6 md:mt-4"></div>
                    </div>
                )}

                <SummaryTable allSessions={filteredData} allAggregates={filteredAggregates} />

                <div className="flex items-center gap-2 mb-4">
                    <button
                        onClick={handleExport}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border rn-clr-border-opaque rn-clr-content-secondary hover:rn-clr-background-secondary transition-colors"
                        title="Export all sessions (all KBs) as a JSON backup file"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" />
                        </svg>
                        Export
                    </button>
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border rn-clr-border-opaque rn-clr-content-secondary hover:rn-clr-background-secondary transition-colors"
                        title="Import sessions from a JSON backup file (duplicates are skipped)"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M16 6l-4-4m0 0L8 6m4-4v13" />
                        </svg>
                        Import
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json"
                        onChange={handleImport}
                        className="hidden"
                    />
                    <span className="text-[10px] rn-clr-content-tertiary ml-1">
                        {totalAllKbsCount} sessions total (all KBs)
                    </span>
                </div>

                {filteredData.length === 0 ? (
                    <div className="rn-clr-content-secondary">
                        No practice sessions recorded yet.
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        <div className="uppercase text-xs font-bold text-gray-400 mb-2 tracking-wider">History Log</div>
                        {filteredData.slice(0, NUM_TO_LOAD_IN_BATCH * numLoaded).map((session) => (
                            <QueueSessionItem
                                key={session.id}
                                session={session}
                                onDelete={() => deleteItem(session.id)}
                            />
                        ))}
                    </div>
                )}

                {numUnloaded > 0 && (
                    <button
                        onClick={() => setNumLoaded(n => n + 1)}
                        className="mt-4 w-full py-2 text-center text-blue-500 hover:text-blue-600 font-medium"
                    >
                        Load more ({numUnloaded})
                    </button>
                )}
            </div>
        </div>
    );
}

function QueueSessionItem({ session, onDelete, isLive }: { session: PracticedQueueSession, onDelete: () => void, isLive?: boolean }) {
    const plugin = usePlugin();

    const formatTime = (ms: number) => {
        if (!ms) return "0s";
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    const formatAge = (firstRepTime?: number) => {
        if (!firstRepTime) return "New";
        const diff = Date.now() - firstRepTime;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const months = Math.floor(days / 30);
        const years = Math.floor(days / 365);

        if (years > 0) return `${years}.${Math.floor((days % 365) / 30)}y`;
        if (months > 0) return `${months}.${Math.floor(days % 30 / 3)}m`;
        if (days > 0) return `${days}d`;

        const hours = Math.floor(diff / (1000 * 60 * 60));
        if (hours > 0) return `${hours}h`;
        const minutes = Math.floor(diff / (1000 * 60));
        if (minutes > 0) return `${minutes}min`;

        return "Just now";
    }

    const formatInterval = (intervalMs?: number) => {
        if (!intervalMs || intervalMs <= 0) return "-";
        const days = Math.floor(intervalMs / (1000 * 60 * 60 * 24));
        const months = Math.floor(days / 30);
        const years = Math.floor(days / 365);

        if (years > 0) return `${years}.${Math.floor((days % 365) / 30)}y`;
        if (months > 0) return `${months}.${Math.floor(days % 30 / 3)}m`;
        if (days > 0) return `${days}d`;
        const hours = Math.floor(intervalMs / (1000 * 60 * 60));
        if (hours > 0) return `${hours}h`;
        return "<1h";
    }

    const formatCoverage = (createdAt?: number, nextRepTime?: number) => {
        if (!createdAt || !nextRepTime) return "-";
        const totalMs = nextRepTime - createdAt;
        return formatInterval(totalMs);
    }

    const handleOpen = async () => {
        if (session.queueId) {
            const rem = await plugin.rem.findOne(session.queueId);
            if (rem) {
                plugin.window.openRem(rem);
            } else {
                plugin.app.toast("Could not find the document for this queue.");
            }
        }
    }

    const seconds = session.flashcardsTime / 1000;
    const count = session.flashcardsCount;

    const cardsPerMinVal = count > 0 && seconds > 0 ? (count / seconds) * 60 : 0;
    const cardsPerMin = count > 0 && seconds > 0 ? cardsPerMinVal.toFixed(1) : '-';

    const avgSpeedSeconds = count > 0 ? (seconds / count).toFixed(1) : '-';

    const forgotCount = session.againCount || 0;
    const rememberedCount = Math.max(0, count - forgotCount);
    const retentionRate = count > 0 ? ((rememberedCount / count) * 100).toFixed(0) : "100";

    let hue = 0;
    if (count > 0 && seconds > 0) {
        if (cardsPerMinVal < 1.5) {
            hue = 0;
        } else if (cardsPerMinVal >= 4) {
            hue = 120;
        } else {
            const ratio = (cardsPerMinVal - 1.5) / (4 - 1.5);
            hue = Math.floor(ratio * 120);
        }
    }
    const speedColor = { color: count > 0 ? `hsl(${hue}, 90%, 35%)` : '' };

    const retentionVal = parseInt(retentionRate);
    const retentionColor = retentionVal >= 90 ? "text-green-600" : (retentionVal < 80 ? "text-red-500" : "text-yellow-600");

    if (isLive) {
        return (
            <div className="p-4 border-l-4 border-green-500 bg-green-500/5 rounded-r-lg shadow-sm mb-4">
                <div onClick={handleOpen} className="cursor-pointer">
                    <div className="font-bold text-xl mb-3 truncate" title={session.scopeName || "Ad-hoc Queue"}>
                        {session.scopeName ? session.scopeName : (session.queueId ? (
                            <RemViewer remId={session.queueId} width="100%" />
                        ) : "Ad-hoc Queue")}
                    </div>

                    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
                        <div className="bg-white/50 dark:bg-black/20 p-2 rounded">
                            <div className="text-xs uppercase font-bold text-gray-500 mb-1">Time</div>
                            <div className="text-2xl font-mono font-semibold">{formatTime(session.totalTime)}</div>
                        </div>


                        <div className="bg-white/50 dark:bg-black/20 p-2 rounded">
                            <div className="text-xs uppercase font-bold text-gray-500 mb-1">Cards</div>
                            <div className="text-xl font-semibold">
                                {count} <span className="text-xs font-normal text-gray-400">({formatTime(session.flashcardsTime)})</span>
                            </div>
                        </div>
                        {session.incRemsCount > 0 && (
                            <div className="bg-white/50 dark:bg-black/20 p-2 rounded">
                                <div className="text-xs uppercase font-bold text-gray-500 mb-1">Inc. Rems</div>
                                <div className="text-xl font-semibold">
                                    {session.incRemsCount} <span className="text-xs font-normal text-gray-400">({formatTime(session.incRemsTime)})</span>
                                </div>
                            </div>
                        )}

                        <div className="bg-white/50 dark:bg-black/20 p-2 rounded">
                            <div className="text-xs uppercase font-bold text-gray-500 mb-1">Speed</div>
                            <div className="flex flex-col">
                                <div className="text-2xl font-bold" style={speedColor}>
                                    {cardsPerMin}<span className="text-sm font-normal ml-1">cpm</span>
                                </div>
                                <div className="text-xs text-gray-400">
                                    {avgSpeedSeconds} s/card
                                </div>
                            </div>
                        </div>

                        <div className="bg-white/50 dark:bg-black/20 p-2 rounded">
                            <div className="text-xs uppercase font-bold text-gray-500 mb-1">Retention</div>
                            <div className="flex flex-col">
                                <div className={`text-2xl font-bold ${retentionColor}`}>
                                    {retentionRate}<span className="text-sm font-normal ml-1">%</span>
                                </div>
                                <div className="text-xs font-semibold text-gray-500">
                                    <span className="text-green-600">{rememberedCount}</span>
                                    <span className="mx-1">/</span>
                                    <span className="text-red-500">{forgotCount}</span>
                                </div>
                            </div>
                        </div>

                        <div className="bg-white/50 dark:bg-black/20 p-2 rounded">
                            <div className="text-xs uppercase font-bold text-gray-500 mb-1">Card Age</div>
                            <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                                {formatAge(session.currentCardFirstRep)}
                                {session.currentCardInterval && (
                                    <span className="text-sm font-normal text-gray-400 dark:text-gray-500 ml-1">
                                        (Ivl: {formatInterval(session.currentCardInterval)})
                                    </span>
                                )}
                            </div>
                            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                <span title="Total Review Time" className="inline-flex items-center gap-1 align-baseline">
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 self-center" viewBox="0 0 20 20" fill="currentColor">
                                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                                    </svg>
                                    <span>{session.currentCardTotalTime !== undefined ? formatTime(session.currentCardTotalTime) : '-'}</span>
                                </span>
                                <span className="mx-2 text-gray-300 dark:text-gray-600">|</span>
                                <span title="Total Repetitions">
                                    {session.currentCardRepCount !== undefined ? `${session.currentCardRepCount} reps` : '-'}
                                </span>
                            </div>
                            {session.currentCardTotalTime !== undefined && session.currentCardFirstRep && (() => {
                                const ageMs = Date.now() - session.currentCardFirstRep;
                                const ageYears = ageMs / (1000 * 60 * 60 * 24 * 365);
                                const totalTimeMinutes = session.currentCardTotalTime / (1000 * 60);
                                if (ageYears > 0) {
                                    const cost = totalTimeMinutes / ageYears;
                                    return (
                                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400" title="Cost: Total time (min) / Age (years)">
                                            💰 Cost: {cost.toFixed(1)} min/year
                                        </div>
                                    );
                                }
                                return null;
                            })()}
                        </div>

                        {session.prevCardId && (
                            <div className="bg-white/30 dark:bg-black/10 p-2 rounded opacity-75">
                                <div className="text-xs uppercase font-bold text-gray-400 mb-1">Prev. Card</div>
                                <div className="text-xl font-bold text-gray-500 dark:text-gray-400">
                                    {formatAge(session.prevCardFirstRep)}
                                    {session.prevCardInterval && (
                                        <span className="text-sm font-normal text-gray-400 dark:text-gray-500 ml-1">
                                            (Ivl: {formatInterval(session.prevCardInterval)})
                                        </span>
                                    )}
                                </div>
                                <div className="mt-1 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                                    <span title="Total Review Time" className="flex items-center gap-1">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                                        </svg>
                                        {formatTime(session.prevCardTotalTime || 0)}
                                    </span>
                                    <span className="w-px h-3 bg-gray-300 dark:bg-gray-600"></span>
                                    <span title="Total Repetitions">
                                        {session.prevCardRepCount} reps
                                    </span>
                                </div>
                                {session.prevCardNextRepTime && (
                                    <>
                                        <div className="mt-1 text-xs text-gray-400 dark:text-gray-500" title="Total time coverage from card creation to next scheduled review">
                                            📊 Coverage: {formatCoverage(session.prevCardFirstRep, session.prevCardNextRepTime)}
                                        </div>
                                        {session.prevCardTotalTime && session.prevCardFirstRep && (() => {
                                            const coverageMs = session.prevCardNextRepTime - session.prevCardFirstRep;
                                            const coverageYears = coverageMs / (1000 * 60 * 60 * 24 * 365);
                                            const totalTimeMinutes = session.prevCardTotalTime / (1000 * 60);
                                            if (coverageYears > 0) {
                                                const cost = totalTimeMinutes / coverageYears;
                                                return (
                                                    <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                                                        💰 Cost: {cost.toFixed(1)} min/year
                                                    </div>
                                                );
                                            }
                                            return null;
                                        })()}
                                    </>
                                )}
                            </div>
                        )}

                    </div>

                    <div className="text-xs text-green-600 font-medium mt-3 flex items-center gap-1">
                        <span className="relative flex h-2 w-2 mr-1">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                        </span>
                        Recording Live...
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="p-3 border rounded-lg rn-clr-border-opaque hover:shadow-sm transition-shadow rn-clr-background-elevation-10">
            <div className="flex justify-between items-start">
                <div onClick={handleOpen} className="cursor-pointer flex-grow">
                    <div className="font-semibold text-lg hover:underline truncate" title={session.scopeName || "Ad-hoc Queue"}>
                        {session.scopeName ? session.scopeName : (session.queueId ? (
                            <RemViewer remId={session.queueId} width="100%" />
                        ) : "Ad-hoc Queue")}
                    </div>
                    <div className="text-sm rn-clr-content-secondary flex flex-col gap-1 mt-1">
                        <div className="flex flex-wrap gap-3 items-center">
                            <span className="rn-clr-background-secondary px-2 py-0.5 rounded text-xs font-mono" title="Total Time">
                                {formatTime(session.totalTime)}
                            </span>

                            <span>{session.flashcardsCount} Cards ({formatTime(session.flashcardsTime)})</span>

                            <div className="flex items-center gap-1 text-xs rn-clr-background-secondary px-1.5 py-0.5 rounded" title="Remembered / Forgot (Retention %)">
                                <span className="font-bold text-green-600">{rememberedCount}</span>
                                <span className="text-gray-400">/</span>
                                <span className="font-bold text-red-500">{forgotCount}</span>
                                <span className="ml-1 font-semibold text-gray-500">({retentionRate}%)</span>
                            </div>

                            {session.incRemsCount > 0 && (
                                <span>{session.incRemsCount} IncRems ({formatTime(session.incRemsTime)})</span>
                            )}
                        </div>
                        <div className="text-xs rn-clr-content-tertiary flex items-center gap-2 mt-1">
                            <span>Speed:</span>
                            <span className="font-bold" style={speedColor}>
                                {cardsPerMin} cpm
                            </span>
                            <span className="text-gray-400">
                                ({avgSpeedSeconds} s/card)
                            </span>
                        </div>
                    </div>
                    <div className="text-xs rn-clr-content-tertiary mt-1">
                        {timeSince(new Date(session.startTime))}
                    </div>
                </div>
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onDelete();
                    }}
                    className="rn-clr-content-tertiary hover:text-red-500 p-1"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        </div>
    )
}

renderWidget(PracticedQueues);
