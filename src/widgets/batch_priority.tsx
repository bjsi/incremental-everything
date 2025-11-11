// widgets/batch_priority.tsx
import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  PluginRem,
  RNPlugin,
  BuiltInPowerupCodes,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  powerupCode, 
  prioritySlotCode,
  allIncrementalRemKey 
} from '../lib/consts';
import { IncrementalRem, ActionItemType } from '../lib/incremental_rem';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { calculateRelativePriority } from '../lib/priority';
import { percentileToHslColor } from '../lib/color';
import { remToActionItemType } from '../lib/incremental_rem';
import { safeRemTextToString } from '../lib/pdfUtils';
import dayjs from 'dayjs';

// Types for our operations
type OperationType = 'increase' | 'decrease' | 'spread' | 'adjust';
type SortField = 'hierarchy' | 'name' | 'currentPriority' | 'newPriority' | 'type' | 'nextRepDate' | 'repetitions' | 'percentile';
type SortDirection = 'asc' | 'desc';

interface IncrementalRemData {
  remId: string;
  rem: PluginRem;
  name: string;
  currentPriority: number;
  newPriority: number | null;
  type: ActionItemType | 'rem';
  nextRepDate: number;
  repetitions: number;
  depth: number;
  path: string[];
  pathIds: string[];
  isChecked: boolean;
  percentile: number | null;
}

function BatchPriority() {
  console.log('🚀 BatchPriority: Component rendering');
  const plugin = usePlugin();
  
  // Get the focused rem from session storage
  const focusedRemId = useTrackerPlugin(
    async (rp) => {
      const id = await rp.storage.getSession<string>('batchPriorityFocusedRem');
      console.log('📌 BatchPriority: Focused rem ID from session:', id);
      return id;
    },
    []
  );

  // State management
  const [incrementalRems, setIncrementalRems] = useState<IncrementalRemData[]>([]);
  const [filteredRems, setFilteredRems] = useState<IncrementalRemData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [operation, setOperation] = useState<OperationType>('increase');
  const [changePercent, setChangePercent] = useState(50);
  const [decreasePercent, setDecreasePercent] = useState(150); // Separate state for decrease
  const [spreadStart, setSpreadStart] = useState(1);
  const [spreadEnd, setSpreadEnd] = useState(100);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [hasCalculated, setHasCalculated] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [priorityRangeMin, setPriorityRangeMin] = useState(0);
  const [priorityRangeMax, setPriorityRangeMax] = useState(100);
  const [sortField, setSortField] = useState<SortField>('hierarchy');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [isApplying, setIsApplying] = useState(false);
  const [appliedCount, setAppliedCount] = useState(0);
  const [totalToApply, setTotalToApply] = useState(0);
  const [previousStates, setPreviousStates] = useState<IncrementalRemData[][]>([]);

  // Get all incremental rems from storage
  const allIncrementalRems = useTrackerPlugin(
    (rp) => {
      console.log('📊 BatchPriority: Fetching all incremental rems from storage');
      return rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey);
    },
    []
  );

