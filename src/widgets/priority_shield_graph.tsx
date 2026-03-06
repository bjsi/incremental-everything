import { renderWidget, usePlugin, useRunAsync, useTrackerPlugin } from '@remnote/plugin-sdk';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceArea,
} from 'recharts';
import { useState } from 'react';
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
  dismissedCount?: number;
}

interface ChartData {
  date: string;
  absolute: number | null;
  relative: number | null;
  universeSize: number; // NEW: Universe size for the chart
  dismissedCount?: number;
  totalUniverse?: number;
  processingPercentage?: number;
}

function PriorityShieldGraph() {
  const plugin = usePlugin();

  const [zoomState, setZoomState] = useState<Record<string, {
    startIndex: number | null;
    endIndex: number | null;
    refAreaLeft: string | null;
    refAreaRight: string | null;
    autoFit?: boolean;
  }>>({});

  const getZState = (title: string) => {
    return zoomState[title] || {
      startIndex: null,
      endIndex: null,
      refAreaLeft: null,
      refAreaRight: null,
      autoFit: false,
    };
  };

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
    if (!rem?.text) return 'Document';
    return await plugin.richText.toString(rem.text) || 'Document';
  }, [effectiveDocScopeId]);

  const processHistoryData = (history: Record<string, ShieldHistoryEntry> | undefined) => {
    if (!history) return [];
    const unsortedData = Object.entries(history).map(([date, values]) => {
      const universeSize = values.universeSize || 0;
      const isIncRem = 'dismissedCount' in values;

      const item: any = {
        date: date,
        absolute: values.absolute,
        relative: values.percentile,
        universeSize: universeSize,
      };

      if (isIncRem) {
        const dismissedCount = values.dismissedCount || 0;
        const totalUniverse = universeSize + dismissedCount;
        item.dismissedCount = dismissedCount;
        item.totalUniverse = totalUniverse;
        item.processingPercentage = totalUniverse > 0 ? (dismissedCount / totalUniverse) * 100 : 0;
      }
      return item;
    });

    const sortedData = unsortedData.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return sortedData.map(item => ({
      ...item,
      date: dayjs(item.date).format('MMM DD'),
    }));
  };

  // --- Incremental Rem Data ---
  const kbChartData = useRunAsync(async () => {
    const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
    const currentKbId = kbData?._id || 'global';
    const rawHistory = (await plugin.storage.getSynced(priorityShieldHistoryKey)) as any;

    if (!rawHistory) return [];

    // 1. Check for explicit KB partition
    if (rawHistory[currentKbId]) {
      return processHistoryData(rawHistory[currentKbId]);
    }

    // 2. Fallback to legacy (if keys are dates) - strict Primary KB check
    const keys = Object.keys(rawHistory);
    const isLegacy = keys.some(k => /^\d{4}-\d{2}-\d{2}$/.test(k));

    if (isLegacy) {
      const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
      if (isPrimary) {
        // Filter out non-date keys (e.g. other KB IDs in mixed state)
        const cleanLegacy: Record<string, ShieldHistoryEntry> = {};
        for (const k of keys) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
            cleanLegacy[k] = rawHistory[k];
          }
        }
        return processHistoryData(cleanLegacy);
      }
    }

    return [];
  }, []);

  // --- NEW: Fetch document-level data using effectiveDocScopeId ---
  const docChartData = useRunAsync(async () => {
    if (!effectiveDocScopeId) return null;
    const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
    const currentKbId = kbData?._id || 'global';
    const rawAllDocHistory = (await plugin.storage.getSynced(documentPriorityShieldHistoryKey)) as any;

    if (!rawAllDocHistory) return null;

    // 1. Check for explicit KB partition
    if (rawAllDocHistory[currentKbId]) {
      // Structure: { kbId: { scopeId: { date: entry } } }
      return processHistoryData(rawAllDocHistory[currentKbId][effectiveDocScopeId]);
    }

    // 2. Fallback to legacy (keys are scopeIds, values are {date: entry})
    // Check if our scope ID exists at root
    const potentialScopeData = rawAllDocHistory[effectiveDocScopeId];
    if (potentialScopeData) {
      // Verify it looks like history data (has date keys)
      const dateKeys = Object.keys(potentialScopeData);
      if (dateKeys.some(k => /^\d{4}-\d{2}-\d{2}$/.test(k))) {
        const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
        if (isPrimary) {
          return processHistoryData(potentialScopeData);
        }
      }
    }

    return null;
  }, [effectiveDocScopeId]);

  // --- Flashcard Data ---
  const cardKbChartData = useRunAsync(async () => {
    const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
    const currentKbId = kbData?._id || 'global';
    const rawHistory = (await plugin.storage.getSynced(cardPriorityShieldHistoryKey)) as any;

    if (!rawHistory) return [];

    // 1. Check for explicit KB partition
    if (rawHistory[currentKbId]) {
      return processHistoryData(rawHistory[currentKbId]);
    }

    // 2. Fallback to legacy
    const keys = Object.keys(rawHistory);
    const isLegacy = keys.some(k => /^\d{4}-\d{2}-\d{2}$/.test(k));

    if (isLegacy) {
      const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
      if (isPrimary) {
        const cleanLegacy: Record<string, ShieldHistoryEntry> = {};
        for (const k of keys) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
            cleanLegacy[k] = rawHistory[k];
          }
        }
        return processHistoryData(cleanLegacy);
      }
    }

    return [];
  }, []);

  // --- NEW: Fetch card document-level data using effectiveDocScopeId ---
  const cardDocChartData = useRunAsync(async () => {
    if (!effectiveDocScopeId) return null;
    const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
    const currentKbId = kbData?._id || 'global';
    const rawAllDocHistory = (await plugin.storage.getSynced(documentCardPriorityShieldHistoryKey)) as any;

    if (!rawAllDocHistory) return null;

    // 1. Check for explicit KB partition
    if (rawAllDocHistory[currentKbId]) {
      return processHistoryData(rawAllDocHistory[currentKbId][effectiveDocScopeId]);
    }

    // 2. Fallback to legacy
    const potentialScopeData = rawAllDocHistory[effectiveDocScopeId];
    if (potentialScopeData) {
      const dateKeys = Object.keys(potentialScopeData);
      if (dateKeys.some(k => /^\d{4}-\d{2}-\d{2}$/.test(k))) {
        const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
        if (isPrimary) {
          return processHistoryData(potentialScopeData);
        }
      }
    }

    return null;
  }, [effectiveDocScopeId]);

  // Custom tooltip to show all three values clearly
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0]?.payload;
      const isIncRem = data && 'dismissedCount' in data;

      return (
        <div className="bg-white p-2 border border-gray-300 rounded shadow text-sm tooltip-container">
          <p className="font-semibold mb-1">{`Date: ${label}`}</p>
          {payload.map((entry: any, index: number) => {
            if (entry.dataKey === 'absolute' || entry.dataKey === 'relative') {
              return (
                <p key={index} style={{ color: entry.color }}>
                  {`${entry.name}: ${entry.value !== null ?
                    (entry.dataKey === 'relative' ? `${entry.value}%` : entry.value)
                    : 'N/A'}`}
                </p>
              );
            }
            if (!isIncRem && entry.dataKey === 'universeSize') {
              return (
                <p key={index} style={{ color: entry.color }}>
                  {`${entry.name}: ${entry.value.toLocaleString()}`}
                </p>
              );
            }
            return null;
          })}

          {isIncRem && data && (
            <div className="mt-1 pt-1 border-t border-gray-100">
              <p style={{ color: '#10b981' }}>{`Universe of Incremental Rems: ${(data.universeSize || 0).toLocaleString()}`}</p>
              <p style={{ color: '#d97706' }}>{`Universe of Dismissed Rems: ${(data.dismissedCount || 0).toLocaleString()}`}</p>
              <p style={{ color: '#333' }} className="font-medium">{`Total Universe: ${(data.totalUniverse || 0).toLocaleString()}`}</p>
              <p className="text-[11px] text-gray-500 mt-1 uppercase tracking-wider">{`Processing: ${data.processingPercentage ? data.processingPercentage.toFixed(1) : 0}%`}</p>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  const renderChart = (data: ChartData[], title: string, color1: string, color2: string, color3: string) => {
    const isIncRemChart = title.includes('IncRem');
    const zState = getZState(title);

    const zoomOut = () => {
      setZoomState(prev => ({
        ...prev,
        [title]: {
          startIndex: null,
          endIndex: null,
          refAreaLeft: null,
          refAreaRight: null,
        }
      }));
    };

    const zoom = () => {
      let { refAreaLeft, refAreaRight } = zState;

      if (refAreaLeft === refAreaRight || !refAreaLeft || !refAreaRight) {
        setZoomState(prev => ({
          ...prev,
          [title]: { ...prev[title], refAreaLeft: null, refAreaRight: null }
        }));
        return;
      }

      let indexLeft = data.findIndex(d => d.date === refAreaLeft);
      let indexRight = data.findIndex(d => d.date === refAreaRight);

      if (indexLeft === -1 || indexRight === -1) {
        setZoomState(prev => ({
          ...prev,
          [title]: { ...prev[title], refAreaLeft: null, refAreaRight: null }
        }));
        return;
      }

      if (indexLeft > indexRight) {
        let temp = indexLeft;
        indexLeft = indexRight;
        indexRight = temp;
      }

      setZoomState(prev => ({
        ...prev,
        [title]: {
          ...prev[title],
          refAreaLeft: null,
          refAreaRight: null,
          startIndex: indexLeft,
          endIndex: indexRight,
        }
      }));
    };

    // Slice data based on zoom state
    let displayData = data;
    if (typeof zState.startIndex === 'number' && typeof zState.endIndex === 'number') {
      displayData = data.slice(zState.startIndex, zState.endIndex + 1);
    }

    // Find the maximum universe size for better y-axis scaling based on visible data
    const maxUniverse = Math.max(...displayData.map(d => isIncRemChart && d.totalUniverse !== undefined ? d.totalUniverse : (d.universeSize || 0)));
    const universeAxisMax = Math.ceil(maxUniverse * 1.1) || 10; // Add 10% padding

    let absoluteMin = 0;
    let absoluteMax = 100;
    let relativeMin = 0;
    let relativeMax = 100;

    if (zState.autoFit && displayData.length > 0) {
      const absValues = displayData.map(d => d.absolute).filter((v): v is number => v !== null);
      const relValues = displayData.map(d => d.relative).filter((v): v is number => v !== null);

      const allValues = [...absValues, ...relValues];

      if (allValues.length > 0) {
        const globalMin = Math.max(0, Math.floor(Math.min(...allValues) - 5));
        let globalMax = Math.min(100, Math.ceil(Math.max(...allValues) + 5));

        if (globalMax === globalMin) {
          globalMax = Math.min(100, globalMax + 5);
        }

        absoluteMin = globalMin;
        absoluteMax = globalMax;
        relativeMin = globalMin;
        relativeMax = globalMax;
      }
    }

    const toggleAutoFit = () => {
      setZoomState(prev => ({
        ...prev,
        [title]: { ...getZState(title), autoFit: !getZState(title).autoFit }
      }));
    };

    return (
      <div
        className="mb-6 relative"
        style={{ userSelect: 'none' }}
        onDragStart={(e) => e.preventDefault()}
      >
        <h4 className="text-md font-semibold text-center mb-2 mt-2">{title}</h4>

        <div className="absolute top-0 right-4 flex gap-2 z-10 justify-end items-center pointer-events-auto w-max" style={{ top: '6px' }}>
          <button
            className="rn-button rn-button--secondary shadow-sm relative"
            style={{ margin: 0, fontSize: '11px', minHeight: '22px', padding: '0 8px' }}
            onClick={toggleAutoFit}
          >
            {zState.autoFit ? 'Reset Y-Axis' : 'Optimize Priorities Zoom'}
          </button>

          {zState.startIndex !== null && (
            <button
              className="rn-button rn-button--secondary shadow-sm relative"
              style={{ margin: 0, fontSize: '11px', minHeight: '22px', padding: '0 8px' }}
              onClick={zoomOut}
            >
              Reset Data Range
            </button>
          )}
        </div>

        <ResponsiveContainer width="100%" height={300} debounce={50}>
          <ComposedChart
            data={displayData}
            margin={{ top: 5, right: 50, left: 10, bottom: 5 }}
            onMouseDown={(e: any) => {
              if (e && e.activeLabel) {
                const current = getZState(title);
                setZoomState(prev => ({
                  ...prev,
                  [title]: {
                    ...current,
                    refAreaLeft: e.activeLabel,
                    refAreaRight: e.activeLabel
                  }
                }));
              }
            }}
            onMouseMove={(e: any) => {
              const current = getZState(title);
              if (current.refAreaLeft && e && e.activeLabel && e.activeLabel !== current.refAreaRight) {
                setZoomState(prev => ({ ...prev, [title]: { ...current, refAreaRight: e.activeLabel } }));
              }
            }}
            onMouseUp={zoom}
            onMouseLeave={() => {
              if (zState.refAreaLeft) zoom();
            }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />

            {/* Left Y-axis for Absolute Priority */}
            <YAxis
              yAxisId="left"
              orientation="left"
              stroke={color1}
              domain={[absoluteMin, absoluteMax]}
              allowDataOverflow
              width={30}
            />

            {/* Right Y-axis for Relative Priority % */}
            <YAxis
              yAxisId="middle"
              orientation="right"
              stroke={color2}
              domain={[relativeMin, relativeMax]}
              allowDataOverflow
              tickFormatter={(tick) => `${tick}%`}
              width={60}
            />

            {/* Far-right Y-axis for Universe Size */}
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke={color3}
              domain={[0, universeAxisMax]}
              allowDataOverflow
              tickFormatter={(value) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toString()}
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

            {isIncRemChart ? (
              <>
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="universeSize"
                  name="Universe Size (IncRems)"
                  stackId="1"
                  stroke="#10b981"
                  fill="transparent"
                  strokeWidth={2}
                  animationDuration={300}
                />
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="dismissedCount"
                  name="Dismissed Rems"
                  stackId="1"
                  stroke="#333"
                  fill="rgba(250, 204, 21, 0.4)"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  animationDuration={300}
                />
              </>
            ) : (
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="universeSize"
                name="Universe Size"
                stroke={color3}
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={{ r: 3 }}
                animationDuration={300}
              />
            )}

            {zState.refAreaLeft && zState.refAreaRight ? (
              <ReferenceArea
                yAxisId="left"
                x1={zState.refAreaLeft}
                x2={zState.refAreaRight}
                strokeOpacity={0.3}
                fill="#8884d8"
              />
            ) : null}
          </ComposedChart>
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
      {effectiveDocScopeId && hasCardDocData && renderChart(
        cardDocChartData!,
        `📄 ${documentName || 'Document'} Card Shield`,
        '#d35400', '#f1c40f', '#16a085'
      )}

      {(hasDocData || hasCardDocData) && (hasKbData || hasCardKbData) && (
        <div style={{ height: '2px', backgroundColor: 'var(--rn-clr-border-opaque)', margin: '32px 0' }} />
      )}

      {hasKbData && renderChart(
        kbChartData,
        '🌐 Knowledge Base IncRem Shield',
        '#8884d8', '#82ca9d', '#e91e63'
      )}
      {hasCardKbData && renderChart(
        cardKbChartData,
        '🌐 Knowledge Base Card Shield',
        '#c0392b', '#e67e22', '#2980b9'
      )}

      <div className="mt-4 text-sm rn-clr-content-secondary text-justify">
        <p className="mb-3">
          <b>Graph Controls:</b> Click and drag on any graph to zoom into a specific period. Use the "Optimize Priorities Zoom" button to perfectly frame the vertical priority lines within your zoomed date range. A "Reset" button will appear in the top-right corner to return to the full view.
        </p>

        <p className="mb-3">
          <b>Priority Shield:</b> This metric represents your processing capacity for high-priority items. A higher shield value (closer to 100) means you are successfully reviewing your most important material on time.
        </p>

        {effectiveDocScopeId && hasDocData && (
          <p className="mb-3">
            <b>Document Shield:</b> Shows your priority protection within {originalScopeId ? 'the original document scope (for Priority Review Documents)' : 'the current document/folder scope'}. This helps you track how well you're keeping up with the most important items in this specific context.
          </p>
        )}

        <p className="mb-3">
          <b>Universe Size:</b> This metric is represented differently depending on the graph type:
          <ul className="list-disc pl-5 mt-1">
            <li><b>For Incremental Rems:</b> The chart tracks your processing lifecycle using three layered components:<br />
              - <b>Total Universe (Black dashed line):</b> The absolute maximum volume of material you have managed in this scope (Active + Dismissed).<br />
              - <b>Active Universe (Green line):</b> The physical volume of IncRems currently in your queue awaiting review.<br />
              - <b>Dismissed Area (Yellow shading):</b> The accumulated volume of material you have permanently marked with the `dismissed` powerup. The wider this area gets, the more backlog you've cleared!</li>
            <li><b>For Cards:</b> It shows the <b>Universe Size (Dashed line)</b>, which is the total number of Rems with Cards. <i>Note:</i> The universe shown in the Card Shield is the number of <i>Rems</i> with cards, which is different from the total number of <i>flashcards</i> shown in other RemNote UI (since a single Rem can generate several flashcards). The `cardPriority` powerup is assigned per rem, not per individual flashcard.</li>
          </ul>
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
          For <b>Incremental Rems</b>, tracking the visual layers paints a clear picture of your workflow:
          <ul className="list-disc pl-5 mt-1">
            <li>If the <b>Active Universe (Green)</b> drops but the <b>Total Universe (Black)</b> remains steady and the <b>Dismissed Area (Yellow)</b> expands, you are efficiently processing and dismissing items faster than you add them!</li>
            <li>If the <b>Active Universe (Green)</b> climbs while the <b>Dismissed Area (Yellow)</b> stays flat, you are continuously adding new IncRems without clearing older ones. This influx automatically lowers your priority shield percentiles, as each item is now a smaller percentage of a larger workload.</li>
            <li>If the <b>Total Universe (Black)</b> drops natively, it means you have physically structurally deleted IncRems from your Knowledge Base, or fully removed the `Incremental` tag spanning outside the `Dismissed` review queue standard logic.</li>
          </ul>
          <br></br>
          For <b>Flashcards</b>, this number will usually only increase (unless you delete cards). The evolution will show you the size of your knowledge (considering you keep control of your due cards).
        </p>
      </div>
    </div>
  );
}

renderWidget(PriorityShieldGraph);
