import { renderWidget, usePlugin, useRunAsync, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useState, useMemo, useRef } from 'react';
import { allIncrementalRemKey, allCardPriorityInfoKey, powerupCode, prioritySlotCode } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { CardPriorityInfo } from '../lib/card_priority';
import { extractText, determineIncRemType, getTotalTimeSpent, getTopLevelDocument, getBreadcrumbText } from '../lib/incRemHelpers';
import { safeRemTextToString } from '../lib/pdfUtils';
import { getNextSpacingDateForRem } from '../lib/scheduler';
import { getSortingRandomness } from '../lib/sorting';
import { IncRemTable, IncRemWithDetails, DocumentInfo } from '../components';
import type { IncRemListState } from '../components';
import { buildDocumentScope } from '../lib/scope_helpers';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface GraphDataPoint {
  range: string;
  incRem: number;
  card: number;
}

/**
 * Computes absolute priority bins from all KB IncRems and card infos.
 */
function computeKbGraphBins(
  allIncRems: IncrementalRem[],
  allCardInfos: CardPriorityInfo[],
): GraphDataPoint[] {
  const bins: GraphDataPoint[] = Array(20).fill(0).map((_, i) => ({
    range: `${i * 5}-${(i + 1) * 5}`,
    incRem: 0,
    card: 0,
  }));

  for (const item of allIncRems) {
    const p = Math.max(0, Math.min(100, item.priority));
    const idx = Math.min(Math.floor(p / 5), 19);
    bins[idx].incRem++;
  }

  for (const item of allCardInfos) {
    const p = Math.max(0, Math.min(100, item.priority));
    const idx = Math.min(Math.floor(p / 5), 19);
    bins[idx].card++;
  }

  return bins;
}

const INC_REM_MAIN_VIEW_STATE_KEY = 'inc-rem-main-view-state';
const INC_REM_MAIN_VIEW_DOC_FILTER_KEY = 'inc-rem-main-view-doc-filter';

