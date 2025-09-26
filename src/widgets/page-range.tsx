// widgets/page-range.tsx
import {
  renderWidget,
  usePlugin,
  useTracker,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { 
  getPageRangeKey, 
  getPageHistory,
  getAllIncrementsForPDF,
  getIncrementalPageRange
} from '../lib/pdfUtils';
import { powerupCode, prioritySlotCode, nextRepDateSlotCode, repHistorySlotCode, defaultPriorityId, allIncrementalRemKey } from '../lib/consts';
import { getDailyDocReferenceForDate } from '../lib/date';
import { getInitialPriority } from '../lib/priority_inheritance';
import { percentileToHslColor } from '../lib/color';
import { calculateRelativePriority } from '../lib/priority';
import { IncrementalRem } from '../lib/types';
import { getIncrementalRemInfo } from '../lib/incremental_rem';

function PageRangeWidget() {
  const plugin = usePlugin();
  
  const contextData = useTracker(
    async (rp) => {
      const data = await rp.storage.getSession('pageRangeContext');
      console.log('PageRange: Context data from session:', data);
      return data;
    },
    []
  );

  const allIncrementalRems = useTracker(
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

  // Initialize an incremental rem
  const initIncrementalRem = async (remId: string) => {
    try {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) return;
      
      const isAlreadyIncremental = await rem.hasPowerup(powerupCode);
      if (!isAlreadyIncremental) {
        // Get default priority from settings
        const defaultPrioritySetting = (await plugin.settings.getSetting<number>(defaultPriorityId)) || 10;
        const defaultPriority = Math.min(100, Math.max(0, defaultPrioritySetting));
        
        // Try to inherit priority from closest incremental ancestor
        const initialPriority = await getInitialPriority(plugin, rem, defaultPriority);
        
        // Add powerup
        await rem.addPowerup(powerupCode);
        
        // Set initial interval (using 1 day as default)
        const nextRepDate = new Date(Date.now() + (1 * 24 * 60 * 60 * 1000));
        const dateRef = await getDailyDocReferenceForDate(plugin, nextRepDate);
        if (dateRef) {
          await rem.setPowerupProperty(powerupCode, nextRepDateSlotCode, dateRef);
        }
        
        // Set priority
        await rem.setPowerupProperty(powerupCode, prioritySlotCode, [initialPriority.toString()]);
        
        // Initialize history
        await rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify([])]);
        
        // Update the all incremental rems list
        const newIncRem = await getIncrementalRemInfo(plugin, rem);
        if (newIncRem) {
          const currentAllRems = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];
          const updatedAllRems = [...currentAllRems, newIncRem];
          await plugin.storage.setSession(allIncrementalRemKey, updatedAllRems);
        }
        
        // Reload the related rems list
        await reloadRelatedRems();
        
        const remName = rem.text ? await plugin.richText.toString(rem.text) : 'Rem';
        await plugin.app.toast(`Made "${remName}" incremental with priority ${initialPriority}`);
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
      const incRemInfo = await getIncrementalRemInfo(plugin, rem);
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
        const incRemInfo = await getIncrementalRemInfo(plugin, rem);
        if (incRemInfo) {
          const currentAllRems = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];
          const updatedAllRems = currentAllRems
            .filter((x) => x.remId !== remId)
            .concat(incRemInfo);
          await plugin.storage.setSession(allIncrementalRemKey, updatedAllRems);
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
          const incRemInfo = await getIncrementalRemInfo(plugin, remObj);
          if (incRemInfo) {
            const percentile = remsForCalculation.length > 0 ? 
              calculateRelativePriority(remsForCalculation, rem.remId) : null;
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
          const isIncremental = await currentRem.hasPowerup('incremental');
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

  const inputStartRef = React.useRef<HTMLInputElement>(null);
  
  useEffect(() => {
    if (!isLoading && contextData) {
      setTimeout(() => {
        inputStartRef.current?.focus();
        inputStartRef.current?.select();
      }, 50);
    }
  }, [isLoading, contextData]);

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
      .filter(item => item.isIncremental && item.range)
      .map(item => item.range)
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);

    const unassignedRanges = [];
    let lastEnd = 0;
    
    for (const range of assignedRanges) {
      if (range.start > lastEnd + 1) {
        unassignedRanges.push({
          start: lastEnd + 1,
          end: range.start - 1
        });
      }
      lastEnd = Math.max(lastEnd, range.end || range.start);
    }
    
    if (!contextData?.totalPages || lastEnd < 1000) {
      unassignedRanges.push({
        start: lastEnd + 1,
        end: null
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
      className="flex flex-col p-4 gap-4"
      style={{ minWidth: '550px', maxWidth: '700px', maxHeight: '95vh', overflowY: 'auto' }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !editingRemId && !editingPriorityRemId) { 
          e.preventDefault(); 
          handleSave(); 
        }
        if (e.key === 'Escape' && !editingRemId && !editingPriorityRemId) { 
          e.preventDefault(); 
          handleClose(); 
        }
      }}
    >
      <div className="text-2xl font-bold">📄 PDF Control Panel</div>
      
      <div className="text-sm rn-clr-content-secondary">
        Current rem: 
        <span className="font-semibold"> {currentRemName || '...'}</span>
        {isCurrentRemIncremental && <span className="ml-2" title="Incremental Rem">⚡</span>}
      </div>

      {/* Current Rem Settings */}
      <div className="p-3 border rounded dark:border-gray-600">
        <div className="font-semibold mb-2">Quick Edit - Current Rem Page Range</div>
        <div className="flex flex-col gap-2">
          <div className="flex gap-4">
            <div className="flex items-center gap-2">
              <label>Start:</label>
              <input
                ref={inputStartRef} type="number" min="1"
                value={pageRangeStart}
                onChange={(e) => setPageRangeStart(parseInt(e.target.value) || 1)}
                className="w-20 text-center p-1 border rounded dark:bg-gray-700 dark:border-gray-600"
              />
            </div>
            <div className="flex items-center gap-2">
              <label>End:</label>
              <input
                type="number" min={pageRangeStart}
                value={pageRangeEnd || ''}
                onChange={(e) => setPageRangeEnd(parseInt(e.target.value) || 0)}
                placeholder="No limit"
                className="w-20 text-center p-1 border rounded dark:bg-gray-700 dark:border-gray-600"
              />
            </div>
          </div>
          {pageRangeStart > 1 || pageRangeEnd > 0 ? (
            <div className="text-sm font-semibold text-blue-700 dark:text-blue-300">
              Range: Pages {pageRangeStart}-{pageRangeEnd || '∞'}
            </div>
          ) : (
            <div className="text-sm text-gray-700 dark:text-gray-300">No restrictions</div>
          )}
        </div>
      </div>

      {/* Available Ranges */}
      {(() => {
        const unassignedRanges = getUnassignedRanges();
        return unassignedRanges.length > 0 ? (
          <div className="p-2 rounded bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
            <div className="text-sm text-yellow-700 dark:text-yellow-300">
              <div className="font-semibold">Available page ranges:</div>
              <div className="text-xs mt-1">
                {unassignedRanges.map((range, idx) => (
                  <span key={idx}>
                    {range.start}-{range.end || '∞'}
                    {idx < unassignedRanges.length - 1 && ', '}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <div className="text-sm text-red-700 dark:text-red-300">
              ⚠ All pages have been assigned
            </div>
          </div>
        );
      })()}

      <hr className="dark:border-gray-700" />

      {/* All Rems Using This PDF (including current) */}
      <div className="flex flex-col gap-2">
        <div className="font-semibold">All Rems Using This PDF ({sortedRelatedRems.length})</div>
        <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
          {sortedRelatedRems.map((item) => {
            const isCurrentRem = item.remId === contextData?.incrementalRemId;
            const priorityInfo = remPriorities[item.remId];
            const priorityColor = priorityInfo?.percentile ? 
              percentileToHslColor(priorityInfo.percentile) : 'transparent';
            
            return (
              <div key={item.remId} className={`rounded ${
                isCurrentRem 
                  ? 'bg-green-50 dark:bg-green-900/20 border-2 border-green-300 dark:border-green-700'
                  : item.isIncremental 
                    ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800' 
                    : 'bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600'
              }`}>
                {/* Main Rem Info - Clickable */}
                <div 
                  className="p-2 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
                  onClick={() => toggleExpanded(item.remId)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs">{expandedRems.has(item.remId) ? '▼' : '▶'}</span>
                    {item.isIncremental && <span title="Incremental Rem">⚡</span>}
                    <div className={`font-medium flex-1 text-sm ${!item.isIncremental ? 'text-gray-700 dark:text-gray-300' : ''}`}>
                      {item.name}
                      {isCurrentRem && <span className="ml-2 text-xs text-green-600 dark:text-green-400">(current)</span>}
                    </div>
                    {/* Priority Badge with Color */}
                    {item.isIncremental && priorityInfo && (
                      <div 
                        className="px-2 py-0.5 rounded text-xs font-semibold text-white"
                        style={{ backgroundColor: priorityColor }}
                        title={`Priority: ${priorityInfo.absolute} (${priorityInfo.percentile}% of KB)`}
                      >
                        P:{priorityInfo.absolute} ({priorityInfo.percentile}%)
                      </div>
                    )}
                  </div>
                  {item.range ? (
                    <div className={`text-xs mt-1 ${!item.isIncremental ? 'text-gray-600 dark:text-gray-400' : 'text-gray-500 dark:text-gray-400'}`}>
                      Pages: {item.range.start} - {item.range.end || '∞'}
                      {item.isIncremental && item.currentPage && (
                        <>
                          {` • At: ${item.currentPage}`}
                          {remHistories[item.remId] && (() => {
                            const lastEntry = remHistories[item.remId][remHistories[item.remId].length - 1];
                            if (lastEntry && lastEntry.timestamp) {
                              const date = new Date(lastEntry.timestamp);
                              return ` (${date.toLocaleDateString('en-US', { 
                                month: 'numeric', 
                                day: 'numeric', 
                                year: '2-digit' 
                              })}, ${date.toLocaleTimeString('en-US', { 
                                hour: 'numeric', 
                                minute: '2-digit',
                                hour12: true 
                              })})`;
                            }
                            return '';
                          })()}
                        </>
                      )}
                    </div>
                  ) : (
                    <div className={`text-xs mt-1 ${!item.isIncremental ? 'text-gray-600 dark:text-gray-400' : 'text-gray-500 dark:text-gray-400'}`}>
                      No page range set
                    </div>
                  )}
                </div>
                
                {/* Expanded Content */}
                {expandedRems.has(item.remId) && (
                  <div className="border-t border-gray-300 dark:border-gray-600 p-2">
                    {/* Action Buttons */}
                    <div className="flex gap-2 mb-2 flex-wrap">
                      {!item.isIncremental ? (
                        <button
                          onClick={() => initIncrementalRem(item.remId)}
                          className="px-3 py-1 text-xs rounded"
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
                                className="px-3 py-1 text-xs rounded"
                                style={{
                                  backgroundColor: '#3B82F6',
                                  color: 'white',
                                }}
                              >
                                Save Range
                              </button>
                              <button
                                onClick={() => setEditingRemId(null)}
                                className="px-3 py-1 text-xs rounded"
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
                              className="px-3 py-1 text-xs rounded"
                              style={{
                                backgroundColor: '#6B7280',
                                color: 'white',
                              }}
                            >
                              Cancel Priority Edit
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => startEditingRem(item.remId)}
                                className="px-3 py-1 text-xs rounded"
                                style={{
                                  backgroundColor: '#3B82F6',
                                  color: 'white',
                                }}
                              >
                                Edit Page Range
                              </button>
                              <button
                                onClick={() => startEditingPriority(item.remId)}
                                className="px-3 py-1 text-xs rounded"
                                style={{
                                  backgroundColor: '#8B5CF6',
                                  color: 'white',
                                }}
                              >
                                Edit Priority
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                    
                    {/* Inline Priority Editor */}
                    {editingPriorityRemId === item.remId && (
                      <div className="flex flex-col gap-2 mb-2 p-2 bg-purple-50 dark:bg-purple-900/20 rounded">
                        <div className="flex items-center gap-2">
                          <label className="text-xs font-semibold">Priority:</label>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={editingPriorities[item.remId]}
                            onChange={(e) => setEditingPriorities({
                              ...editingPriorities,
                              [item.remId]: Math.min(100, Math.max(0, parseInt(e.target.value) || 0))
                            })}
                            className="w-16 text-xs p-1 border rounded dark:bg-gray-700 dark:border-gray-600"
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
                              calculateRelativePriority(
                                allIncrementalRems || [], 
                                item.remId
                              ) || 50
                            )}}
                          />
                        </div>
                        <div className="text-xs text-gray-600 dark:text-gray-400">
                          Lower values = higher priority (0 is highest, 100 is lowest)
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => savePriority(item.remId)}
                            className="px-3 py-1 text-xs rounded"
                            style={{
                              backgroundColor: '#8B5CF6',
                              color: 'white',
                            }}
                          >
                            Save Priority
                          </button>
                          <button
                            onClick={() => setEditingPriorityRemId(null)}
                            className="px-3 py-1 text-xs rounded"
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
                      <div className="flex gap-2 mb-2">
                        <input
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
                          className="w-16 text-xs p-1 border rounded dark:bg-gray-700 dark:border-gray-600"
                          placeholder="Start"
                        />
                        <span className="text-xs self-center">to</span>
                        <input
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
                          className="w-16 text-xs p-1 border rounded dark:bg-gray-700 dark:border-gray-600"
                          placeholder="End"
                        />
                      </div>
                    )}
                    
                    {/* Reading History */}
                    {remHistories[item.remId] && remHistories[item.remId].length > 0 && (
                      <div className="mt-2">
                        <div className="text-xs font-semibold mb-1">Reading History</div>
                        <div className="grid grid-cols-3 gap-1 max-h-32 overflow-y-auto">
                          {remHistories[item.remId].slice(-12).reverse().map((entry, idx) => (
                            <div key={idx} className="p-1 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">
                              <div className="text-xs font-semibold">Page {entry.page}</div>
                              <div className="text-xs text-gray-500">
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

      <hr className="dark:border-gray-700" />

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <button
          onClick={handleSave}
          className="flex-1 px-4 py-2 font-semibold rounded"
          style={{
            backgroundColor: '#3B82F6',
            color: 'white',
            border: 'none',
          }}
        >
          Save Current Rem
        </button>
        
        {(pageRangeStart > 1 || pageRangeEnd > 0) && (
          <button
            onClick={handleClear}
            className="px-4 py-2 font-semibold rounded"
            style={{
              backgroundColor: '#E5E7EB',
              color: '#374151',
              border: 'none',
            }}
          >
            Clear
          </button>
        )}
        
        <button
          onClick={handleClose}
          className="px-4 py-2 font-semibold rounded"
          style={{
            backgroundColor: '#E5E7EB',
            color: '#374151',
            border: 'none',
          }}
        >
          Close
        </button>
      </div>

      <div className="text-xs rn-clr-content-secondary text-center">
        Press Enter to save current rem, Escape to close
      </div>
    </div>
  );
}

renderWidget(PageRangeWidget);