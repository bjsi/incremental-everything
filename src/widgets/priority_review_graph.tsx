import { renderWidget, usePlugin, useRunAsync, useTrackerPlugin } from '@remnote/plugin-sdk';
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

// Union type to handle backward compatibility (if old data exists as just array)
type GraphStorageData = GraphDataPoint[] | { bins: GraphDataPoint[]; stats: GraphStats };

function PriorityReviewGraph() {
  const plugin = usePlugin();
  
  // Get the Rem ID this widget is attached to
  const context = useTrackerPlugin(async (rp) => {
    return await rp.widget.getWidgetContext<{ widgetInstanceId: string; remId: string }>();
  }, []);
  
  const remId = context?.remId;

  // Fetch the data and parse it
  const { data, stats } = useRunAsync(async () => {
    if (!remId) return { data: [], stats: null };
    
    const stored = await plugin.storage.getSynced(GRAPH_DATA_KEY_PREFIX + remId) as GraphStorageData;
    
    if (!stored) return { data: [], stats: null };

    if (Array.isArray(stored)) {
      // Old format compatibility
      return { data: stored, stats: null };
    } else {
      // New format with stats
      return { data: stored.bins || [], stats: stored.stats || null };
    }
  }, [remId]) || { data: [], stats: null };

  if (!data || data.length === 0) {
    // If no data is found, we don't render anything or render a placeholder
    // This avoids cluttering empty Rems if the tag is added accidentally
    return null; 
  }

  return (
    <div className="w-full flex flex-col items-center p-4 bg-white rounded-lg border border-gray-200 shadow-sm mt-2">
      <h4 className="text-sm font-semibold mb-2 text-gray-700">Priority Distribution of Items</h4>
      <div style={{ width: '100%', height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{
              top: 5,
              right: 10,
              left: 0,
              bottom: 5,
            }}
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
          X-Axis: Priority Range (0-100) | Y-Axis: Left (IncRem) / Right (Cards)
        </div>
        {stats && (
          <div className="text-sm font-medium text-gray-700 bg-gray-50 px-3 py-1 rounded-full border border-gray-200">
            Randomness: IncRem {stats.incRem}%, Cards {stats.card}%
          </div>
        )}
      </div>
    </div>
  );
}

renderWidget(PriorityReviewGraph);