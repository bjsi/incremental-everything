import { renderWidget, usePlugin, useRunAsync } from '@remnote/plugin-sdk';
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
import { priorityShieldHistoryKey } from '../lib/consts';
import dayjs from 'dayjs';

interface ShieldHistoryEntry {
  absolute: number | null;
  percentile: number | null;
}

function PriorityShieldGraph() {
  const plugin = usePlugin();

  const chartData = useRunAsync(async () => {
    const history = (await plugin.storage.getSynced(
      priorityShieldHistoryKey
    )) as Record<string, ShieldHistoryEntry>;

    if (!history) {
      return [];
    }

    // 1. Convert to an array first. The date is still the original "YYYY-MM-DD" string.
    const unsortedData = Object.entries(history).map(([date, values]) => ({
        date: date,
        absolute: values.absolute,
        relative: values.percentile,
      }));
      
    // 2. Sort the array using the valid, original date strings.
    const sortedData = unsortedData.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    
    // 3. NOW, format the date for display in the chart's X-axis.
    return sortedData.map(item => ({
        ...item,
        date: dayjs(item.date).format('MMM DD'),
    }));
    }, []);

  if (!chartData || chartData.length === 0) {
    return <div className="p-4">No history data found. Start reviewing to build your graph!</div>;
  }

  return (
    <div className="p-4 flex flex-col" style={{ width: '750px', height: '500px' }}>
              <h3 className="text-lg font-bold text-center mb-4">
        Priority Shield History (= Priority Protection)
      </h3>
      <ResponsiveContainer debounce={50}>
        <LineChart
          data={chartData}
          margin={{ top: 5, right: 30, left: 0, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          {/* vvv CHANGED: The 'reversed' property is removed from the left axis vvv */}
          <YAxis yAxisId="left" orientation="left" stroke="#8884d8" domain={[0, 100]} />
          {/* ^^^ CHANGED ^^^ */}
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke="#82ca9d"
            domain={[0, 100]}
            tickFormatter={(tick) => `${tick}%`}
            />
          <Tooltip />
          <Legend />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="absolute"
            // vvv CHANGED: Updated label vvv
            name="Absolute Priority (Higher is Better)"
            // ^^^ CHANGED ^^^
            stroke="#8884d8"
            activeDot={{ r: 8 }}
          />
          <Line
            yAxisId="right"
            type="monotone"
            // vvv CHANGED: Updated dataKey and label vvv
            dataKey="relative"
            name="Relative Priority (%) (Higher is Better)"
            // ^^^ CHANGED ^^^
            stroke="#82ca9d"
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="mt-4 text-sm rn-clr-content-secondary text-justify">
        <b>Priority Shield:</b> your processing capacity for high priority Incremental Rems on a given day. If your graph oscillates around priority of 3%, you will know that only top 3% of your learning material is guaranteed a timely repetition. You can increase that number by doing more work, reducing inflow of new material, deprioritizing less important Incremental Rems, or reducing the randomization degree for the due Incremental Rems queue in the Sorting Criteria.
      </p>
    </div>
  );
}

renderWidget(PriorityShieldGraph);