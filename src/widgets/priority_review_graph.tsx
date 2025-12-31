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
import { GRAPH_DATA_KEY_PREFIX } from '../lib/consts';

interface GraphDataPoint {
  range: string;
  incRem: number;
  card: number;
}

interface GraphStats {
  incRem: number;
  card: number;
}

interface FullGraphData {
  bins: GraphDataPoint[];
  binsRelative?: GraphDataPoint[];
  stats: GraphStats | null;
}

function PriorityReviewGraph() {
  const plugin = usePlugin();
  const [viewMode, setViewMode] = useState<'absolute' | 'relative'>('absolute');
  
  // Get the Rem ID this widget is attached to
  const context = useTrackerPlugin(async (rp) => {
    return await rp.widget.getWidgetContext<{ widgetInstanceId: string; remId: string }>();
  }, []);
  
  const remId = context?.remId;

  // Fetch the data and parse it
  const graphData = useRunAsync(async () => {
    if (!remId) return null;
    const stored = await plugin.storage.getSynced(GRAPH_DATA_KEY_PREFIX + remId) as any;
    
    if (!stored) return null;

    // Handle legacy format (just array)
    if (Array.isArray(stored)) {
      return { bins: stored, binsRelative: undefined, stats: null };
    }
    
    // Handle new format
    return {
      bins: stored.bins || [],
      binsRelative: stored.binsRelative, // May be undefined for older docs created before this update
      stats: stored.stats || null
    };
  }, [remId]);

  if (!graphData || !graphData.bins || graphData.bins.length === 0) {
    return null;
  }

  // Determine which data to show
  const activeData = viewMode === 'relative' && graphData.binsRelative 
    ? graphData.binsRelative 
    : graphData.bins;

  const hasRelativeData = !!graphData.binsRelative;

  return (
    <div className="w-full flex flex-col items-center p-4 bg-white rounded-lg border border-gray-200 shadow-sm mt-2">
      <div className="flex justify-between items-center w-full mb-4 px-4">
        <h4 className="text-sm font-semibold text-gray-700">
          Priority Distribution
        </h4>
        
        {/* View Mode Toggle */}
        {hasRelativeData && (
          <div className="flex bg-gray-100 p-1 rounded-md">
            <button
              onClick={() => setViewMode('absolute')}
              className={`px-3 py-1 text-xs rounded-sm transition-all ${
                viewMode === 'absolute' 
                  ? 'bg-white text-blue-600 shadow-sm font-medium' 
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Absolute Priority
            </button>
            <button
              onClick={() => setViewMode('relative')}
              className={`px-3 py-1 text-xs rounded-sm transition-all ${
                viewMode === 'relative' 
                  ? 'bg-white text-blue-600 shadow-sm font-medium' 
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Relative Percentile
            </button>
          </div>
        )}
      </div>

      <div style={{ width: '100%', height: 300 }}>
        <ResponsiveContainer width="100%" height="100%" minHeight={300} minWidth={100}>
          <BarChart
            data={activeData}
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
            
            {/* Left Y-Axis for Incremental Rems */}
            <YAxis 
              yAxisId="left"
              orientation="left"
              stroke="#3b82f6" 
              allowDecimals={false}
              label={{ value: 'IncRems', angle: -90, position: 'insideLeft', fill: '#3b82f6', fontSize: 10 }}
            />
            
            {/* Right Y-Axis for Flashcards */}
            <YAxis 
              yAxisId="right"
              orientation="right"
              stroke="#ef4444"
              allowDecimals={false}
              label={{ value: 'Cards', angle: 90, position: 'insideRight', fill: '#ef4444', fontSize: 10 }}
            />
            
            <Tooltip 
              contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
            />
            <Legend verticalAlign="top" height={36}/>
            
            {/* Bars linked to specific axes */}
            <Bar yAxisId="left" dataKey="incRem" name="Incremental Rems" fill="#3b82f6" />
            <Bar yAxisId="right" dataKey="card" name="Flashcards" fill="#ef4444" />
            
          </BarChart>
        </ResponsiveContainer>
      </div>
      
      <div className="flex flex-col items-center mt-2">
        <div className="text-xs text-gray-500 mb-1">
          {viewMode === 'absolute' 
            ? 'X-Axis: Absolute Priority (0-100)' 
            : 'X-Axis: Relative Percentile in scope Priority Queue (0-100%)'}
        </div>
        {graphData.stats && (
          <div className="text-sm font-medium text-gray-700 bg-gray-50 px-3 py-1 rounded-full border border-gray-200 mt-1">
            Randomness: IncRem {graphData.stats.incRem}%, Cards {graphData.stats.card}%
          </div>
        )}
      </div>
    </div>
  );
}

renderWidget(PriorityReviewGraph);