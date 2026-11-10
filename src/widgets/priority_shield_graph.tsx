import { renderWidget, usePlugin, useRunAsync, useTrackerPlugin } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
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
import { CSSProperties, useEffect, useRef, useState } from 'react';
import {
  priorityShieldHistoryKey,
  documentPriorityShieldHistoryKey,
  cardPriorityShieldHistoryKey,
  documentCardPriorityShieldHistoryKey,
  priorityShieldGraphPrefsKey,
} from '../lib/consts';
import dayjs from 'dayjs';
import { IE_DOCS_BASE_URL } from '../lib/settings';
import {
  CardRow,
  GraphHistory,
  IncRemRow,
  PriorityRow,
  buildCardRows,
  buildIncRemRows,
  buildPriorityRows,
} from '../lib/shield_graph_data';

const DOCS_PATH = 'Prioritization-%26-Sorting/#priority-shield-history';

/**
 * Opens the docs section for this graph. `window.open` is blocked in some
 * embedded contexts, so fall back to a synthesised anchor click — same helper
 * shape as the IE Settings popup.
 */
const openDocs = () => {
  const url = `${IE_DOCS_BASE_URL}${DOCS_PATH}`;
  const opened = window.open(url, '_blank');
  if (!opened || opened.closed) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => document.body.removeChild(link), 100);
  }
};

type TimePeriod = 'month' | '3m' | '6m' | 'year' | 'all';

const TIME_PERIOD_OPTIONS: { value: TimePeriod; label: string }[] = [
  { value: 'month', label: '1M' },
  { value: '3m', label: '3M' },
  { value: '6m', label: '6M' },
  { value: 'year', label: '1Y' },
  { value: 'all', label: 'All' },
];

const PERIOD_TO_DAYS: Record<TimePeriod, number | null> = {
  month: 30,
  '3m': 90,
  '6m': 180,
  year: 365,
  all: null,
};

type ChartKind = 'priority' | 'card' | 'incRem';
type Dated<T> = T & { date: string };
type AnyRow = Dated<PriorityRow> | Dated<CardRow> | Dated<IncRemRow>;
type ScopeTab = 'kb' | 'doc';

/**
 * Every axis takes the colour of the series it measures; an axis holding a
 * stack of several series (the universes) is neutral grey.
 */
const PRIORITY_COLORS = { absolute: '#2b6cb0', relative: '#0d9488' };
const INCREM_COLORS = { absolute: '#8884d8' };
const CARD_COLORS = {
  kb: { absolute: '#c0392b', relative: '#e67e22', universe: '#2980b9' },
  doc: { absolute: '#d35400', relative: '#f1c40f', universe: '#16a085' },
};
const WEIGHTED_COLOR = '#ff6b6b';
const UNIVERSE_AXIS_COLOR = '#888888';
const CARDS_BAND = { stroke: '#c8902f', fill: 'rgba(200, 144, 47, 0.18)' };
const INCREMS_BAND = { stroke: '#10b981', fill: 'rgba(16, 185, 129, 0.18)' };
const DISMISSED_BAND = { stroke: '#333', fill: 'rgba(250, 204, 21, 0.4)' };

/**
 * Inline, not Tailwind: `bg-white` has no rule in the popup's CSS, so the box
 * came out transparent. Opaque theme background, above the next chart.
 */
const TOOLTIP_BOX: CSSProperties = {
  background: 'var(--rn-clr-background-primary, #fff)',
  border: '1px solid var(--rn-clr-border-opaque, #d1d5db)',
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
};

const fmtCount = (v: number | null | undefined) => (v || 0).toLocaleString();
const fmtP = (v: number | null | undefined) => (v === null || v === undefined ? 'N/A' : v);
const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? 'N/A' : `${v}%`);

