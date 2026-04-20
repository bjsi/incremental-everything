import React, { useEffect, useState } from "react";
import {
    RemHierarchyEditorTree,
    RemId,
    RemViewer,
    renderWidget,
    usePlugin,
    useSyncedStorageState,
} from "@remnote/plugin-sdk";
import '../style.css';
import '../App.css';
import { timeSince } from "../lib/utils";
import { safeRemTextToString } from "../lib/pdfUtils";

const NUM_TO_LOAD_IN_BATCH = 20;

export interface RemHistoryData {
    key: number;
    remId: RemId;
    open: boolean;
    time: number;
    kbId?: string;
    text?: string;
    _v?: number;
}

function RemHistory() {
    const plugin = usePlugin();
    const [remDataRaw, setRemData] = useSyncedStorageState<RemHistoryData[]>(
        "remData",
        []
    );

    const [filteredRemData, setFilteredRemData] = useState<RemHistoryData[]>([]);
    const [searchText, setSearchText] = useState("");

    // Backfill text for legacy entries lacking it
    useEffect(() => {
        let mounted = true;
        async function backfillData() {
            const needsBackfill = remDataRaw
                .filter(item => typeof item.text === 'undefined' || item._v !== 1)
                .slice(0, 5);

            if (needsBackfill.length === 0) return;

            const updates = new Map<number, string>();

            for (const item of needsBackfill) {
                try {
                    const rem = await plugin.rem.findOne(item.remId);
                    const frontText = await safeRemTextToString(plugin, rem?.text);
                    const backText = await safeRemTextToString(plugin, rem?.backText);
                    const cleanFront = frontText === 'Untitled' && (!rem?.text || rem.text.length === 0) ? '' : frontText.substring(0, 200);
                    const cleanBack = backText === 'Untitled' && (!rem?.backText || rem.backText.length === 0) ? '' : backText.substring(0, 200);
                    const text = `${cleanFront} ${cleanBack}`.trim();
                    updates.set(item.key, text);
                } catch (e) {
                    console.error("Error processing rem history backfill", item.remId, e);
                }
            }

            if (!mounted) return;

            setRemData(
                remDataRaw.map(item => {
                    if (updates.has(item.key)) {
                        return { ...item, text: updates.get(item.key), _v: 1 };
                    }
                    return item;
                })
            );
        }

        if (remDataRaw.some(x => typeof x.text === 'undefined' || x._v !== 1)) {
            const timer = setTimeout(backfillData, 1000);
            return () => clearTimeout(timer);
        }
    }, [remDataRaw, plugin]);

    // Filter by KB and search text
    useEffect(() => {
        async function filterData() {
            const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
            const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
            const currentKbId = currentKb._id;

            let filtered = remDataRaw.filter((item) => {
                if (!item.kbId) {
                    return isPrimary;
                }
                return item.kbId === currentKbId;
            });

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

            setFilteredRemData(filtered);
        }
        filterData();
    }, [remDataRaw, plugin, searchText]);

    const closeIndex = (itemKey: number) => {
        const originalIndex = remDataRaw.findIndex(x => x.key === itemKey);
        if (originalIndex !== -1) {
            remDataRaw.splice(originalIndex, 1);
            setRemData([...remDataRaw]);
        }
    };

    const setData = (itemKey: number, changes: Partial<RemHistoryData>) => {
        const originalIndex = remDataRaw.findIndex(x => x.key === itemKey);
        if (originalIndex !== -1) {
            const oldData = remDataRaw[originalIndex];
            const newData = { ...oldData, ...changes };
            remDataRaw.splice(originalIndex, 1, newData);
            setRemData([...remDataRaw]);
        }
    };

    const [numLoaded, setNumLoaded] = React.useState(1);

    useEffect(() => {
        setNumLoaded(1);
    }, [filteredRemData.length]);

    const numUnloaded = Math.max(
        0,
        filteredRemData.length - NUM_TO_LOAD_IN_BATCH * numLoaded
    );

    return (
        <div
            className="h-full w-full overflow-y-auto rn-clr-background-primary"
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="p-2 text-lg font-bold">Visited Rem History</div>
            <div className="px-2 pb-2">
                <input
                    className="w-full p-2 border rounded-md rn-clr-background-secondary rn-clr-content-primary border-gray-200 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    placeholder="Search history..."
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                />
            </div>
            {filteredRemData.length === 0 && (
                <div className="p-2 rn-clr-content-primary">
                    Navigate to other documents to automatically record history.
                </div>
            )}
            {filteredRemData.slice(0, NUM_TO_LOAD_IN_BATCH * numLoaded).map((data) => (
                <RemHistoryItem
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

interface RemHistoryItemProps {
    data: RemHistoryData;
    remId: string;
    setData: (changes: Partial<RemHistoryData>) => void;
    closeIndex: () => void;
}

function RemHistoryItem({
    data,
    remId,
    setData,
    closeIndex,
}: RemHistoryItemProps) {
    const plugin = usePlugin();

    const openRem = async (remId: RemId) => {
        const rem = await plugin.rem.findOne(remId);
        if (rem) {
            plugin.window.openRem(rem);
        }
    };

    return (
        <div className="px-1 py-4 w-full" style={{ borderBottom: '1px solid var(--rn-clr-background-tertiary)' }} key={remId}>
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
                        width="100%"
                        className="font-medium cursor-pointer line-clamp-2"
                    />
                    <div className="text-xs rn-clr-content-tertiary">
                        {timeSince(new Date(data.time))}
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

renderWidget(RemHistory);
