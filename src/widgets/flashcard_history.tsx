import React, { useEffect, useState } from "react";
import {
    QueueInteractionScore,
    RemHierarchyEditorTree,
    RemId,
    RemViewer,
    renderWidget,
    usePlugin,
    useSyncedStorageState,
    useTrackerPlugin,
} from "@remnote/plugin-sdk";
import '../style.css';
import '../App.css';
import { timeSince } from "../lib/utils";
import { safeRemTextToString } from "../lib/pdfUtils";
import { PriorityBadge } from "../components";
import { InlinePriorityEditor } from "../components/InlineEditors";
import { getCardPriority, CardPriorityInfo, CARD_PRIORITY_CODE } from "../lib/card_priority";
import { pendingPrioritySaveKey, flashcardHistoryTextLimit } from "../lib/consts";
import {
    flashcardHistorySpec,
    shardKey,
    writeHistoryShard,
    migrateLegacyHistory,
} from "../lib/history_shards";

const NUM_TO_LOAD_IN_BATCH = 30;

export interface FlashcardHistoryData {
    /** @deprecated Was a `Math.random()` row identity. Identity is derived from
     *  cardId now; old entries still carry it and it is ignored. */
    key?: number;
    remId: RemId;
    cardId: string;
    time: number;
    /** @deprecated Legacy field. Row expansion is component state now — entries
     *  written before that change still carry it, and it is ignored. */
    open?: boolean;
    kbId?: string;
    text?: string;
    _v?: number;
    score?: QueueInteractionScore;
}

const entryId = flashcardHistorySpec.getId;

