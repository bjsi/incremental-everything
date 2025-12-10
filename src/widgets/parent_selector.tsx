// widgets/parent_selector.tsx
// FIXED VERSION - handles allIncrementalRems timing issue

import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  RemId,
  ReactRNPlugin,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { powerupCode, prioritySlotCode, allIncrementalRemKey } from '../lib/consts';
import { calculateRelativePercentile, percentileToHslColor } from '../lib/utils';
import { IncrementalRem, initIncrementalRem } from '../lib/incremental_rem';
import { removeIncrementalRemCache } from '../lib/incremental_rem/cache';
import {
  ParentTreeNode,
  ParentSelectorContext,
  updateNodeInTree,
} from '../lib/hierarchical_parent_selector/types';
import {
  loadChildrenForNode,
  saveLastSelectedDestination,
  expandToLastDestination,
  flattenTreeForDisplay,
} from '../lib/hierarchical_parent_selector/treeHelpers';

// ============================================================================
// STYLES
// ============================================================================

const containerStyle: React.CSSProperties = {
  backgroundColor: 'var(--rn-clr-background-primary)',
  minWidth: '400px',
  maxWidth: '500px',
  display: 'flex',
  flexDirection: 'column',
};

const headerStyle: React.CSSProperties = {
  borderBottom: '1px solid var(--rn-clr-border-primary)',
  backgroundColor: 'var(--rn-clr-background-secondary)',
  padding: '12px 16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const listContainerStyle: React.CSSProperties = {
  maxHeight: '400px',
  overflowY: 'auto',
  padding: '8px 0',
};

const kbdStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 5px',
  fontSize: '10px',
  fontFamily: 'monospace',
  backgroundColor: 'var(--rn-clr-background-tertiary)',
  borderRadius: '3px',
  border: '1px solid var(--rn-clr-border-primary)',
};

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

interface ExpandButtonProps {
  hasChildren: boolean;
  isExpanded: boolean;
  isLoading: boolean;
  onClick: (e: React.MouseEvent) => void;
}

const ExpandButton: React.FC<ExpandButtonProps> = ({
  hasChildren,
  isExpanded,
  isLoading,
  onClick,
}) => {
  if (!hasChildren) {
    return <span style={{ width: '20px', display: 'inline-block' }} />;
  }

  return (
    <button
      onClick={onClick}
      style={{
        width: '20px',
        height: '20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        borderRadius: '4px',
        color: 'var(--rn-clr-content-secondary)',
        fontSize: '12px',
        transition: 'all 0.15s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
      }}
      title={isExpanded ? 'Collapse' : 'Expand children'}
    >
      {isLoading ? '⟳' : isExpanded ? '▼' : '▶'}
    </button>
  );
};

interface PriorityBadgeProps {
  priority: number | null;
  percentile: number | null;
  isIncremental: boolean;
}

const PriorityBadge: React.FC<PriorityBadgeProps> = ({
  priority,
  percentile,
  isIncremental,
}) => {
  if (!isIncremental || priority === null) return null;

  const color = percentile !== null ? percentileToHslColor(percentile) : '#6b7280';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 6px',
        borderRadius: '10px',
        fontSize: '10px',
        fontWeight: 600,
        color: 'white',
        backgroundColor: color,
      }}
      title={`Priority: ${priority}${percentile !== null ? ` (${percentile}%)` : ''}`}
    >
      P{priority}
    </span>
  );
};

interface TreeNodeRowProps {
  node: ParentTreeNode;
  isSelected: boolean;
  isLoadingChildren: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  onMouseEnter: () => void;
}