function withDateLabels<T extends { originalDate: string }>(rows: T[]): Dated<T>[] {
  return rows.map((r) => ({ ...r, date: dayjs(r.originalDate).format('MMM DD') }));
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

  const [showWeightedShield, setShowWeightedShield] = useState(false);
  const [timePeriod, setTimePeriod] = useState<TimePeriod>('3m');
  const [scopeTab, setScopeTab] = useState<ScopeTab>('doc');

  // Hydrate { showWeightedShield, timePeriod } from device-local storage on
  // mount, then persist on every change. The ref-gate prevents the persist
  // effect from clobbering the saved value with the default before hydration
  // completes. Same pattern used by the Study Dashboard and the analytics tab.
  const prefsHydratedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    plugin.storage
      .getLocal<{ showWeightedShield?: boolean; timePeriod?: TimePeriod } | null>(
        priorityShieldGraphPrefsKey
      )
      .then((saved) => {
        if (cancelled) return;
        if (typeof saved?.showWeightedShield === 'boolean') {
          setShowWeightedShield(saved.showWeightedShield);
        }
        if (saved?.timePeriod && saved.timePeriod in PERIOD_TO_DAYS) {
          setTimePeriod(saved.timePeriod);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) prefsHydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [plugin]);

  useEffect(() => {
    if (!prefsHydratedRef.current) return;
    plugin.storage
      .setLocal(priorityShieldGraphPrefsKey, { showWeightedShield, timePeriod })
      .catch(() => {});
  }, [plugin, showWeightedShield, timePeriod]);

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

  // In a Priority Review Document, the document scope is the original one.
  const originalScopeId = useTrackerPlugin(
    (rp) => rp.storage.getSession<string | null>('originalScopeId'),
    []
  );
  const effectiveDocScopeId = originalScopeId || subQueueId;

  const documentName = useRunAsync(async () => {
    if (!effectiveDocScopeId) return null;
    const rem = await plugin.rem.findOne(effectiveDocScopeId);
    if (!rem?.text) return 'Document';
    return await plugin.richText.toString(rem.text) || 'Document';
  }, [effectiveDocScopeId]);

  /**
   * One KB's history from a KB-partitioned key ({ kbId: { date: entry } }),
   * or from the legacy unpartitioned shape (date keys at the root), which
   * belongs to the primary KB only.
   */
  const loadKbHistory = async (key: string): Promise<GraphHistory | null> => {
    const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
    const currentKbId = kbData?._id || 'global';
    const raw = (await plugin.storage.getSynced(key)) as any;
    if (!raw) return null;
    if (raw[currentKbId]) return raw[currentKbId];
    const keys = Object.keys(raw);
    if (keys.some((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)) && (await plugin.kb.isPrimaryKnowledgeBase())) {
      const clean: GraphHistory = {};
      for (const k of keys) if (/^\d{4}-\d{2}-\d{2}$/.test(k)) clean[k] = raw[k];
      return clean;
    }
    return null;
  };

  /** One scope's history: { kbId: { scopeId: { date: entry } } }, or legacy { scopeId: { date: entry } }. */
  const loadDocHistory = async (key: string, scopeId: string): Promise<GraphHistory | null> => {
    const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
    const currentKbId = kbData?._id || 'global';
    const raw = (await plugin.storage.getSynced(key)) as any;
    if (!raw) return null;
    if (raw[currentKbId]) return raw[currentKbId][scopeId] ?? null;
    const legacy = raw[scopeId];
    if (
      legacy &&
      Object.keys(legacy).some((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)) &&
      (await plugin.kb.isPrimaryKnowledgeBase())
    ) {
      return legacy;
    }
    return null;
  };

  const kbIncHistory = useRunAsync(() => loadKbHistory(priorityShieldHistoryKey), []);
  const kbCardHistory = useRunAsync(() => loadKbHistory(cardPriorityShieldHistoryKey), []);
  const docIncHistory = useRunAsync(
    async () => (effectiveDocScopeId ? loadDocHistory(documentPriorityShieldHistoryKey, effectiveDocScopeId) : null),
    [effectiveDocScopeId]
  );
  const docCardHistory = useRunAsync(
    async () => (effectiveDocScopeId ? loadDocHistory(documentCardPriorityShieldHistoryKey, effectiveDocScopeId) : null),
    [effectiveDocScopeId]
  );

  const filterByPeriod = <T extends { originalDate: string }>(data: T[], period: TimePeriod): T[] => {
    if (data.length === 0) return [];
    const days = PERIOD_TO_DAYS[period];
    if (days === null) return data;
    const cutoff = dayjs().subtract(days, 'day').startOf('day');
    const filtered = data.filter((d) => dayjs(d.originalDate).isAfter(cutoff));
    // If the period filter removes everything (e.g. very old data), fall back to full data
    return filtered.length > 0 ? filtered : data;
  };

  const scopeCharts = (inc: GraphHistory | null | undefined, card: GraphHistory | null | undefined) => ({
    priority: withDateLabels(filterByPeriod(buildPriorityRows(inc, card), timePeriod)),
    card: withDateLabels(filterByPeriod(buildCardRows(card), timePeriod)),
    incRem: withDateLabels(filterByPeriod(buildIncRemRows(inc), timePeriod)),
  });
  const kb = scopeCharts(kbIncHistory, kbCardHistory);
  const doc = scopeCharts(effectiveDocScopeId ? docIncHistory : null, effectiveDocScopeId ? docCardHistory : null);
  const hasAny = (s: typeof kb) => s.priority.length > 0 || s.card.length > 0 || s.incRem.length > 0;
  const hasKbData = hasAny(kb);
  const hasDocData = !!effectiveDocScopeId && hasAny(doc);
  const showTabs = hasKbData && hasDocData;
  const activeScope: ScopeTab = showTabs ? scopeTab : hasDocData ? 'doc' : 'kb';

  // Focus the container once the tabs appear, so ← → work without a click first.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showTabs) containerRef.current?.focus({ preventScroll: true });
  }, [showTabs]);

  // --- Tooltips: read straight from the hovered row, in the series' colours ---

  const PriorityTooltip = ({ active, payload, label }: any) => {
    const d: PriorityRow | undefined = active ? payload?.[0]?.payload : undefined;
    if (!d) return null;
    const absolute = d.rebuilt ? d.absoluteRebuilt : d.absolute;
    return (
      <div className="p-2 rounded text-sm" style={TOOLTIP_BOX}>
        <p className="font-semibold mb-1">{`Date: ${label}`}</p>
        <p style={{ color: PRIORITY_COLORS.absolute }}>
          {`Absolute Priority: ${fmtP(absolute)}`}
          {d.rebuilt && ' (rebuilt)'}
        </p>
        <p className="text-[12px]" style={{ color: PRIORITY_COLORS.absolute, opacity: 0.8 }}>
          {`IncRem side: ${fmtP(d.incRemAbsolute)} · Card side: ${fmtP(d.cardAbsolute)}`}
        </p>
        <p style={{ color: PRIORITY_COLORS.relative }}>{`Relative Priority: ${fmtPct(d.relative)}`}</p>
        {showWeightedShield && (
          <p style={{ color: WEIGHTED_COLOR }}>{`Weighted Shield: ${fmtPct(d.weightedShield)}`}</p>
        )}
        <div className="mt-1 pt-1 border-t border-gray-100">
          <p style={{ color: CARDS_BAND.stroke }}>{`Cards: ${fmtCount(d.cardUniverse)}`}</p>
          <p style={{ color: INCREMS_BAND.stroke }}>{`IncRems: ${fmtCount(d.incRemUniverse)}`}</p>
          <p className="font-medium" style={{ color: PRIORITY_COLORS.absolute }}>
            {`Priority Shield universe (IncRems + Cards): ${fmtCount(d.unifiedUniverse)}`}
          </p>
          <p style={{ color: DISMISSED_BAND.stroke }}>{`Dismissed Rems (outside the shield): ${fmtCount(d.dismissedCount)}`}</p>
        </div>
        {d.rebuilt && (
          <p className="text-[11px] text-gray-500 mt-1" style={{ maxWidth: 320 }}>
            Rebuilt from the IncRem and Card Shield histories: the lower of the two sides, and their universes
            added up. Relative and weighted values were not recorded before v1.0.193.
          </p>
        )}
      </div>
    );
  };

  const CardTooltip = ({ active, payload, label }: any) => {
    const d: CardRow | undefined = active ? payload?.[0]?.payload : undefined;
    if (!d) return null;
    const colors = CARD_COLORS[activeScope];
    return (
      <div className="p-2 rounded text-sm" style={TOOLTIP_BOX}>
        <p className="font-semibold mb-1">{`Date: ${label}`}</p>
        <p style={{ color: colors.absolute }}>{`Absolute Priority: ${fmtP(d.absolute)}`}</p>
        <p style={{ color: colors.relative }}>{`Relative Priority (%): ${fmtPct(d.relative)}`}</p>
        {showWeightedShield && d.weightedShield !== null && (
          <p style={{ color: WEIGHTED_COLOR }}>{`Weighted Shield (%): ${fmtPct(d.weightedShield)}`}</p>
        )}
        <p style={{ color: colors.universe }}>{`Universe Size: ${fmtCount(d.universeSize)}`}</p>
      </div>
    );
  };

  const IncRemTooltip = ({ active, payload, label }: any) => {
    const d: IncRemRow | undefined = active ? payload?.[0]?.payload : undefined;
    if (!d) return null;
    return (
      <div className="p-2 rounded text-sm" style={TOOLTIP_BOX}>
        <p className="font-semibold mb-1">{`Date: ${label}`}</p>
        <p style={{ color: INCREM_COLORS.absolute }}>{`Absolute Priority: ${fmtP(d.absolute)}`}</p>
        <div className="mt-1 pt-1 border-t border-gray-100">
          <p style={{ color: INCREMS_BAND.stroke }}>{`Universe of Incremental Rems: ${fmtCount(d.universeSize)}`}</p>
          <p style={{ color: DISMISSED_BAND.stroke }}>{`Universe of Dismissed Rems: ${fmtCount(d.dismissedCount)}`}</p>
          <p className="font-medium" style={{ color: DISMISSED_BAND.stroke }}>{`IncRems + Dismissed: ${fmtCount(d.totalUniverse)}`}</p>
          <p className="text-[11px] text-gray-500 uppercase tracking-wider">{`Processing: ${d.processingPercentage.toFixed(1)}%`}</p>
        </div>
      </div>
    );
  };

  const kFormatter = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toString());

  const renderChart = (kind: ChartKind, data: AnyRow[], title: string) => {
    if (data.length === 0) return null;
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
        const temp = indexLeft;
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

    // The universe axis spans the top of the stack (or the single line).
    const universeTop = (d: AnyRow): number =>
      kind === 'priority' ? (d as PriorityRow).unifiedUniverse + (d as PriorityRow).dismissedCount
      : kind === 'incRem' ? (d as IncRemRow).totalUniverse
      : (d as CardRow).universeSize;
    const maxUniverse = Math.max(0, ...displayData.map(universeTop));
    const universeAxisMax = Math.ceil(maxUniverse * 1.1) || 10; // Add 10% padding

    let absoluteMin = 0;
    let absoluteMax = 100;
    let relativeMin = 0;
    let relativeMax = 100;

    if (zState.autoFit && displayData.length > 0) {
      const values: (number | null | undefined)[] = [];
      for (const d of displayData) {
        values.push((d as any).absolute);
        if (kind === 'priority') values.push((d as PriorityRow).absoluteRebuilt);
        if (kind !== 'incRem') values.push((d as PriorityRow | CardRow).relative);
      }
      const allValues = values.filter((v): v is number => v !== null && v !== undefined);

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

    const cardColors = CARD_COLORS[activeScope];
    const absoluteColor =
      kind === 'priority' ? PRIORITY_COLORS.absolute : kind === 'card' ? cardColors.absolute : INCREM_COLORS.absolute;
    const relativeColor = kind === 'priority' ? PRIORITY_COLORS.relative : cardColors.relative;
    const universeAxisColor = kind === 'card' ? cardColors.universe : UNIVERSE_AXIS_COLOR;
    const hasRebuilt = kind === 'priority' && displayData.some((d) => (d as PriorityRow).rebuilt);

    const tooltip =
      kind === 'priority' ? <PriorityTooltip /> : kind === 'card' ? <CardTooltip /> : <IncRemTooltip />;

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

            {/* Left Y-axis: Absolute Priority */}
            <YAxis
              yAxisId="left"
              orientation="left"
              stroke={absoluteColor}
              domain={[absoluteMin, absoluteMax]}
              allowDataOverflow
              width={30}
            />

            {/* Right Y-axis: Relative Priority % (and the Weighted Shield) */}
            {kind !== 'incRem' && (
              <YAxis
                yAxisId="middle"
                orientation="right"
                stroke={relativeColor}
                domain={[relativeMin, relativeMax]}
                allowDataOverflow
                tickFormatter={(tick) => `${tick}%`}
                width={60}
              />
            )}

            {/* Far-right Y-axis: Universe Size */}
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke={universeAxisColor}
              domain={[0, universeAxisMax]}
              allowDataOverflow
              tickFormatter={kFormatter}
              width={45}
              tick={{ fontSize: 11 }}
            />

            <Tooltip content={tooltip} wrapperStyle={{ zIndex: 1000 }} />
            <Legend wrapperStyle={{ paddingTop: '10px' }} />

            {/* Universe layers first, so the priority lines draw over them.
                Stacked bottom to top in the order declared. */}
            {kind === 'priority' && (
              <>
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="cardUniverse"
                  name="Cards"
                  stackId="universe"
                  stroke={CARDS_BAND.stroke}
                  fill={CARDS_BAND.fill}
                  strokeWidth={1.5}
                  animationDuration={300}
                />
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="incRemUniverse"
                  name="IncRems"
                  stackId="universe"
                  stroke={INCREMS_BAND.stroke}
                  fill={INCREMS_BAND.fill}
                  strokeWidth={1.5}
                  animationDuration={300}
                />
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="dismissedCount"
                  name="Dismissed Rems"
                  stackId="universe"
                  stroke={DISMISSED_BAND.stroke}
                  fill={DISMISSED_BAND.fill}
                  strokeWidth={1.5}
                  strokeDasharray="5 5"
                  animationDuration={300}
                />
              </>
            )}

            {kind === 'incRem' && (
              <>
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="universeSize"
                  name="Universe Size (IncRems)"
                  stackId="universe"
                  stroke={INCREMS_BAND.stroke}
                  fill="transparent"
                  strokeWidth={2}
                  animationDuration={300}
                />
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="dismissedCount"
                  name="Dismissed Rems"
                  stackId="universe"
                  stroke={DISMISSED_BAND.stroke}
                  fill={DISMISSED_BAND.fill}
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  animationDuration={300}
                />
              </>
            )}

            {kind === 'card' && (
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="universeSize"
                name="Universe Size"
                stroke={cardColors.universe}
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={{ r: 3 }}
                animationDuration={300}
              />
            )}

            <Line
              yAxisId="left"
              type="monotone"
              dataKey="absolute"
              name="Absolute Priority"
              stroke={absoluteColor}
              strokeWidth={2}
              dot={{ r: 3 }}
            />

            {hasRebuilt && (
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="absoluteRebuilt"
                name="Absolute Priority (rebuilt)"
                legendType="none"
                stroke={absoluteColor}
                strokeOpacity={0.6}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
              />
            )}

            {kind !== 'incRem' && (
              <Line
                yAxisId="middle"
                type="monotone"
                dataKey="relative"
                name="Relative Priority (%)"
                stroke={relativeColor}
                strokeWidth={2}
                activeDot={{ r: 6 }}
                dot={{ r: 3 }}
              />
            )}

            {kind !== 'incRem' && showWeightedShield && (
              <Line
                yAxisId="middle"
                type="monotone"
                dataKey="weightedShield"
                name="Weighted Shield (%)"
                stroke={WEIGHTED_COLOR}
                strokeWidth={2}
                strokeDasharray="8 4"
                dot={{ r: 2 }}
                connectNulls
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

  if (!hasKbData && !hasDocData) {
    return <div className="p-4">No history data found. Start reviewing to build your graph!</div>;
  }

  const scopeLabel = activeScope === 'doc' ? `📄 ${documentName || 'Document'}` : '🌐 Knowledge Base';
  const charts = activeScope === 'doc' ? doc : kb;
  const tabs: { id: ScopeTab; label: string }[] = [
    { id: 'kb', label: '🌐 Knowledge Base' },
    { id: 'doc', label: `📄 ${documentName || 'Document'}` },
  ];

  return (
    <div
      ref={containerRef}
      className="p-4 flex flex-col"
      style={{ width: '1030px', outline: 'none' }}
      tabIndex={-1}
      onKeyDown={(e) => {
        // Arrows switch the scope tab; keys live on the container (popups are keyboard-driven).
        if (!showTabs || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
        e.preventDefault();
        setScopeTab((t) => (t === 'kb' ? 'doc' : 'kb'));
      }}
    >
      <div className="flex flex-col items-center mb-6 relative">
        <h3 className="text-lg font-bold">Priority Shield History</h3>
        <button
          onClick={openDocs}
          title="Open the documentation for Priority Shield History"
          className="rounded-full w-6 h-6 flex items-center justify-center hover:opacity-75"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))',
            color: 'var(--rn-clr-content-secondary)',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          ?
        </button>
        <div className="flex items-center gap-4 mt-2 text-sm flex-wrap justify-center" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showWeightedShield}
              onChange={(e) => setShowWeightedShield(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Show Weighted Shield
          </label>
          <div className="flex items-center gap-2 select-none" role="radiogroup" aria-label="Time period">
            <span className="text-xs uppercase tracking-wider opacity-70">Period:</span>
            {TIME_PERIOD_OPTIONS.map(opt => (
              <label key={opt.value} className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="time-period"
                  value={opt.value}
                  checked={timePeriod === opt.value}
                  onChange={() => {
                    setTimePeriod(opt.value);
                    setZoomState({});
                  }}
                  style={{ cursor: 'pointer' }}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      {showTabs && (
        <div
          role="tablist"
          aria-label="Scope"
          className="flex justify-center gap-1 mb-4"
          style={{ borderBottom: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))' }}
          title="← → to switch"
        >
          {tabs.map((t) => {
            const selected = activeScope === t.id;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={selected}
                onClick={() => setScopeTab(t.id)}
                className="px-4 py-1.5 text-sm"
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: `2px solid ${selected ? 'var(--rn-clr-content-accent, #3b82f6)' : 'transparent'}`,
                  marginBottom: '-1px',
                  fontWeight: selected ? 600 : 400,
                  color: selected ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-secondary)',
                  cursor: 'pointer',
                  maxWidth: 420,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      {renderChart('priority', charts.priority, `${scopeLabel} Priority Shield — IncRems + Cards`)}
      {renderChart('card', charts.card, `${scopeLabel} Card Shield — Cards only`)}
      {renderChart('incRem', charts.incRem, `${scopeLabel} IncRem Shield — IncRems only`)}

      <div className="mt-4 text-sm rn-clr-content-secondary text-justify">
        <p className="mb-3">
          <b>Graph Controls:</b> Click and drag on any graph to zoom into a specific period. Use the "Optimize Priorities Zoom" button to perfectly frame the vertical priority lines within your zoomed date range. A "Reset" button will appear in the top-right corner to return to the full view.
          {showTabs && ' The tabs (or ← →) switch between the Knowledge Base and the document.'}
        </p>

        <p className="mb-3">
          <b>Shields:</b> A shield is the priority of the most important item still due. A higher value (closer to 100) means you are reviewing your most important material on time. Three charts, one per universe:
        </p>

        <ul className="list-disc pl-5 mb-3">
          <li className="mb-1">
            <b>Priority Shield — IncRems + Cards</b> ranks your Incremental Rems and your cards together by absolute priority, one element each (a Rem with three cards counts three), so its percentile says how much of your whole top-priority material is protected. Its absolute value is the lower of two sides, both in the tooltip: the IncRem side and the card side. Days before v1.0.193 are <i>rebuilt</i> from the other two charts (thin dashed line): the lower of their absolute values, and their universes added up. Their relative and weighted values were never recorded, so those lines start at v1.0.193.
          </li>
          <li className="mb-1">
            <b>Card Shield — Cards only</b> ranks only your cards: the retention view on its own.
          </li>
          <li>
            <b>IncRem Shield — IncRems only</b> follows the top missed Incremental Rem and your reading backlog. It shows no percentile: dismissing an IncRem takes it out of this universe, so its rank would move without any review.
          </li>
        </ul>

        {hasDocData && (
          <p className="mb-3">
            <b>Document scope:</b> the same three charts within {originalScopeId ? 'the original document scope (for Priority Review Documents)' : 'the current document/folder scope'}, to track how well you're keeping up with the most important items in this specific context.
          </p>
        )}

        <div className="mb-3">
          <p>
            <b>Universe Size</b> is drawn on the far-right axis:
          </p>
          <ul className="list-disc pl-5 mt-1">
            <li><b>Priority Shield:</b> stacked bands — <b>Cards</b> at the bottom, <b>IncRems</b> above them (the top of this band is the shield's own universe), and <b>Dismissed Rems</b> on top. Dismissed Rems are outside the shield: they need no more reading, and their remaining work is in their cards, which are already counted.</li>
            <li><b>IncRem Shield:</b> the <b>Active Universe (green line)</b> is the IncRems awaiting review; the <b>Dismissed Area (yellow)</b> stacked on it is what you have marked with the `dismissed` powerup, and its top (<b>black dashed line</b>) is everything you have managed.</li>
            <li><b>Card Shield:</b> the <b>Universe Size (dashed line)</b> is the total number of <i>cards</i> in scope (a Rem owning N cards contributes N). <i>Note:</i> points stored before v1.0.65 (2026-08-28) used a per-Rem-with-cards universe, so expect a one-time step on the day you upgraded to it.</li>
          </ul>
        </div>

        <p className="mb-3">
          <b>Absolute Priority</b> refers to the number set in the Incremental Rem or Flashcard priority property.
        </p>

        <p className="mb-3">
          <b>Relative Priority</b> <i>percentile</i> is the item's relative rank within the {hasDocData ? 'respective scope' : 'Knowledge Base'}; this gives you a clearer metric for managing your learning load.
          The higher the percentile of your Relative Priority shield, the more your top priority material is safeguarded and processed.
          If your graph oscillates around priority of 4%, you will know that only top 4% of your learning material is guaranteed a timely repetition.
          You can increase that number by doing more work, reducing inflow of new material, deprioritizing less important Incremental Rems / Flashcards, or reducing the randomization degree for the due Incremental Rems queue / Flashcards queue in the <b>Sorting Criteria</b> queue menu (the three-dot icon).
        </p>

        <p className="mb-3">
          <b>Weighted Shield</b> (⚖️) measures the fraction of your total priority-weighted workload that has been processed. Each item is weighted exponentially by priority: high-priority items (low percentile) carry ~10× the weight of low-priority items. Processing any item increases the shield, and processing high-priority items gives a bigger boost. 100% means everything is processed; a low value means significant high-priority material remains unreviewed. Toggle its display with the "Show Weighted Shield" checkbox at the top of the widget.
        </p>

        <div>
          <p>
            <b>Understanding Universe Size Changes:</b>
          </p>
          <p className="mt-2">
            For <b>Incremental Rems</b>, tracking the visual layers paints a clear picture of your workflow:
          </p>
          <ul className="list-disc pl-5 mt-1">
            <li>If the <b>Active Universe (Green)</b> drops but the <b>Total Universe (Black)</b> remains steady and the <b>Dismissed Area (Yellow)</b> expands, you are efficiently processing and dismissing items faster than you add them!</li>
            <li>If the <b>Active Universe (Green)</b> climbs while the <b>Dismissed Area (Yellow)</b> stays flat, you are continuously adding new IncRems without clearing older ones. This influx automatically lowers your priority shield percentiles, as each item is now a smaller percentage of a larger workload.</li>
            <li>If the <b>Total Universe (Black)</b> drops, you have deleted IncRems from your Knowledge Base, or removed the `Incremental` tag without dismissing them.</li>
          </ul>
          <p className="mt-2">
            For <b>Flashcards</b>, this number will usually only increase (unless you delete cards). The evolution will show you the size of your knowledge (considering you keep control of your due cards).
          </p>
        </div>
      </div>
    </div>
  );
}

renderWidget(withHoverTips(PriorityShieldGraph));