function FlashcardHistory() {
    const plugin = usePlugin();
    // One shard per knowledge base: this widget only ever showed the current KB's
    // entries, so the other KBs' rows were read and synced only to be discarded.
    const kbId = useTrackerPlugin(
        async (rp) => (await rp.kb.getCurrentKnowledgeBaseData())?._id,
        []
    );
    const [historyDataRaw] = useSyncedStorageState<FlashcardHistoryData[]>(
        kbId ? shardKey(flashcardHistorySpec, kbId) : "",
        []
    );

    // Drain the pre-shard global key on first mount. Writers do the same, so this
    // only matters for a KB the user reads but never practises in.
    useEffect(() => {
        migrateLegacyHistory(plugin, flashcardHistorySpec);
    }, [plugin]);

    const setHistoryData = React.useCallback(
        async (entries: FlashcardHistoryData[]) => {
            // Never write before the KB resolves, or the entries would land in the
            // unpartitioned shard and disappear from this list.
            if (!kbId) return;
            await writeHistoryShard(plugin, flashcardHistorySpec, kbId, entries);
        },
        [plugin, kbId]
    );

    const [filteredData, setFilteredData] = useState<FlashcardHistoryData[]>([]);
    const [searchText, setSearchText] = useState("");
    const [filterScore, setFilterScore] = useState<QueueInteractionScore | "ALL">("ALL");

    // Backfill text for legacy entries lacking it
    useEffect(() => {
        let mounted = true;
        async function backfillData() {
            const needsBackfill = historyDataRaw
                .filter(item => typeof item.text === 'undefined' || item._v !== 1)
                .slice(0, 5);

            if (needsBackfill.length === 0) return;

            const updates = new Map<string, string>();

            for (const item of needsBackfill) {
                try {
                    const rem = await plugin.rem.findOne(item.remId);
                    const frontText = await safeRemTextToString(plugin, rem?.text);
                    const backText = await safeRemTextToString(plugin, rem?.backText);
                    const cleanFront = frontText === 'Untitled' && (!rem?.text || rem.text.length === 0) ? '' : frontText;
                    const cleanBack = backText === 'Untitled' && (!rem?.backText || rem.backText.length === 0) ? '' : backText;
                    // The limit applies to the combined preview; writeHistoryShard
                    // enforces it again, so the two cannot drift.
                    const text = `${cleanFront} ${cleanBack}`.trim().substring(0, flashcardHistoryTextLimit);
                    updates.set(entryId(item), text);
                } catch (e) {
                    console.error("Error processing flashcard history backfill", item.remId, e);
                }
            }

            if (!mounted) return;

            setHistoryData(
                historyDataRaw.map(item => {
                    const id = entryId(item);
                    if (updates.has(id)) {
                        return { ...item, text: updates.get(id), _v: 1 };
                    }
                    return item;
                })
            );
        }

        if (historyDataRaw.some(x => typeof x.text === 'undefined' || x._v !== 1)) {
            const timer = setTimeout(backfillData, 1000);
            return () => clearTimeout(timer);
        }
    }, [historyDataRaw, plugin]);

    // Filter by score and search text. The KB filter that used to live here is
    // gone: the shard we read IS the current KB's, so every entry qualifies.
    useEffect(() => {
        async function filterData() {
            let filtered = historyDataRaw;

            if (filterScore !== "ALL") {
                filtered = filtered.filter(item => item.score === filterScore);
            }

            if (searchText.trim().length > 0) {
                const lowerSearch = searchText.toLowerCase();
                const tokens = lowerSearch.split(/\s+/).filter(t => t.length > 0);

                filtered = filtered.map(item => {
                    if (!item.text) return { item, score: 0 };
                    const lowerText = item.text.toLowerCase();
                    let score = 0;
                    for (const token of tokens) {
                        if (lowerText.includes(token)) {
                            score++;
                        }
                    }
                    return { item, score };
                })
                    .filter(x => x.score > 0)
                    .sort((a, b) => {
                        if (b.score !== a.score) return b.score - a.score;
                        return b.item.time - a.item.time;
                    })
                    .map(x => x.item);
            }

            setFilteredData(filtered);
        }
        filterData();
    }, [historyDataRaw, plugin, searchText, filterScore]);

    const closeIndex = (itemKey: string) => {
        const remaining = historyDataRaw.filter(x => entryId(x) !== itemKey);
        if (remaining.length !== historyDataRaw.length) {
            setHistoryData(remaining);
        }
    };

    // Row expansion is transient UI state and is deliberately NOT persisted.
    // It used to live on the stored entry as `open`, which meant every click of a
    // chevron rewrote the whole history array — half a megabyte of synced storage
    // per expand/collapse. Keeping it in component state costs nothing and removes
    // that write entirely.
    const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
    const toggleOpen = (itemKey: string) => {
        setOpenKeys((prev) => {
            const next = new Set(prev);
            if (next.has(itemKey)) next.delete(itemKey);
            else next.add(itemKey);
            return next;
        });
    };

    const [numLoaded, setNumLoaded] = React.useState(1);

    useEffect(() => {
        setNumLoaded(1);
    }, [filteredData.length]);

    const numUnloaded = Math.max(
        0,
        filteredData.length - NUM_TO_LOAD_IN_BATCH * numLoaded
    );

    return (
        <div
            className="h-full w-full overflow-y-auto rn-clr-background-primary"
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="p-2 text-lg font-bold">Flashcard History</div>
            <div className="px-2 pb-2">
                <input
                    className="w-full p-2 border rounded-md rn-clr-background-secondary rn-clr-content-primary border-gray-200 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    placeholder="Search history..."
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                />
                <div className="flex flex-wrap gap-4 mt-2 text-sm rn-clr-content-primary">
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="radio" checked={filterScore === "ALL"} onChange={() => setFilterScore("ALL")} /> All
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="radio" checked={filterScore === QueueInteractionScore.AGAIN} onChange={() => setFilterScore(QueueInteractionScore.AGAIN)} /> Again
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="radio" checked={filterScore === QueueInteractionScore.HARD} onChange={() => setFilterScore(QueueInteractionScore.HARD)} /> Hard
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="radio" checked={filterScore === QueueInteractionScore.GOOD} onChange={() => setFilterScore(QueueInteractionScore.GOOD)} /> Good
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="radio" checked={filterScore === QueueInteractionScore.EASY} onChange={() => setFilterScore(QueueInteractionScore.EASY)} /> Easy
                    </label>
                </div>
            </div>
            {filteredData.length === 0 && (
                <div className="p-2 rn-clr-content-primary">
                    Practice some flashcards to see your history here.
                </div>
            )}
            {filteredData.slice(0, NUM_TO_LOAD_IN_BATCH * numLoaded).map((data) => {
                // Derived, stable identity. The old `data.key || Math.random()`
                // remounted any row missing a key on every single render, which
                // reset its expansion state.
                const id = entryId(data);
                return (
                    <HistoryItem
                        data={data}
                        remId={data.remId}
                        key={id}
                        open={openKeys.has(id)}
                        toggleOpen={() => toggleOpen(id)}
                        closeIndex={() => closeIndex(id)}
                    />
                );
            })}
            {numUnloaded > 0 && (
                <div
                    onMouseOver={() => setNumLoaded((i) => i + 1)}
                    className="pb-[200px] p-2 cursor-pointer"
                >
                    Load more <span className="rn-clr-content-secondary">({numUnloaded})</span>
                </div>
            )}
        </div>
    );
}

function RatingBadge({ score }: { score?: QueueInteractionScore }) {
    if (score === undefined) return null;
    
    let label = 'Unknown';
    let bgColor = 'rgba(156,163,175,0.15)';
    let color = '#9ca3af';

    switch (score) {
        case QueueInteractionScore.AGAIN:
            label = 'Again';
            bgColor = 'rgba(239,68,68,0.15)'; // red
            color = '#ef4444';
            break;
        case QueueInteractionScore.HARD:
            label = 'Hard';
            bgColor = 'rgba(249,115,22,0.15)'; // orange
            color = '#f97316';
            break;
        case QueueInteractionScore.GOOD:
            label = 'Good';
            bgColor = 'rgba(16,185,129,0.15)'; // green
            color = '#10b981';
            break;
        case QueueInteractionScore.EASY:
            label = 'Easy';
            bgColor = 'rgba(59,130,246,0.15)'; // blue
            color = '#3b82f6';
            break;
    }

    return (
        <span
            style={{
                display: 'inline-block',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                padding: '1px 5px',
                borderRadius: 3,
                backgroundColor: bgColor,
                color: color,
                flexShrink: 0,
                alignSelf: 'center',
            }}
        >
            {label}
        </span>
    );
}

