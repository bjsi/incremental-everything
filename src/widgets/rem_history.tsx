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
import { remHistoryTextLimit } from "../lib/consts";

const NUM_TO_LOAD_IN_BATCH = 20;

export interface RemHistoryData {
    key: number;
    remId: RemId;
    /** @deprecated Legacy field. Row expansion is component state now — entries
     *  written before that change still carry it, and it is ignored. */
    open?: boolean;
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
                    const cleanFront = frontText === 'Untitled' && (!rem?.text || rem.text.length === 0) ? '' : frontText.substring(0, remHistoryTextLimit);
                    const cleanBack = backText === 'Untitled' && (!rem?.backText || rem.backText.length === 0) ? '' : backText.substring(0, remHistoryTextLimit);
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

    // Row expansion is transient UI state and is deliberately NOT persisted.
    // It used to live on the stored entry as `open`, so every chevron click
    // rewrote the whole history array to synced storage. Component state costs
    // nothing and removes that write entirely.
    const [openKeys, setOpenKeys] = useState<Set<number>>(new Set());
    const toggleOpen = (itemKey: number) => {
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
                    open={openKeys.has(data.key)}
                    toggleOpen={() => toggleOpen(data.key)}
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
    open: boolean;
    toggleOpen: () => void;
    closeIndex: () => void;
}

function RemHistoryItem({
    data,
    remId,
    open,
    toggleOpen,
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
            {open && (
                <div className="m-2">
                    <RemHierarchyEditorTree height="auto" width="100%" remId={remId} />
                </div>
            )}
        </div>
    );
}

renderWidget(RemHistory);
