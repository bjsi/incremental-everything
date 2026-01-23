import React, { useEffect, useState } from "react";
import {
    RemHierarchyEditorTree,
    RemId,
    RemViewer,
    renderWidget,
    usePlugin,
    useSyncedStorageState,
} from "@remnote/plugin-sdk";
import { timeSince } from "../lib/utils";
import { IncrementalHistoryData } from "../lib/history_utils";
import { safeRemTextToString } from "../lib/pdfUtils";

const NUM_TO_LOAD_IN_BATCH = 30;

function IncrementalHistory() {
    const plugin = usePlugin();
    const [historyDataRaw, setHistoryData] = useSyncedStorageState<IncrementalHistoryData[]>(
        "incrementalHistoryData",
        []
    );

    // Filtered data state
    const [filteredData, setFilteredData] = useState<IncrementalHistoryData[]>([]);

    // Search State
    const [searchText, setSearchText] = useState("");

    // Backfill Effect: Fetch text for items that don't have it
    useEffect(() => {
        let mounted = true;
        async function backfillData() {
            // Find items needing backfill (missing text OR old version)
            const needsBackfill = historyDataRaw
                .filter(item => typeof item.text === 'undefined' || item._v !== 1)
                .slice(0, 5); // Batch size to avoid overload

            if (needsBackfill.length === 0) return;

            const updates = new Map<number, string>();

            for (const item of needsBackfill) {
                try {
                    const rem = await plugin.rem.findOne(item.remId);

                    const frontText = await safeRemTextToString(plugin, rem?.text);
                    const backText = await safeRemTextToString(plugin, rem?.backText);

                    // Truncate if necessary (safeRemTextToString guarantees a string, 'Untitled' if empty/failed)
                    const cleanFront = frontText === 'Untitled' && (!rem?.text || rem.text.length === 0) ? '' : frontText.substring(0, 200);
                    const cleanBack = backText === 'Untitled' && (!rem?.backText || rem.backText.length === 0) ? '' : backText.substring(0, 200);

                    const text = `${cleanFront} ${cleanBack}`.trim();
                    updates.set(item.key, text);
                } catch (e) {
                    // Safe to ignore mostly, but good to log
                    console.error("Error processing history item backfill", item.remId, e);
                }
            }

            if (!mounted) return;

            // Batch update
            setHistoryData(
                historyDataRaw.map(item => {
                    if (updates.has(item.key)) {
                        return { ...item, text: updates.get(item.key), _v: 1 };
                    }
                    return item;
                })
            );
        }

        // Run periodically if there are items effectively
        if (historyDataRaw.some(x => typeof x.text === 'undefined' || x._v !== 1)) {
            const timer = setTimeout(backfillData, 1000);
            return () => clearTimeout(timer);
        }
    }, [historyDataRaw, plugin]);

    // Effect to filter data by Knowledge Base AND Search Text
    useEffect(() => {
        async function filterData() {
            const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
            const currentKbId = currentKb._id;

            // 1. KB Filter (Only show items from current KB if they have a KB ID recorded)
            let filtered = historyDataRaw.filter((item) => {
                if (!item.kbId) {
                    // If no kbId, assume it's valid for now or legacy
                    return true;
                }
                return item.kbId === currentKbId;
            });

            // 2. Search Filter
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
                        // Sort by matches (desc), then by time (desc)
                        if (b.score !== a.score) return b.score - a.score;
                        return b.item.time - a.item.time;
                    })
                    .map(x => x.item);
            }

            setFilteredData(filtered);
        }
        filterData();
    }, [historyDataRaw, plugin, searchText]);

    const closeIndex = (itemKey: number) => {
        // Find index in original list
        const originalIndex = historyDataRaw.findIndex(x => x.key === itemKey);
        if (originalIndex !== -1) {
            historyDataRaw.splice(originalIndex, 1);
            setHistoryData([...historyDataRaw]);
        }
    };

    const setData = (itemKey: number, changes: Partial<IncrementalHistoryData>) => {
        const originalIndex = historyDataRaw.findIndex(x => x.key === itemKey);
        if (originalIndex !== -1) {
            const oldData = historyDataRaw[originalIndex];
            const newData = { ...oldData, ...changes };
            historyDataRaw.splice(originalIndex, 1, newData);
            setHistoryData([...historyDataRaw]);
        }
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
            <div className="p-2 text-lg font-bold">Incremental History</div>
            <div className="px-2 pb-2">
                <input
                    className="w-full p-2 border rounded-md rn-clr-background-secondary rn-clr-content-primary border-gray-200 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    placeholder="Search history..."
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                />
            </div>
            {filteredData.length === 0 && (
                <div className="p-2 rn-clr-content-primary">
                    Study some Incremental Rems to see your history here.
                </div>
            )}
            {filteredData.slice(0, NUM_TO_LOAD_IN_BATCH * numLoaded).map((data) => (
                <HistoryItem
                    data={data}
                    remId={data.remId}
                    key={data.key || Math.random()}
                    setData={(c) => setData(data.key, c)}
                    closeIndex={() => closeIndex(data.key)}
                />
            ))}
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

function HistoryItem({
    data,
    remId,
    setData,
    closeIndex,
}: {
    data: IncrementalHistoryData;
    remId: string;
    setData: (changes: Partial<IncrementalHistoryData>) => void;
    closeIndex: () => void;
}) {
    const plugin = usePlugin();

    const openRem = async (remId: RemId) => {
        const rem = await plugin.rem.findOne(remId);
        if (rem) {
            plugin.window.openRem(rem);
        }
    };

    return (
        <div className="px-1 py-4 border-b border-gray-100" key={data.key}>
            <div className="flex gap-2 mb-2">
                <div
                    className="flex items-center justify-center flex-shrink-0 w-6 h-6 rounded-md cursor-pointer hover:bg-gray-200"
                    onClick={() => setData({ open: !data.open })}
                >
                    <img
                        src={`${plugin.rootURL}chevron_down.svg`}
                        style={{
                            transform: `rotate(${data.open ? 0 : -90}deg)`,
                            transitionProperty: "transform",
                            transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
                            transitionDuration: "150ms",
                        }}
                    />
                </div>
                <div className="flex-grow min-w-0" onClick={() => openRem(remId)}>
                    <RemViewer
                        remId={remId}
                        constraintRef="parent"
                        width="100%"
                        className="font-light cursor-pointer line-clamp-2"
                    />
                    <div className="text-xs rn-clr-content-tertiary">
                        Seen {timeSince(new Date(data.time))}
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
            {data.open && (
                <div className="m-2">
                    <RemHierarchyEditorTree height="auto" width="100%" remId={remId} />
                </div>
            )}
        </div>
    );
}

renderWidget(IncrementalHistory);