// Load incremental rems in the focused rem's hierarchy
useEffect(() => {
  const loadIncrementalRems = async () => {
    console.log('🔄 BatchPriority: Starting to load incremental rems');
    console.log('   - focusedRemId:', focusedRemId);
    
    if (!focusedRemId) {
      console.log('❌ BatchPriority: No focused rem ID, stopping load');
      setIsLoading(false);
      setErrorMessage('No focused rem ID found in session');
      return;
    }

    try {
      setIsLoading(true);
      setErrorMessage('');
      
      console.log('🔍 BatchPriority: Finding rem with ID:', focusedRemId);
      const focusedRem = await plugin.rem.findOne(focusedRemId);
      
      if (!focusedRem) {
        console.log('❌ BatchPriority: Could not find rem with ID:', focusedRemId);
        setIsLoading(false);
        setErrorMessage(`Could not find rem with ID: ${focusedRemId}`);
        return;
      }
      
      console.log('✅ BatchPriority: Found focused rem:', focusedRem._id);
      const focusedRemText = focusedRem.text ? await safeRemTextToString(plugin, focusedRem.text) : 'Untitled';
      console.log('   - Rem text:', focusedRemText);

      // Get all descendants of the focused rem first
      console.log('🌳 BatchPriority: Getting all descendants...');
      const allDescendants = await focusedRem.getDescendants();
      console.log('   - Found', allDescendants.length, 'descendants');
      
      // Include the focused rem itself
      const allRemsToCheck = [focusedRem, ...allDescendants];
      console.log('   - Total rems to check:', allRemsToCheck.length);
      
      const incrementalData: IncrementalRemData[] = [];
      
      // Check each rem for incremental powerup - process ALL rems in the hierarchy
      console.log('🔎 BatchPriority: Checking each rem for incremental powerup...');
      
      for (const rem of allRemsToCheck) {
        try {
          const hasIncremental = await rem.hasPowerup(powerupCode);
          
          if (hasIncremental) {
            console.log(`   ✓ Found incremental rem:`, rem._id);
            
            const incInfo = await getIncrementalRemInfo(plugin, rem);
            if (incInfo) {
              const remText = rem.text ? await safeRemTextToString(plugin, rem.text) : 'Untitled';
              console.log(`     - Name: ${remText}, Priority: ${incInfo.priority}`);
              
              // Calculate depth and path for hierarchy display
              const { path, pathIds } = await getRemPathWithIds(plugin, rem, focusedRemId);
              const depth = rem._id === focusedRemId ? 0 : path.length - 1;
              
              // Determine type using the existing remToActionItemType function
              const actionItem = await remToActionItemType(plugin, rem);
              const remType = actionItem?.type || 'rem';
              
              incrementalData.push({
                remId: rem._id,
                rem: rem,
                name: remText,
                currentPriority: incInfo.priority,
                newPriority: null,
                type: remType,
                nextRepDate: incInfo.nextRepDate,
                repetitions: incInfo.history?.length || 0,
                depth: depth,
                path: path,
                pathIds: pathIds,
                isChecked: true,
                percentile: allIncrementalRems ? 
                  calculateRelativePriority(allIncrementalRems, rem._id) : null
              });
            } else {
              console.log(`     ⚠️ Could not get incremental info for rem:`, rem._id);
            }
          }
        } catch (remError) {
          console.error(`   ❌ Error checking rem:`, remError);
        }
      }
      
      console.log('📈 BatchPriority: Found', incrementalData.length, 'incremental rems total');
      
      // Sort by hierarchy (path)
      incrementalData.sort((a, b) => {
        const minLength = Math.min(a.path.length, b.path.length);
        for (let i = 0; i < minLength; i++) {
          const comp = a.path[i].localeCompare(b.path[i]);
          if (comp !== 0) return comp;
        }
        return a.path.length - b.path.length;
      });
      
      console.log('✅ BatchPriority: Setting incremental rems data');
      setIncrementalRems(incrementalData);
      setFilteredRems(incrementalData);
      
      // Initially expand all nodes
      const allIds = new Set(incrementalData.map(item => item.remId));
      setExpandedNodes(allIds);
      console.log('   - Expanded all nodes');
      
    } catch (error) {
      console.error('❌ BatchPriority: Error loading incremental rems:', error);
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      setErrorMessage(`Error: ${message}`);
      await plugin.app.toast('Error loading incremental rems');
    } finally {
      setIsLoading(false);
      console.log('🏁 BatchPriority: Finished loading');
    }
  };

  loadIncrementalRems();
}, [focusedRemId, plugin, allIncrementalRems]);

  // Apply filters and sorting
  useEffect(() => {
    let filtered = [...incrementalRems];
    
    // Apply search filter
    if (searchTerm) {
      filtered = filtered.filter(rem => 
        rem.name.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    
    // Apply type filter
    if (typeFilter !== 'all') {
      filtered = filtered.filter(rem => rem.type === typeFilter);
    }
    
    // Apply priority range filter
    filtered = filtered.filter(rem => 
      rem.currentPriority >= priorityRangeMin && 
      rem.currentPriority <= priorityRangeMax
    );
    
    // Apply sorting
    if (sortField === 'hierarchy') {
      // Hierarchical sorting - maintain tree structure
      filtered.sort((a, b) => {
        const minLength = Math.min(a.path.length, b.path.length);
        for (let i = 0; i < minLength; i++) {
          const comp = a.path[i].localeCompare(b.path[i]);
          if (comp !== 0) return sortDirection === 'asc' ? comp : -comp;
        }
        const lengthComp = a.path.length - b.path.length;
        return sortDirection === 'asc' ? lengthComp : -lengthComp;
      });
    } else {
      // Other sorting fields
      filtered.sort((a, b) => {
        let compareValue = 0;
        
        switch (sortField) {
          case 'name':
            compareValue = a.name.localeCompare(b.name);
            break;
          case 'currentPriority':
            compareValue = a.currentPriority - b.currentPriority;
            break;
          case 'newPriority':
            const aNew = a.newPriority ?? a.currentPriority;
            const bNew = b.newPriority ?? b.currentPriority;
            compareValue = aNew - bNew;
            break;
          case 'type':
            compareValue = a.type.localeCompare(b.type);
            break;
          case 'nextRepDate':
            compareValue = a.nextRepDate - b.nextRepDate;
            break;
          case 'repetitions':
            compareValue = a.repetitions - b.repetitions;
            break;
          case 'percentile':
            compareValue = (a.percentile ?? 100) - (b.percentile ?? 100);
            break;
        }
        
        return sortDirection === 'asc' ? compareValue : -compareValue;
      });
    }
    
    setFilteredRems(filtered);
  }, [incrementalRems, searchTerm, typeFilter, priorityRangeMin, priorityRangeMax, sortField, sortDirection]);

  // Calculate new priorities based on operation
  const calculateNewPriorities = () => {
    console.log('🧮 BatchPriority: Calculating new priorities');
    console.log('   - Operation:', operation);
    console.log('   - Parameters:', { changePercent, decreasePercent, spreadStart, spreadEnd });
    
    // Save current state for undo
    setPreviousStates(prev => [...prev, incrementalRems]);
    
    const checkedRems = incrementalRems.filter(r => r.isChecked);
    console.log('   - Checked rems:', checkedRems.length);
    
    if (checkedRems.length === 0) {
      console.log('   ⚠️ No items selected');
      plugin.app.toast('No items selected for priority change');
      return;
    }

    let updatedRems = [...incrementalRems];

    switch (operation) {
      case 'increase': {
        const multiplier = changePercent / 100;
        console.log('   - Increase multiplier:', multiplier);
        updatedRems = updatedRems.map(rem => ({
          ...rem,
          newPriority: rem.isChecked ? 
            Math.max(0, Math.round(rem.currentPriority * multiplier)) : null
        }));
        break;
      }
      
      case 'decrease': {
        const multiplier = decreasePercent / 100;
        console.log('   - Decrease multiplier:', multiplier);
        updatedRems = updatedRems.map(rem => ({
          ...rem,
          newPriority: rem.isChecked ? 
            Math.min(100, Math.round(rem.currentPriority * multiplier)) : null
        }));
        break;
      }
      
      case 'spread': {
        const spreadRange = spreadEnd - spreadStart;
        const numChecked = checkedRems.length;
        console.log('   - Spread range:', spreadRange, 'Num checked:', numChecked);
        
        if (numChecked <= 1) {
          console.log('   ⚠️ Need at least 2 items for spread');
          plugin.app.toast('Need at least 2 items for spread operation');
          return;
        }
        
        const step = spreadRange / (numChecked - 1);
        console.log('   - Step size:', step);
        let currentIndex = 0;
        
        updatedRems = updatedRems.map(rem => {
          if (rem.isChecked) {
            const newPriority = Math.round(spreadStart + (currentIndex * step));
            currentIndex++;
            return { ...rem, newPriority };
          }
          return { ...rem, newPriority: null };
        });
        break;
      }
      
      case 'adjust': {
        // Adjust maintains relative priorities within new range
        const checkedPriorities = checkedRems.map(r => r.currentPriority);
        const minCurrent = Math.min(...checkedPriorities);
        const maxCurrent = Math.max(...checkedPriorities);
        const currentRange = maxCurrent - minCurrent || 1;
        
        const newRange = spreadEnd - spreadStart;
        console.log('   - Adjust: current range', currentRange, 'new range:', newRange);
        
        updatedRems = updatedRems.map(rem => {
          if (rem.isChecked) {
            const relativePosition = (rem.currentPriority - minCurrent) / currentRange;
            const newPriority = Math.round(spreadStart + (relativePosition * newRange));
            return { ...rem, newPriority };
          }
          return { ...rem, newPriority: null };
        });
        break;
      }
    }
    
    console.log('✅ BatchPriority: Calculated new priorities');
    setIncrementalRems(updatedRems);
    setIsPreviewMode(true);
    setHasCalculated(true);
  };

  // Apply the new priorities with progress indicator
  const applyChanges = async () => {
    console.log('💾 BatchPriority: Applying changes');
    const toUpdate = incrementalRems.filter(r => r.isChecked && r.newPriority !== null);
    console.log('   - Rems to update:', toUpdate.length);
    
    if (toUpdate.length === 0) {
      console.log('   ⚠️ No changes to apply');
      await plugin.app.toast('No changes to apply');
      return;
    }
    
    setIsApplying(true);
    setTotalToApply(toUpdate.length);
    setAppliedCount(0);
    
    try {
      // Update each rem's priority
      for (let i = 0; i < toUpdate.length; i++) {
        const remData = toUpdate[i];
        console.log(`   - Updating rem ${i + 1}/${toUpdate.length}: ${remData.name} to priority ${remData.newPriority}`);
        await remData.rem.setPowerupProperty(
          powerupCode, 
          prioritySlotCode, 
          [remData.newPriority!.toString()]
        );
        setAppliedCount(i + 1);
      }
      
      // Update the session storage with new incremental rem data
      console.log('📊 BatchPriority: Updating session storage');
      for (const remData of toUpdate) {
        const updatedIncRem = await getIncrementalRemInfo(plugin, remData.rem);
        if (updatedIncRem) {
          await updateIncrementalRemCache(plugin, updatedIncRem);
        }
      }
      console.log('   - Updated session storage for', toUpdate.length, 'rems');
      
      console.log('✅ BatchPriority: Successfully applied all changes');
      await plugin.app.toast(`Successfully updated priority for ${toUpdate.length} rem(s)`);
      plugin.widget.closePopup();
      
    } catch (error) {
      console.error('❌ BatchPriority: Error applying changes:', error);
      await plugin.app.toast('Error applying changes');
    } finally {
      setIsApplying(false);
    }
  };

  // Undo last operation
  const undoLastOperation = () => {
    if (previousStates.length > 0) {
      const prevState = previousStates[previousStates.length - 1];
      setIncrementalRems(prevState);
      setPreviousStates(prev => prev.slice(0, -1));
      setIsPreviewMode(false);
      setHasCalculated(false);
    }
  };

  // Export to CSV
  const exportToCSV = () => {
    const headers = ['Name', 'Current Priority', 'New Priority', 'Percentile', 'Type', 'Next Rep Date', 'Repetitions'];
    const rows = filteredRems.map(rem => [
      rem.name,
      rem.currentPriority,
      rem.newPriority || '',
      rem.percentile || '',
      getDisplayType(rem.type),
      dayjs(rem.nextRepDate).format('YYYY-MM-DD'),
      rem.repetitions
    ]);
    
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `incremental-rems-${dayjs().format('YYYY-MM-DD')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Toggle checkbox
  const toggleCheck = (remId: string) => {
    console.log('☑️ BatchPriority: Toggling checkbox for rem:', remId);
    setIncrementalRems(prev => prev.map(rem => {
      if (rem.remId === remId) {
        const newChecked = !rem.isChecked;
        // If unchecking and we're in preview mode, clear the new priority
        if (!newChecked && isPreviewMode) {
          return { ...rem, isChecked: newChecked, newPriority: null };
        }
        return { ...rem, isChecked: newChecked };
      }
      return rem;
    }));
  };

  // Toggle all checkboxes
  const toggleAll = (checked: boolean) => {
    console.log('☑️ BatchPriority: Toggle all checkboxes to:', checked);
    setIncrementalRems(prev => prev.map(rem => ({
      ...rem,
      isChecked: checked,
      newPriority: checked ? rem.newPriority : null
    })));
  };

  // Toggle node expansion
  const toggleExpanded = (remId: string) => {
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(remId)) {
        newSet.delete(remId);
      } else {
        newSet.add(remId);
      }
      return newSet;
    });
  };

// Check if a node should be visible based on parent expansion
  const isNodeVisible = (remData: IncrementalRemData) => {
    // Always show root level items
    if (remData.depth === 0) return true;
    
    // For hierarchical sorting, check if all parent nodes are expanded
    if (sortField === 'hierarchy') {
      // Check each ancestor in the path
      for (let i = 0; i < remData.pathIds.length - 1; i++) {
        const parentId = remData.pathIds[i];

        // An ancestor's expansion state only matters if it's also an incremental rem
        // that is being displayed in the table. We ignore intermediate non-incremental rems.
        const isParentInTable = incrementalRems.some(rem => rem.remId === parentId);
        
        if (isParentInTable && !expandedNodes.has(parentId)) {
          return false;
        }
      }
      return true;
    }
    
    // For non-hierarchical sorting, show all items
    return true;
  };

  // Check if a node has children - need to check incremental rems only
  const hasChildren = (remId: string) => {
    return incrementalRems.some(r => {
      // Check if this rem's path includes the given remId (but isn't the rem itself)
      // This properly identifies parent-child relationships
      const parentIndex = r.pathIds.indexOf(remId);
      return parentIndex >= 0 && parentIndex < r.pathIds.length - 1;
    });
  };

  // Handle sorting
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Recalculate when item is re-checked in preview mode
  useEffect(() => {
    if (isPreviewMode && hasCalculated) {
      // Find any checked items without new priorities
      const needsRecalc = incrementalRems.some(r => r.isChecked && r.newPriority === null);
      if (needsRecalc) {
        console.log('🔄 BatchPriority: Recalculating for newly checked items');
        calculateNewPriorities();
      }
    }
  }, [incrementalRems.map(r => r.isChecked).join(',')]);

  // Get unique types for filter dropdown
  const uniqueTypes = useMemo(() => {
    const types = new Set(incrementalRems.map(r => r.type));
    return Array.from(types);
  }, [incrementalRems]);

  // Display type mapping for better readability
  const getDisplayType = (type: string): string => {
    const typeMap: Record<string, string> = {
      'pdf': 'PDF',
      'html': 'HTML',
      'youtube': 'YouTube',
      'rem': 'Extract',
      'pdf-highlight': 'PDF Highlight',
      'html-highlight': 'HTML Highlight'
    };
    return typeMap[type] || type;
  };

  // Styles using hard-coded colors like page-range.tsx
  const styles = {
    container: {
      height: '950px',
      overflowY: 'auto' as const,
      backgroundColor: 'white',
      color: '#111827'
    },
    darkContainer: {
      backgroundColor: '#1f2937',
      color: '#f9fafb'
    },
    button: {
      padding: '8px 16px',
      borderRadius: '6px',
      border: 'none',
      cursor: 'pointer',
      fontWeight: 500,
      transition: 'all 0.15s ease'
    },
    primaryButton: {
      backgroundColor: '#3b82f6',
      color: 'white'
    },
    secondaryButton: {
      backgroundColor: '#6b7280',
      color: 'white'
    },
    successButton: {
      backgroundColor: '#10b981',
      color: 'white'
    },
    dangerButton: {
      backgroundColor: '#ef4444',
      color: 'white'
    },
    input: {
      padding: '4px 8px',
      borderRadius: '4px',
      border: '1px solid #d1d5db',
      backgroundColor: 'white',
      color: '#111827'
    },
    darkInput: {
      backgroundColor: '#374151',
      border: '1px solid #4b5563',
      color: '#f9fafb'
    },
    tableHeader: {
      backgroundColor: '#f3f4f6',
      color: '#111827',
      padding: '8px',
      fontWeight: 600,
      fontSize: '14px'
    },
    darkTableHeader: {
      backgroundColor: '#374151',
      color: '#f9fafb'
    },
    tableRow: {
      borderTop: '1px solid #e5e7eb',
      padding: '8px',
      fontSize: '14px'
    },
    darkTableRow: {
      borderTop: '1px solid #4b5563'
    }
  };

  console.log('🎨 BatchPriority: Rendering UI');

  if (isLoading) {
    return <div style={{ padding: '16px' }}>Loading incremental rems...</div>;
  }

  if (errorMessage) {
    return (
      <div style={{ padding: '16px' }}>
        <div style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '8px', color: '#dc2626' }}>Error</div>
        <div style={{ fontSize: '14px', color: '#6b7280', marginBottom: '16px' }}>{errorMessage}</div>
        <button 
          onClick={() => plugin.widget.closePopup()}
          style={{ ...styles.button, ...styles.secondaryButton }}
        >
          Close
        </button>
      </div>
    );
  }

  if (incrementalRems.length === 0) {
    return (
      <div style={{ padding: '16px' }}>
        <div style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '8px' }}>No Incremental Rems Found</div>
        <div style={{ fontSize: '14px', color: '#6b7280' }}>
          The selected rem and its descendants contain no incremental rems.
        </div>
        <button 
          onClick={() => plugin.widget.closePopup()}
          style={{ ...styles.button, ...styles.secondaryButton, marginTop: '16px' }}
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ fontSize: '24px', fontWeight: 'bold' }}>Batch Priority Change</div>
        
        {/* Search and Filters Bar */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Search by name..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ ...styles.input, flex: '1', minWidth: '200px' }}
          />
          
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            style={styles.input}
          >
            <option value="all">All Types</option>
            {uniqueTypes.map(type => (
              <option key={type} value={type}>{getDisplayType(type)}</option>
            ))}
          </select>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <label style={{ fontSize: '12px' }}>Priority:</label>
            <input
              type="number"
              min="0"
              max="100"
              value={priorityRangeMin}
              onChange={(e) => setPriorityRangeMin(Number(e.target.value))}
              style={{ ...styles.input, width: '60px' }}
            />
            <span>-</span>
            <input
              type="number"
              min="0"
              max="100"
              value={priorityRangeMax}
              onChange={(e) => setPriorityRangeMax(Number(e.target.value))}
              style={{ ...styles.input, width: '60px' }}
            />
          </div>
          
          <button
            onClick={exportToCSV}
            style={{ ...styles.button, backgroundColor: '#8b5cf6', color: 'white' }}
          >
            Export CSV
          </button>
        </div>
        
        {/* Operation Selection */}
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px', backgroundColor: '#f9fafb' }}>
          <div style={{ fontWeight: 600, marginBottom: '8px' }}>Priority Operation</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }
          }>
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="radio"
                  value="increase"
                  checked={operation === 'increase'}
                  onChange={(e) => setOperation(e.target.value as OperationType)}
                  disabled={isPreviewMode}
                />
                <span style={{ fontWeight: 500 }}>Increase Priority</span>
              </label>
              {operation === 'increase' && (
                <div style={{ marginLeft: '24px', marginTop: '8px' }}>
                  <label>Change %: </label>
                  <input
                    type="number"
                    min="1"
                    max="99"
                    value={changePercent}
                    onChange={(e) => {
                      const val = Math.max(1, Math.min(99, Number(e.target.value) || 1));
                      setChangePercent(val);
                    }}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '80px' }}
                  />
                  <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                    Multiply by {changePercent/100} (lower value = higher priority)
                    <br/>
                    <span style={{ color: '#3b82f6' }}>Valid range: 1-99%</span>
                  </div>
                </div>
              )}
            </div>
            
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="radio"
                  value="decrease"
                  checked={operation === 'decrease'}
                  onChange={(e) => setOperation(e.target.value as OperationType)}
                  disabled={isPreviewMode}
                />
                <span style={{ fontWeight: 500 }}>Decrease Priority</span>
              </label>
              {operation === 'decrease' && (
                <div style={{ marginLeft: '24px', marginTop: '8px' }}>
                  <label>Change %: </label>
                  <input
                    type="number"
                    min="101"
                    max="1000"
                    value={decreasePercent}
                    onChange={(e) => {
                      // Allow typing without immediate validation
                      const inputVal = e.target.value;
                      if (inputVal === '') {
                        setDecreasePercent(101);
                      } else {
                        setDecreasePercent(Number(inputVal));
                      }
                    }}
                    onBlur={(e) => {
                      // Apply validation only on blur
                      const val = Math.max(101, Math.min(1000, Number(e.target.value) || 101));
                      setDecreasePercent(val);
                    }}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '80px' }}
                  />
                  <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                    Multiply by {decreasePercent/100} (higher value = lower priority)
                    <br/>
                    <span style={{ color: '#3b82f6' }}>Valid range: 101-1000%</span>
                  </div>
                </div>
              )}
            </div>
            
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="radio"
                  value="spread"
                  checked={operation === 'spread'}
                  onChange={(e) => setOperation(e.target.value as OperationType)}
                  disabled={isPreviewMode}
                />
                <span style={{ fontWeight: 500 }}>Spread Evenly</span>
              </label>
              {operation === 'spread' && (
                <div style={{ marginLeft: '24px', marginTop: '8px' }}>
                  <label>Range: </label>
                  <input
                    type="number"
                    min="0"
                    max="99"
                    value={spreadStart}
                    onChange={(e) => setSpreadStart(Number(e.target.value))}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '60px' }}
                  />
                  <span> to </span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={spreadEnd}
                    onChange={(e) => setSpreadEnd(Number(e.target.value))}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '60px' }}
                  />
                  <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                    Distribute evenly across range
                  </div>
                </div>
              )}
            </div>
            
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="radio"
                  value="adjust"
                  checked={operation === 'adjust'}
                  onChange={(e) => setOperation(e.target.value as OperationType)}
                  disabled={isPreviewMode}
                />
                <span style={{ fontWeight: 500 }}>Adjust Proportionally</span>
              </label>
              {operation === 'adjust' && (
                <div style={{ marginLeft: '24px', marginTop: '8px' }}>
                  <label>Range: </label>
                  <input
                    type="number"
                    min="0"
                    max="99"
                    value={spreadStart}
                    onChange={(e) => setSpreadStart(Number(e.target.value))}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '60px' }}
                  />
                  <span> to </span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={spreadEnd}
                    onChange={(e) => setSpreadEnd(Number(e.target.value))}
                    disabled={isPreviewMode}
                    style={{ ...styles.input, width: '60px' }}
                  />
                  <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                    Maintain relative priorities
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Control Buttons */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            onClick={() => toggleAll(true)}
            style={{ ...styles.button, ...styles.primaryButton }}
          >
            Check All
          </button>
          <button
            onClick={() => toggleAll(false)}
            style={{ ...styles.button, ...styles.secondaryButton }}
          >
            Uncheck All
          </button>
          
          {previousStates.length > 0 && (
            <button
              onClick={undoLastOperation}
              style={{ ...styles.button, backgroundColor: '#f59e0b', color: 'white' }}
            >
              Undo ({previousStates.length})
            </button>
          )}
          
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
            {!isPreviewMode && (
              <button
                onClick={calculateNewPriorities}
                style={{ ...styles.button, ...styles.primaryButton }}
              >
                Preview Changes
              </button>
            )}
            {isPreviewMode && (
              <>
                <button
                  onClick={() => {
                    console.log('🔄 BatchPriority: Resetting preview mode');
                    setIsPreviewMode(false);
                    setHasCalculated(false);
                    setIncrementalRems(prev => prev.map(r => ({ ...r, newPriority: null })));
                  }}
                  style={{ ...styles.button, ...styles.secondaryButton }}
                >
                  Reset
                </button>
                <button
                  onClick={applyChanges}
                  style={{ ...styles.button, ...styles.successButton }}
                  disabled={isApplying}
                >
                  {isApplying ? `Applying... (${appliedCount}/${totalToApply})` : 'Accept and Apply'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Progress Bar */}
        {isApplying && (
          <div style={{ width: '100%', backgroundColor: '#e5e7eb', borderRadius: '4px', height: '20px' }}>
            <div 
              style={{ 
                width: `${(appliedCount / totalToApply) * 100}%`, 
                backgroundColor: '#3b82f6',
                height: '100%',
                borderRadius: '4px',
                transition: 'width 0.3s ease'
              }} 
            />
          </div>
        )}

        {/* Table */}
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden', flex: 1 }}>
          {/* Table Header */}
          <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 80px 80px 80px 120px 120px 60px', ...styles.tableHeader }}>
            <div style={{ padding: '8px' }}>✓</div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('hierarchy')}>
              Name {sortField === 'hierarchy' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('currentPriority')}>
              Current {sortField === 'currentPriority' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('newPriority')}>
              New {sortField === 'newPriority' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('percentile')}>
              % {sortField === 'percentile' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('type')}>
              Type {sortField === 'type' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('nextRepDate')}>
              Next Rep {sortField === 'nextRepDate' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
            <div style={{ padding: '8px', cursor: 'pointer' }} onClick={() => handleSort('repetitions')}>
              Reps {sortField === 'repetitions' && (sortDirection === 'asc' ? '↑' : '↓')}
            </div>
          </div>
          
          {/* Table Body */}
          <div style={{ maxHeight: '450px', overflowY: 'auto' }}>
            {filteredRems.map((remData) => {
              if (!isNodeVisible(remData)) return null;
              
              const hasChildNodes = hasChildren(remData.remId);
              const isExpanded = expandedNodes.has(remData.remId);
              const priorityColor = remData.percentile ? 
                percentileToHslColor(remData.percentile) : 'transparent';
              
              return (
                <div
                  key={remData.remId}
                  style={{ 
                    display: 'grid', 
                    gridTemplateColumns: '40px 1fr 80px 80px 80px 120px 120px 60px',
                    ...styles.tableRow,
                    paddingLeft: sortField === 'hierarchy' ? `${remData.depth * 20 + 8}px` : '8px'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f3f4f6';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <div style={{ padding: '8px' }}>
                    <input
                      type="checkbox"
                      checked={remData.isChecked}
                      onChange={() => toggleCheck(remData.remId)}
                    />
                  </div>
                  <div style={{ padding: '8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {sortField === 'hierarchy' && hasChildNodes && (
                      <button
                        onClick={() => toggleExpanded(remData.remId)}
                        style={{ fontSize: '12px', padding: '0 4px', background: 'none', border: 'none', cursor: 'pointer' }}
                      >
                        {isExpanded ? '▼' : '▶'}
                      </button>
                    )}
                    <span style={{ 
                      overflow: 'hidden', 
                      textOverflow: 'ellipsis', 
                      whiteSpace: 'nowrap',
                      maxWidth: '300px',
                      display: 'inline-block'
                    }} title={remData.name}>
                      {remData.name.length > 50 ? remData.name.substring(0, 50) + '...' : remData.name}
                    </span>
                  </div>
                  <div style={{ padding: '8px', fontWeight: 600 }}>
                    {remData.currentPriority}
                  </div>
                  <div style={{ padding: '8px' }}>
                    {remData.newPriority !== null && (
                      <span 
                        style={{ 
                          fontWeight: 600,
                          // Inverted colors: red for increase (better), green for decrease (worse)
                          color: remData.newPriority < remData.currentPriority ? '#ef4444' : '#10b981' 
                        }}
                      >
                        {remData.newPriority}
                      </span>
                    )}
                  </div>
                  <div style={{ padding: '8px' }}>
                    <span 
                      style={{ 
                        padding: '2px 6px', 
                        borderRadius: '4px', 
                        fontSize: '11px', 
                        color: 'white',
                        backgroundColor: priorityColor,
                        display: 'inline-block'
                      }}
                    >
                      {remData.percentile}%
                    </span>
                  </div>
                  <div style={{ padding: '8px', fontSize: '12px' }}>
                    {getDisplayType(remData.type)}
                  </div>
                  <div style={{ padding: '8px', fontSize: '12px' }}>
                    {dayjs(remData.nextRepDate).format('MMM D, YY')}
                  </div>
                  <div style={{ padding: '8px', fontSize: '12px' }}>
                    {remData.repetitions}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Summary */}
        <div style={{ fontSize: '14px', color: '#6b7280', display: 'flex', justifyContent: 'space-between' }}>
          <span>
            Total: {incrementalRems.length} incremental rem(s) | 
            Filtered: {filteredRems.length} | 
            Selected: {incrementalRems.filter(r => r.isChecked).length}
          </span>
          <span>
            {searchTerm && `Searching for: "${searchTerm}"`}
            {typeFilter !== 'all' && ` | Type: ${getDisplayType(typeFilter)}`}
            {(priorityRangeMin > 0 || priorityRangeMax < 100) && ` | Priority: ${priorityRangeMin}-${priorityRangeMax}`}
          </span>
        </div>
      </div>
    </div>
  );
}

// Helper function with IDs for proper hierarchy tracking - including focused rem as root
async function getRemPathWithIds(plugin: RNPlugin, rem: PluginRem, stopAtId: string): Promise<{path: string[], pathIds: string[]}> {
  console.log('🛤️ Getting path for rem:', rem._id, 'stopping at:', stopAtId);
  const path: string[] = [];
  const pathIds: string[] = [];
  let current: PluginRem | undefined = rem;
  
  // If this IS the focused rem, just return its own info
  if (current._id === stopAtId) {
    const text = current.text ? await safeRemTextToString(plugin, current.text) : 'Untitled';
    return { path: [text], pathIds: [current._id] };
  }
  
  // Build path from current up to (but not including) the focused rem
  while (current) {
    const text = current.text ? await safeRemTextToString(plugin, current.text) : 'Untitled';
    path.unshift(text);
    pathIds.unshift(current._id);
    
    // Stop if we've reached the focused rem
    if (current._id === stopAtId) {
      break;
    }
    
    // If no parent or parent would go beyond focused rem, stop
    if (!current.parent) {
      break;
    }
    
    // Check if the parent is an ancestor of the focused rem
    // This ensures we include intermediate non-incremental rems in the path
    current = await plugin.rem.findOne(current.parent);
  }
  
  console.log('   - Path:', path);
  console.log('   - Path IDs:', pathIds);
  return { path, pathIds };
}

console.log('✅ BatchPriority: Widget module loaded');

renderWidget(BatchPriority);
