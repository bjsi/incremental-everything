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
import { calculateRelativePercentile } from '../lib/utils';
import {
  PriorityBadge,
  ReadingHistoryView,
  InlinePriorityEditor,
  InlinePageRangeEditor,
  InlineHistoryEditor
} from '../components';
import { IncrementalRem } from '../lib/incremental_rem';
import { getIncrementalRemFromRem, initIncrementalRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';

/**
 * Format seconds into a human-readable duration string
 */
function formatDuration(seconds: number): string {
  if (!seconds || seconds === 0) return '';

  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0
      ? `${hours}h ${minutes}m`
      : `${hours}h`;
  }
}

function PageRangeWidget() {
  const plugin = usePlugin();
  const pageRangeInputRefs = React.useRef<Record<string, {start: HTMLInputElement | null, end: HTMLInputElement | null}>>({});
  const inputStartRef = React.useRef<HTMLInputElement>(null);
  
  const contextData = useTrackerPlugin(
    async (rp) => {
      const data = await rp.storage.getSession('pageRangeContext');
      console.log('PageRange: Context data from session:', data);
      return data;
    },
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
  const [pageHistory, setPageHistory] = useState<PageHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [currentRemName, setCurrentRemName] = useState<string>('');
  const [isCurrentRemIncremental, setIsCurrentRemIncremental] = useState<boolean>(false);
  const [remHistories, setRemHistories] = useState<Record<string, PageHistoryEntry[]>>({});
  const [expandedRems, setExpandedRems] = useState<Set<string>>(new Set());
  const [editingRemId, setEditingRemId] = useState<string | null>(null);
  const [editingRanges, setEditingRanges] = useState<Record<string, {start: number, end: number}>>({});
  const [remPriorities, setRemPriorities] = useState<Record<string, {absolute: number, percentile: number | null}>>({});
  const [editingPriorityRemId, setEditingPriorityRemId] = useState<string | null>(null);
  const [editingPriorities, setEditingPriorities] = useState<Record<string, number>>({});
  const [editingHistoryRemId, setEditingHistoryRemId] = useState<string | null>(null);
  const [editingHistoryPage, setEditingHistoryPage] = useState<number>(0);
  const [remStatistics, setRemStatistics] = useState<Record<string, any>>({});
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
        setEditingPriorityRemId(remId);
        setEditingPriorities({
          ...editingPriorities,
          [remId]: incRemInfo.priority
        });
      }
    }
  };

  // Save priority inline
  const savePriority = async (remId: string) => {
    const priority = editingPriorities[remId];
    if (priority !== undefined) {
      const rem = await plugin.rem.findOne(remId);
      if (rem) {
        await rem.setPowerupProperty(powerupCode, prioritySlotCode, [priority.toString()]);
        
        // Update the incremental rem list
        const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
        if (incRemInfo) {
          await updateIncrementalRemCache(plugin, incRemInfo);
        }
        
        setEditingPriorityRemId(null);
        await reloadRelatedRems();
        await plugin.app.toast(`Priority updated to ${priority}`);
      }
    }
  };

  // Calculate priority info for each incremental rem
  const calculatePriorities = async (rems: any[], allRems?: IncrementalRem[]) => {
    const priorities: Record<string, {absolute: number, percentile: number | null}> = {};
    
    // Use passed allRems or fetch from storage
    const remsForCalculation = allRems || (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
    
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
    
    // Ensure we have the latest all incremental rems data
    const allRems = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];
    
    // Calculate priorities with the fetched data
    await calculatePriorities(related, allRems);
    
    // Fetch reading histories and statistics for each related rem
    const histories: Record<string, PageHistoryEntry[]> = {}; // CHANGED TYPE
    const statistics: Record<string, any> = {}; // ADD THIS LINE
    let totalTime = 0; // ADD THIS LINE
    
    for (const item of related) {
        // Always fetch stats if it's a related rem
        const history = await getPageHistory(plugin, item.remId, contextData.pdfRemId);
        if (history.length > 0) {
            histories[item.remId] = history;
        }
        
        // ADD THESE LINES
        const stats = await getReadingStatistics(plugin, item.remId, contextData.pdfRemId);
        statistics[item.remId] = stats;
        totalTime += stats.totalTimeSeconds;
        
    }
    
    setRemHistories(histories);
    setRemStatistics(statistics); // ADD THIS LINE
    setTotalPdfReadingTime(totalTime); // ADD THIS LINE
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
    
    setEditingRemId(remId);
    
    // Load existing range for this rem
    const savedRange = await getIncrementalPageRange(plugin, remId, contextData.pdfRemId);
    if (savedRange) {
      setEditingRanges({
        ...editingRanges,
        [remId]: { start: savedRange.start || 1, end: savedRange.end || 0 }
      });
    } else {
      setEditingRanges({
        ...editingRanges,
        [remId]: { start: 1, end: 0 }
      });
    }
  };

  // Save page range for a specific rem
  const saveRemRange = async (remId: string) => {
    if (!contextData?.pdfRemId) return;
    
    const range = editingRanges[remId];
    if (!range) return;
    
    const rangeKey = getPageRangeKey(remId, contextData.pdfRemId);
    
    if (range.start > 1 || range.end > 0) {
      await plugin.storage.setSynced(rangeKey, range);
      await plugin.app.toast(`Saved page range: ${range.start}-${range.end || '∞'}`);
    } else {
      await plugin.storage.setSynced(rangeKey, null);
      await plugin.app.toast('Cleared page range');
    }
    
    setEditingRemId(null);
    await reloadRelatedRems();
  };

  // --- NEW: Start editing history ---
  const startEditingHistory = (remId: string, currentPage: number | null) => {
    setEditingHistoryRemId(remId);
    // If currentPage is not set, try to get the last page from history
    if (currentPage && currentPage > 0) {
      setEditingHistoryPage(currentPage);
    } else {
      // Check if we have history for this rem
      const history = remHistories[remId];
      if (history && history.length > 0) {
        // Use the last recorded page from history
        const lastEntry = history[history.length - 1];
        setEditingHistoryPage(lastEntry.page);
      } else {
        // Default to 1 if no history exists
        setEditingHistoryPage(1);
      }
    }
  };
  
  // --- NEW: Save reading history record ---
  const saveReadingHistory = async (remId: string) => {
    if (!contextData?.pdfRemId || !editingHistoryPage || editingHistoryPage <= 0) {
      await plugin.app.toast("Please enter a valid page number.");
      return;
    }
  
    // Update both the current reading position (for the queue) and the history log
    await setIncrementalReadingPosition(plugin, remId, contextData.pdfRemId, editingHistoryPage);
    await addPageToHistory(plugin, remId, contextData.pdfRemId, editingHistoryPage, false);
  
    await plugin.app.toast(`Updated reading position to page ${editingHistoryPage}`);
    
    // Reset state and reload the list to show the new data
    setEditingHistoryRemId(null);
    setEditingHistoryPage(0);
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
        
        // Load history for current rem
        const history = await getPageHistory(plugin, incrementalRemId, pdfRemId);
        setPageHistory(history || []);
        
      } catch (error) {
        console.error('PageRange: Error loading data:', error);
        await plugin.app.toast(`Error loading data: ${error.message}`);
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [contextData?.incrementalRemId, contextData?.pdfRemId, plugin]);
    
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
    if (editingRemId) {
      // Use a longer delay and retry mechanism for first render
      let attempts = 0;
      const maxAttempts = 10; // Try for up to 500ms (10 * 50ms)
      
      const tryFocus = () => {
        const inputElement = pageRangeInputRefs.current[editingRemId]?.start;
        
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
  }, [editingRemId]);

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

  
  // ** START OF FIX **
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
  // ** END OF FIX **
  
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
        if (e.key === 'Enter' && !editingRemId && !editingPriorityRemId && !editingHistoryRemId) {
          e.preventDefault();
          handleSave();
        }
        if (e.key === 'Escape' && !editingRemId && !editingPriorityRemId && !editingHistoryRemId) {
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
          {sortedRelatedRems.map((item) => {
            const isCurrentRem = item.remId === contextData?.incrementalRemId;
            const priorityInfo = remPriorities[item.remId];

            return (
              <div
                key={item.remId}
                className="rounded p-2 cursor-pointer transition-colors"
                style={{
                  backgroundColor: isCurrentRem ? 'var(--rn-clr-background-tertiary)' : 'var(--rn-clr-background-secondary)',
                  border: isCurrentRem ? '2px solid #10b981' : '1px solid var(--rn-clr-border-primary)',
                }}
                onClick={() => toggleExpanded(item.remId)}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = isCurrentRem ? 'var(--rn-clr-background-tertiary)' : 'var(--rn-clr-background-secondary)'; }}
              >
                {/* Main Rem Info */}
                <div className="flex items-center gap-2">
                  <span className="text-xs transition-transform" style={{
                    color: 'var(--rn-clr-content-secondary)',
                    transform: expandedRems.has(item.remId) ? 'rotate(0deg)' : 'rotate(-90deg)'
                  }}>▼</span>
                  {item.isIncremental && <span className="text-xs" title="Incremental Rem">⚡</span>}
                  <span className="text-sm flex-1 truncate" style={{ color: 'var(--rn-clr-content-primary)' }}>
                    {item.name}
                  </span>
                  {isCurrentRem && (
                    <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: '#d1fae5', color: '#065f46' }}>Current</span>
                  )}
                  {item.isIncremental && priorityInfo && (
                    <PriorityBadge priority={priorityInfo.absolute} percentile={priorityInfo.percentile ?? undefined} compact />
                  )}
                  {item.range && (
                    <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-secondary)' }} title="Page range">
                      p.{item.range.start}-{item.range.end || '∞'}
                    </span>
                  )}
                  {item.currentPage && (
                    <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }} title="Current reading position">
                      📖{item.currentPage}
                    </span>
                  )}
                  {remStatistics[item.remId]?.totalTimeSeconds > 0 && (
                    <span className="text-xs" style={{ color: '#10b981' }} title="Total reading time">
                      ⏱️{formatDuration(remStatistics[item.remId].totalTimeSeconds)}
                    </span>
                  )}
                </div>
                
                {/* Expanded Content */}
                {expandedRems.has(item.remId) && (
                  <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--rn-clr-border-primary)' }} onClick={(e) => e.stopPropagation()}>
                    {/* Action Buttons */}
                    <div className="flex gap-1 mb-2 flex-wrap">
                      {!item.isIncremental ? (
                        <button
                          onClick={() => handleInitIncrementalRem(item.remId)}
                          className="px-2 py-1 text-xs rounded transition-colors"
                          style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: '#10b981' }}
                          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#10b981'; e.currentTarget.style.color = 'white'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; e.currentTarget.style.color = '#10b981'; }}
                        >
                          Make Incremental
                        </button>
                      ) : (
                        <>
                          {editingRemId === item.remId ? (
                            <>
                              <button onClick={() => saveRemRange(item.remId)} className="px-2 py-1 text-xs rounded" style={{ backgroundColor: '#3b82f6', color: 'white' }}>Save</button>
                              <button onClick={() => setEditingRemId(null)} className="px-2 py-1 text-xs rounded" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-secondary)' }}>Cancel</button>
                            </>
                          ) : editingPriorityRemId === item.remId ? (
                            <button onClick={() => setEditingPriorityRemId(null)} className="px-2 py-1 text-xs rounded" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-secondary)' }}>Cancel</button>
                          ) : editingHistoryRemId === item.remId ? (
                            <button onClick={() => setEditingHistoryRemId(null)} className="px-2 py-1 text-xs rounded" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-secondary)' }}>Cancel</button>
                          ) : (
                            <>
                              <button
                                onClick={() => startEditingRem(item.remId)}
                                className="px-2 py-1 text-xs rounded transition-colors"
                                style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: '#3b82f6' }}
                                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#3b82f6'; e.currentTarget.style.color = 'white'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; e.currentTarget.style.color = '#3b82f6'; }}
                              >
                                📄 Range
                              </button>
                              <button
                                onClick={() => startEditingPriority(item.remId)}
                                className="px-2 py-1 text-xs rounded transition-colors"
                                style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: '#8b5cf6' }}
                                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#8b5cf6'; e.currentTarget.style.color = 'white'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; e.currentTarget.style.color = '#8b5cf6'; }}
                              >
                                ★ Priority
                              </button>
                              <button
                                onClick={() => startEditingHistory(item.remId, item.currentPage)}
                                className="px-2 py-1 text-xs rounded transition-colors"
                                style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: '#10b981' }}
                                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#10b981'; e.currentTarget.style.color = 'white'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; e.currentTarget.style.color = '#10b981'; }}
                              >
                                📖 History
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                    
                    {/* Inline Priority Editor */}
                    {editingPriorityRemId === item.remId && (
                      <InlinePriorityEditor
                        value={editingPriorities[item.remId]}
                        onChange={(value) => setEditingPriorities({ ...editingPriorities, [item.remId]: value })}
                        onSave={() => savePriority(item.remId)}
                        onCancel={() => setEditingPriorityRemId(null)}
                      />
                    )}

                    {/* Page Range Editor */}
                    {editingRemId === item.remId && editingRanges[item.remId] && (
                      <InlinePageRangeEditor
                        startValue={editingRanges[item.remId].start}
                        endValue={editingRanges[item.remId].end}
                        onStartChange={(value) => setEditingRanges({ ...editingRanges, [item.remId]: { ...editingRanges[item.remId], start: value } })}
                        onEndChange={(value) => setEditingRanges({ ...editingRanges, [item.remId]: { ...editingRanges[item.remId], end: value } })}
                        onSave={() => saveRemRange(item.remId)}
                        onCancel={() => setEditingRemId(null)}
                        startInputRef={(el) => {
                          if (!pageRangeInputRefs.current[item.remId]) pageRangeInputRefs.current[item.remId] = { start: null, end: null };
                          pageRangeInputRefs.current[item.remId].start = el;
                        }}
                        endInputRef={(el) => {
                          if (!pageRangeInputRefs.current[item.remId]) pageRangeInputRefs.current[item.remId] = { start: null, end: null };
                          pageRangeInputRefs.current[item.remId].end = el;
                        }}
                      />
                    )}

                    {/* Inline History Editor */}
                    {editingHistoryRemId === item.remId && (
                      <InlineHistoryEditor
                        value={editingHistoryPage}
                        onChange={setEditingHistoryPage}
                        onSave={() => saveReadingHistory(item.remId)}
                        onCancel={() => setEditingHistoryRemId(null)}
                      />
                    )}
                    
                    {/* Reading History */}
                    {remHistories[item.remId] && remHistories[item.remId].length > 0 && (
                      <ReadingHistoryView
                        history={remHistories[item.remId]}
                        statistics={remStatistics[item.remId]}
                        formatDuration={formatDuration}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
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