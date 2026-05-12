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
  incRemDue: number;
  incRemNotDue: number;
  cardDue: number;
  cardNotDue: number;
}

const INC_REM_DUE_COLOR = '#3b82f6';
const INC_REM_NOT_DUE_COLOR = '#bfdbfe';
const CARD_DUE_COLOR = '#ef4444';
const CARD_NOT_DUE_COLOR = '#fecaca';

/**
 * Computes absolute priority bins from all KB IncRems and card infos.
 * Each bin splits items into "due" (nextRepDate <= now for IncRems; dueCards > 0
 * for rems with cards) and "not due" (already processed, scheduled forward).
 */
function computeKbGraphBins(
  allIncRems: IncrementalRem[],
  allCardInfos: CardPriorityInfo[],
): GraphDataPoint[] {
  const now = Date.now();
  const bins: GraphDataPoint[] = Array(20).fill(0).map((_, i) => ({
    // Integer-priority labels. Last bucket spans [95, 100] inclusive because
    // priority is clamped to 100 in the binning step below.
    range: i === 19 ? '95-100' : `${i * 5}-${i * 5 + 4}`,
    incRemDue: 0,
    incRemNotDue: 0,
    cardDue: 0,
    cardNotDue: 0,
  }));

  for (const item of allIncRems) {
    const p = Math.max(0, Math.min(100, item.priority));
    const idx = Math.min(Math.floor(p / 5), 19);
    if (item.nextRepDate <= now) bins[idx].incRemDue++;
    else bins[idx].incRemNotDue++;
  }

  // Filter out inheritance-only rems (cardCount === 0) that hold the powerup
  // only for child inheritance but have no actual cards themselves.
  for (const item of allCardInfos) {
    if (item.cardCount !== undefined && item.cardCount <= 0) continue;
    const p = Math.max(0, Math.min(100, item.priority));
    const idx = Math.min(Math.floor(p / 5), 19);
    if ((item.dueCards ?? 0) > 0) bins[idx].cardDue++;
    else bins[idx].cardNotDue++;
  }

  return bins;
}

function PriorityBinTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const data = payload[0]?.payload as GraphDataPoint | undefined;
  if (!data) return null;

  const incTotal = data.incRemDue + data.incRemNotDue;
  const cardTotal = data.cardDue + data.cardNotDue;
  const incPct = incTotal > 0 ? Math.round((data.incRemNotDue / incTotal) * 100) : 0;
  const cardPct = cardTotal > 0 ? Math.round((data.cardNotDue / cardTotal) * 100) : 0;

  return (
    <div
      style={{
        borderRadius: 8,
        border: 'none',
        boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
        background: 'white',
        padding: '8px 10px',
        fontSize: 12,
        color: '#374151',
        lineHeight: 1.4,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ color: INC_REM_DUE_COLOR, fontWeight: 600 }}>
        Incremental Rems: {incTotal}
      </div>
      <div style={{ marginLeft: 8 }}>
        Due: {data.incRemDue} · Processed: {data.incRemNotDue} ({incPct}%)
      </div>
      <div style={{ color: CARD_DUE_COLOR, fontWeight: 600, marginTop: 4 }}>
        Rems with Cards: {cardTotal}
      </div>
      <div style={{ marginLeft: 8 }}>
        Due: {data.cardDue} · Processed: {data.cardNotDue} ({cardPct}%)
      </div>
    </div>
  );
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

  // Container ref used to locate the rendered <svg> for export.
  const chartContainerRef = useRef<HTMLDivElement>(null);

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

  const handleReviewInEditor = async (remId: string, subsequentRemIds?: string[]) => {
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

  // Builds an annotated, exportable SVG with header band, legend, and bars converted
  // from recharts <path> to plain <rect>. The `tooltipMode` controls how each bar
  // carries its bucket data:
  //   - 'native-title' → inject an SVG <title> child (for standalone .svg export)
  //   - 'data-attr'    → set data-bin-index="N" (for HTML export with JS tooltips)
  const buildAnnotatedSvg = (
    tooltipMode: 'native-title' | 'data-attr',
  ): { svg: SVGSVGElement; chartWidth: number; totalHeight: number } | null => {
    const container = chartContainerRef.current;
    if (!container || !graphBins) return null;

    const liveSvg = container.querySelector('svg');
    if (!liveSvg) return null;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = liveSvg.cloneNode(true) as SVGSVGElement;
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    svg.removeAttribute('style');

    const chartWidth = parseFloat(svg.getAttribute('width') || '') || liveSvg.clientWidth || 800;
    const chartHeight = parseFloat(svg.getAttribute('height') || '') || liveSvg.clientHeight || 350;
    const titleBandHeight = 56;
    const legendBandHeight = 32;
    const headerHeight = titleBandHeight + legendBandHeight;
    const padding = 12;

    // Replace each recharts bar <path> with a proper <rect> (using the dimensions
    // recharts already wrote on the path) — universally hoverable and well-behaved.
    const barPaths = svg.querySelectorAll('path.recharts-rectangle');
    barPaths.forEach((path) => {
      const x = path.getAttribute('x');
      const y = path.getAttribute('y');
      const width = path.getAttribute('width');
      const height = path.getAttribute('height');
      const fill = path.getAttribute('fill') || 'currentColor';
      if (!x || !y || !width || !height) return;

      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', width);
      rect.setAttribute('height', height);
      rect.setAttribute('fill', fill);
      rect.setAttribute('class', 'recharts-rectangle');
      rect.setAttribute('pointer-events', 'all');
      path.parentNode?.replaceChild(rect, path);
    });

    const tooltipFor = (bin: GraphDataPoint): string => {
      const incTotal = bin.incRemDue + bin.incRemNotDue;
      const cardTotal = bin.cardDue + bin.cardNotDue;
      const incPct = incTotal > 0 ? Math.round((bin.incRemNotDue / incTotal) * 100) : 0;
      const cardPct = cardTotal > 0 ? Math.round((bin.cardNotDue / cardTotal) * 100) : 0;
      return (
        `Priority ${bin.range}\n` +
        `Incremental Rems: ${incTotal}  (Due ${bin.incRemDue} · Processed ${bin.incRemNotDue} = ${incPct}%)\n` +
        `Rems with Cards:  ${cardTotal}  (Due ${bin.cardDue} · Processed ${bin.cardNotDue} = ${cardPct}%)`
      );
    };

    // Annotate each bar with either a <title> or a data-bin-index.
    const barSeries = svg.querySelectorAll('.recharts-bar');
    barSeries.forEach((series) => {
      const barCells = series.querySelectorAll('.recharts-bar-rectangle');
      barCells.forEach((cell, idx) => {
        const bin = graphBins[idx];
        if (!bin) return;
        cell.querySelectorAll('rect, path').forEach((shape) => {
          if (tooltipMode === 'native-title') {
            const titleEl = document.createElementNS(SVG_NS, 'title');
            titleEl.textContent = tooltipFor(bin);
            shape.insertBefore(titleEl, shape.firstChild);
          } else {
            shape.setAttribute('data-bin-index', String(idx));
          }
        });
      });
    });

    // Wrap existing children so we can prepend a header band.
    const wrapperG = document.createElementNS(SVG_NS, 'g');
    wrapperG.setAttribute('transform', `translate(0, ${headerHeight})`);
    while (svg.firstChild) wrapperG.appendChild(svg.firstChild);

    const totalHeight = chartHeight + headerHeight + padding;
    svg.setAttribute('width', String(chartWidth));
    svg.setAttribute('height', String(totalHeight));
    svg.setAttribute('viewBox', `0 0 ${chartWidth} ${totalHeight}`);

    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('x', '0');
    bg.setAttribute('y', '0');
    bg.setAttribute('width', String(chartWidth));
    bg.setAttribute('height', String(totalHeight));
    bg.setAttribute('fill', '#ffffff');
    svg.appendChild(bg);

    const incCount = allIncRems?.length || 0;
    const cardCount = allCardInfos?.filter(c => c.cardCount === undefined || c.cardCount > 0).length || 0;

    const titleEl = document.createElementNS(SVG_NS, 'text');
    titleEl.setAttribute('x', String(chartWidth / 2));
    titleEl.setAttribute('y', '24');
    titleEl.setAttribute('text-anchor', 'middle');
    titleEl.setAttribute('font-family', 'system-ui, -apple-system, "Segoe UI", sans-serif');
    titleEl.setAttribute('font-size', '14');
    titleEl.setAttribute('font-weight', '600');
    titleEl.setAttribute('fill', '#374151');
    titleEl.textContent = 'KB Priority Distribution';
    svg.appendChild(titleEl);

    const subtitleEl = document.createElementNS(SVG_NS, 'text');
    subtitleEl.setAttribute('x', String(chartWidth / 2));
    subtitleEl.setAttribute('y', '44');
    subtitleEl.setAttribute('text-anchor', 'middle');
    subtitleEl.setAttribute('font-family', 'system-ui, -apple-system, "Segoe UI", sans-serif');
    subtitleEl.setAttribute('font-size', '11');
    subtitleEl.setAttribute('fill', '#9ca3af');
    subtitleEl.textContent = `(${incCount.toLocaleString()} IncRems, ${cardCount.toLocaleString()} Rems with Cards)`;
    svg.appendChild(subtitleEl);

    // Manual legend row.
    const legendEntries: Array<{ label: string; color: string }> = [
      { label: 'IncRems · Due', color: INC_REM_DUE_COLOR },
      { label: 'IncRems · Processed', color: INC_REM_NOT_DUE_COLOR },
      { label: 'Cards · Due', color: CARD_DUE_COLOR },
      { label: 'Cards · Processed', color: CARD_NOT_DUE_COLOR },
    ];
    const legendY = titleBandHeight + legendBandHeight / 2;
    const swatchSize = 12;
    const gapAfterSwatch = 6;
    const gapBetweenEntries = 18;
    const legendFontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    const legendFontSize = 11;
    const approxCharWidth = 6.2;
    const entryWidths = legendEntries.map(e => swatchSize + gapAfterSwatch + e.label.length * approxCharWidth);
    const totalLegendWidth = entryWidths.reduce((s, w) => s + w, 0) + gapBetweenEntries * (legendEntries.length - 1);
    let cursorX = (chartWidth - totalLegendWidth) / 2;

    legendEntries.forEach((entry, i) => {
      const swatch = document.createElementNS(SVG_NS, 'rect');
      swatch.setAttribute('x', String(cursorX));
      swatch.setAttribute('y', String(legendY - swatchSize / 2));
      swatch.setAttribute('width', String(swatchSize));
      swatch.setAttribute('height', String(swatchSize));
      swatch.setAttribute('fill', entry.color);
      swatch.setAttribute('rx', '2');
      svg.appendChild(swatch);

      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', String(cursorX + swatchSize + gapAfterSwatch));
      label.setAttribute('y', String(legendY));
      label.setAttribute('dominant-baseline', 'central');
      label.setAttribute('font-family', legendFontFamily);
      label.setAttribute('font-size', String(legendFontSize));
      label.setAttribute('fill', '#374151');
      label.textContent = entry.label;
      svg.appendChild(label);

      cursorX += entryWidths[i] + gapBetweenEntries;
    });

    svg.appendChild(wrapperG);

    return { svg, chartWidth, totalHeight };
  };

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportGraphSvg = () => {
    const built = buildAnnotatedSvg('native-title');
    if (!built) return;
    const xml = new XMLSerializer().serializeToString(built.svg);
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`], { type: 'image/svg+xml' });
    const stamp = new Date().toISOString().slice(0, 10);
    triggerDownload(blob, `kb-priority-distribution-${stamp}.svg`);
  };

  const handleExportGraphHtml = () => {
    const built = buildAnnotatedSvg('data-attr');
    if (!built || !graphBins) return;
    const { svg, chartWidth, totalHeight } = built;

    const svgMarkup = new XMLSerializer().serializeToString(svg);
    const stamp = new Date().toISOString().slice(0, 10);

    // Tooltip rendering is done in JS; data lives in a JSON island.
    const dataJson = JSON.stringify(graphBins);
    const colors = {
      incDue: INC_REM_DUE_COLOR,
      incNotDue: INC_REM_NOT_DUE_COLOR,
      cardDue: CARD_DUE_COLOR,
      cardNotDue: CARD_NOT_DUE_COLOR,
    };
    const colorsJson = JSON.stringify(colors);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>KB Priority Distribution — ${stamp}</title>
<style>
  html, body { margin: 0; padding: 0; background: #f3f4f6; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #374151; }
  .wrap { max-width: ${chartWidth + 40}px; margin: 24px auto; padding: 16px; background: #ffffff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .chart-host { position: relative; width: 100%; }
  .chart-host svg { display: block; width: 100%; height: auto; max-width: ${chartWidth}px; }
  rect.recharts-rectangle[data-bin-index] { cursor: pointer; transition: opacity 120ms ease; }
  rect.recharts-rectangle[data-bin-index]:hover { opacity: 0.78; }
  .bin-hover-overlay { fill: transparent; cursor: pointer; }
  .tooltip {
    position: fixed; pointer-events: none; z-index: 1000;
    background: #ffffff; color: #374151;
    border-radius: 8px; border: none;
    box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
    padding: 8px 10px;
    font-size: 12px; line-height: 1.4;
    opacity: 0; transform: translate(0, 0);
    transition: opacity 80ms ease;
    max-width: 320px;
  }
  .tooltip.visible { opacity: 1; }
  .tooltip .range { font-weight: 600; margin-bottom: 4px; }
  .tooltip .series-header { font-weight: 600; margin-top: 4px; }
  .tooltip .series-detail { margin-left: 8px; }
  .footer { text-align: center; color: #9ca3af; font-size: 11px; margin-top: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="chart-host" id="chart-host" style="height:${totalHeight}px;">${svgMarkup}</div>
  <div class="footer">Exported ${stamp} · Hover any bar for the bucket breakdown</div>
</div>
<div class="tooltip" id="tooltip" role="tooltip" aria-hidden="true"></div>
<script>
(function () {
  var bins = ${dataJson};
  var colors = ${colorsJson};
  var tooltip = document.getElementById('tooltip');
  var host = document.getElementById('chart-host');

  function buildTooltipHtml(bin) {
    var incTotal = bin.incRemDue + bin.incRemNotDue;
    var cardTotal = bin.cardDue + bin.cardNotDue;
    var incPct = incTotal > 0 ? Math.round(bin.incRemNotDue / incTotal * 100) : 0;
    var cardPct = cardTotal > 0 ? Math.round(bin.cardNotDue / cardTotal * 100) : 0;
    return ''
      + '<div class="range">Priority ' + bin.range + '</div>'
      + '<div class="series-header" style="color:' + colors.incDue + '">Incremental Rems: ' + incTotal + '</div>'
      + '<div class="series-detail">Due: ' + bin.incRemDue + ' · Processed: ' + bin.incRemNotDue + ' (' + incPct + '%)</div>'
      + '<div class="series-header" style="color:' + colors.cardDue + '">Rems with Cards: ' + cardTotal + '</div>'
      + '<div class="series-detail">Due: ' + bin.cardDue + ' · Processed: ' + bin.cardNotDue + ' (' + cardPct + '%)</div>';
  }

  function showTooltip(e, idx) {
    var bin = bins[idx];
    if (!bin) return;
    tooltip.innerHTML = buildTooltipHtml(bin);
    tooltip.classList.add('visible');
    tooltip.setAttribute('aria-hidden', 'false');
    positionTooltip(e);
  }

  function positionTooltip(e) {
    var x = e.clientX + 14;
    var y = e.clientY + 14;
    var rect = tooltip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - 14;
    if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - 14;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function hideTooltip() {
    tooltip.classList.remove('visible');
    tooltip.setAttribute('aria-hidden', 'true');
  }

  // Attach hover listeners to each bar rect.
  var bars = host.querySelectorAll('rect.recharts-rectangle[data-bin-index]');
  bars.forEach(function (rect) {
    var idx = parseInt(rect.getAttribute('data-bin-index'), 10);
    rect.addEventListener('mouseenter', function (e) { showTooltip(e, idx); });
    rect.addEventListener('mousemove', positionTooltip);
    rect.addEventListener('mouseleave', hideTooltip);
  });

  // Also add a full-bin invisible hover band over each X bucket so users can hover
  // the entire vertical column (including empty space above the stack) and still
  // see the tooltip — matches the in-app behavior more closely.
  // We compute these bands from the rendered SVG's bar positions.
  try {
    var svg = host.querySelector('svg');
    var nsResolver = null;
    var binBuckets = {};
    bars.forEach(function (r) {
      var idx = r.getAttribute('data-bin-index');
      var x = parseFloat(r.getAttribute('x'));
      var w = parseFloat(r.getAttribute('width'));
      if (!binBuckets[idx]) binBuckets[idx] = { minX: x, maxX: x + w };
      else {
        if (x < binBuckets[idx].minX) binBuckets[idx].minX = x;
        if (x + w > binBuckets[idx].maxX) binBuckets[idx].maxX = x + w;
      }
    });
    // Find the chart plot area for vertical extents from the cartesian grid clipPath.
    var clip = svg.querySelector('clipPath rect');
    if (clip) {
      var plotY = parseFloat(clip.getAttribute('y'));
      var plotH = parseFloat(clip.getAttribute('height'));
      var plotTransform = svg.querySelector('g[transform^="translate(0,"]');
      // The wrapper <g transform="translate(0, headerHeight)"> moves the plot down;
      // we honor that by appending overlays as siblings inside the same wrapper.
      var overlayParent = plotTransform || svg;
      Object.keys(binBuckets).forEach(function (idx) {
        var b = binBuckets[idx];
        var pad = 8;
        var overlay = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        overlay.setAttribute('x', String(b.minX - pad / 2));
        overlay.setAttribute('y', String(plotY));
        overlay.setAttribute('width', String((b.maxX - b.minX) + pad));
        overlay.setAttribute('height', String(plotH));
        overlay.setAttribute('class', 'bin-hover-overlay');
        overlay.setAttribute('data-bin-index', idx);
        overlay.addEventListener('mouseenter', function (e) { showTooltip(e, parseInt(idx, 10)); });
        overlay.addEventListener('mousemove', positionTooltip);
        overlay.addEventListener('mouseleave', hideTooltip);
        overlayParent.appendChild(overlay);
      });
    }
  } catch (err) {
    // Overlay enhancement is best-effort; bar-only hover still works.
    console.warn('bin overlay setup skipped:', err);
  }
})();
</script>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    triggerDownload(blob, `kb-priority-distribution-${stamp}.html`);
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
        className="flex items-center justify-end gap-1 px-4 py-1 shrink-0"
        style={{ borderBottom: '1px solid var(--rn-clr-border-primary)' }}
      >
        {showGraph && (
          <>
            <button
              onClick={handleExportGraphHtml}
              className="px-2 py-1 text-xs rounded transition-colors"
              style={{
                backgroundColor: 'var(--rn-clr-background-primary)',
                color: 'var(--rn-clr-content-tertiary)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-primary)'; }}
              title="Export graph as standalone HTML with JS-driven tooltips that match the in-app design"
            >
              ⬇️ Export HTML
            </button>
            <button
              onClick={handleExportGraphSvg}
              className="px-2 py-1 text-xs rounded transition-colors"
              style={{
                backgroundColor: 'var(--rn-clr-background-primary)',
                color: 'var(--rn-clr-content-tertiary)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-primary)'; }}
              title="Export graph as SVG (uses native browser tooltips on bar hover; may not work in all browsers)"
            >
              ⬇️ Export SVG
            </button>
          </>
        )}
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
                ({allIncRems?.length || 0} IncRems, {allCardInfos?.filter(c => c.cardCount === undefined || c.cardCount > 0).length || 0} Rems with Cards)
              </span>
            </h4>

            <div ref={chartContainerRef} style={{ width: '100%', height: 350 }}>
              <ResponsiveContainer width="100%" height="100%" minHeight={350} minWidth={100}>
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
                  <Tooltip content={<PriorityBinTooltip />} />
                  <Legend verticalAlign="top" height={36} />
                  <Bar yAxisId="left" stackId="incRem" dataKey="incRemNotDue" name="IncRems · Processed" fill={INC_REM_NOT_DUE_COLOR} />
                  <Bar yAxisId="left" stackId="incRem" dataKey="incRemDue" name="IncRems · Due" fill={INC_REM_DUE_COLOR} />
                  <Bar yAxisId="right" stackId="card" dataKey="cardNotDue" name="Cards · Processed" fill={CARD_NOT_DUE_COLOR} />
                  <Bar yAxisId="right" stackId="card" dataKey="cardDue" name="Cards · Due" fill={CARD_DUE_COLOR} />
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
            onReviewInEditor={handleReviewInEditor}
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
