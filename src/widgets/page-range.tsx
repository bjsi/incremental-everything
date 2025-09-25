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
  getAllIncrementsForPDF 
} from '../lib/pdfUtils';
import { powerupCode, prioritySlotCode, nextRepDateSlotCode, repHistorySlotCode, defaultPriorityId } from '../lib/consts';
import { getDailyDocReferenceForDate } from '../lib/date';
import { getInitialPriority } from '../lib/priority_inheritance';

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
        
        // Open priority popup for fine-tuning
        await plugin.widget.openPopup('priority', { remId });
        
        // Reload the related rems list
        await reloadRelatedRems();
        
        await plugin.app.toast(`Made "${rem.text ? await plugin.richText.toString(rem.text) : 'Rem'}" incremental with priority ${initialPriority}`);
      }
    } catch (error) {
      console.error('Error initializing incremental rem:', error);
      await plugin.app.toast('Error making rem incremental');
    }
  };

  // Reload the related rems list
  const reloadRelatedRems = async () => {
    if (!contextData?.pdfRemId) return;
    
    const related = await getAllIncrementsForPDF(plugin, contextData.pdfRemId);
    setRelatedRems(related);
    
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
    const savedRange = await plugin.storage.getSynced(getPageRangeKey(remId, contextData.pdfRemId));
    if (savedRange && typeof savedRange === 'object') {
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
        const savedRange = await plugin.storage.getSynced(getPageRangeKey(incrementalRemId, pdfRemId));
        if (savedRange && typeof savedRange === 'object') {
          setPageRangeStart(savedRange.start || 1);
          setPageRangeEnd(savedRange.end || 0);
        } else {
          setPageRangeStart(1);
          setPageRangeEnd(0);
        }
        
        // Load related rems
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
  
  // Calculate unassigned ranges
  const getUnassignedRanges = () => {
    const assignedRanges = relatedRems
      .filter(item => item.isIncremental && item.range && item.remId !== contextData?.incrementalRemId)
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
  
  return (
    <div 
      className="flex flex-col p-4 gap-4"
      style={{ minWidth: '550px', maxWidth: '700px', maxHeight: '95vh', overflowY: 'auto' }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !editingRemId) { e.preventDefault(); handleSave(); }
        if (e.key === 'Escape' && !editingRemId) { e.preventDefault(); handleClose(); }
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
        <div className="font-semibold mb-2">Current Rem Page Range</div>
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

      {/* Enhanced Control Panel for Other Rems */}
      {relatedRems.filter(item => item.remId !== contextData?.incrementalRemId).length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="font-semibold">All Rems Using This PDF ({relatedRems.filter(item => item.remId !== contextData?.incrementalRemId).length})</div>
          <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
            {relatedRems
              .filter(item => item.remId !== contextData?.incrementalRemId)
              .map((item) => (
              <div key={item.remId} className={`rounded ${
                  item.isIncremental 
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
                    </div>
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
                    <div className="flex gap-2 mb-2">
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
                      ) : editingRemId === item.remId ? (
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
                      ) : (
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
                      )}
                    </div>
                    
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
            ))}
          </div>
        </div>
      )}

      <hr className="dark:border-gray-700" />

      {/* Current Rem's History */}
      {pageHistory.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex justify-between items-center">
            <div className="font-semibold text-sm">Current Rem Reading History</div>
            <button onClick={() => setShowHistory(!showHistory)} className="text-xs px-2 py-1 border rounded dark:border-gray-600">
              {showHistory ? 'Hide' : 'Show'}
            </button>
          </div>
          {showHistory && (
            <div className="max-h-32 overflow-y-auto">
              <div className="grid grid-cols-3 gap-1 text-xs">
                {pageHistory.slice(-15).reverse().map((entry, idx) => (
                  <div key={idx} className="p-1 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800">
                    <div className="font-semibold">Page {entry.page}</div>
                    <div className="text-blue-600 dark:text-blue-400">
                      {new Date(entry.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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