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
import { PriorityBadge } from "../components";
import { InlinePriorityEditor } from "../components/InlineEditors";
import { getIncrementalRemFromRem, IncrementalRem } from "../lib/incremental_rem";
import { ActionItemType } from "../lib/incremental_rem/types";
import { determineIncRemType } from "../lib/incRemHelpers";
import { TypeBadge } from "../components";
import { allIncrementalRemKey, pendingPrioritySaveKey } from "../lib/consts";

const NUM_TO_LOAD_IN_BATCH = 30;

/**
 * Resolved item types (PDF, Web Extract, Rem…), keyed by rem id, for the whole
 * lifetime of this sidebar.
 *
 * Module-level rather than component state because the list re-filters on every
 * keystroke in the search box: without it, typing would re-resolve the type of
 * every row it reveals. A rem's type changes only if its sources do, which is
 * rare enough that a stale entry until the sidebar reloads is the right trade.
 * `null` records "asked, and there is no type" (deleted rem, unresolvable
 * source) so it is not asked again.
 */
const typeCache = new Map<string, ActionItemType | null>();

/** How many rows are resolved before the list is re-rendered with what is known. */
const TYPE_FLUSH_EVERY = 5;

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

    // Event-type filter (radio buttons under the search box)
    const [filterEvent, setFilterEvent] = useState<'ALL' | 'reviewed' | 'created' | 'dismissed'>('ALL');

    // KB-wide priority percentile map for IncRem priority badges
    const [percentileMap, setPercentileMap] = useState<Record<string, number>>({});

    // Item type per rem id, filled in progressively by the resolver below.
    const [typeMap, setTypeMap] = useState<Record<string, ActionItemType>>(() =>
        Object.fromEntries(
            [...typeCache.entries()].filter(([, t]) => !!t) as [string, ActionItemType][]
        )
    );

    useEffect(() => {
        let cancelled = false;
        async function buildPercentiles() {
            const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
            const sorted = [...allIncRems].sort((a, b) => a.priority - b.priority);
            const map: Record<string, number> = {};
            sorted.forEach((item, index) => {
                map[item.remId] = Math.round(((index + 1) / sorted.length) * 100);
            });
            if (!cancelled) setPercentileMap(map);
        }
        buildPercentiles();
        return () => { cancelled = true; };
    }, [plugin, historyDataRaw]);

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

    // Effect to filter data by Knowledge Base AND Search Text, then sort chronologically
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

            // 2. Event-type filter. "dismissed" includes both standalone dismissals
            //    and reviewed-and-then-dismissed entries (which display both badges).
            if (filterEvent !== 'ALL') {
                filtered = filtered.filter((item) => {
                    if (filterEvent === 'dismissed') {
                        return item.eventType === 'dismissed' || !!item.wasDismissed;
                    }
                    return item.eventType === filterEvent;
                });
            }

            // 3. Search Filter
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
            } else {
                // No search active: sort chronologically (most recent first)
                filtered = [...filtered].sort((a, b) => b.time - a.time);
            }

            setFilteredData(filtered);
        }
        filterData();
    }, [historyDataRaw, plugin, searchText, filterEvent]);

    const closeIndex = (itemKey: number) => {
        // Find index in original list
        const originalIndex = historyDataRaw.findIndex(x => x.key === itemKey);
        if (originalIndex !== -1) {
            historyDataRaw.splice(originalIndex, 1);
            setHistoryData([...historyDataRaw]);
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
    }, [filteredData.length]);

    const numUnloaded = Math.max(
        0,
        filteredData.length - NUM_TO_LOAD_IN_BATCH * numLoaded
    );

    const visibleData = React.useMemo(
        () => filteredData.slice(0, NUM_TO_LOAD_IN_BATCH * numLoaded),
        [filteredData, numLoaded]
    );
    const visibleIdsKey = visibleData.map((d) => d.remId).join(',');

    // Resolve the item type of the rows on screen — ONE AT A TIME.
    //
    // determineIncRemType is not a cheap read: per rem it probes several powerups,
    // resolves sources (and the source's own type), and walks up to 20 ancestors
    // looking for a PDF. Firing that from each row's own effect would put thirty of
    // those walks on the bridge at once, which is precisely the pattern that makes
    // the priority-editor badges stall the editor. Sequential, cached and limited to
    // visible rows keeps it to a trickle of reads that finish while you are reading
    // the first entry.
    useEffect(() => {
        let cancelled = false;

        async function resolveTypes() {
            const pending = [...new Set(visibleData.map((d) => d.remId))].filter(
                (id) => !typeCache.has(id)
            );
            if (pending.length === 0) return;

            let batch: Record<string, ActionItemType> = {};
            const flush = () => {
                if (Object.keys(batch).length === 0) return;
                const staged = batch;
                batch = {};
                setTypeMap((prev) => ({ ...prev, ...staged }));
            };

            for (let i = 0; i < pending.length; i++) {
                if (cancelled) return;
                const remId = pending[i];
                let resolved: ActionItemType | null = null;
                try {
                    const rem = await plugin.rem.findOne(remId);
                    // silent: a history row is a label, not a request to open anything —
                    // a highlight whose PDF was deleted must not toast at the user.
                    resolved = rem ? await determineIncRemType(plugin, rem, { silent: true }) : null;
                } catch (e) {
                    console.error('[IncrementalHistory] Could not resolve item type', remId, e);
                }
                typeCache.set(remId, resolved);
                if (resolved) batch[remId] = resolved;

                // Re-render in batches: a setState per row would re-render the whole
                // list (and every RemViewer in it) thirty times.
                if ((i + 1) % TYPE_FLUSH_EVERY === 0 && !cancelled) flush();
            }

            if (!cancelled) flush();
        }

        resolveTypes();
        return () => {
            cancelled = true;
        };
    }, [plugin, visibleIdsKey]);

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
                <div className="flex flex-wrap gap-4 mt-2 text-sm rn-clr-content-primary">
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="radio" checked={filterEvent === 'ALL'} onChange={() => setFilterEvent('ALL')} /> All
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="radio" checked={filterEvent === 'reviewed'} onChange={() => setFilterEvent('reviewed')} /> Reviewed
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="radio" checked={filterEvent === 'created'} onChange={() => setFilterEvent('created')} /> Created
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="radio" checked={filterEvent === 'dismissed'} onChange={() => setFilterEvent('dismissed')} /> Dismissed
                    </label>
                </div>
            </div>
            {filteredData.length === 0 && (
                <div className="p-2 rn-clr-content-primary">
                    Study or create Incremental Rems to see your history here.
                </div>
            )}
            {visibleData.map((data) => (
                <HistoryItem
                    data={data}
                    remId={data.remId}
                    key={data.key || Math.random()}
                    open={openKeys.has(data.key)}
                    toggleOpen={() => toggleOpen(data.key)}
                    closeIndex={() => closeIndex(data.key)}
                    percentile={percentileMap[data.remId]}
                    incRemType={typeMap[data.remId]}
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

/** Small pill badge to differentiate event types */
function EventBadge({ eventType }: { eventType?: 'reviewed' | 'created' | 'dismissed' }) {
    const palette =
        eventType === 'created'
            ? { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', label: 'Created' }
            : eventType === 'dismissed'
                ? { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', label: 'Dismissed' }
                : { bg: 'rgba(99,102,241,0.12)', fg: '#818cf8', label: 'Reviewed' };
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
                backgroundColor: palette.bg,
                color: palette.fg,
                flexShrink: 0,
                alignSelf: 'center',
            }}
        >
            {palette.label}
        </span>
    );
}

function HistoryItem({
    data,
    remId,
    open,
    toggleOpen,
    closeIndex,
    percentile,
    incRemType,
}: {
    data: IncrementalHistoryData;
    remId: string;
    open: boolean;
    toggleOpen: () => void;
    closeIndex: () => void;
    percentile?: number;
    /** Resolved by the parent (see typeCache); undefined until it arrives. */
    incRemType?: ActionItemType;
}) {
    const plugin = usePlugin();

    const [incPriority, setIncPriority] = useState<number | null>(null);
    const [editingPriority, setEditingPriority] = useState<number | null>(null);

    // Load the Incremental Rem priority for the badge
    useEffect(() => {
        let cancelled = false;
        async function loadPriority() {
            const rem = await plugin.rem.findOne(remId);
            if (!rem || cancelled) return;
            const incRem = await getIncrementalRemFromRem(plugin, rem);
            if (!cancelled) setIncPriority(incRem ? incRem.priority : null);
        }
        loadPriority();
        return () => { cancelled = true; };
    }, [plugin, remId]);

    // Delegate the DB write to the persistent background tracker (index.tsx) via
    // pendingPrioritySaveKey, mirroring priority.tsx. The widget never writes to the
    // DB directly — this survives sidebar/popup teardown and avoids racing the queue.
    const savePriority = async () => {
        if (editingPriority === null) return;
        const newPriority = editingPriority;
        setEditingPriority(null);

        plugin.storage.setSession(pendingPrioritySaveKey, {
            remId,
            incPriority: newPriority,
            cardPriority: null,
            cardSource: 'manual',
            needsAddPowerup: false,
            triggerCascade: true,
            event: 'editor',
        }).catch(console.error);

        // Optimistically reflect the change in the badge.
        setIncPriority(newPriority);
    };

    const openRem = async (remId: RemId) => {
        const rem = await plugin.rem.findOne(remId);
        if (rem) {
            plugin.window.openRem(rem);
        }
    };

    const isCreated = data.eventType === 'created';
    const isDismissedOnly = data.eventType === 'dismissed';
    const timeLabel = isCreated
        ? `Created ${timeSince(new Date(data.time))}`
        : isDismissedOnly
            ? `Dismissed ${timeSince(new Date(data.time))}`
            : `Seen ${timeSince(new Date(data.time))}`;

    return (
        <div className="px-1 py-4 border-b border-gray-100" key={data.key}>
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
                    {/* flex-wrap: with two event badges, a type badge and a priority
                        badge this row can outgrow a narrow sidebar — wrapping keeps the
                        priority badge readable instead of squeezing the labels. */}
                    <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                        <EventBadge eventType={data.eventType} />
                        {data.eventType === 'reviewed' && data.wasDismissed && (
                            <EventBadge eventType="dismissed" />
                        )}
                        {/* What kind of item this is (PDF, Web Extract, Rem…). Absent
                            while it resolves, and for rems that no longer exist. */}
                        <TypeBadge type={incRemType} mini />
                        {incPriority !== null && (
                            <span
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingPriority((prev) => (prev === null ? incPriority : null));
                                }}
                                className="ml-auto"
                                style={{ cursor: 'pointer' }}
                                title="Click to change priority"
                            >
                                <PriorityBadge
                                    priority={incPriority}
                                    percentile={percentile}
                                    compact
                                    useAbsoluteColoring={percentile == null}
                                />
                            </span>
                        )}
                    </div>
                    <div onClick={() => openRem(remId)}>
                        <RemViewer
                            remId={remId}
                            width="100%"
                            className="font-light cursor-pointer line-clamp-2"
                        />
                        <div className="text-xs rn-clr-content-tertiary">
                            {timeLabel}
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

renderWidget(IncrementalHistory);

