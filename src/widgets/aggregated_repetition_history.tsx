import React, { useState } from 'react';
import { renderWidget, usePlugin, WidgetLocation, useRunAsync, PluginRem } from '@remnote/plugin-sdk';
import { IncrementalRep } from '../lib/incremental_rem/types';
import { formatDuration } from '../lib/utils';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { getDismissedHistoryFromRem } from '../lib/dismissed';
import { safeRemTextToString } from '../lib/pdfUtils'; // Reuse this safe string converter

// --- Types ---

interface NodeStats {
    id: string; // Rem ID
    isIncremental: boolean;
    isDismissed: boolean;
    reps: number;
    time: number;
    history: IncrementalRep[];

    // These are aggregates for the node AND its descendants
    aggrReps: number;
    aggrTime: number;
    aggrIncCount: number; // Count of active incremental descendants (inclusive)
    aggrDismCount: number; // Count of dismissed descendants (inclusive)

    childrenIds: string[]; // IDs of direct children

    // For display
    remName: string;
}

interface TreeData {
    nodes: Record<string, NodeStats>;
    rootId: string;
}

// --- Helpers ---

function getTotalTime(history: IncrementalRep[]): number {
    if (!history || history.length === 0) return 0;
    return history.reduce((total, rep) => total + (rep.reviewTimeSeconds || 0), 0);
}

function getRepCount(history: IncrementalRep[]): number {
    return history?.filter(h =>
        h.eventType === undefined ||
        h.eventType === 'rep' ||
        h.eventType === 'rescheduledInQueue' ||
        h.eventType === 'executeRepetition'
    ).length || 0;
}

// --- Components ---

const Header = ({ onClose, onSwitch }: { onClose: () => void, onSwitch: () => void }) => (
    <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid var(--rn-clr-border-primary)',
        backgroundColor: 'var(--rn-clr-background-secondary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
    }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '14px' }}>
            <span>📊</span>
            <span>Aggregated History</span>
            <button
                onClick={onSwitch}
                style={{
                    marginLeft: '12px',
                    fontSize: '11px',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    border: '1px solid var(--rn-clr-border-primary)',
                    background: 'transparent',
                    cursor: 'pointer',
                    color: 'var(--rn-clr-content-secondary)'
                }}
                title="Switch to Single View"
            >
                Show Single
            </button>
        </div>
        <button
            onClick={onClose}
            style={{
                background: 'none',
                border: 'none',
                fontSize: '18px',
                cursor: 'pointer',
                opacity: 0.6,
                padding: '4px',
                lineHeight: 1,
            }}
            title="Close"
        >
            ✕
        </button>
    </div>
);

const StatsRow = ({ label, count, reps, time, color }: { label: string, count: number, reps: number, time: number, color?: string }) => (
    <div style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr 1fr',
        padding: '6px 0',
        fontSize: '12px',
        borderBottom: '1px solid var(--rn-clr-border-secondary)',
        alignItems: 'center',
    }}>
        <div style={{ fontWeight: 500, color: color || 'inherit', paddingLeft: '8px' }}>{label}</div>
        <div style={{ textAlign: 'center' }}>{count}</div>
        <div style={{ textAlign: 'center' }}>{reps}</div>
        <div style={{ textAlign: 'center' }}>{formatDuration(time) || '0s'}</div>
    </div>
);

const StatsSection = ({ data }: { data: TreeData }) => {
    const root = data.nodes[data.rootId];
    if (!root) return null; // Should not happen

    const totalCount = root.aggrIncCount + root.aggrDismCount;
    // const totalReps = root.aggrReps; // This is redundant if we sum the rows? 
    // Wait, aggrReps includes both incremental and dismissed.
    // We need to split stats by type to match the request exactly.
    // The previous aggregation logic combined them. Let's adjust logic or just calculate here if possible.
    // Actually, `aggrReps` in my proposed type structure sums everything.
    // The user wants: Incremental + Dismissed, Incremental (% total), Dismissed (% total).

    // To get split stats (Incremental vs Dismissed), I should probably traverse the tree data I built.
    let incReps = 0;
    let incTime = 0;
    let dismReps = 0;
    let dismTime = 0;

    Object.values(data.nodes).forEach(node => {
        if (node.isIncremental) {
            incReps += node.reps;
            incTime += node.time;
        }
        if (node.isDismissed) {
            dismReps += node.reps;
            dismTime += node.time;
        }
    });

    const totalReps = incReps + dismReps;
    const totalTime = incTime + dismTime;

    const incPercent = totalCount > 0 ? Math.round((root.aggrIncCount / totalCount) * 100) : 0;
    const dismPercent = totalCount > 0 ? Math.round((root.aggrDismCount / totalCount) * 100) : 0;

    return (
        <div style={{
            padding: '12px 16px',
            backgroundColor: 'var(--rn-clr-background-primary)',
            borderBottom: '1px solid var(--rn-clr-border-primary)',
        }}>
            <div style={{
                display: 'grid',
                gridTemplateColumns: '2fr 1fr 1fr 1fr',
                fontSize: '10px',
                fontWeight: 600,
                color: 'var(--rn-clr-content-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                marginBottom: '8px',
                paddingLeft: '8px',
            }}>
                <div>Type</div>
                <div style={{ textAlign: 'center' }}>Items</div>
                <div style={{ textAlign: 'center' }}>Reps</div>
                <div style={{ textAlign: 'center' }}>Time</div>
            </div>

            <StatsRow label="Total" count={totalCount} reps={totalReps} time={totalTime} />
            <StatsRow
                label={`Incremental (${incPercent}%)`}
                count={root.aggrIncCount}
                reps={incReps}
                time={incTime}
                color="var(--rn-clr-green, #22c55e)"
            />
            <StatsRow
                label={`Dismissed (${dismPercent}%)`}
                count={root.aggrDismCount}
                reps={dismReps}
                time={dismTime}
                color="var(--rn-clr-orange, #f59e0b)"
            />
        </div>
    );
};

