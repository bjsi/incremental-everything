import { renderWidget, usePlugin, useRunAsync, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useState, useMemo } from 'react';
import { allIncrementalRemKey, allCardPriorityInfoKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { CardPriorityInfo } from '../lib/card_priority';
import { extractText, determineIncRemType, getTotalTimeSpent, getTopLevelDocument } from '../lib/incRemHelpers';
import { IncRemTable, IncRemWithDetails, DocumentInfo } from '../components';
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

export function IncRemMainView() {
  const plugin = usePlugin();
  const [loadingRems, setLoadingRems] = useState<boolean>(false);
  const [incRemsWithDetails, setIncRemsWithDetails] = useState<IncRemWithDetails[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [filteredByDocument, setFilteredByDocument] = useState<Set<string> | null>(null);
  const [showGraph, setShowGraph] = useState(false);

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

          return {
            ...incRem,
            remText: textStr || '[Empty rem]',
            incRemType,
            percentile: percentiles[incRem.remId],
            totalTimeSpent: getTotalTimeSpent(incRem),
            documentId: topLevelDoc?.id,
            documentName: topLevelDoc?.name,
          };
        } catch (error) {
          console.error('Error loading rem details:', error);
          return null;
        }
      })
    );

    setIncRemsWithDetails(remsWithDetails.filter((rem): rem is IncRemWithDetails => rem !== null));
    setLoadingRems(false);
  };

  const handleRemClick = async (remId: string) => {
    try {
      const rem = await plugin.rem.findOne(remId);
      const incRem = incRemsWithDetails.find(r => r.remId === remId);

      if (rem) {
        if (incRem?.incRemType === 'pdf-note') {
          // For PDF notes, attempt to force open in main editor context using openRemAsPage
          // User confirmed this is the safe way to avoid opening the PDF
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
        />
      </div>
    </div>
  );
}

renderWidget(IncRemMainView);