const TreeNodeRow: React.FC<TreeNodeRowProps> = ({
  node,
  isSelected,
  isLoadingChildren,
  onSelect,
  onToggleExpand,
  onMouseEnter,
}) => {
  const indentPadding = 16 + node.depth * 20;

  return (
    <div
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: `8px 16px 8px ${indentPadding}px`,
        cursor: 'pointer',
        backgroundColor: isSelected
          ? 'var(--rn-clr-background-tertiary)'
          : 'transparent',
        borderLeft: isSelected
          ? '3px solid #3b82f6'
          : '3px solid transparent',
        transition: 'background-color 0.1s ease',
      }}
    >
      <ExpandButton
        hasChildren={node.hasChildren}
        isExpanded={node.isExpanded}
        isLoading={isLoadingChildren}
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpand();
        }}
      />

      {node.isIncremental && (
        <span style={{ fontSize: '12px' }} title="Incremental Rem">
          ⚡
        </span>
      )}

      <span
        style={{
          flex: 1,
          fontSize: '13px',
          color: 'var(--rn-clr-content-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={node.name}
      >
        {node.name.length > 50 ? `${node.name.slice(0, 50)}...` : node.name}
      </span>

      <PriorityBadge
        priority={node.priority}
        percentile={node.percentile}
        isIncremental={node.isIncremental}
      />
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

function ParentSelectorWidget() {
  const plugin = usePlugin();
  const containerRef = React.useRef<HTMLDivElement>(null);

  const [tree, setTree] = useState<ParentTreeNode[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [loadingNodeId, setLoadingNodeId] = useState<RemId | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Auto-focus the container when the popup opens
  useEffect(() => {
    // Small delay to ensure the popup is fully rendered
    const timer = setTimeout(() => {
      containerRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  const contextData = useTrackerPlugin(
    async (rp) => {
      const data = await rp.storage.getSession<ParentSelectorContext>('parentSelectorContext');
      console.log('[ParentSelector:Widget] Context data loaded:', JSON.stringify({
        pdfRemId: data?.pdfRemId,
        contextRemId: data?.contextRemId,
        lastSelectedDestination: data?.lastSelectedDestination,
        rootCandidatesCount: data?.rootCandidates?.length,
      }, null, 2));
      return data;
    },
    []
  );

  const allIncrementalRems = useTrackerPlugin(
    async (rp) => {
      const data = await rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey);
      console.log('[ParentSelector:Widget] allIncrementalRems loaded:', data?.length ?? 'null/undefined');
      return data;
    },
    []
  );

  const displayList = useMemo(() => flattenTreeForDisplay(tree), [tree]);
  const selectedNode = displayList[selectedIndex] || null;

  // ---------------------------------------------------------------------------
  // INITIALIZATION - FIXED VERSION
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const initializeTree = async () => {
      console.log('[ParentSelector:Widget] ========== INITIALIZATION ==========');
      console.log('[ParentSelector:Widget] contextData:', !!contextData);
      console.log('[ParentSelector:Widget] contextData?.rootCandidates:', contextData?.rootCandidates?.length);
      console.log('[ParentSelector:Widget] allIncrementalRems:', allIncrementalRems?.length ?? 'null/undefined');
      console.log('[ParentSelector:Widget] isInitialized:', isInitialized);
      
      if (!contextData?.rootCandidates || isInitialized) {
        console.log('[ParentSelector:Widget] Skipping init - no data or already initialized');
        return;
      }

      setIsLoading(true);

      let initialTree = [...contextData.rootCandidates];
      console.log('[ParentSelector:Widget] Initial tree has', initialTree.length, 'root nodes');

      // If there's a last selected destination, try to expand to it
      // FIX: Use empty array as fallback if allIncrementalRems is null/undefined
      const incrementalRemsToUse = allIncrementalRems || [];
      
      console.log('[ParentSelector:Widget] lastSelectedDestination:', contextData.lastSelectedDestination);
      console.log('[ParentSelector:Widget] incrementalRemsToUse length:', incrementalRemsToUse.length);
      
      if (contextData.lastSelectedDestination) {
        console.log('[ParentSelector:Widget] Attempting to expand to last destination...');
        
        try {
          const { tree: expandedTree, foundIndex } = await expandToLastDestination(
            plugin,
            initialTree,
            contextData.lastSelectedDestination,
            incrementalRemsToUse
          );
          
          initialTree = expandedTree;
          console.log('[ParentSelector:Widget] Expand result - foundIndex:', foundIndex);

          if (foundIndex >= 0) {
            setSelectedIndex(foundIndex);
            console.log('[ParentSelector:Widget] Set selected index to:', foundIndex);
          } else {
            console.log('[ParentSelector:Widget] Destination not found in tree, keeping default selection');
          }
        } catch (error) {
          console.error('[ParentSelector:Widget] Error expanding to last destination:', error);
        }
      } else {
        console.log('[ParentSelector:Widget] No last destination to expand to');
      }

      setTree(initialTree);
      setIsLoading(false);
      setIsInitialized(true);
      console.log('[ParentSelector:Widget] ========== INITIALIZATION COMPLETE ==========');
    };

    initializeTree();
  }, [contextData, allIncrementalRems, plugin, isInitialized]);

  // ---------------------------------------------------------------------------
  // HANDLERS
  // ---------------------------------------------------------------------------

  const handleToggleExpand = useCallback(
    async (nodeRemId: RemId) => {
      if (loadingNodeId) return;

      const nodeInList = displayList.find((n) => n.remId === nodeRemId);
      if (!nodeInList) return;

      if (nodeInList.isExpanded) {
        setTree((prevTree) =>
          updateNodeInTree(prevTree, nodeRemId, (node) => ({
            ...node,
            isExpanded: false,
          }))
        );
        return;
      }

      if (!nodeInList.childrenLoaded) {
        setLoadingNodeId(nodeRemId);

        const children = await loadChildrenForNode(
          plugin,
          nodeRemId,
          allIncrementalRems || [],
          nodeInList.depth
        );

        setTree((prevTree) =>
          updateNodeInTree(prevTree, nodeRemId, (node) => ({
            ...node,
            children,
            childrenLoaded: true,
            isExpanded: true,
          }))
        );

        setLoadingNodeId(null);
      } else {
        setTree((prevTree) =>
          updateNodeInTree(prevTree, nodeRemId, (node) => ({
            ...node,
            isExpanded: true,
          }))
        );
      }
    },
    [displayList, loadingNodeId, plugin, allIncrementalRems]
  );

  const handleSelect = useCallback(
    async (node: ParentTreeNode) => {
      if (!contextData || isCreating) return;

      console.log('[ParentSelector:Widget] ========== HANDLE SELECT ==========');
      console.log('[ParentSelector:Widget] Selected node:', node.name, node.remId);
      console.log('[ParentSelector:Widget] Context pdfRemId:', contextData.pdfRemId);
      console.log('[ParentSelector:Widget] Context contextRemId:', contextData.contextRemId);
      console.log('[ParentSelector:Widget] showPriorityPopupAfterCreate:', (contextData as any).showPriorityPopupAfterCreate);

      setIsCreating(true);

      try {
        const { extractRemId, extractContent, makeIncremental, pdfRemId, contextRemId } =
          contextData;
        
        // Check if we need to show priority popup after creating
        const showPriorityPopup = (contextData as any).showPriorityPopupAfterCreate === true;

        // Create the new rem
        const newRem = await plugin.rem.createRem();
        if (!newRem) {
          await plugin.app.toast('Failed to create rem');
          setIsCreating(false);
          return;
        }

        const sourceLink = {
          i: 'q' as const,
          _id: extractRemId,
          pin: true,
        };
        const contentWithReference = [...extractContent, ' ', sourceLink];
        await newRem.setText(contentWithReference);
        await newRem.setParent(node.remId);

        if (makeIncremental) {
          await initIncrementalRem(plugin as ReactRNPlugin, newRem);
        }

        // Save destination
        console.log('[ParentSelector:Widget] About to save last destination:');
        console.log('[ParentSelector:Widget]   pdfRemId:', pdfRemId);
        console.log('[ParentSelector:Widget]   contextRemId:', contextRemId);
        console.log('[ParentSelector:Widget]   destinationRemId (node.remId):', node.remId);
        
        await saveLastSelectedDestination(plugin, pdfRemId, contextRemId, node.remId);
        
        console.log('[ParentSelector:Widget] Destination saved!');

        // Remove incremental status from original extract
        const extractRem = await plugin.rem.findOne(extractRemId);
        if (extractRem) {
          await removeIncrementalRemCache(plugin, extractRemId);
          await extractRem.removePowerup(powerupCode);
          await extractRem.setHighlightColor('Yellow');
        }

        plugin.widget.closePopup();

        const actionText = makeIncremental ? 'incremental rem' : 'rem';
        await plugin.app.toast(
          `Created ${actionText} under "${node.name.slice(0, 30)}..."`
        );

        // Show priority popup if needed (for new incremental rems created directly)
        if (showPriorityPopup && makeIncremental) {
          console.log('[ParentSelector:Widget] Showing priority popup for new rem:', newRem._id);
          // Small delay to let the parent selector popup close first
          setTimeout(async () => {
            // Open priority popup with remId passed directly
            await plugin.widget.openPopup('priority', {
              remId: newRem._id,
            });
          }, 300);
        }
      } catch (error) {
        console.error('[ParentSelector:Widget] Error creating rem:', error);
        await plugin.app.toast('Error creating rem');
        setIsCreating(false);
      }
    },
    [contextData, isCreating, plugin]
  );

  const handleClose = useCallback(() => {
    plugin.widget.closePopup();
  }, [plugin]);

  // ---------------------------------------------------------------------------
  // KEYBOARD NAVIGATION
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isLoading || isCreating) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, displayList.length - 1));
          break;

        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;

        case 'ArrowRight':
        case 'Tab':
          e.preventDefault();
          if (selectedNode?.hasChildren && !selectedNode.isExpanded) {
            handleToggleExpand(selectedNode.remId);
          }
          break;

        case 'ArrowLeft':
          e.preventDefault();
          if (selectedNode?.isExpanded) {
            handleToggleExpand(selectedNode.remId);
          } else if (selectedNode?.parentId) {
            const parentIndex = displayList.findIndex(
              (n) => n.remId === selectedNode.parentId
            );
            if (parentIndex >= 0) {
              setSelectedIndex(parentIndex);
            }
          }
          break;

        case 'Enter':
          e.preventDefault();
          if (selectedNode) {
            handleSelect(selectedNode);
          }
          break;

        case 'Escape':
          e.preventDefault();
          handleClose();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    displayList,
    selectedNode,
    isLoading,
    isCreating,
    handleToggleExpand,
    handleSelect,
    handleClose,
  ]);

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div 
        ref={containerRef}
        tabIndex={-1}
        style={{...containerStyle, outline: 'none'}}
      >
        <div style={{ padding: '24px', textAlign: 'center' }}>
          <span style={{ color: 'var(--rn-clr-content-secondary)' }}>Loading...</span>
        </div>
      </div>
    );
  }

  if (!contextData || displayList.length === 0) {
    return (
      <div 
        ref={containerRef}
        tabIndex={-1}
        style={{...containerStyle, outline: 'none'}}
      >
        <div style={{ padding: '16px' }}>
          <div style={{ color: 'var(--rn-clr-content-secondary)', marginBottom: '12px' }}>
            No rems found for this PDF.
          </div>
          <button
            onClick={handleClose}
            style={{
              padding: '8px 16px',
              fontSize: '12px',
              borderRadius: '6px',
              backgroundColor: 'var(--rn-clr-background-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
              color: 'var(--rn-clr-content-primary)',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  const actionText = contextData.makeIncremental
    ? 'Create Incremental Rem'
    : 'Create Rem';

  return (
    <div 
      ref={containerRef}
      tabIndex={-1}
      style={{...containerStyle, outline: 'none'}}
    >
      {/* Header */}
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>📁</span>
          <span
            style={{
              fontWeight: 600,
              fontSize: '14px',
              color: 'var(--rn-clr-content-primary)',
            }}
          >
            Select Parent Rem
          </span>
        </div>
        <button
          onClick={handleClose}
          style={{
            padding: '4px 8px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--rn-clr-content-tertiary)',
            fontSize: '12px',
            borderRadius: '4px',
          }}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      {/* DEBUG INFO - Remove this in production */}
      <div style={{ 
        padding: '8px 16px', 
        backgroundColor: '#fef3c7', 
        fontSize: '10px',
        fontFamily: 'monospace',
        borderBottom: '1px solid var(--rn-clr-border-primary)',
      }}>
        <div><strong>DEBUG INFO:</strong></div>
        <div>pdfRemId: {contextData.pdfRemId?.slice(0, 8)}...</div>
        <div>contextRemId: {contextData.contextRemId ? `${contextData.contextRemId.slice(0, 8)}...` : 'null'}</div>
        <div>lastDest: {contextData.lastSelectedDestination ? `${contextData.lastSelectedDestination.slice(0, 8)}...` : 'null'}</div>
        <div>allIncRems: {allIncrementalRems?.length ?? 'null'}</div>
      </div>

      {/* Instructions */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--rn-clr-border-primary)',
          fontSize: '12px',
          color: 'var(--rn-clr-content-secondary)',
        }}
      >
        <p style={{ margin: 0 }}>
          Choose where to create the new{' '}
          {contextData.makeIncremental ? 'incremental ' : ''}rem.
        </p>
        <p
          style={{
            margin: '4px 0 0 0',
            fontSize: '11px',
            color: 'var(--rn-clr-content-tertiary)',
          }}
        >
          Use <kbd style={kbdStyle}>↑</kbd>/<kbd style={kbdStyle}>↓</kbd> to navigate,{' '}
          <kbd style={kbdStyle}>→</kbd> to expand, <kbd style={kbdStyle}>←</kbd> to collapse,{' '}
          <kbd style={kbdStyle}>Enter</kbd> to select
        </p>
      </div>

      {/* Tree List */}
      <div style={listContainerStyle}>
        {displayList.map((node, index) => (
          <TreeNodeRow
            key={`${node.remId}-${node.depth}`}
            node={node}
            isSelected={index === selectedIndex}
            isLoadingChildren={loadingNodeId === node.remId}
            onSelect={() => handleSelect(node)}
            onToggleExpand={() => handleToggleExpand(node.remId)}
            onMouseEnter={() => setSelectedIndex(index)}
          />
        ))}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--rn-clr-border-primary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontSize: '11px',
            color: 'var(--rn-clr-content-tertiary)',
          }}
        >
          {displayList.length} item{displayList.length !== 1 ? 's' : ''}
          {contextData.lastSelectedDestination && ' • Last destination remembered'}
        </span>
        <button
          onClick={() => selectedNode && handleSelect(selectedNode)}
          disabled={!selectedNode || isCreating}
          style={{
            padding: '8px 16px',
            fontSize: '12px',
            fontWeight: 600,
            borderRadius: '6px',
            backgroundColor: isCreating ? '#9ca3af' : '#3b82f6',
            border: 'none',
            color: 'white',
            cursor: isCreating ? 'not-allowed' : 'pointer',
            transition: 'background-color 0.15s ease',
          }}
        >
          {isCreating ? 'Creating...' : actionText}
        </button>
      </div>
    </div>
  );
}

renderWidget(ParentSelectorWidget);