const TreeNode = ({
    nodeId,
    data,
    depth = 0
}: {
    nodeId: string,
    data: TreeData,
    depth?: number
}) => {
    const [expanded, setExpanded] = useState(false);
    const node = data.nodes[nodeId];

    if (!node) return null;

    // Only render if it's the root OR if it (or its subtree) contributes stats
    // But usually we want to show the structure. user said: "organized as they are in the hierarchy tree"
    // So we should show nodes even if they are not themselves Incremental/Dismissed, IF they have descendants that are.
    // If a node has aggrIncCount == 0 and aggrDismCount == 0, maybe hide it?
    // Let's hide nodes that have NO incremental/dismissed descendants and are not incremental/dismissed themselves.
    const hasRelevance = node.isIncremental || node.isDismissed || node.aggrIncCount > 0 || node.aggrDismCount > 0;

    if (!hasRelevance && depth > 0) return null;

    const hasChildren = node.childrenIds.some(childId => {
        const child = data.nodes[childId];
        return child && (child.isIncremental || child.isDismissed || child.aggrIncCount > 0 || child.aggrDismCount > 0);
    });

    const isRoot = depth === 0;

    return (
        <div style={{ paddingLeft: isRoot ? 0 : '12px' }}>
            {!isRoot && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '4px 8px 4px 0',
                    fontSize: '12px',
                    borderRadius: '4px',
                    cursor: hasChildren ? 'pointer' : 'default',
                    color: 'var(--rn-clr-content-primary)',
                }}
                    onClick={(e) => {
                        if (hasChildren) {
                            e.stopPropagation();
                            setExpanded(!expanded);
                        }
                    }}
                >
                    <div style={{ width: '16px', display: 'flex', justifyContent: 'center', marginRight: '4px', opacity: 0.5 }}>
                        {hasChildren ? (expanded ? '▼' : '▶') : '•'}
                    </div>

                    <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {node.isIncremental && <span style={{ color: 'var(--rn-clr-green, #22c55e)', marginRight: '4px' }}>●</span>}
                        {node.isDismissed && <span style={{ color: 'var(--rn-clr-orange, #f59e0b)', marginRight: '4px' }}>●</span>}
                        {node.remName}
                    </div>

                    <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginLeft: '8px', minWidth: '40px', textAlign: 'right' }}>
                        {node.aggrReps > 0 ? `${node.aggrReps} reps` : ''}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginLeft: '8px', minWidth: '50px', textAlign: 'right' }}>
                        {node.aggrTime > 0 ? formatDuration(node.aggrTime) : ''}
                    </div>
                </div>
            )}

            {(isRoot || expanded) && node.childrenIds.map(childId => (
                <TreeNode key={childId} nodeId={childId} data={data} depth={depth + 1} />
            ))}
        </div>
    );
};


