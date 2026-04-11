import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import { useMemo, useState, useCallback, useRef } from 'react';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { getCardPriority, setCardPriority, CardPriorityInfo } from '../lib/card_priority';
import { allIncrementalRemKey, powerupCode, prioritySlotCode, allCardPriorityInfoKey, cardPriorityCacheRefreshKey, pageRangeWidgetId } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { calculateRelativePercentile, formatDuration } from '../lib/utils';
import { updateCardPriorityCache } from '../lib/card_priority/cache';
import { PriorityBadge } from '../components';
import {
  findPreferredPDFInRem,
  getIncrementalPageRange,
  getPageHistory,
  getReadingStatistics,
  setIncrementalReadingPosition,
  addPageToHistory,
  getPageRangeKey,
  safeRemTextToString,
  PageHistoryEntry,
} from '../lib/pdfUtils';

// Move styles outside component to avoid recreation on every render
const adjustButtonStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: '6px',
  fontSize: '11px',
  fontWeight: 600,
  cursor: 'pointer',
  border: 'none',
  transition: 'all 0.15s ease',
};

export function PriorityEditor() {
  const plugin = usePlugin();
  const widgetContext = useRunAsync(async () => await plugin.widget.getWidgetContext<any>(), []);
  const remId = widgetContext?.remId;

  const [isExpanded, setIsExpanded] = useState(false);

  // PDF range editing state
  type PdfEditMode
    = { mode: 'none' }
    | { mode: 'range'; start: number; end: number }
    | { mode: 'history'; page: number };
  const [pdfEdit, setPdfEdit] = useState<PdfEditMode>({ mode: 'none' });
  const pdfStartRef = useRef<HTMLInputElement>(null);
  const pdfEndRef = useRef<HTMLInputElement>(null);
  const pdfPageRef = useRef<HTMLInputElement>(null);

  // Listen for cache refresh signal to force re-evaluation of all data
  const refreshSignal = useTrackerPlugin(
    (rp) => rp.storage.getSession(cardPriorityCacheRefreshKey),
    []
  );

  // SUPER OPTIMIZED: Combine ALL data fetching into a single hook
  // This reduces the render cascade from ~9 renders to ~3 renders
  const remData = useTrackerPlugin(
    async (plugin) => {
      if (!remId) return null;

      const rem = await plugin.rem.findOne(remId);
      if (!rem) return null;

      // Execute ALL queries in parallel for maximum performance
      const [incRemInfo, cardInfo, cards, hasPowerup, allIncRems, allPrioritizedCardInfo, displayMode, pdfRem] = await Promise.all([
        getIncrementalRemFromRem(plugin, rem),
        getCardPriority(plugin, rem),
        rem.getCards(),
        rem.hasPowerup('cardPriority'),
        plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
        plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey),
        plugin.settings.getSetting<string>('priorityEditorDisplayMode'),
        findPreferredPDFInRem(plugin as any, rem, false),
      ]);

      // Fetch PDF range / history / stats if a PDF source was found
      let pdfRemId: string | null = null;
      let pdfRemName: string | null = null;
      let pdfRange: { start: number; end: number | null } | null = null;
      let pdfHistory: PageHistoryEntry[] = [];
      let pdfStats: any = null;
      if (pdfRem) {
        pdfRemId = pdfRem._id;
        pdfRemName = pdfRem.text ? await safeRemTextToString(plugin as any, pdfRem.text) : null;
        const [range, history, stats] = await Promise.all([
          getIncrementalPageRange(plugin as any, rem._id, pdfRem._id),
          getPageHistory(plugin as any, rem._id, pdfRem._id),
          getReadingStatistics(plugin as any, rem._id, pdfRem._id),
        ]);
        pdfRange = range;
        pdfHistory = history;
        pdfStats = stats;
      }

      // Calculate relative priorities inline
      const incRemRelativePriority = (incRemInfo && allIncRems && allIncRems.length > 0)
        ? calculateRelativePercentile(allIncRems, rem._id)
        : 50;

      // Calculate card relative priority inline using pre-calculated kbPercentile
      const cardPriorityInfo = allPrioritizedCardInfo?.find(info => info.remId === rem._id);
      const cardRelativePriority = cardPriorityInfo?.kbPercentile ?? null;

      return {
        rem,
        incRemInfo,
        cardInfo,
        hasCards: cards && cards.length > 0,
        hasPowerup,
        incRemRelativePriority,
        cardRelativePriority,
        allPrioritizedCardInfo: allPrioritizedCardInfo || [],
        displayMode: displayMode || 'all',
        pdfRemId,
        pdfRemName,
        pdfRange,
        pdfHistory,
        pdfStats,
      };
    },
    [remId, refreshSignal]
  );

  const rem = remData?.rem ?? null;
  const incRemInfo = remData?.incRemInfo ?? null;
  const cardInfo = remData?.cardInfo ?? null;
  const hasCards = remData?.hasCards ?? false;
  const hasCardPriorityPowerup = remData?.hasPowerup ?? false;
  const incRemRelativePriority = remData?.incRemRelativePriority ?? null;
  const cardRelativePriority = remData?.cardRelativePriority ?? null;
  const allPrioritizedCardInfo = remData?.allPrioritizedCardInfo ?? [];
  const displayMode = remData?.displayMode ?? 'all';

  // IMPORTANT: All hooks must be called unconditionally BEFORE any early returns
  // Optimized: Use useMemo to avoid recalculating these conditions on every render
  const canShowIncRem = useMemo(() => !!incRemInfo, [incRemInfo]);
  const canShowCard = useMemo(() => hasCards || hasCardPriorityPowerup, [hasCards, hasCardPriorityPowerup]);

  // Memoize callback functions to avoid recreation on every render
  const quickUpdateIncPriority = useCallback(async (delta: number) => {
    if (!incRemInfo || !rem) return;
    const newPriority = Math.max(0, Math.min(100, incRemInfo.priority + delta));
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [newPriority.toString()]);

    // Update the incremental rem cache
    const updatedIncRem = await getIncrementalRemFromRem(plugin, rem);
    if (updatedIncRem) {
      await updateIncrementalRemCache(plugin, updatedIncRem);
    }
    
    // Trigger inheritance cascade in the background tracker
    await plugin.storage.setSession('pendingInheritanceCascade', rem._id);
  }, [incRemInfo, rem, plugin]);

  const quickUpdateCardPriority = useCallback(async (delta: number) => {
    if (!rem) return;
    const currentPriority = cardInfo?.priority ?? 50;
    const newPriority = Math.max(0, Math.min(100, currentPriority + delta));

    await setCardPriority(plugin, rem, newPriority, 'manual');
    await updateCardPriorityCache(plugin, rem._id);

    // Trigger inheritance cascade in the background tracker
    await plugin.storage.setSession('pendingInheritanceCascade', rem._id);
  }, [rem, cardInfo, plugin]);

  // Memoize whether card priority is manual (for visual indicator)
  const isCardPriorityManual = useMemo(
    () => cardInfo?.source === 'manual',
    [cardInfo?.source]
  );

  // PDF callbacks
  const pdfSaveRange = useCallback(async () => {
    if (pdfEdit.mode !== 'range' || !remId || !remData?.pdfRemId) return;
    const { start, end } = pdfEdit;
    const rangeKey = getPageRangeKey(remId, remData.pdfRemId);
    if (start > 1 || end > 0) {
      await plugin.storage.setSynced(rangeKey, { start, end });
      await plugin.app.toast(`Saved page range: ${start}–${end || '∞'}`);
    } else {
      await plugin.storage.setSynced(rangeKey, null);
      await plugin.app.toast('Cleared page range');
    }
    setPdfEdit({ mode: 'none' });
  }, [pdfEdit, remId, remData?.pdfRemId, plugin]);

  const pdfSaveHistory = useCallback(async () => {
    if (pdfEdit.mode !== 'history' || !remId || !remData?.pdfRemId) return;
    const { page } = pdfEdit;
    if (page <= 0) { await plugin.app.toast('Enter a valid page number.'); return; }
    await setIncrementalReadingPosition(plugin as any, remId, remData.pdfRemId, page);
    await addPageToHistory(plugin as any, remId, remData.pdfRemId, page, undefined);
    await plugin.app.toast(`Reading position set to page ${page}`);
    setPdfEdit({ mode: 'none' });
  }, [pdfEdit, remId, remData?.pdfRemId, plugin]);

  const openPdfPanel = useCallback(async () => {
    if (!remId || !remData?.pdfRemId) return;
    await plugin.storage.setSession('pageRangeContext', {
      incrementalRemId: remId,
      pdfRemId: remData.pdfRemId,
      totalPages: undefined,
      currentPage: undefined,
    });
    await plugin.widget.openPopup(pageRangeWidgetId, { remId });
  }, [remId, remData?.pdfRemId, plugin]);

  // Memoize computed values
  const showCardEditor = useMemo(
    () => (displayMode === 'all') && (hasCards || hasCardPriorityPowerup),
    [displayMode, hasCards, hasCardPriorityPowerup]
  );

  // --- RENDER LOGIC (after all hooks) ---

  // Optimized: Check if we're still loading critical data before making visibility decisions
  const isLoadingCriticalData = !rem || remData === undefined;

  if (isLoadingCriticalData) {
    return null; // Still loading, don't render yet
  }

  // Handle disabled state
  if (displayMode === 'disable') {
    return null;
  }

  // Handle logic for 'incRemOnly' and 'all'
  if (displayMode === 'incRemOnly' && !canShowIncRem) {
    return null; // Mode is 'incRemOnly' but this isn't an IncRem
  }

  if (displayMode === 'all' && !canShowIncRem && !canShowCard) {
    return null; // Mode is 'all' but this is neither an IncRem nor a Card
  }

  return (
    <div
      className="priority-editor-widget"
      style={{
        position: 'sticky',
        top: '12px',
        backgroundColor: isExpanded ? 'var(--rn-clr-background-primary)' : 'transparent',
        border: isExpanded ? '1px solid var(--rn-clr-border-primary)' : 'none',
        color: 'var(--rn-clr-content-primary)',
        borderRadius: '12px',
        padding: isExpanded ? '16px' : '4px',
        boxShadow: isExpanded ? '0 4px 20px rgba(0,0,0,0.15)' : 'none',
        transition: 'all 0.2s ease',
        minWidth: isExpanded ? '240px' : 'auto',
        zIndex: 1000,
      }}
    >
      {!isExpanded ? (
        <div
          onClick={() => setIsExpanded(true)}
          className="cursor-pointer flex flex-col items-center gap-1.5"
          title="Click to expand priority controls"
        >
          {incRemInfo && (
            <PriorityBadge priority={incRemInfo.priority} percentile={incRemRelativePriority ?? undefined} compact />
          )}
          {showCardEditor && (
            <PriorityBadge priority={cardInfo?.priority ?? 50} percentile={cardRelativePriority ?? undefined} compact source={cardInfo?.source} isCardPriority={true} />
          )}
          {remData?.pdfRemId && (
            <span
              title={remData.pdfRange ? `PDF: p.${remData.pdfRange.start}–${remData.pdfRange.end || '∞'}` : 'PDF source — no range set'}
              style={{
                fontSize: '10px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                color: remData.pdfRange ? 'var(--rn-clr-content-secondary)' : 'var(--rn-clr-content-tertiary)',
                opacity: remData.pdfRange ? 1 : 0.55,
                whiteSpace: 'nowrap',
              }}
            >
              📄{remData.pdfRange ? (
                <>
                  {` p.${remData.pdfRange.start}–${remData.pdfRange.end || '∞'}`}
                  {remData.pdfHistory && remData.pdfHistory.length > 0 && (
                    <span style={{ color: '#10b981', marginLeft: '2px' }}>
                      ({remData.pdfHistory[remData.pdfHistory.length - 1].page})
                    </span>
                  )}
                </>
              ) : ' —'}
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm">⚡</span>
              <span className="text-xs font-bold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                Quick Priority
              </span>
            </div>
            <button
              onClick={() => setIsExpanded(false)}
              className="w-5 h-5 flex items-center justify-center rounded-full transition-colors"
              style={{
                color: 'var(--rn-clr-content-tertiary)',
                backgroundColor: 'var(--rn-clr-background-secondary)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)'; }}
            >
              <span className="text-xs">✕</span>
            </button>
          </div>

          {/* Inc Rem Section */}
          {incRemInfo && (
            <div
              className="p-3 rounded-lg"
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">📖</span>
                  <span className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                    Inc Rem
                  </span>
                </div>
                <PriorityBadge priority={incRemInfo.priority} percentile={incRemRelativePriority ?? undefined} compact />
              </div>
              <div className="flex items-center justify-center gap-1">
                <button
                  onClick={() => quickUpdateIncPriority(-10)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#ef4444', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  −10
                </button>
                <button
                  onClick={() => quickUpdateIncPriority(-1)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#f97316', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  −1
                </button>
                <button
                  onClick={() => quickUpdateIncPriority(1)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#22c55e', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  +1
                </button>
                <button
                  onClick={() => quickUpdateIncPriority(10)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#3b82f6', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  +10
                </button>
              </div>
            </div>
          )}

          {/* Cards Section */}
          {showCardEditor && (
            <div
              className="p-3 rounded-lg"
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">🎴</span>
                  <span className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                    Cards
                  </span>
                  {isCardPriorityManual && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                      style={{ backgroundColor: '#8b5cf6', color: 'white' }}
                    >
                      manual
                    </span>
                  )}
                </div>
                <PriorityBadge priority={cardInfo?.priority ?? 50} percentile={cardRelativePriority ?? undefined} compact source={cardInfo?.source} isCardPriority={true} />
              </div>
              <div className="flex items-center justify-center gap-1">
                <button
                  onClick={() => quickUpdateCardPriority(-10)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#ef4444', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  −10
                </button>
                <button
                  onClick={() => quickUpdateCardPriority(-1)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#f97316', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  −1
                </button>
                <button
                  onClick={() => quickUpdateCardPriority(1)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#22c55e', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  +1
                </button>
                <button
                  onClick={() => quickUpdateCardPriority(10)}
                  style={{ ...adjustButtonStyle, backgroundColor: '#3b82f6', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  +10
                </button>
              </div>
              <div className="text-[10px] text-center mt-2" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                {!hasCards && hasCardPriorityPowerup ? "Set for inheritance" : `Source: ${cardInfo?.source}`}
              </div>
            </div>
          )}

          {/* PDF Range Section */}
          {remData?.pdfRemId && (
            <div
              className="p-3 rounded-lg"
              style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
            >
              {/* Header row */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">📄</span>
                  <span className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>PDF Range</span>
                  {remData.pdfRemName && (
                    <span className="text-[10px] truncate max-w-[100px]" style={{ color: 'var(--rn-clr-content-tertiary)' }}
                      title={remData.pdfRemName}>{remData.pdfRemName}</span>
                  )}
                </div>
                {remData.pdfRange ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                    style={{ backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-secondary)', whiteSpace: 'nowrap' }}>
                    p.{remData.pdfRange.start}–{remData.pdfRange.end || '∞'}
                    {remData.pdfHistory && remData.pdfHistory.length > 0 && (
                      <span style={{ color: '#10b981', marginLeft: '2px' }}>
                        ({remData.pdfHistory[remData.pdfHistory.length - 1].page})
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-[10px]" style={{ color: 'var(--rn-clr-content-tertiary)', opacity: 0.6 }}>No range</span>
                )}
              </div>

              {/* Editing area */}
              {pdfEdit.mode === 'range' && (
                <div
                  className="flex flex-col gap-2"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); pdfSaveRange(); } }}
                >
                  <div className="flex items-center gap-2">
                    <label className="text-[10px]" style={{ color: 'var(--rn-clr-content-secondary)' }}>Start</label>
                    <input
                      ref={pdfStartRef}
                      autoFocus
                      type="number" min="1" value={pdfEdit.start}
                      onChange={(e) => setPdfEdit({ ...pdfEdit, start: parseInt(e.target.value) || 1 })}
                      onFocus={(e) => e.target.select()}
                      onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); pdfEndRef.current?.focus(); } }}
                      className="w-14 text-center p-1 rounded text-[11px]"
                      style={{ border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)' }} />
                    <label className="text-[10px]" style={{ color: 'var(--rn-clr-content-secondary)' }}>End</label>
                    <input
                      ref={pdfEndRef}
                      type="number" min={pdfEdit.start} value={pdfEdit.end || ''}
                      placeholder="∞"
                      onChange={(e) => setPdfEdit({ ...pdfEdit, end: parseInt(e.target.value) || 0 })}
                      onFocus={(e) => e.target.select()}
                      onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); pdfStartRef.current?.focus(); } }}
                      className="w-14 text-center p-1 rounded text-[11px]"
                      style={{ border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)' }} />
                  </div>
                  <div className="flex gap-1">
                    <button onClick={pdfSaveRange} className="px-2 py-1 text-[11px] rounded" style={{ backgroundColor: '#3b82f6', color: 'white' }}>Save</button>
                    <button onClick={() => setPdfEdit({ mode: 'none' })} className="px-2 py-1 text-[11px] rounded"
                      style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-secondary)' }}>Cancel</button>
                  </div>
                </div>
              )}
              {pdfEdit.mode === 'history' && (() => {
                const rangeStart = remData.pdfRange?.start ?? 1;
                const rangeEnd = remData.pdfRange?.end ?? null;
                const outOfRange = pdfEdit.page < rangeStart || (rangeEnd !== null && pdfEdit.page > rangeEnd);
                return (
                  <div
                    className="flex flex-col gap-2"
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!outOfRange) pdfSaveHistory(); } }}
                  >
                    <div className="flex items-center gap-2">
                      <label className="text-[10px]" style={{ color: 'var(--rn-clr-content-secondary)' }}>Page</label>
                      <input
                        ref={pdfPageRef}
                        autoFocus
                        type="number"
                        min={rangeStart}
                        max={rangeEnd ?? undefined}
                        value={pdfEdit.page}
                        onChange={(e) => setPdfEdit({ ...pdfEdit, page: parseInt(e.target.value) || rangeStart })}
                        onFocus={(e) => e.target.select()}
                        className="w-20 text-center p-1 rounded text-[11px]"
                        style={{
                          border: `1px solid ${outOfRange ? '#ef4444' : 'var(--rn-clr-border-primary)'}`,
                          backgroundColor: 'var(--rn-clr-background-primary)',
                          color: 'var(--rn-clr-content-primary)',
                        }} />
                      {outOfRange && (
                        <span className="text-[10px]" style={{ color: '#ef4444' }}>
                          {rangeEnd !== null ? `${rangeStart}–${rangeEnd}` : `≥${rangeStart}`}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button onClick={pdfSaveHistory} disabled={outOfRange} className="px-2 py-1 text-[11px] rounded"
                        style={{ backgroundColor: outOfRange ? '#6b7280' : '#10b981', color: 'white', cursor: outOfRange ? 'not-allowed' : 'pointer' }}>Save Position</button>
                      <button onClick={() => setPdfEdit({ mode: 'none' })} className="px-2 py-1 text-[11px] rounded"
                        style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-secondary)' }}>Cancel</button>
                    </div>
                  </div>
                );
              })()}
              {pdfEdit.mode === 'none' && (
                <div className="flex gap-1 flex-wrap">
                  <button
                    onClick={() => setPdfEdit({ mode: 'range', start: remData.pdfRange?.start || 1, end: remData.pdfRange?.end || 0 })}
                    className="px-2 py-1 text-[11px] rounded transition-colors"
                    style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: '#3b82f6' }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#3b82f6'; e.currentTarget.style.color = 'white'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; e.currentTarget.style.color = '#3b82f6'; }}
                  >📄 Range</button>
                  <button
                    onClick={() => {
                      const lastPage = remData.pdfHistory?.slice(-1)[0]?.page
                        ?? remData.pdfRange?.start
                        ?? 1;
                      setPdfEdit({ mode: 'history', page: lastPage });
                    }}
                    className="px-2 py-1 text-[11px] rounded transition-colors"
                    style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: '#10b981' }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#10b981'; e.currentTarget.style.color = 'white'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; e.currentTarget.style.color = '#10b981'; }}
                  >📖 Position</button>
                </div>
              )}

              {/* Stats + last session */}
              {(remData.pdfStats?.totalTimeSeconds > 0 || remData.pdfHistory?.length > 0) && (
                <div className="mt-2 flex items-center gap-3 flex-wrap">
                  {remData.pdfStats?.totalTimeSeconds > 0 && (
                    <span className="text-[10px]" style={{ color: '#10b981' }}
                      title="Total reading time">⏱️{formatDuration(remData.pdfStats.totalTimeSeconds)}</span>
                  )}
                  {remData.pdfHistory?.length > 0 && (
                    <span className="text-[10px]" style={{ color: 'var(--rn-clr-content-tertiary)' }}
                      title={`Last: page ${remData.pdfHistory[remData.pdfHistory.length - 1].page}`}>
                      Last p.{remData.pdfHistory[remData.pdfHistory.length - 1].page}
                    </span>
                  )}
                </div>
              )}

              {/* Full panel link */}
              <button
                onClick={openPdfPanel}
                className="w-full mt-2 py-1 rounded text-[11px] transition-colors"
                style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-tertiary)', border: '1px solid var(--rn-clr-border-primary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--rn-clr-content-primary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--rn-clr-content-tertiary)'; }}
              >
                PDF Control Panel ↗
              </button>
            </div>
          )}

          {/* Open Full Panel Button */}
          <button
            onClick={() => plugin.widget.openPopup('priority', { remId })}
            className="w-full py-2 rounded-lg text-xs font-semibold transition-all"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
              color: 'var(--rn-clr-content-secondary)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
              e.currentTarget.style.color = 'var(--rn-clr-content-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)';
              e.currentTarget.style.color = 'var(--rn-clr-content-secondary)';
            }}
          >
            Open Full Panel →
          </button>
        </div>
      )}
    </div>
  );
}

renderWidget(PriorityEditor);