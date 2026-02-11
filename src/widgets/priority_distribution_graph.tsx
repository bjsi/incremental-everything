import { renderWidget, usePlugin, useRunAsync, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useState } from 'react';
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
import { PRIORITY_GRAPH_DATA_KEY_PREFIX } from '../lib/consts';

interface GraphDataPoint {
  range: string;
  incRem: number;
  card: number;
}

interface PriorityGraphData {
  bins: GraphDataPoint[];
  binsKbRelative?: GraphDataPoint[];
  lastUpdated?: string;
}

// Export as a reusable component, not just a widget
export function PriorityDistributionGraphComponent({ documentId }: { documentId: string }) {
  const plugin = usePlugin();
  const [viewMode, setViewMode] = useState<'absolute' | 'kbRelative'>('absolute');

  // Reactive fetch: automatically re-runs when the storage key updates
  const graphData = useTrackerPlugin(async (reactivePlugin) => {
    if (!documentId) return null;
    const stored = await reactivePlugin.storage.getSynced(PRIORITY_GRAPH_DATA_KEY_PREFIX + documentId) as any;

    if (!stored) return null;

    return {
      bins: stored.bins || [],
      binsKbRelative: stored.binsKbRelative,
      lastUpdated: stored.lastUpdated || null,
    } as PriorityGraphData;
  }, [documentId]);

  if (!graphData || !graphData.bins || graphData.bins.length === 0) {
    return null;
  }

  // Determine which data to show
  const activeData = viewMode === 'kbRelative' && graphData.binsKbRelative
    ? graphData.binsKbRelative
    : graphData.bins;

  const hasKbRelativeData = !!graphData.binsKbRelative;

  return (
    <div
      style={{ maxWidth: '95%', overflow: 'hidden' }}
      className="w-95 mx-auto flex flex-col items-center p-4 bg-white rounded-lg border border-gray-200 shadow-sm mt-2"
    >
      <div className="flex justify-between items-center w-full mb-4 px-4">
        <h4 className="text-sm font-semibold text-gray-700">
          Priority Distribution
        </h4>

        {/* View Mode Toggle */}
        {hasKbRelativeData && (
          <div className="flex bg-gray-100 p-1 rounded-md">
            <button
              onClick={() => setViewMode('absolute')}
              className={`px-3 py-1 text-xs rounded-sm transition-all ${viewMode === 'absolute'
                ? 'bg-white text-blue-600 shadow-sm font-medium'
                : 'text-gray-500 hover:text-gray-700'
                }`}
            >
              Absolute Priority
            </button>
            <button
              onClick={() => setViewMode('kbRelative')}
              className={`px-3 py-1 text-xs rounded-sm transition-all ${viewMode === 'kbRelative'
                ? 'bg-white text-blue-600 shadow-sm font-medium'
                : 'text-gray-500 hover:text-gray-700'
                }`}
            >
              KB Percentile
            </button>
          </div>
        )}
      </div>

      <div style={{ width: '100%', height: 300 }}>
        <ResponsiveContainer width="100%" height="100%" minHeight={300} minWidth={100}>
          <BarChart
            data={activeData}
            margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
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

            {/* Left Y-Axis for Incremental Rems */}
            <YAxis
              yAxisId="left"
              orientation="left"
              stroke="#3b82f6"
              allowDecimals={false}
              label={{ value: 'IncRems', angle: -90, position: 'insideLeft', fill: '#3b82f6', fontSize: 10 }}
            />

            {/* Right Y-Axis for Rems with Cards */}
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#ef4444"
              allowDecimals={false}
              label={{ value: 'Rems with Cards', angle: 90, position: 'insideRight', fill: '#ef4444', fontSize: 10 }}
            />

            <Tooltip
              contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
            />
            <Legend verticalAlign="top" height={36} />

            {/* Bars linked to specific axes */}
            <Bar yAxisId="left" dataKey="incRem" name="Incremental Rems" fill="#3b82f6" />
            <Bar yAxisId="right" dataKey="card" name="Rems with Cards" fill="#ef4444" />

          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-col items-center mt-2">
        <div className="text-xs text-gray-500 mb-1">
          {viewMode === 'absolute'
            ? 'X-Axis: Absolute Priority (0-100)'
            : 'X-Axis: KB-wide Relative Percentile (0-100%)'}
        </div>
        {graphData.lastUpdated && (
          <div className="text-xs text-gray-400 mt-1">
            Last updated: {new Date(graphData.lastUpdated).toLocaleString()}
          </div>
        )}
      </div>
    </div>
  );
}

// Retain default export for widget registration if needed, but we essentially deprecate it.
// We'll just export an empty or placeholder widget to avoid build errors if registry still points to it,
// or we can remove the widgets.ts entry entirely later.
export default PriorityDistributionGraphComponent;