export function IncRemMainView() {
  const plugin = usePlugin();
  const [loadingRems, setLoadingRems] = useState<boolean>(false);
  const [incRemsWithDetails, setIncRemsWithDetails] = useState<IncRemWithDetails[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [filteredByDocument, setFilteredByDocument] = useState<Set<string> | null>(null);
  const [showGraph, setShowGraph] = useState(false);

  // Track in-flight priority changes so cache reloads don't overwrite them with stale data.
  const pendingPriorityChanges = useRef<Record<string, number>>({});

  // Track current filter/sort state for "Back to IncRem List" flow
  const currentListState = useRef<IncRemListState | null>(null);

  // Load saved state from session (for "Back to IncRem List" flow)
  const [initialState, setInitialState] = useState<IncRemListState | undefined>(undefined);
  const [stateCheckDone, setStateCheckDone] = useState(false);
  const initialStateLoaded = useRef(false);

  const initialData = useTrackerPlugin(
    async (rp) => {
      if (initialStateLoaded.current) return null;
      initialStateLoaded.current = true;
      const state = await rp.storage.getSession<IncRemListState>(INC_REM_MAIN_VIEW_STATE_KEY);
      if (state) {
        setInitialState(state);
        await rp.storage.setSession(INC_REM_MAIN_VIEW_STATE_KEY, undefined);
      }
      // Restore the document filter if previously saved
      const savedDocId = await rp.storage.getSession<string | null>(INC_REM_MAIN_VIEW_DOC_FILTER_KEY);
      if (savedDocId) {
        setSelectedDocumentId(savedDocId);
        const scope = await buildDocumentScope(rp as any, savedDocId);
        setFilteredByDocument(scope);
        await rp.storage.setSession(INC_REM_MAIN_VIEW_DOC_FILTER_KEY, undefined);
      }

      const randomness = await getSortingRandomness(rp as any);

      setStateCheckDone(true);
      return { randomness };
    },
    []
  );

  const allIncRems = useTrackerPlugin(
    async (rp) => {
      try {
        const incRems = (await rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
        loadIncRemDetails(incRems);
        return incRems;
      } catch (error) {
        console.error('INC REM MAIN VIEW: Error loading incRems', error);
        return [];
      }
    },
    []
  );

  // Fetch card priority infos for the graph
  const allCardInfos = useRunAsync(async () => {
    return (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
  }, []);

  const loadIncRemDetails = async (incRems: IncrementalRem[]) => {
    if (loadingRems) return;
    setLoadingRems(true);

    const sortedByPriority = [...incRems].sort((a, b) => a.priority - b.priority);
    const percentiles: Record<string, number> = {};
    sortedByPriority.forEach((item, index) => {
      percentiles[item.remId] = Math.round(((index + 1) / sortedByPriority.length) * 100);
    });

    const remsWithDetails = await Promise.all(
      incRems.map(async (incRem) => {
        try {
          const rem = await plugin.rem.findOne(incRem.remId);
          if (!rem) return null;

          const text = await rem.text;
          let textStr = extractText(text);
          if (textStr.length > 300) textStr = textStr.substring(0, 300) + '...';

          const incRemType = await determineIncRemType(plugin, rem);

          const topLevelDoc = await getTopLevelDocument(plugin, rem);

          // Get breadcrumb for tooltip
          const breadcrumb = await getBreadcrumbText(plugin, rem);

          return {
            ...incRem,
            remText: textStr || '[Empty rem]',
            incRemType,
            percentile: percentiles[incRem.remId],
            totalTimeSpent: getTotalTimeSpent(incRem),
            documentId: topLevelDoc?.id,
            documentName: topLevelDoc?.name,
            breadcrumb,
          };
        } catch (error) {
          console.error('Error loading rem details:', error);
          return null;
        }
      })
    );

    let finalDetails = remsWithDetails.filter(Boolean) as IncRemWithDetails[];

    // Apply any pending priority changes so stale cache data doesn't overwrite them
    const pending = pendingPriorityChanges.current;
    const hasPending = Object.keys(pending).length > 0;
    if (hasPending) {
      finalDetails = finalDetails.map((item) =>
        pending[item.remId] !== undefined
          ? { ...item, priority: pending[item.remId] }
          : item
      );
    }

    // Clear pending entries only when the cache data already has the correct value
    for (const remId of Object.keys(pending)) {
      const cacheItem = incRems.find(r => r.remId === remId);
      if (cacheItem && cacheItem.priority === pending[remId]) {
        delete pendingPriorityChanges.current[remId];
      }
    }

    setIncRemsWithDetails(finalDetails);
    setLoadingRems(false);
  };

  const handleRemClick = async (remId: string) => {
    try {
      const rem = await plugin.rem.findOne(remId);
      const incRem = incRemsWithDetails.find(r => r.remId === remId);

      if (rem) {
        if (incRem?.incRemType === 'pdf-note') {
          // For PDF notes, use openRemAsPage to avoid opening the PDF viewer
          await rem.openRemAsPage();
        } else {
          await plugin.window.openRem(rem);
        }
        await plugin.widget.closePopup();
      }
    } catch (error) {
      console.error('Error opening rem:', error);
    }
  };

  const handlePriorityChange = async (remId: string, newPriority: number) => {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) return;

    // Track the pending change BEFORE any async ops that trigger cache reloads
    pendingPriorityChanges.current[remId] = newPriority;

    // Persist to powerup property
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [newPriority.toString()]);

    // Update the cache
    const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
    if (incRemInfo) {
      await updateIncrementalRemCache(plugin, incRemInfo);
    }

    // Update local state so the UI re-renders immediately
    setIncRemsWithDetails((prev) =>
      prev.map((item) =>
        item.remId === remId ? { ...item, priority: newPriority } : item
      )
    );

    await plugin.app.toast(`Priority updated to ${newPriority}`);
  };

  const handleReviewAndOpen = async (remId: string, subsequentRemIds?: string[]) => {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) return;

    // Store the current list state so the timer can reopen with the same filters/sorting
    if (currentListState.current) {
      await plugin.storage.setSession(INC_REM_MAIN_VIEW_STATE_KEY, currentListState.current);
    }
    // Also store the document filter (exclusive to main view)
    if (selectedDocumentId) {
      await plugin.storage.setSession(INC_REM_MAIN_VIEW_DOC_FILTER_KEY, selectedDocumentId);
    }

    // Store the subsequent queue list for sequential review
    if (subsequentRemIds) {
      await plugin.storage.setSession('editor-review-timer-queue-list', subsequentRemIds);
    } else {
      await plugin.storage.setSession('editor-review-timer-queue-list', undefined);
    }

    // Compute the scheduler's suggested interval (like editor_review does)
    const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
    const inLookbackMode = !!(await plugin.queue.inLookbackMode());
    const scheduleData = await getNextSpacingDateForRem(plugin, remId, inLookbackMode);
    const interval = scheduleData?.newInterval || 1;
    const remName = await safeRemTextToString(plugin, rem.text);

    // Set up timer session keys (DON'T call updateReviewRemData — the timer will
    // handle rescheduling on end-review via Mode 2)
    await plugin.storage.setSession('editor-review-timer-rem-id', remId);
    await plugin.storage.setSession('editor-review-timer-start', Date.now());
    await plugin.storage.setSession('editor-review-timer-interval', interval);
    await plugin.storage.setSession('editor-review-timer-priority', incRemInfo?.priority ?? 10);
    await plugin.storage.setSession('editor-review-timer-rem-name', remName || 'Unnamed Rem');
    await plugin.storage.setSession('editor-review-timer-from-queue', false);
    await plugin.storage.setSession('editor-review-timer-origin', 'inc-rem-main-view');

    await plugin.app.toast(`⏱️ Timer started for: ${remName}`);

    // Open the rem in the editor
    const incRemType = await determineIncRemType(plugin, rem);
    if (incRemType === 'pdf-note') {
      await rem.openRemAsPage();
    } else {
      await plugin.window.openRem(rem);
    }

    await plugin.widget.closePopup();
  };

  const handleStateChange = (state: IncRemListState) => {
    currentListState.current = state;
  };

  const handleDocumentFilterChange = async (documentId: string | null) => {
    setSelectedDocumentId(documentId);
    if (documentId) {
      const scope = await buildDocumentScope(plugin, documentId);
      setFilteredByDocument(scope);
    } else {
      setFilteredByDocument(null);
    }
  };

  const documents = useMemo<DocumentInfo[]>(() => {
    const now = Date.now();
    const docMap = new Map<string, { name: string; count: number; dueCount: number }>();

    for (const rem of incRemsWithDetails) {
      if (rem.documentId && rem.documentName) {
        const existing = docMap.get(rem.documentId);
        const isDue = rem.nextRepDate <= now;
        if (existing) {
          existing.count++;
          if (isDue) existing.dueCount++;
        } else {
          docMap.set(rem.documentId, {
            name: rem.documentName,
            count: 1,
            dueCount: isDue ? 1 : 0,
          });
        }
      }
    }

    return Array.from(docMap.entries())
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [incRemsWithDetails]);

  const displayedRems = useMemo(() => {
    if (!filteredByDocument) return incRemsWithDetails;
    return incRemsWithDetails.filter((rem) => filteredByDocument.has(rem.remId));
  }, [incRemsWithDetails, filteredByDocument]);

  // Compute KB-wide graph bins
  const graphBins = useMemo(() => {
    if (!showGraph || !allIncRems || !allCardInfos) return null;
    return computeKbGraphBins(allIncRems, allCardInfos);
  }, [showGraph, allIncRems, allCardInfos]);

  const now = Date.now();
  const dueCount = displayedRems.filter((r) => r.nextRepDate <= now).length;
  const totalCount = displayedRems.length;

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: 'var(--rn-clr-background-primary)' }}>
      {/* Graph toggle button in a small bar above the table */}
      <div
        className="flex items-center justify-end px-4 py-1 shrink-0"
        style={{ borderBottom: '1px solid var(--rn-clr-border-primary)' }}
      >
        <button
          onClick={() => setShowGraph(!showGraph)}
          className="px-2 py-1 text-xs rounded transition-colors"
          style={{
            backgroundColor: showGraph ? 'var(--rn-clr-background-tertiary)' : 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-tertiary)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = showGraph ? 'var(--rn-clr-background-tertiary)' : 'var(--rn-clr-background-primary)';
          }}
          title={showGraph ? 'Hide KB Priority Graph' : 'Show KB Priority Graph'}
        >
          📊 {showGraph ? 'Hide Graph' : 'KB Priority Graph'}
        </button>
      </div>

      {/* KB Priority Distribution Graph */}
      {showGraph && graphBins && (
        <div className="shrink-0 px-2 py-3" style={{ borderBottom: '1px solid var(--rn-clr-border-primary)', overflow: 'hidden' }}>
          <div className="w-full flex flex-col items-center p-3 bg-white rounded-lg border border-gray-200 shadow-sm" style={{ maxWidth: '100%' }}>
            <h4 className="text-sm font-semibold text-gray-700 mb-3">
              KB Priority Distribution
              <span className="text-xs font-normal text-gray-400 ml-2">
                ({allIncRems?.length || 0} IncRems, {allCardInfos?.length || 0} Rems with Cards)
              </span>
            </h4>

            <div style={{ width: '100%', height: 250 }}>
              <ResponsiveContainer width="100%" height="100%" minHeight={250} minWidth={100}>
                <BarChart
                  data={graphBins}
                  margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="range"
                    tick={{ fontSize: 10 }}
                    interval={0}
                    angle={-45}
                    textAnchor="end"
                    height={50}
                  />
                  <YAxis
                    yAxisId="left"
                    orientation="left"
                    stroke="#3b82f6"
                    allowDecimals={false}
                    tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v)}
                    label={{ value: 'IncRems', angle: -90, position: 'insideLeft', fill: '#3b82f6', fontSize: 10 }}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    stroke="#ef4444"
                    allowDecimals={false}
                    tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v)}
                    label={{ value: 'Rems with Cards', angle: 90, position: 'insideRight', fill: '#ef4444', fontSize: 10 }}
                  />
                  <Tooltip
                    contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
                  />
                  <Legend verticalAlign="top" height={36} />
                  <Bar yAxisId="left" dataKey="incRem" name="Incremental Rems" fill="#3b82f6" />
                  <Bar yAxisId="right" dataKey="card" name="Rems with Cards" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="text-xs text-gray-500 mt-1">
              X-Axis: Absolute Priority (0-100)
            </div>
          </div>
        </div>
      )}

      {/* Original IncRemTable */}
      <div className="flex-1" style={{ minHeight: 0 }}>
        {stateCheckDone && (
          <IncRemTable
            title="All Inc Rems"
            icon="📊"
            incRems={displayedRems}
            loading={loadingRems}
            dueCount={dueCount}
            totalCount={totalCount}
            onRemClick={handleRemClick}
            documents={documents}
            selectedDocumentId={selectedDocumentId}
            onDocumentFilterChange={handleDocumentFilterChange}
            onPriorityChange={handlePriorityChange}
            onReviewAndOpen={handleReviewAndOpen}
            initialState={initialState}
            onStateChange={handleStateChange}
            sortingRandomness={initialData?.randomness ?? 0}
          />
        )}
      </div>
    </div>
  );
}

renderWidget(IncRemMainView);
