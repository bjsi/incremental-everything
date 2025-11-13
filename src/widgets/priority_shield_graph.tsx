import { renderWidget, usePlugin, useRunAsync, useTrackerPlugin } from '@remnote/plugin-sdk';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  priorityShieldHistoryKey,
  documentPriorityShieldHistoryKey,
  cardPriorityShieldHistoryKey,
  documentCardPriorityShieldHistoryKey,
} from '../lib/consts';
import dayjs from 'dayjs';

interface ShieldHistoryEntry {
  absolute: number | null;
  percentile: number | null;
  universeSize?: number; // NEW: Track the total count of items in scope
}

interface ChartData {
  date: string;
  absolute: number | null;
  relative: number | null;
  universeSize: number; // NEW: Universe size for the chart
}

function PriorityShieldGraph() {
  const plugin = usePlugin();
  
  // Get the context to check if we're in a document queue
  const ctx = useTrackerPlugin(
    async (rp) => await rp.widget.getWidgetContext<any>(),
    []
  );
  
  // Get the current subQueueId from context
  const subQueueId = ctx?.contextData?.subQueueId || ctx?.subQueueId;
  
  // --- NEW: Get the original scope ID for Priority Review Documents ---
  const originalScopeId = useTrackerPlugin(
    (rp) => rp.storage.getSession<string | null>('originalScopeId'),
    []
  );
  
  // --- NEW: Determine which scope to use for document-level data ---
  // If we're in a Priority Review Document, use the originalScopeId
  // Otherwise, use the subQueueId
  const effectiveDocScopeId = originalScopeId || subQueueId;
  
  // Fetch document name - use the effective scope ID
  const documentName = useRunAsync(async () => {
    if (!effectiveDocScopeId) return null;
    const rem = await plugin.rem.findOne(effectiveDocScopeId);
    return rem?.text?.join('') || 'Document';
  }, [effectiveDocScopeId]);

  const processHistoryData = (history: Record<string, ShieldHistoryEntry> | undefined) => {
    if (!history) return [];
    const unsortedData = Object.entries(history).map(([date, values]) => ({
      date: date,
      absolute: values.absolute,
      relative: values.percentile,
      universeSize: values.universeSize || 0, // NEW: Include universe size with default
    }));
    const sortedData = unsortedData.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return sortedData.map(item => ({
      ...item,
      date: dayjs(item.date).format('MMM DD'),
    }));
  };
  
  // --- Incremental Rem Data ---
  const kbChartData = useRunAsync(async () => {
    const history = (await plugin.storage.getSynced(priorityShieldHistoryKey)) as Record<string, ShieldHistoryEntry>;
    return processHistoryData(history);
  }, []);

  // --- NEW: Fetch document-level data using effectiveDocScopeId ---
  const docChartData = useRunAsync(async () => {
    if (!effectiveDocScopeId) return null;
    const allDocHistory = (await plugin.storage.getSynced(documentPriorityShieldHistoryKey)) as Record<string, Record<string, ShieldHistoryEntry>>;
    return processHistoryData(allDocHistory?.[effectiveDocScopeId]);
  }, [effectiveDocScopeId]);

  // --- Flashcard Data ---
  const cardKbChartData = useRunAsync(async () => {
    const history = (await plugin.storage.getSynced(cardPriorityShieldHistoryKey)) as Record<string, ShieldHistoryEntry>;
    return processHistoryData(history);
  }, []);

  // --- NEW: Fetch card document-level data using effectiveDocScopeId ---
  const cardDocChartData = useRunAsync(async () => {
    if (!effectiveDocScopeId) return null;
    const allDocHistory = (await plugin.storage.getSynced(documentCardPriorityShieldHistoryKey)) as Record<string, Record<string, ShieldHistoryEntry>>;
    return processHistoryData(allDocHistory?.[effectiveDocScopeId]);
  }, [effectiveDocScopeId]);

  // Custom tooltip to show all three values clearly
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white p-2 border border-gray-300 rounded shadow">
          <p className="font-semibold">{`Date: ${label}`}</p>
          {payload.map((entry: any, index: number) => {
            if (entry.dataKey === 'universeSize') {
              return (
                <p key={index} style={{ color: entry.color }}>
                  {`${entry.name}: ${entry.value.toLocaleString()}`}
                </p>
              );
            }
            return (
              <p key={index} style={{ color: entry.color }}>
                {`${entry.name}: ${entry.value !== null ? 
                  (entry.dataKey === 'relative' ? `${entry.value}%` : entry.value) 
                  : 'N/A'}`}
              </p>
            );
          })}
        </div>
      );
    }
    return null;
  };

  const renderChart = (data: ChartData[], title: string, color1: string, color2: string, color3: string) => {
    // Find the maximum universe size for better y-axis scaling
    const maxUniverse = Math.max(...data.map(d => d.universeSize || 0));
    const universeAxisMax = Math.ceil(maxUniverse * 1.1); // Add 10% padding
    
    return (
      <div className="mb-6">
        <h4 className="text-md font-semibold text-center mb-2">{title}</h4>
        <ResponsiveContainer width="100%" height={300} debounce={50}>
          <LineChart data={data} margin={{ top: 5, right: 50, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />
            
            {/* Left Y-axis for Absolute Priority */}
            <YAxis 
              yAxisId="left" 
              orientation="left" 
              stroke={color1} 
              domain={[0, 100]}
              width={30}
            />
            
            {/* Right Y-axis for Relative Priority % */}
            <YAxis 
              yAxisId="middle" 
              orientation="right" 
              stroke={color2} 
              domain={[0, 100]} 
              tickFormatter={(tick) => `${tick}%`}
              width={60}
            />
            
            {/* Far-right Y-axis for Universe Size */}
            <YAxis 
              yAxisId="right" 
              orientation="right" 
              stroke={color3}
              domain={[0, universeAxisMax]}
              tickFormatter={(value) => value >= 1000 ? `${(value/1000).toFixed(1)}k` : value.toString()}
              width={45}
              tick={{ fontSize: 11 }}
              style={{ marginLeft: 60 }}
            />
            
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ paddingTop: '10px' }} />
            
            <Line 
              yAxisId="left" 
              type="monotone" 
              dataKey="absolute" 
              name="Absolute Priority" 
              stroke={color1}
              strokeWidth={2}
              dot={{ r: 3 }}
            />
            
            <Line 
              yAxisId="middle" 
              type="monotone" 
              dataKey="relative" 
              name="Relative Priority (%)" 
              stroke={color2}
              strokeWidth={2}
              activeDot={{ r: 6 }}
              dot={{ r: 3 }}
            />
            
            <Line 
              yAxisId="right" 
              type="monotone" 
              dataKey="universeSize" 
              name="Universe Size" 
              stroke={color3}
              strokeWidth={2}
              strokeDasharray="5 5" // Dashed line to differentiate
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  };

  const hasKbData = kbChartData && kbChartData.length > 0;
  const hasDocData = docChartData && docChartData.length > 0;
  const hasCardKbData = cardKbChartData && cardKbChartData.length > 0;
  const hasCardDocData = cardDocChartData && cardDocChartData.length > 0;

  if (!hasKbData && !hasDocData && !hasCardKbData && !hasCardDocData) {
    return <div className="p-4">No history data found. Start reviewing to build your graph!</div>;
  }

  // Remove the fixed height and scrolling - let the container size naturally
  return (
    <div className="p-4 flex flex-col" style={{ width: '1030px' }}>
      <h3 className="text-lg font-bold text-center mb-4">Priority Shield History</h3>
      
      {/* Show document-level charts if we have an effective scope (original or current) */}
      {effectiveDocScopeId && hasDocData && renderChart(
        docChartData!, 
        `📄 ${documentName || 'Document'} IncRem Shield`, 
        '#e74c3c', '#f39c12', '#9b59b6'
      )}
      {hasKbData && renderChart(
        kbChartData, 
        '🌐 Knowledge Base IncRem Shield', 
        '#8884d8', '#82ca9d', '#e91e63'
      )}
      
      {(hasDocData || hasKbData) && (hasCardDocData || hasCardKbData) && <hr className="my-8 border-gray-400" />}

      {effectiveDocScopeId && hasCardDocData && renderChart(
        cardDocChartData!, 
        `🎴 ${documentName || 'Document'} Card Shield`, 
        '#d35400', '#f1c40f', '#16a085'
      )}
      {hasCardKbData && renderChart(
        cardKbChartData, 
        '🌐 Knowledge Base Card Shield', 
        '#c0392b', '#e67e22', '#2980b9'
      )}
      
      <div className="mt-4 text-sm rn-clr-content-secondary text-justify">
        <p className="mb-3">
          <b>Priority Shield:</b> This metric represents your processing capacity for high-priority items. A higher shield value (closer to 100) means you are successfully reviewing your most important material on time.
        </p>
        
        {effectiveDocScopeId && hasDocData && (
          <p className="mb-3">
            <b>Document Shield:</b> Shows your priority protection within {originalScopeId ? 'the original document scope (for Priority Review Documents)' : 'the current document/folder scope'}. This helps you track how well you're keeping up with the most important items in this specific context.
          </p>
        )}
        
        <p className="mb-3">
          <b>Universe Size (dashed line):</b> Shows the total number of <b>IncRems</b> or <b>Rems with Cards</b> in the respective scope. When this number decreases, it often indicates successful processing and removal of items (e.g., removing the Incremental tag after processing). This explains why priority percentiles might suddenly change - a smaller universe means each remaining item represents a larger percentage of the whole.
          <br></br>
          <i>Note:</i> The universe shown in the <b>Card Shield</b> is total number of <b>Rems with Cards</b>, which is <i>different</i> from the total number of <b>flashcards</b> shown in other RemNote UI (remember that a Rem can have several flashcards!). `cardPriority` powerup (and its priority) is assigned per rem, not per flashcard. The total number of flashcards is larger them the universe shown here.
        </p>
        
        <p className="mb-3">
          <b>Absolute Priority</b> refers to the number set in the Incremental Rem or Flashcard priority property.
        </p>
        
        <p className="mb-3">
          <b>Relative Priority</b> <i>percentile</i> is the Rem's relative rank within the {effectiveDocScopeId && hasDocData ? "respective scope" : "Knowledge Base"} (% of {effectiveDocScopeId && hasDocData ? "scope" : "KB"}); this gives you a clearer metric for managing your learning load. 
          The higher the percentile of your Relative Priority shield, the more your top priority material is safeguarded and processed. 
          If your graph oscillates around priority of 4%, you will know that only top 4% of your learning material is guaranteed a timely repetition. 
          You can increase that number by doing more work, reducing inflow of new material, deprioritizing less important Incremental Rems / Flashcards, or reducing the randomization degree for the due Incremental Rems queue / Flashcards queue in the <b>Sorting Criteria</b> queue menu (the three-dot icon).
        </p>
        
        <p>
          <b>Understanding Universe Size Changes:</b> <br></br>
          For <b>Incremental Rems</b>, when the universe size drops, it typically means you're successfully processing items and removing them from the queue. Conversely, when universe size increases, new IncRems are being added to your learning queue (increasing your to-do list of material to process), which may affect priority percentiles even if absolute priorities remain the same. 
          <br></br>
          For <b>Flashcards</b>, this number will usually only increase (unless you delete cards). The evolution will show you the size of your knowledge (considering you keep control of your due cards).
        </p>
      </div>
    </div>
  );
}

renderWidget(PriorityShieldGraph);
