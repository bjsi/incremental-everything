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
  addPageToHistory
} from '../lib/pdfUtils';
import { powerupCode, prioritySlotCode, allIncrementalRemKey } from '../lib/consts';
import { percentileToHslColor, calculateRelativePercentile } from '../lib/utils';
import { IncrementalRem } from '../lib/incremental_rem';
import { getIncrementalRemFromRem, initIncrementalRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';

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
  const [pageHistory, setPageHistory] = useState<Array<{page: number, timestamp: number}>>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [currentRemName, setCurrentRemName] = useState<string>('');
  const [isCurrentRemIncremental, setIsCurrentRemIncremental] = useState<boolean>(false);
  const [remHistories, setRemHistories] = useState<Record<string, Array<{page: number, timestamp: number}>>>({});
  const [expandedRems, setExpandedRems] = useState<Set<string>>(new Set());
  const [editingRemId, setEditingRemId] = useState<string | null>(null);
  const [editingRanges, setEditingRanges] = useState<Record<string, {start: number, end: number}>>({});
  const [remPriorities, setRemPriorities] = useState<Record<string, {absolute: number, percentile: number | null}>>({});
  const [editingPriorityRemId, setEditingPriorityRemId] = useState<string | null>(null);
  const [editingPriorities, setEditingPriorities] = useState<Record<string, number>>({});
  
  // --- NEW: State for the history editor ---
  const [editingHistoryRemId, setEditingHistoryRemId] = useState<string | null>(null);
  const [editingHistoryPage, setEditingHistoryPage] = useState<number>(0);

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

  // Reload the related rems list
  const reloadRelatedRems = async () => {
    if (!contextData?.pdfRemId) return;
    
    const related = await getAllIncrementsForPDF(plugin, contextData.pdfRemId);
    setRelatedRems(related);
    
    // Ensure we have the latest all incremental rems data
    const allRems = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];
    
    // Calculate priorities with the fetched data
    await calculatePriorities(related, allRems);
    
    // Fetch reading histories for each related rem
    const histories: Record<string, Array<{page: number, timestamp: number}>> = {};
    for (const item of related) {
      if (item.currentPage) {
        const history = await getPageHistory(plugin, item.remId, contextData.pdfRemId);
        if (history.length > 0) {
          histories[item.remId] = history;
        }
      }
    }
    setRemHistories(histories);
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
    // Pre-fill with the current page to make it easier to increment
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
    await addPageToHistory(plugin, remId, contextData.pdfRemId, editingHistoryPage);
  
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
      .filter((item) => item.isIncremental && item.range)
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
      className="flex flex-col h-full"
      style={{
        minWidth: '600px',
        maxWidth: '750px',
        maxHeight: '95vh',
        backgroundColor: 'var(--rn-clr-background-primary)',
        borderRadius: '12px',
        overflow: 'hidden',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)'
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
      <div className="px-7 py-6" style={{
        borderBottom: '1px solid var(--rn-clr-border-primary)',
        backgroundColor: 'var(--rn-clr-background-secondary)',
        boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)'
      }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="text-4xl" style={{ lineHeight: '1' }}>📄</div>
            <div>
              <h2 className="text-2xl font-bold tracking-tight" style={{
                color: 'var(--rn-clr-content-primary)',
                letterSpacing: '-0.02em'
              }}>
                PDF Control Panel
              </h2>
              <div className="text-sm mt-1.5 flex items-center gap-2" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                <span className="font-medium">{currentRemName || '...'}</span>
                {isCurrentRemIncremental && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                    style={{
                      backgroundColor: '#dbeafe',
                      color: '#1e40af'
                    }}
                    title="Incremental Rem"
                  >
                    ⚡ Incremental
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-2.5 rounded-xl transition-all"
            style={{
              color: 'var(--rn-clr-content-secondary)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
              e.currentTarget.style.transform = 'scale(1.05)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.transform = 'scale(1)';
            }}
            title="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-5"
        style={{ backgroundColor: 'var(--rn-clr-background-primary)' }}
      >

      {/* Current Rem Settings */}
      <div className="p-5 rounded-xl mb-5" style={{
        backgroundColor: 'var(--rn-clr-background-secondary)',
        border: '1px solid var(--rn-clr-border-primary)',
        boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px 0 rgba(0, 0, 0, 0.03)'
      }}>
        <div className="font-bold mb-4 text-base" style={{ color: 'var(--rn-clr-content-primary)' }}>
          Quick Edit - Current Rem Page Range
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex gap-5">
            <div className="flex items-center gap-2.5">
              <label className="font-medium text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>Start:</label>
              <input
                ref={inputStartRef}
                type="number"
                min="1"
                value={pageRangeStart}
                onChange={(e) => setPageRangeStart(parseInt(e.target.value) || 1)}
                className="w-24 text-center p-2 rounded-lg transition-all"
                style={{
                  border: '1.5px solid var(--rn-clr-border-primary)',
                  backgroundColor: 'var(--rn-clr-background-primary)',
                  color: 'var(--rn-clr-content-primary)',
                  fontSize: '14px',
                  fontWeight: '500'
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = '#3b82f6';
                  e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.1)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'var(--rn-clr-border-primary)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              />
            </div>
            <div className="flex items-center gap-2.5">
              <label className="font-medium text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>End:</label>
              <input
                type="number"
                min={pageRangeStart}
                value={pageRangeEnd || ''}
                onChange={(e) => setPageRangeEnd(parseInt(e.target.value) || 0)}
                placeholder="No limit"
                className="w-24 text-center p-2 rounded-lg transition-all"
                style={{
                  border: '1.5px solid var(--rn-clr-border-primary)',
                  backgroundColor: 'var(--rn-clr-background-primary)',
                  color: 'var(--rn-clr-content-primary)',
                  fontSize: '14px',
                  fontWeight: '500'
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = '#3b82f6';
                  e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.1)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'var(--rn-clr-border-primary)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              />
            </div>
          </div>
          {pageRangeStart > 1 || pageRangeEnd > 0 ? (
            <div className="text-sm font-semibold px-3 py-1.5 rounded-lg inline-flex items-center gap-2" style={{
              backgroundColor: '#dbeafe',
              color: '#1e40af',
              width: 'fit-content'
            }}>
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V7.414A2 2 0 0015.414 6L12 2.586A2 2 0 0010.586 2H6zm5 6a1 1 0 10-2 0v3.586l-1.293-1.293a1 1 0 10-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 11.586V8z" clipRule="evenodd" />
              </svg>
              Pages {pageRangeStart}-{pageRangeEnd || '∞'}
            </div>
          ) : (
            <div className="text-sm px-3 py-1.5" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              No page range restrictions
            </div>
          )}
        </div>
      </div>

      {/* Available Ranges */}
      {(() => {
        const unassignedRanges = getUnassignedRanges();
        return unassignedRanges.length > 0 ? (
          <div className="p-4 rounded-xl mb-5" style={{
            backgroundColor: '#fefce8',
            border: '1.5px solid #fde047',
            boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)'
          }}>
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4" style={{ color: '#ca8a04' }} fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
              <div className="font-bold text-sm" style={{ color: '#92400e' }}>Available page ranges</div>
            </div>
            <div className="text-sm font-medium flex flex-wrap gap-2" style={{ color: '#713f12' }}>
              {unassignedRanges.map((range, idx) => {
                const endPageDisplay =
                  range.end || (contextData?.totalPages > 0 ? contextData.totalPages : '∞');
                return (
                  <span key={idx} className="px-2.5 py-1 rounded-lg" style={{
                    backgroundColor: '#fef9c3',
                    color: '#854d0e',
                    border: '1px solid #fde047'
                  }}>
                    {range.start}-{endPageDisplay}
                  </span>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-xl mb-5 flex items-center gap-2" style={{
            backgroundColor: '#fee2e2',
            border: '1.5px solid #fca5a5',
            boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)'
          }}>
            <svg className="w-5 h-5" style={{ color: '#dc2626' }} fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <div className="text-sm font-semibold" style={{ color: '#991b1b' }}>
              All pages have been assigned
            </div>
          </div>
        );
      })()}

      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 h-px" style={{ backgroundColor: 'var(--rn-clr-border-primary)' }}></div>
        <span className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
          All Rems
        </span>
        <div className="flex-1 h-px" style={{ backgroundColor: 'var(--rn-clr-border-primary)' }}></div>
      </div>

      {/* All Rems Using This PDF (including current) */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="text-2xl">📑</div>
          <h3 className="font-bold text-base" style={{ color: 'var(--rn-clr-content-primary)' }}>
            All Rems Using This PDF
          </h3>
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold" style={{
            backgroundColor: 'var(--rn-clr-background-tertiary)',
            color: 'var(--rn-clr-content-secondary)'
          }}>
            {sortedRelatedRems.length}
          </span>
        </div>
        <div className="flex flex-col gap-3 max-h-96 overflow-y-auto pr-1">
          {sortedRelatedRems.map((item) => {
            const isCurrentRem = item.remId === contextData?.incrementalRemId;
            const priorityInfo = remPriorities[item.remId];
            const priorityColor = priorityInfo?.percentile ?
              percentileToHslColor(priorityInfo.percentile) : 'transparent';

            const borderLeftColor = isCurrentRem ? '#10b981' : (item.isIncremental ? '#3b82f6' : 'var(--rn-clr-border-primary)');

            return (
              <div key={item.remId} className="rounded-xl transition-all" style={{
                backgroundColor: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
                borderLeft: `4px solid ${borderLeftColor}`,
                boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = '0 1px 3px 0 rgba(0, 0, 0, 0.05)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
              >
                {/* Main Rem Info - Clickable */}
                <div
                  className="p-4 cursor-pointer transition-all"
                  onClick={() => toggleExpanded(item.remId)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <div className="flex items-center gap-2.5 mb-2.5">
                    <span className="text-sm font-medium transition-transform" style={{
                      color: 'var(--rn-clr-content-secondary)',
                      transform: expandedRems.has(item.remId) ? 'rotate(90deg)' : 'rotate(0deg)'
                    }}>
                      ▶
                    </span>
                    {item.isIncremental && <span className="text-base" title="Incremental Rem">⚡</span>}
                    <div className="font-semibold flex-1 text-base" style={{ color: 'var(--rn-clr-content-primary)' }}>
                      {item.name}
                      {isCurrentRem && (
                        <span className="ml-2 text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-bold" style={{
                          backgroundColor: '#d1fae5',
                          color: '#065f46'
                        }}>
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                          </svg>
                          Current
                        </span>
                      )}
                    </div>
                    {/* Priority Badge with Color */}
                    {item.isIncremental && priorityInfo && (
                      <div
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white shadow-sm"
                        style={{ backgroundColor: priorityColor }}
                        title={`Priority: ${priorityInfo.absolute} (${priorityInfo.percentile}% of KB)`}
                      >
                        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                        {priorityInfo.absolute} <span className="opacity-75">({priorityInfo.percentile}%)</span>
                      </div>
                    )}
                  </div>
                  {item.range ? (
                    <div className="text-sm flex flex-wrap items-center gap-2.5 ml-7" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2H6zm1 2a1 1 0 000 2h6a1 1 0 100-2H7zm6 7a1 1 0 011 1v3a1 1 0 11-2 0v-3a1 1 0 011-1zm-3 3a1 1 0 100 2h.01a1 1 0 100-2H10zm-4 1a1 1 0 011-1h.01a1 1 0 110 2H7a1 1 0 01-1-1zm1-4a1 1 0 100 2h.01a1 1 0 100-2H7zm2 1a1 1 0 011-1h.01a1 1 0 110 2H10a1 1 0 01-1-1zm4-4a1 1 0 100 2h.01a1 1 0 100-2H13zM9 9a1 1 0 011-1h.01a1 1 0 110 2H10a1 1 0 01-1-1zM7 8a1 1 0 000 2h.01a1 1 0 000-2H7z" clipRule="evenodd" />
                        </svg>
                        Pages {item.range.start} - {item.range.end || '∞'}
                      </span>
                      {item.isIncremental && item.currentPage && (
                        <>
                          <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>•</span>
                          <span className="font-medium">At: {item.currentPage}</span>
                          {remHistories[item.remId] && (() => {
                            const lastEntry = remHistories[item.remId][remHistories[item.remId].length - 1];
                            if (lastEntry && lastEntry.timestamp) {
                              const date = new Date(lastEntry.timestamp);
                              return (
                                <span className="text-xs px-2 py-0.5 rounded" style={{
                                  backgroundColor: 'var(--rn-clr-background-tertiary)',
                                  color: 'var(--rn-clr-content-tertiary)'
                                }}>
                                  {date.toLocaleDateString('en-US', {
                                    month: 'short',
                                    day: 'numeric'
                                  })} {date.toLocaleTimeString('en-US', {
                                    hour: 'numeric',
                                    minute: '2-digit',
                                    hour12: true
                                  })}
                                </span>
                              );
                            }
                            return '';
                          })()}
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="text-sm ml-7" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                      No page range set
                    </div>
                  )}
                </div>
                
                {/* Expanded Content */}
                {expandedRems.has(item.remId) && (
                  <div className="pt-3 px-3 pb-3" style={{
                    borderTop: '1px solid var(--rn-clr-border-primary)'
                  }}>
                    {/* Action Buttons */}
                    <div className="flex gap-2 mb-3 flex-wrap">
                      {!item.isIncremental ? (
                        <button
                          onClick={() => handleInitIncrementalRem(item.remId)}
                          className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                          style={{
                            backgroundColor: '#10B981',
                            color: 'white',
                          }}
                        >
                          Make Incremental
                        </button>
                      ) : (
                        <>
                          {editingRemId === item.remId ? (
                            <>
                              <button
                                onClick={() => saveRemRange(item.remId)}
                                className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                                style={{
                                  backgroundColor: '#3B82F6',
                                  color: 'white',
                                }}
                              >
                                Save Range
                              </button>
                              <button
                                onClick={() => setEditingRemId(null)}
                                className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                                style={{
                                  backgroundColor: '#6B7280',
                                  color: 'white',
                                }}
                              >
                                Cancel
                              </button>
                            </>
                          ) : editingPriorityRemId === item.remId ? (
                            <button
                              onClick={() => setEditingPriorityRemId(null)}
                              className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                              style={{
                                backgroundColor: '#6B7280',
                                color: 'white',
                              }}
                            >
                              Cancel Priority Edit
                            </button>
                          ) : editingHistoryRemId === item.remId ? (
                            <button
                              onClick={() => setEditingHistoryRemId(null)}
                              className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                              style={{
                                backgroundColor: '#6B7280',
                                color: 'white',
                              }}
                            >
                              Cancel History Edit
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => startEditingRem(item.remId)}
                                className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                                style={{
                                  backgroundColor: '#3B82F6',
                                  color: 'white',
                                }}
                              >
                                Edit Page Range
                              </button>
                              <button
                                onClick={() => startEditingPriority(item.remId)}
                                className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                                style={{
                                  backgroundColor: '#8B5CF6',
                                  color: 'white',
                                }}
                              >
                                Edit Priority
                              </button>
                              <button
                                onClick={() => startEditingHistory(item.remId, item.currentPage)}
                                className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                                style={{
                                  backgroundColor: '#10B981',
                                  color: 'white',
                                }}
                              >
                                Add History Record
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                    
                    {/* Inline Priority Editor */}
                    {editingPriorityRemId === item.remId && (
                      <div className="flex flex-col gap-2 mb-3 p-3 rounded" style={{
                        backgroundColor: '#f3e8ff',
                        border: '1px solid #c084fc'
                      }}>
                        <div className="flex items-center gap-2">
                          <label className="text-xs font-semibold" style={{ color: '#6b21a8' }}>Priority:</label>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={editingPriorities[item.remId]}
                            onChange={(e) => setEditingPriorities({
                              ...editingPriorities,
                              [item.remId]: Math.min(100, Math.max(0, parseInt(e.target.value) || 0))
                            })}
                            className="w-16 text-xs p-1.5 rounded"
                            style={{
                              border: '1px solid var(--rn-clr-border-primary)',
                              backgroundColor: 'var(--rn-clr-background-primary)',
                              color: 'var(--rn-clr-content-primary)'
                            }}
                          />
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={editingPriorities[item.remId]}
                            onChange={(e) => setEditingPriorities({
                              ...editingPriorities,
                              [item.remId]: parseInt(e.target.value)
                            })}
                            className="flex-1"
                            style={{ accentColor: percentileToHslColor(
                              calculateRelativePercentile(
                                allIncrementalRems || [],
                                item.remId
                              ) || 50
                            )}}
                          />
                        </div>
                        <div className="text-xs" style={{ color: '#7c3aed' }}>
                          Lower values = higher priority (0 is highest, 100 is lowest)
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => savePriority(item.remId)}
                            className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                            style={{
                              backgroundColor: '#8B5CF6',
                              color: 'white',
                            }}
                          >
                            Save Priority
                          </button>
                          <button
                            onClick={() => setEditingPriorityRemId(null)}
                            className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                            style={{
                              backgroundColor: '#6B7280',
                              color: 'white',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    
                    {/* Page Range Editor */}
                    {editingRemId === item.remId && editingRanges[item.remId] && (
                      <div className="flex gap-2 mb-3 items-center p-3 rounded" style={{
                        backgroundColor: '#dbeafe',
                        border: '1px solid #60a5fa'
                      }}>
                        <label className="text-xs font-semibold" style={{ color: '#1e40af' }}>Pages:</label>
                        <input
                          ref={(el) => {
                            if (!pageRangeInputRefs.current[item.remId]) {
                              pageRangeInputRefs.current[item.remId] = { start: null, end: null };
                            }
                            pageRangeInputRefs.current[item.remId].start = el;
                          }}
                          type="number"
                          min="1"
                          value={editingRanges[item.remId].start}
                          onChange={(e) => setEditingRanges({
                            ...editingRanges,
                            [item.remId]: {
                              ...editingRanges[item.remId],
                              start: parseInt(e.target.value) || 1
                            }
                          })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              saveRemRange(item.remId);
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditingRemId(null);
                            }
                            if (e.key === 'Tab' && e.shiftKey) {
                              e.preventDefault();
                              pageRangeInputRefs.current[item.remId]?.end?.focus();
                            }
                          }}
                          className="w-20 text-xs p-1.5 rounded"
                          style={{
                            border: '1px solid var(--rn-clr-border-primary)',
                            backgroundColor: 'var(--rn-clr-background-primary)',
                            color: 'var(--rn-clr-content-primary)'
                          }}
                          placeholder="Start"
                        />
                        <span className="text-xs" style={{ color: '#1e40af' }}>to</span>
                        <input
                          ref={(el) => {
                            if (!pageRangeInputRefs.current[item.remId]) {
                              pageRangeInputRefs.current[item.remId] = { start: null, end: null };
                            }
                            pageRangeInputRefs.current[item.remId].end = el;
                          }}
                          type="number"
                          min={editingRanges[item.remId].start}
                          value={editingRanges[item.remId].end || ''}
                          onChange={(e) => setEditingRanges({
                            ...editingRanges,
                            [item.remId]: {
                              ...editingRanges[item.remId],
                              end: parseInt(e.target.value) || 0
                            }
                          })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              saveRemRange(item.remId);
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditingRemId(null);
                            }
                            if (e.key === 'Tab' && !e.shiftKey) {
                              e.preventDefault();
                              pageRangeInputRefs.current[item.remId]?.start?.focus();
                            }
                          }}
                          className="w-20 text-xs p-1.5 rounded"
                          style={{
                            border: '1px solid var(--rn-clr-border-primary)',
                            backgroundColor: 'var(--rn-clr-background-primary)',
                            color: 'var(--rn-clr-content-primary)'
                          }}
                          placeholder="End"
                        />
                      </div>
                    )}

                    {/* Inline History Editor */}
                    {editingHistoryRemId === item.remId && (
                      <div className="flex flex-col gap-2 mb-3 p-3 rounded" style={{
                        backgroundColor: '#d1fae5',
                        border: '1px solid #34d399'
                      }}>
                        <div className="flex items-center gap-2">
                          <label className="text-xs font-semibold" style={{ color: '#065f46' }}>End Page:</label>
                          <input
                            type="number"
                            min={1}
                            value={editingHistoryPage || ''}
                            onChange={(e) => setEditingHistoryPage(parseInt(e.target.value) || 0)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                saveReadingHistory(item.remId);
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                setEditingHistoryRemId(null);
                              }
                            }}
                            className="w-20 text-xs p-1.5 rounded"
                            style={{
                              border: '1px solid var(--rn-clr-border-primary)',
                              backgroundColor: 'var(--rn-clr-background-primary)',
                              color: 'var(--rn-clr-content-primary)'
                            }}
                            placeholder="e.g., 42"
                            autoFocus
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => saveReadingHistory(item.remId)}
                            className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                            style={{
                              backgroundColor: '#10B981',
                              color: 'white',
                            }}
                          >
                            Save Record
                          </button>
                          <button
                            onClick={() => setEditingHistoryRemId(null)}
                            className="px-3 py-1.5 text-xs rounded font-medium transition-opacity hover:opacity-80"
                            style={{
                              backgroundColor: '#6B7280',
                              color: 'white',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    
                    {/* Reading History */}
                    {remHistories[item.remId] && remHistories[item.remId].length > 0 && (
                      <div className="mt-2">
                        <div className="text-xs font-semibold mb-2" style={{ color: 'var(--rn-clr-content-primary)' }}>
                          Reading History
                        </div>
                        <div className="grid grid-cols-3 gap-2 max-h-32 overflow-y-auto">
                          {remHistories[item.remId].slice(-12).reverse().map((entry, idx) => (
                            <div key={idx} className="p-2 rounded" style={{
                              backgroundColor: 'var(--rn-clr-background-primary)',
                              border: '1px solid var(--rn-clr-border-primary)'
                            }}>
                              <div className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                                Page {entry.page}
                              </div>
                              <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                                {new Date(entry.timestamp).toLocaleDateString([], {
                                  month: 'numeric',
                                  day: 'numeric'
                                })} {new Date(entry.timestamp).toLocaleTimeString([], {
                                  hour: 'numeric',
                                  minute: '2-digit'
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      </div>

      {/* Footer Actions */}
      <div className="px-7 py-5" style={{
        borderTop: '1px solid var(--rn-clr-border-primary)',
        backgroundColor: 'var(--rn-clr-background-secondary)',
        boxShadow: '0 -1px 3px 0 rgba(0, 0, 0, 0.05)'
      }}>
        <div className="flex gap-3 mb-3">
          <button
            onClick={handleSave}
            className="flex-1 px-5 py-3 font-bold rounded-xl transition-all shadow-sm"
            style={{
              backgroundColor: '#3B82F6',
              color: 'white',
              border: 'none',
              fontSize: '14px'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#2563eb';
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(59, 130, 246, 0.3), 0 2px 4px -1px rgba(59, 130, 246, 0.2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#3B82F6';
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 1px 2px 0 rgba(0, 0, 0, 0.05)';
            }}
          >
            <span className="inline-flex items-center gap-2">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M7.707 10.293a1 1 0 10-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 11.586V6h5a2 2 0 012 2v7a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h5v5.586l-1.293-1.293zM9 4a1 1 0 012 0v2H9V4z" />
              </svg>
              Save Current Rem
            </span>
          </button>

          {(pageRangeStart > 1 || pageRangeEnd > 0) && (
            <button
              onClick={handleClear}
              className="px-5 py-3 font-bold rounded-xl transition-all"
              style={{
                backgroundColor: 'var(--rn-clr-background-tertiary)',
                color: 'var(--rn-clr-content-primary)',
                border: '1.5px solid var(--rn-clr-border-primary)',
                fontSize: '14px'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-primary)';
                e.currentTarget.style.borderColor = '#dc2626';
                e.currentTarget.style.color = '#dc2626';
                e.currentTarget.style.transform = 'translateY(-1px)';
                e.currentTarget.style.boxShadow = '0 2px 4px 0 rgba(0, 0, 0, 0.05)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
                e.currentTarget.style.borderColor = 'var(--rn-clr-border-primary)';
                e.currentTarget.style.color = 'var(--rn-clr-content-primary)';
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              <span className="inline-flex items-center gap-2">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                Clear
              </span>
            </button>
          )}
        </div>

        <div className="flex items-center justify-center gap-2 text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
          <kbd className="px-2 py-1 rounded font-mono font-semibold" style={{
            backgroundColor: 'var(--rn-clr-background-tertiary)',
            border: '1px solid var(--rn-clr-border-primary)',
            fontSize: '11px'
          }}>
            Enter
          </kbd>
          <span>to save</span>
          <span>•</span>
          <kbd className="px-2 py-1 rounded font-mono font-semibold" style={{
            backgroundColor: 'var(--rn-clr-background-tertiary)',
            border: '1px solid var(--rn-clr-border-primary)',
            fontSize: '11px'
          }}>
            Esc
          </kbd>
          <span>to close</span>
        </div>
      </div>
    </div>
  );
}

renderWidget(PageRangeWidget);