function AggregatedRepetitionHistoryPopup() {
    const plugin = usePlugin();

    const result = useRunAsync(async () => {
        try {
            const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
            const remId = ctx?.contextData?.remId;
            if (!remId) return null;

            const rootRem = await plugin.rem.findOne(remId);
            if (!rootRem) return null;

            // Fetch all descendants flat
            const descendants = await rootRem.getDescendants();
            const allRems = [rootRem, ...descendants];

            // Build a map of ID -> NodeData
            // We need to populate props for all nodes first
            const nodes: Record<string, NodeStats> = {};
            const childMap: Record<string, string[]> = {};

            // 1. Initialize nodes
            const remIndexMap: Record<string, number> = {};

            allRems.forEach((r, index) => {
                remIndexMap[r._id] = index;
            });
            allRems.forEach((r, index) => {
                remIndexMap[r._id] = index;
            });


            for (const r of allRems) {
                // Determine if Inc/Dism
                let isInc = false;
                let isDism = false;
                let history: IncrementalRep[] = [];

                // Check Inc
                const incInfo = await getIncrementalRemFromRem(plugin, r);
                if (incInfo) {
                    isInc = true;
                    history = incInfo.history || [];
                } else {
                    // Check Dism
                    const dismInfo = await getDismissedHistoryFromRem(plugin, r);
                    if (dismInfo) {
                        isDism = true;
                        history = dismInfo.history || [];
                    }
                }

                const reps = getRepCount(history);
                const time = getTotalTime(history);
                const name = await safeRemTextToString(plugin, r.text);



                nodes[r._id] = {
                    id: r._id,
                    isIncremental: isInc,
                    isDismissed: isDism,
                    reps,
                    time,
                    history,
                    aggrReps: reps, // Start with self
                    aggrTime: time,
                    aggrIncCount: isInc ? 1 : 0,
                    aggrDismCount: isDism ? 1 : 0,
                    childrenIds: [], // Will populate next
                    remName: name || 'Untitled',
                };

                // Populate child map for hierarchy reconstruction
                // We only care about parent-child relationships WITHIN the fetched set
                // descendants list might not be in order, but `r.parent` gives parent.
                // NOTE: `r.parent` needs to be fetched or is it a property?
                // In PluginRem, `parent` is a property that returns Promise<PluginRem | undefined>
                // OR `parentId`. Let's use `parentId`.
                // Actually `allRems` includes root. Root's parent is outside scope.
                // For descendants, their parent should be in `allRems` (unless structure changed async).
                if (r._id !== rootRem._id) {
                    // FIX: Use `r.parent`, not `r.parentId`. `parent` is the standard SDK property.
                    const parentId = r.parent;
                    if (parentId && nodes[parentId]) {
                        if (!childMap[parentId]) childMap[parentId] = [];
                        childMap[parentId].push(r._id);
                    } else if (parentId && !nodes[parentId]) {
                        // Console log if parent is missing (should not happen for descendants usually)
                        // But for root's children, root needs to be in nodes (it is).
                        // console.warn(`[AggHistory] Parent ${parentId} not found in nodes for child ${r._id} (${name})`);
                    }
                }
            }

            // 2. Link children in our nodes map and sort them by appearance order (Editor order)
            for (const id in nodes) {
                if (childMap[id]) {
                    // Sort children by their original index in allRems (DFS/Document order)
                    const sortedChildren = childMap[id].sort((aId, bId) => {
                        const indexA = remIndexMap[aId] ?? 0;
                        const indexB = remIndexMap[bId] ?? 0;
                        return indexA - indexB;
                    });

                    nodes[id].childrenIds = sortedChildren;
                }
            }

            // 3. Aggregate Stats (Bottom-Up)
            // Since we don't have a guaranteed topologically sorted list in reverse for bottom-up,
            // we can use a recursive function to aggregate.

            const aggregate = (nodeId: string): { r: number, t: number, i: number, d: number } => {
                const node = nodes[nodeId];
                if (!node) return { r: 0, t: 0, i: 0, d: 0 };

                let sumReps = node.reps;
                let sumTime = node.time;
                let sumInc = node.isIncremental ? 1 : 0;
                let sumDism = node.isDismissed ? 1 : 0;

                for (const childId of node.childrenIds) {
                    const childStats = aggregate(childId);
                    sumReps += childStats.r;
                    sumTime += childStats.t;
                    sumInc += childStats.i;
                    sumDism += childStats.d;
                }

                node.aggrReps = sumReps;
                node.aggrTime = sumTime;
                node.aggrIncCount = sumInc;
                node.aggrDismCount = sumDism;

                return { r: sumReps, t: sumTime, i: sumInc, d: sumDism };
            };

            aggregate(rootRem._id);

            return {
                nodes,
                rootId: rootRem._id
            };

        } catch (error) {
            console.error(error);
            return null;
        }
    }, []);

    const containerStyle: React.CSSProperties = {
        width: '450px',
        maxHeight: '850px',
        backgroundColor: 'var(--rn-clr-background-primary)',
        borderRadius: '12px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
    };

    if (!result) {
        return (
            <div style={containerStyle}>
                <div style={{ padding: '32px', textAlign: 'center', color: 'var(--rn-clr-content-tertiary)' }}>
                    Loading aggregated history...
                </div>
            </div>
        );
    }

    return (
        <div style={containerStyle}>
            <Header
                onClose={() => plugin.widget.closePopup()}
                onSwitch={async () => {
                    await plugin.widget.openPopup('repetition_history', { remId: result.rootId });
                }}
            />
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                <StatsSection data={result} />
                <div style={{ padding: '12px 16px' }}>
                    <div style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'var(--rn-clr-content-tertiary)',
                        marginBottom: '8px',
                        textTransform: 'uppercase'
                    }}>
                        Hierarchy
                    </div>
                    <TreeNode nodeId={result.rootId} data={result} />
                </div>
            </div>
        </div>
    );
}

renderWidget(AggregatedRepetitionHistoryPopup);
