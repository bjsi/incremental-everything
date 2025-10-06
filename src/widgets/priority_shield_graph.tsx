import { renderWidget, usePlugin, useRunAsync, useTrackerPlugin } from '@remnote/plugin-sdk';
import React from 'react';
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
  cardPriorityShieldHistoryKey, // new import
  documentCardPriorityShieldHistoryKey, // new import
} from '../lib/consts';
import dayjs from 'dayjs';

interface ShieldHistoryEntry {
  absolute: number | null;
  percentile: number | null;
}

interface ChartData {
  date: string;
  absolute: number | null;
  relative: number | null;
}

function PriorityShieldGraph() {
  const plugin = usePlugin();
  
    // Get the context to check if we're in a document queue
  const ctx = useTrackerPlugin(
    async (rp) => await rp.widget.getWidgetContext<any>(),
    []
  );
  
  // The subQueueId is nested in contextData
  const subQueueId = ctx?.contextData?.subQueueId || ctx?.subQueueId;
  
  // Fetch document name if we have a subQueueId
  const documentName = useRunAsync(async () => {
    if (!subQueueId) return null;
    const rem = await plugin.rem.findOne(subQueueId);
    return rem?.text?.join('') || 'Document';
  }, [subQueueId]);

  const processHistoryData = (history: Record<string, ShieldHistoryEntry> | undefined) => {
    if (!history) return [];
    const unsortedData = Object.entries(history).map(([date, values]) => ({
      date: date,
      absolute: values.absolute,
      relative: values.percentile,
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

  // Fetch document-level data if in a document queue
  const docChartData = useRunAsync(async () => {
    if (!subQueueId) return null;
    const allDocHistory = (await plugin.storage.getSynced(documentPriorityShieldHistoryKey)) as Record<string, Record<string, ShieldHistoryEntry>>;
    return processHistoryData(allDocHistory?.[subQueueId]);
  }, [subQueueId]);

  // --- NEW: Flashcard Data ---
  const cardKbChartData = useRunAsync(async () => {
    const history = (await plugin.storage.getSynced(cardPriorityShieldHistoryKey)) as Record<string, ShieldHistoryEntry>;
    return processHistoryData(history);
  }, []);

  const cardDocChartData = useRunAsync(async () => {
    if (!subQueueId) return null;
    const allDocHistory = (await plugin.storage.getSynced(documentCardPriorityShieldHistoryKey)) as Record<string, Record<string, ShieldHistoryEntry>>;
    return processHistoryData(allDocHistory?.[subQueueId]);
  }, [subQueueId]);

  const renderChart = (data: ChartData[], title: string, color1: string, color2: string) => (
    <div className="mb-6">
      <h4 className="text-md font-semibold text-center mb-2">{title}</h4>
      <ResponsiveContainer width="100%" height={250} debounce={50}>
        <LineChart data={data} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          <YAxis yAxisId="left" orientation="left" stroke={color1} domain={[0, 100]} />
          <YAxis yAxisId="right" orientation="right" stroke={color2} domain={[0, 100]} tickFormatter={(tick) => `${tick}%`} />
          <Tooltip />
          <Legend />
          <Line yAxisId="left" type="monotone" dataKey="absolute" name="Absolute Priority (Higher is Better)" stroke={color1} />
          <Line yAxisId="right" type="monotone" dataKey="relative" name="Relative Priority (%) (Higher is Better)" stroke={color2} activeDot={{ r: 8 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );

  const hasKbData = kbChartData && kbChartData.length > 0;
  const hasDocData = docChartData && docChartData.length > 0;
  const hasCardKbData = cardKbChartData && cardKbChartData.length > 0;
  const hasCardDocData = cardDocChartData && cardDocChartData.length > 0;
  
  const numCharts = (subQueueId && hasDocData ? 1 : 0) + (hasKbData ? 1 : 0) + (subQueueId && hasCardDocData ? 1 : 0) + (hasCardKbData ? 1 : 0);
  const containerHeight = `${200 + numCharts * 350}px`;

  if (!hasKbData && !hasDocData && !hasCardKbData && !hasCardDocData) {
    return <div className="p-4">No history data found. Start reviewing to build your graph!</div>;
  }

  return (
    <div className="p-4 flex flex-col" style={{ width: '950px', height: containerHeight, overflowY: 'auto' }}>
      <h3 className="text-lg font-bold text-center mb-4">Priority Shield History</h3>
      
      {subQueueId && hasDocData && renderChart(docChartData!, `📄 ${documentName || 'Document'} IncRem Shield`, '#e74c3c', '#f39c12')}
      {hasKbData && renderChart(kbChartData, '🌍 Knowledge Base IncRem Shield', '#8884d8', '#82ca9d')}
      
      {(hasDocData || hasKbData) && (hasCardDocData || hasCardKbData) && <hr className="my-8 border-gray-400" />}

      {subQueueId && hasCardDocData && renderChart(cardDocChartData!, `🎴 ${documentName || 'Document'} Card Shield`, '#d35400', '#f1c40f')}
      {hasCardKbData && renderChart(cardKbChartData, '🌍 Knowledge Base Card Shield', '#c0392b', '#e67e22')}
      
      <p className="mt-4 text-sm rn-clr-content-secondary text-justify">
        {/* ... (Updated explanation text) ... */}
        <b>Priority Shield:</b> This metric represents your processing capacity for high-priority items. A higher shield value (closer to 100) means you are successfully reviewing your most important material on time.
        {subQueueId && hasDocData && (
          <>
            <br/><br/>
            <b>Document Shield:</b> Shows your priority protection within the current document/folder scope. This helps you track how well you're keeping up with the most important items in this specific context.
          </>
        )}
        <br/><br/><br/>
        <b>Absolute Priority</b> refers to the number set in the Incremental Rem priority property. 
        <br/><br/>
        <b>Relative Priority</b> <i>percentile</i> is the Rem's relative rank within the {subQueueId && hasDocData ? "respective scope" : "Knowledge Base"} (% of {subQueueId && hasDocData ? "scope" : "KB"}); this gives you a clearer metric for managing your learning load. 
        The higher the percentile of your Relative Priority shield, the more your top priority material is safeguarded and processed. 
        If your graph oscillates around priority of 4%, you will know that only top 4% of your learning material is guaranteed a timely repetition. 
        You can increase that number by doing more work, reducing inflow of new material, deprioritizing less important Incremental Rems, or reducing the randomization degree for the due Incremental Rems queue in the <b>Sorting Criteria</b> queue menu (the three-dot icon).
      </p>
    </div>
  );
}

renderWidget(PriorityShieldGraph);