function HistoryItem({
    data,
    remId,
    open,
    toggleOpen,
    closeIndex,
}: {
    data: FlashcardHistoryData;
    remId: string;
    open: boolean;
    toggleOpen: () => void;
    closeIndex: () => void;
}) {
    const plugin = usePlugin();

    const [priorityInfo, setPriorityInfo] = useState<CardPriorityInfo | null>(null);
    const [editingPriority, setEditingPriority] = useState<number | null>(null);

    // Load the rem's card priority for the badge
    useEffect(() => {
        let cancelled = false;
        async function loadPriority() {
            const rem = await plugin.rem.findOne(remId);
            if (!rem || cancelled) return;
            const info = await getCardPriority(plugin, rem);
            if (!cancelled) setPriorityInfo(info);
        }
        loadPriority();
        return () => { cancelled = true; };
    }, [plugin, remId]);

    // Delegate the DB write to the persistent background tracker (index.tsx) via
    // pendingPrioritySaveKey, mirroring priority.tsx. The widget never writes to the
    // DB directly — this survives popup teardown and avoids racing the queue.
    const savePriority = async () => {
        if (editingPriority === null) return;
        const newPriority = editingPriority;
        setEditingPriority(null);

        const rem = await plugin.rem.findOne(remId);
        if (!rem) return;

        const hasPowerup = await rem.hasPowerup(CARD_PRIORITY_CODE);

        plugin.storage.setSession(pendingPrioritySaveKey, {
            remId,
            incPriority: null,
            cardPriority: newPriority,
            cardSource: 'manual',
            needsAddPowerup: !hasPowerup,
            triggerCascade: true,
        }).catch(console.error);

        // Optimistically reflect the change in the badge.
        setPriorityInfo((prev) =>
            prev ? { ...prev, priority: newPriority, source: 'manual' } : prev
        );
    };

    const openRem = async (remId: RemId) => {
        const rem = await plugin.rem.findOne(remId);
        if (rem) {
            plugin.window.openRem(rem);
        }
    };

    return (
        <div className="px-1 py-4" style={{ borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
            <div className="flex gap-2 mb-2">
                <div
                    className="flex items-center justify-center flex-shrink-0 w-6 h-6 rounded-md cursor-pointer hover:bg-gray-200"
                    onClick={toggleOpen}
                >
                    <img
                        src={`${plugin.rootURL}chevron_down.svg`}
                        style={{
                            transform: `rotate(${open ? 0 : -90}deg)`,
                            transitionProperty: "transform",
                            transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
                            transitionDuration: "150ms",
                        }}
                    />
                </div>
                <div className="flex-grow min-w-0">
                    {(data.score !== undefined || priorityInfo) && (
                        <div className="flex items-center gap-1.5 mb-0.5">
                            {data.score !== undefined && <RatingBadge score={data.score} />}
                            {priorityInfo && (
                                <span
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingPriority((prev) => (prev === null ? priorityInfo.priority : null));
                                    }}
                                    className="ml-auto"
                                    style={{ cursor: 'pointer' }}
                                    title="Click to change priority"
                                >
                                    <PriorityBadge
                                        priority={priorityInfo.priority}
                                        percentile={priorityInfo.kbPercentile ?? undefined}
                                        compact
                                        useAbsoluteColoring={priorityInfo.kbPercentile == null}
                                        source={priorityInfo.source}
                                        isCardPriority
                                    />
                                </span>
                            )}
                        </div>
                    )}
                    <div onClick={() => openRem(remId)}>
                        <RemViewer
                            remId={remId}
                            width="100%"
                            className="font-light cursor-pointer line-clamp-2"
                        />
                        <div className="text-xs rn-clr-content-tertiary">
                            Seen {timeSince(new Date(data.time))}
                        </div>
                    </div>
                </div>
                <div
                    className="flex items-center justify-center flex-shrink-0 w-6 h-6 rounded-md cursor-pointer hover:bg-red-100"
                    onClick={closeIndex}
                >
                    <img
                        src={`${plugin.rootURL}close.svg`}
                        style={{
                            display: "inline-block",
                            fill: "var(--rn-clr-content-tertiary)",
                            color: "color",
                            width: 16,
                            height: 16,
                        }}
                    />
                </div>
            </div>
            {editingPriority !== null && (
                <div className="px-1 pb-1" onClick={(e) => e.stopPropagation()}>
                    <InlinePriorityEditor
                        value={editingPriority}
                        onChange={setEditingPriority}
                        onSave={savePriority}
                        onCancel={() => setEditingPriority(null)}
                    />
                </div>
            )}
            {open && (
                <div className="m-2">
                    <RemHierarchyEditorTree height="auto" width="100%" remId={remId} />
                </div>
            )}
        </div>
    );
}

renderWidget(FlashcardHistory);
