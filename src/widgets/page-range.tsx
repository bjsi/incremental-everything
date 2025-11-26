// widgets/page-range.tsx
import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import {
  getPageRangeKey,
  getPageHistory,
  getAllIncrementsForPDF,
  getIncrementalPageRange,
  setIncrementalReadingPosition,
  addPageToHistory,
  getReadingStatistics,
  PageHistoryEntry
} from '../lib/pdfUtils';
import { powerupCode, prioritySlotCode, allIncrementalRemKey } from '../lib/consts';
import { calculateRelativePercentile, formatDuration } from '../lib/utils';
import { PdfRemItem, EditingState } from '../components';
import { IncrementalRem } from '../lib/incremental_rem';
import { getIncrementalRemFromRem, initIncrementalRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';

function PageRangeWidget() {
  const plugin = usePlugin();
  const pageRangeInputRefs = React.useRef<Record<string, {start: HTMLInputElement | null, end: HTMLInputElement | null}>>({});
  const inputStartRef = React.useRef<HTMLInputElement>(null);
  
  const contextData = useTrackerPlugin(
    async (rp) => rp.storage.getSession('pageRangeContext'),
    []
  );

  const allIncrementalRems = useTrackerPlugin(
    (rp) => rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
    []
  );

  const [pageRangeStart, setPageRangeStart] = useState(1);
  const [pageRangeEnd, setPageRangeEnd] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [relatedRems, setRelatedRems] = useState<any[]>([]);
  const [currentRemName, setCurrentRemName] = useState<string>('');
  const [isCurrentRemIncremental, setIsCurrentRemIncremental] = useState<boolean>(false);
  const [remHistories, setRemHistories] = useState<Record<string, PageHistoryEntry[]>>({});
  const [expandedRems, setExpandedRems] = useState<Set<string>>(new Set());
  const [remPriorities, setRemPriorities] = useState<Record<string, {absolute: number, percentile: number | null}>>({});
  const [remStatistics, setRemStatistics] = useState<Record<string, any>>({});

  const [editingState, setEditingState] = useState<EditingState>({ type: 'none' });
  const [totalPdfReadingTime, setTotalPdfReadingTime] = useState<number>(0);

  const handleInitIncrementalRem = async (remId: string) => {
    try {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) return;

      await initIncrementalRem(plugin, rem);

      await reloadRelatedRems();

      const remName = rem.text ? await plugin.richText.toString(rem.text) : 'Rem';
      const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
      if (incRemInfo) {
        await plugin.app.toast(`Made "${remName}" incremental with priority ${incRemInfo.priority}`);
      }
    } catch (error) {
      console.error('Error initializing incremental rem:', error);
      await plugin.app.toast('Error making rem incremental');
    }
  };

  // Start editing priority inline
  const startEditingPriority = async (remId: string) => {
    const rem = await plugin.rem.findOne(remId);
    if (rem) {
      const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
      if (incRemInfo) {
        setEditingState({ type: 'priority', remId, value: incRemInfo.priority });
      }
    }
  };

  // Save priority inline
  const savePriority = async (remId: string) => {
    if (editingState.type !== 'priority') return;
    const priority = editingState.value;

    const rem = await plugin.rem.findOne(remId);
    if (rem) {
      await rem.setPowerupProperty(powerupCode, prioritySlotCode, [priority.toString()]);

      // Update the incremental rem list
      const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
      if (incRemInfo) {
        await updateIncrementalRemCache(plugin, incRemInfo);
      }

      setEditingState({ type: 'none' });
      await reloadRelatedRems();
      await plugin.app.toast(`Priority updated to ${priority}`);
    }
  };

  // Calculate priority info for each incremental rem
  const calculatePriorities = async (rems: any[]) => {
    const priorities: Record<string, {absolute: number, percentile: number | null}> = {};

    // Use allIncrementalRems from tracker
    const remsForCalculation = allIncrementalRems || [];

    for (const rem of rems) {
      if (rem.isIncremental) {
        const remObj = await plugin.rem.findOne(rem.remId);
        if (remObj) {
          const incRemInfo = await getIncrementalRemFromRem(plugin, remObj);
          if (incRemInfo) {
            const percentile = remsForCalculation.length > 0 ?
              calculateRelativePercentile(remsForCalculation, rem.remId) : null;
            priorities[rem.remId] = {
              absolute: incRemInfo.priority,
              percentile
            };
          }
        }
      }
    }
    
    setRemPriorities(priorities);
  };

    const reloadRelatedRems = async () => {
    if (!contextData?.pdfRemId) return;
    
    const related = await getAllIncrementsForPDF(plugin, contextData.pdfRemId);
    setRelatedRems(related);

    // Calculate priorities using tracker data
    await calculatePriorities(related);
    
    // Fetch reading histories and statistics for each related rem
    const histories: Record<string, PageHistoryEntry[]> = {};
    const statistics: Record<string, any> = {};
    let totalTime = 0;
    
    for (const item of related) {
        // Always fetch stats if it's a related rem
        const history = await getPageHistory(plugin, item.remId, contextData.pdfRemId);
        if (history.length > 0) {
            histories[item.remId] = history;
        }
        
        const stats = await getReadingStatistics(plugin, item.remId, contextData.pdfRemId);
        statistics[item.remId] = stats;
        totalTime += stats.totalTimeSeconds;
        
    }
    
    setRemHistories(histories);
    setRemStatistics(statistics);
    setTotalPdfReadingTime(totalTime);
  };

  // Toggle expanded state for a rem
  const toggleExpanded = (remId: string) => {
    const newExpanded = new Set(expandedRems);
    if (newExpanded.has(remId)) {
      newExpanded.delete(remId);
    } else {
      newExpanded.add(remId);
    }
    setExpandedRems(newExpanded);
  };

  // Start editing page range for a specific rem
  const startEditingRem = async (remId: string) => {
    if (!contextData?.pdfRemId) return;

    // Load existing range for this rem
    const savedRange = await getIncrementalPageRange(plugin, remId, contextData.pdfRemId);
    const start = savedRange?.start || 1;
    const end = savedRange?.end || 0;
    setEditingState({ type: 'range', remId, start, end });
  };

  // Save page range for a specific rem
  const saveRemRange = async (remId: string) => {
    if (!contextData?.pdfRemId || editingState.type !== 'range') return;

    const { start, end } = editingState;
    const rangeKey = getPageRangeKey(remId, contextData.pdfRemId);

    if (start > 1 || end > 0) {
      await plugin.storage.setSynced(rangeKey, { start, end });
      await plugin.app.toast(`Saved page range: ${start}-${end || '∞'}`);
    } else {
      await plugin.storage.setSynced(rangeKey, null);
      await plugin.app.toast('Cleared page range');
    }

    setEditingState({ type: 'none' });
    await reloadRelatedRems();
  };

  // Start editing history
  const startEditingHistory = (remId: string, currentPage: number | null) => {
    let page = 1;
    if (currentPage && currentPage > 0) {
      page = currentPage;
    } else {
      // Check if we have history for this rem
      const history = remHistories[remId];
      if (history && history.length > 0) {
        page = history[history.length - 1].page;
      }
    }
    setEditingState({ type: 'history', remId, page });
  };

  // Save reading history record
  const saveReadingHistory = async (remId: string) => {
    if (editingState.type !== 'history') return;
    const page = editingState.page;

    if (!contextData?.pdfRemId || !page || page <= 0) {
      await plugin.app.toast("Please enter a valid page number.");
      return;
    }

    // Update both the current reading position (for the queue) and the history log
    await setIncrementalReadingPosition(plugin, remId, contextData.pdfRemId, page);
    await addPageToHistory(plugin, remId, contextData.pdfRemId, page, false);

    await plugin.app.toast(`Updated reading position to page ${page}`);

    setEditingState({ type: 'none' });
    await reloadRelatedRems();
  };



  // Load data effect
  useEffect(() => {
    const loadData = async () => {
      if (!contextData?.incrementalRemId || !contextData?.pdfRemId) {
        setIsLoading(false);
        return;
      }
      
      try {
        setIsLoading(true);
        const { incrementalRemId, pdfRemId } = contextData;
        
        // Fetch current rem details
        const currentRem = await plugin.rem.findOne(incrementalRemId);
        if (currentRem) {
          const remText = currentRem.text ? await plugin.richText.toString(currentRem.text) : 'Untitled';
          const isIncremental = await currentRem.hasPowerup(powerupCode);
          setCurrentRemName(remText);
          setIsCurrentRemIncremental(isIncremental);
        }
        
        // Load page range for current rem
        const savedRange = await getIncrementalPageRange(plugin, incrementalRemId, pdfRemId);
        if (savedRange) {
          setPageRangeStart(savedRange.start || 1);
          setPageRangeEnd(savedRange.end || 0);
        } else {
          setPageRangeStart(1);
          setPageRangeEnd(0);
        }
        
        // Load related rems with priorities
        await reloadRelatedRems();

      } catch (error) {
        console.error('PageRange: Error loading data:', error);
        await plugin.app.toast(`Error loading data: ${error.message}`);
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [contextData?.incrementalRemId, contextData?.pdfRemId, plugin]);

  // Recalculate priorities when allIncrementalRems tracker updates
  useEffect(() => {
    if (relatedRems.length > 0 && allIncrementalRems && allIncrementalRems.length > 0) {
      calculatePriorities(relatedRems);
    }
  }, [allIncrementalRems]);

  // Auto-focus main input on load
  useEffect(() => {
    if (!isLoading && contextData) {
      setTimeout(() => {
        inputStartRef.current?.focus();
        inputStartRef.current?.select();
      }, 50);
    }
  }, [isLoading, contextData]);

  // Auto-focus page range editor when editing starts
  useEffect(() => {
    if (editingState.type === 'range') {
      const remId = editingState.remId;
      // Use a longer delay and retry mechanism for first render
      let attempts = 0;
      const maxAttempts = 10; // Try for up to 500ms (10 * 50ms)

      const tryFocus = () => {
        const inputElement = pageRangeInputRefs.current[remId]?.start;

        if (inputElement) {
          inputElement.focus();
          inputElement.select();
        } else if (attempts < maxAttempts) {
          attempts++;
          setTimeout(tryFocus, 50);
        }
      };

      // Start trying after a small initial delay
      setTimeout(tryFocus, 50);
    }
  }, [editingState]);

  const handleSave = async () => {
    if (!contextData?.incrementalRemId || !contextData?.pdfRemId) return;
    
    try {
      const { incrementalRemId, pdfRemId } = contextData;
      const rangeKey = getPageRangeKey(incrementalRemId, pdfRemId);
      
      if (pageRangeStart > 1 || pageRangeEnd > 0) {
        const range = { start: pageRangeStart, end: pageRangeEnd };
        await plugin.storage.setSynced(rangeKey, range);
        await plugin.app.toast(`Saved page range: ${pageRangeStart}-${pageRangeEnd || '∞'}`);
      } else {
        await plugin.storage.setSynced(rangeKey, null);
        await plugin.app.toast('Cleared page range');
      }
      
      plugin.widget.closePopup();
    } catch (error) {
      console.error('PageRange: Error saving:', error);
      await plugin.app.toast(`Error saving: ${error.message}`);
    }
  };

  const handleClear = () => {
    setPageRangeStart(1);
    setPageRangeEnd(0);
  };

  const handleClose = () => plugin.widget.closePopup();



  if (isLoading) {
    return <div className="p-4">Loading...</div>;
  }

  if (!contextData) {
    return (
      <div className="p-4">
        <div className="text-red-600">Error: No context data available.</div>
        <button onClick={handleClose} className="mt-4 px-4 py-2 bg-gray-200 rounded">Close</button>
      </div>
    );
  }

  
  // Calculate unassigned ranges (excluding current rem's range)
  const getUnassignedRanges = () => {
    const assignedRanges = relatedRems
      .filter((item) => item.range)
      .map((item) => item.range)
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
  
    const unassignedRanges = [];
    let lastEnd = 0;
  
    for (const range of assignedRanges) {
      if (range.start > lastEnd + 1) {
        unassignedRanges.push({
          start: lastEnd + 1,
          end: range.start - 1,
        });
      }
      lastEnd = Math.max(lastEnd, range.end || range.start);
    }
  
    const totalPages = contextData?.totalPages;
  
    // Only add a final open range if not all pages are covered.
    if (!totalPages || lastEnd < totalPages) {
      unassignedRanges.push({
        start: lastEnd + 1,
        end: null, // `null` represents the end of the document
      });
    }
  
    return unassignedRanges;
  };

  // Sort related rems: current first, then by page range, then alphabetically
  const sortedRelatedRems = [...relatedRems].sort((a, b) => {
    // Current rem always first
    if (a.remId === contextData?.incrementalRemId) return -1;
    if (b.remId === contextData?.incrementalRemId) return 1;
    
    // Incremental rems before non-incremental
    if (a.isIncremental !== b.isIncremental) {
      return a.isIncremental ? -1 : 1;
    }
    
    // Both have page ranges: sort by start page
    if (a.range && b.range) {
      return a.range.start - b.range.start;
    }
    
    // Only a has page range: a comes first
    if (a.range && !b.range) return -1;
    
    // Only b has page range: b comes first
    if (!a.range && b.range) return 1;
    
    // Neither has page range: sort alphabetically
    return a.name.localeCompare(b.name);
  });
  
  return (
    <div
      className="flex flex-col"
      style={{
        height: '100%',
        width: '100%',
        minWidth: '550px',
        maxWidth: '700px',
        minHeight: '400px',
        backgroundColor: 'var(--rn-clr-background-primary)',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && editingState.type === 'none') {
          e.preventDefault();
          handleSave();
        }
        if (e.key === 'Escape' && editingState.type === 'none') {
          e.preventDefault();
          handleClose();
        }
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">📄</span>
          <span className="font-semibold text-sm" style={{ color: 'var(--rn-clr-content-primary)' }}>PDF Control</span>
          <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            {currentRemName ? `· ${currentRemName.length > 30 ? currentRemName.substring(0, 30) + '...' : currentRemName}` : ''}
          </span>
          {isCurrentRemIncremental && (
            <span className="text-xs" style={{ color: '#3b82f6' }} title="Incremental Rem">⚡</span>
          )}
          {totalPdfReadingTime > 0 && (
            <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              · ⏱️ {formatDuration(totalPdfReadingTime)}
            </span>
          )}
        </div>
        <button
          onClick={handleClose}
          className="p-1 rounded transition-colors text-xs"
          style={{ color: 'var(--rn-clr-content-tertiary)' }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2" style={{ minHeight: 0 }}>

      {/* Current Rem - Quick Edit */}
      <div className="mb-3 p-3 rounded" style={{
        backgroundColor: 'var(--rn-clr-background-secondary)',
        border: '2px solid #3b82f6',
      }}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs">✏️</span>
          <span className="font-semibold text-xs" style={{ color: '#3b82f6' }}>Quick Edit: Current Rem</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>Start page:</label>
            <input
              ref={inputStartRef}
              type="number"
              min="1"
              value={pageRangeStart}
              onChange={(e) => setPageRangeStart(parseInt(e.target.value) || 1)}
              className="w-16 text-center p-1.5 rounded text-xs"
              style={{
                border: '1px solid var(--rn-clr-border-primary)',
                backgroundColor: 'var(--rn-clr-background-primary)',
                color: 'var(--rn-clr-content-primary)',
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>End page:</label>
            <input
              type="number"
              min={pageRangeStart}
              value={pageRangeEnd || ''}
              onChange={(e) => setPageRangeEnd(parseInt(e.target.value) || 0)}
              placeholder="∞"
              className="w-16 text-center p-1.5 rounded text-xs"
              style={{
                border: '1px solid var(--rn-clr-border-primary)',
                backgroundColor: 'var(--rn-clr-background-primary)',
                color: 'var(--rn-clr-content-primary)',
              }}
            />
          </div>
          <div className="flex-1" />
          {pageRangeStart > 1 || pageRangeEnd > 0 ? (
            <span className="text-xs font-medium px-2 py-1 rounded" style={{ backgroundColor: '#dbeafe', color: '#1e40af' }}>
              Pages {pageRangeStart}-{pageRangeEnd || '∞'}
            </span>
          ) : (
            <span className="text-xs px-2 py-1 rounded" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-tertiary)' }}>
              All pages
            </span>
          )}
        </div>
      </div>

      {/* Available Ranges - Hint */}
      {(() => {
        const unassignedRanges = getUnassignedRanges();
        return unassignedRanges.length > 0 ? (
          <div className="mb-3 p-2 rounded flex items-center gap-2" style={{
            backgroundColor: '#fefce8',
            border: '1px solid #fde047',
          }}>
            <span className="text-xs">💡</span>
            <span className="text-xs font-medium" style={{ color: '#92400e' }}>Available ranges:</span>
            <div className="text-xs flex flex-wrap gap-1">
              {unassignedRanges.map((range, idx) => {
                const endPageDisplay =
                  range.end || (contextData?.totalPages > 0 ? contextData.totalPages : '∞');
                return (
                  <span key={idx} className="px-1.5 py-0.5 rounded font-medium" style={{
                    backgroundColor: '#fef9c3',
                    color: '#854d0e',
                  }}>
                    {range.start}-{endPageDisplay}
                  </span>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="mb-3 p-2 rounded flex items-center gap-2" style={{
            backgroundColor: '#fee2e2',
            border: '1px solid #fca5a5',
          }}>
            <span className="text-xs">⚠️</span>
            <span className="text-xs" style={{ color: '#991b1b' }}>
              All pages are already assigned to other rems
            </span>
          </div>
        );
      })()}

      {/* All Rems Using This PDF */}
      <div>
        <div className="flex items-center justify-between py-1 px-1 mb-1">
          <div className="flex items-center gap-2">
            <span className="text-xs">📑</span>
            <span className="font-semibold text-xs" style={{ color: 'var(--rn-clr-content-primary)' }}>All Rems Using This PDF</span>
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-secondary)' }}>{sortedRelatedRems.length}</span>
          </div>
          <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>Click to expand</span>
        </div>
        <div className="flex flex-col gap-1">
          {sortedRelatedRems.map((item) => (
            <PdfRemItem
              key={item.remId}
              item={item}
              isCurrentRem={item.remId === contextData?.incrementalRemId}
              isExpanded={expandedRems.has(item.remId)}
              priorityInfo={remPriorities[item.remId]}
              statistics={remStatistics[item.remId]}
              history={remHistories[item.remId]}
              editingState={editingState}
              onToggleExpanded={toggleExpanded}
              onInitIncremental={handleInitIncrementalRem}
              onStartEditingRem={startEditingRem}
              onStartEditingPriority={startEditingPriority}
              onStartEditingHistory={startEditingHistory}
              onSaveRemRange={saveRemRange}
              onSavePriority={savePriority}
              onSaveHistory={saveReadingHistory}
              onCancelEditing={() => setEditingState({ type: 'none' })}
              onEditingStateChange={setEditingState}
              startInputRef={(el) => {
                if (!pageRangeInputRefs.current[item.remId]) pageRangeInputRefs.current[item.remId] = { start: null, end: null };
                pageRangeInputRefs.current[item.remId].start = el;
              }}
              endInputRef={(el) => {
                if (!pageRangeInputRefs.current[item.remId]) pageRangeInputRefs.current[item.remId] = { start: null, end: null };
                pageRangeInputRefs.current[item.remId].end = el;
              }}
            />
          ))}
        </div>
      </div>
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-between px-3 py-2 shrink-0"
        style={{ borderTop: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}
      >
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
          <kbd className="px-1.5 py-0.5 rounded font-mono" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', border: '1px solid var(--rn-clr-border-primary)', fontSize: '10px' }}>Enter</kbd>
          <span>save</span>
          <kbd className="px-1.5 py-0.5 rounded font-mono" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', border: '1px solid var(--rn-clr-border-primary)', fontSize: '10px' }}>Esc</kbd>
          <span>close</span>
        </div>
        <div className="flex items-center gap-2">
          {(pageRangeStart > 1 || pageRangeEnd > 0) && (
            <button
              onClick={handleClear}
              className="px-2 py-1 text-xs rounded transition-colors"
              style={{ color: 'var(--rn-clr-content-tertiary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; e.currentTarget.style.color = '#dc2626'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--rn-clr-content-tertiary)'; }}
            >
              Clear
            </button>
          )}
          <button
            onClick={handleSave}
            className="px-3 py-1 text-xs rounded transition-colors"
            style={{ backgroundColor: '#3b82f6', color: 'white' }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2563eb'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#3b82f6'; }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

renderWidget(PageRangeWidget);