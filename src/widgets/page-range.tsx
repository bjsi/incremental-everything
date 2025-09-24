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

function PageRangeWidget() {
  const plugin = usePlugin();
  
  const contextData = useTracker(
    async (rp) => {
      // Fetches the context (remId, pdfRemId) passed when the popup was opened.
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

  // This effect loads all the necessary data when the popup opens.
  useEffect(() => {
    const loadData = async () => {
      if (!contextData?.incrementalRemId || !contextData?.pdfRemId) {
        setIsLoading(false);
        return;
      }
      
      try {
        setIsLoading(true);
        const { incrementalRemId, pdfRemId } = contextData;
        
        // Fetch details for the Rem the popup was opened for.
        const currentRem = await plugin.rem.findOne(incrementalRemId);
        if (currentRem) {
          const remText = currentRem.text ? await plugin.richText.toString(currentRem.text) : 'Untitled';
          const isIncremental = await currentRem.hasPowerup('incremental');
          setCurrentRemName(remText);
          setIsCurrentRemIncremental(isIncremental);
        }
        
        // Load the page range for the current Rem.
        const savedRange = await plugin.storage.getSynced(getPageRangeKey(incrementalRemId, pdfRemId));
        if (savedRange && typeof savedRange === 'object') {
          setPageRangeStart(savedRange.start || 1);
          setPageRangeEnd(savedRange.end || 0);
        } else {
          setPageRangeStart(1);
          setPageRangeEnd(0);
        }
        
        // Fetch the master list of related Rems using our definitive logic.
        const related = await getAllIncrementsForPDF(plugin, pdfRemId);
        setRelatedRems(related);
        
        // Fetch the reading history for the current Rem.
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
  
  // Focus the first input field once data is loaded.
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
  
  return (
    <div 
      className="flex flex-col p-4 gap-4"
      style={{ minWidth: '450px', maxWidth: '600px', maxHeight: '90vh', overflowY: 'auto' }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
        if (e.key === 'Escape') { e.preventDefault(); handleClose(); }
      }}
    >
      <div className="text-2xl font-bold">📄 Set Page Range</div>
      
      <div className="text-sm rn-clr-content-secondary">
        Configure page restrictions for: 
        <span className="font-semibold"> {currentRemName || '...'}</span>
        {isCurrentRemIncremental && <span className="ml-2" title="Incremental Rem">⚡</span>}
      </div>

      {/* Inputs */}
      <div className="flex flex-col gap-4">
        <div className="flex justify-between items-center">
          <label className="font-semibold">Start Page</label>
          <input
            ref={inputStartRef} type="number" min="1"
            value={pageRangeStart}
            onChange={(e) => setPageRangeStart(parseInt(e.target.value) || 1)}
            className="w-20 text-center p-1 border rounded dark:bg-gray-700 dark:border-gray-600"
          />
        </div>
        <div className="flex justify-between items-center">
          <label className="font-semibold">End Page (optional)</label>
          <input
            type="number" min={pageRangeStart}
            value={pageRangeEnd || ''}
            onChange={(e) => setPageRangeEnd(parseInt(e.target.value) || 0)}
            placeholder="No limit"
            className="w-20 text-center p-1 border rounded dark:bg-gray-700 dark:border-gray-600"
          />
        </div>
      </div>

      {/* Range Display */}
      {pageRangeStart > 1 || pageRangeEnd > 0 ? (
        <div className="p-3 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <div className="font-semibold text-blue-700 dark:text-blue-300">Range: Pages {pageRangeStart}-{pageRangeEnd || '∞'}</div>
        </div>
      ) : (
        <div className="p-3 rounded bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600">
          <div className="text-gray-700 dark:text-gray-300">No restrictions - all pages available</div>
        </div>
      )}

      {/* Unassigned Ranges Display */}
      {(() => {
        // Calculate unassigned page ranges
        const assignedRanges = relatedRems
          .filter(item => item.isIncremental && item.range && item.remId !== contextData?.incrementalRemId)
          .map(item => item.range)
          .filter(Boolean)
          .sort((a, b) => a.start - b.start);

        if (assignedRanges.length === 0) {
          return (
            <div className="p-2 rounded bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
              <div className="text-sm text-green-700 dark:text-green-300">
                ✓ All pages are available for assignment
              </div>
            </div>
          );
        }

        // Find gaps in assigned ranges
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
        
        // Add final range if there's a gap at the end
        if (contextData?.totalPages && lastEnd < contextData.totalPages) {
          unassignedRanges.push({
            start: lastEnd + 1,
            end: contextData.totalPages
          });
        } else if (!contextData?.totalPages) {
          // If we don't know total pages, show open-ended range
          unassignedRanges.push({
            start: lastEnd + 1,
            end: null
          });
        }

        if (unassignedRanges.length > 0) {
          return (
            <div className="p-2 rounded bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
              <div className="text-sm text-yellow-700 dark:text-yellow-300">
                <div className="font-semibold mb-1">Available page ranges:</div>
                <div className="text-xs">
                  {unassignedRanges.map((range, idx) => (
                    <span key={idx}>
                      {range.start}-{range.end || '∞'}
                      {idx < unassignedRanges.length - 1 && ', '}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          );
        } else {
          return (
            <div className="p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <div className="text-sm text-red-700 dark:text-red-300">
                ⚠ All pages have been assigned to other incremental rems
              </div>
            </div>
          );
        }
      })()}

      <hr className="dark:border-gray-700" />

      {/* Related Rems - FIXED STYLING HERE */}
      {relatedRems.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="font-semibold">Other Rems Using This PDF ({relatedRems.length})</div>
          <div className="flex flex-col gap-2 max-h-60 overflow-y-auto">
            {relatedRems.map((item) => (
              <div key={item.remId} className={`p-2 rounded text-sm ${
                  item.isIncremental 
                    ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800' 
                    : 'bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600'
                }`}>
                <div className="flex items-center gap-2">
                  {item.isIncremental && <span title="Incremental Rem">⚡</span>}
                  <div className={`font-medium flex-1 ${!item.isIncremental ? 'text-gray-700 dark:text-gray-300' : ''}`}>{item.name}</div>
                </div>
                {item.range ? (
                  <div className={`text-xs mt-1 ${!item.isIncremental ? 'text-gray-600 dark:text-gray-400' : 'text-gray-500 dark:text-gray-400'}`}>
                    Pages: {item.range.start} - {item.range.end || '∞'}
                    {item.isIncremental && item.currentPage && ` • At: ${item.currentPage}`}
                  </div>
                ) : (
                  <div className={`text-xs mt-1 ${!item.isIncremental ? 'text-gray-600 dark:text-gray-400' : 'text-gray-500 dark:text-gray-400'}`}>No page range set</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <hr className="dark:border-gray-700" />

      {/* History */}
      {pageHistory.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex justify-between items-center">
            <div className="font-semibold">Reading History</div>
            <button onClick={() => setShowHistory(!showHistory)} className="text-sm px-2 py-1 border rounded dark:border-gray-600">
              {showHistory ? 'Hide' : 'Show'}
            </button>
          </div>
          {showHistory && (
            <div className="max-h-40 overflow-y-auto">
              <div className="grid grid-cols-2 gap-2 text-xs">
                {pageHistory.slice(-20).reverse().map((entry, idx) => (
                  <div key={idx} className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800">
                    <div className="font-semibold">Page {entry.page}</div>
                    <div className="text-blue-600 dark:text-blue-400 mt-1">
                      {new Date(entry.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                    </div>
                  </div>
                ))}
              </div>
              {pageHistory.length > 20 && (
                <div className="text-xs text-center mt-2 rn-clr-content-secondary">
                  Showing last 20 entries of {pageHistory.length} total
                </div>
              )}
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
          Save
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
          Cancel
        </button>
      </div>

      <div className="text-xs rn-clr-content-secondary text-center">
        Press Enter to save, Escape to cancel
      </div>
    </div>
  );
}

renderWidget(PageRangeWidget);