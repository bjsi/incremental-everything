// widgets/parent_selector.tsx
// IMPROVED VERSION - Adds inline child creation capability
// When viewing a node, press '+' or 'n' to create a new child, or click the + button

import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  RemId,
  ReactRNPlugin,
} from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  powerupCode,
  prioritySlotCode,
  allIncrementalRemKey,
  parentSelectorHeadingsOnlyKey,
  parentSelectorHeadingsFirstKey,
} from '../lib/consts';
import { calculateRelativePercentile, percentileToHslColor, screenFittedHeight } from '../lib/utils';
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
  createTreeNode,
  annotateHeadingDescendants,
} from '../lib/hierarchical_parent_selector/treeHelpers';
import { createRemUnderParent } from '../lib/highlightActions';
import { getIncrementalPageRange } from '../lib/pdfUtils';
import { RemTextSegments } from '../components';
import { applyHeadingLevel, getHeadingLevel } from '../lib/outline_restructure';
import { HeadingBadge } from '../components/HeadingBadge';
import { startParentPick } from '../lib/parent_pick';
import { CorpusParentSuggestion, suggestParentFromCorpus } from '../lib/corpus';
import { priorityColor, usePriorityColorScale } from '../components/priorityColor';

// ============================================================================
// STYLES
// ============================================================================

// Fills the popup frame exactly: same height formula as the registration in
// register/widgets.ts, and the frame's width rather than a min-width of its own.
// Any overshoot puts a scrollbar on the frame, and the vertical one then eats
// enough width to force a horizontal one too.
const containerStyle: React.CSSProperties = {
  backgroundColor: 'var(--rn-clr-background-primary)',
  width: '100%',
  height: `${screenFittedHeight(560)}px`,
  boxSizing: 'border-box',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

const headerStyle: React.CSSProperties = {
  flexShrink: 0,
  borderBottom: '1px solid var(--rn-clr-border-primary)',
  backgroundColor: 'var(--rn-clr-background-secondary)',
  padding: '12px 16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

// Takes whatever height the header, instructions and footer leave.
const listContainerStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: '8px 0',
  position: 'relative', // Ensures children's offsetTop is relative precisely to this container
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

interface AddChildButtonProps {
  onClick: (e: React.MouseEvent) => void;
  isVisible: boolean;
}

const AddChildButton: React.FC<AddChildButtonProps> = ({ onClick, isVisible }) => {
  if (!isVisible) return null;

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
        color: 'var(--rn-clr-content-tertiary)',
        fontSize: '14px',
        fontWeight: 'bold',
        transition: 'all 0.15s ease',
        marginLeft: '4px',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
        e.currentTarget.style.color = '#22c55e';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
        e.currentTarget.style.color = 'var(--rn-clr-content-tertiary)';
      }}
      title="Add child rem (press + or n)"
    >
      +
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
  const scale = usePriorityColorScale();
  if (!isIncremental || priority === null) return null;

  const color = scale
    ? priorityColor(scale, priority)
    : percentile !== null ? percentileToHslColor(percentile) : '#6b7280';

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

/**
 * Marks a row that is only shown in this branch because a portal mirrors it —
 * the rem itself lives somewhere else. Filed content still lands in that real
 * home, which is what the portal shows, so picking one of these is safe; the
 * badge is there so the user knows the row isn't where it looks like it is.
 */
const PortalBadge: React.FC<{ breadcrumb?: string }> = ({ breadcrumb }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
      padding: '1px 5px',
      borderRadius: '8px',
      fontSize: '9px',
      fontWeight: 700,
      letterSpacing: '0.02em',
      color: 'white',
      backgroundColor: '#6366f1', // indigo-500: legible on both light and dark
      whiteSpace: 'nowrap',
    }}
    title={
      breadcrumb
        ? `Shown here through a portal — this rem lives under:\n${breadcrumb}`
        : 'Shown here through a portal — this rem lives elsewhere'
    }
  >
    ⧉ portal
  </span>
);

/** The corpus provider's suggestion: green, so it never reads as the (blue) selection. */
const CORPUS_GREEN = '#059669'; // emerald-600: legible on light and dark
const CORPUS_TINT = 'rgba(16, 185, 129, 0.13)';

/** A keyboard key, for the shortcut that jumps to a row (L, S). */
const KEYCAP_WIDTH = 18;
const keycapStyle = (accent: string | null): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  boxSizing: 'border-box',
  minWidth: `${KEYCAP_WIDTH}px`,
  height: '17px',
  padding: '0 4px',
  borderRadius: '4px',
  fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  fontSize: '10px',
  fontWeight: 700,
  lineHeight: 1,
  color: accent ?? 'var(--rn-clr-content-primary)',
  background:
    'linear-gradient(180deg, var(--rn-clr-background-primary, #ffffff) 0%, var(--rn-clr-background-secondary, #eef1f5) 100%)',
  border: `1px solid ${accent ?? 'var(--rn-clr-border-primary, #c5ccd6)'}`,
  // the key's lower edge, and the light catching its top
  boxShadow: `0 2px 0 ${accent ?? 'var(--rn-clr-border-primary, #9aa4b2)'}, inset 0 1px 0 rgba(255, 255, 255, 0.7)`,
  cursor: 'default',
});

/** Tooltip of the corpus provider's suggested row: who suggested it, where, and how it knew. */
function corpusSuggestionTip(s: CorpusParentSuggestion): string {
  const who = s.provider ? `your corpus index (${s.provider})` : 'your corpus index';
  return [
    `Suggested by ${who}${s.confidence === 'medium' ? ' — less sure' : ''}`,
    s.path.length ? s.path.join(' › ') : null,
    s.how || null,
  ]
    .filter(Boolean)
    .join('\n');
}

interface TreeNodeRowProps {
  node: ParentTreeNode;
  isSelected: boolean;
  isLoadingChildren: boolean;
  isSuggested: boolean;
  /** Set on the row the corpus provider suggests (docs/Corpus-Provider.md). */
  corpusSuggestion?: CorpusParentSuggestion | null;
  /** Keys that jump to this row (L: where the popup opened; S: the corpus suggestion). */
  shortcutKeys?: { key: string; tip: string }[];
  onSelect: () => void;
  onToggleExpand: () => void;
  onMouseEnter: () => void;
  onAddChild: () => void;
}

const TreeNodeRow = React.forwardRef<HTMLDivElement, TreeNodeRowProps>((
{
  node,
  isSelected,
  isLoadingChildren,
  isSuggested,
  corpusSuggestion,
  shortcutKeys,
  onSelect,
  onToggleExpand,
  onMouseEnter,
  onAddChild,
}, ref) => {
  const indentPadding = 16 + node.depth * 20;
  const keys = shortcutKeys ?? [];
  const keysWidth = keys.length * KEYCAP_WIDTH + Math.max(0, keys.length - 1) * 3;
  // Left of the arrow when the indentation has room (nested rows); a root row has
  // only 16 px, so there the keys go right after the arrow and every arrow lines up.
  const keysInGutter = keys.length > 0 && indentPadding - 8 >= keysWidth;
  const keycaps = keys.map(({ key, tip }) => (
    <kbd key={key} style={keycapStyle(key === 'S' ? CORPUS_GREEN : null)} title={tip}>
      {key}
    </kbd>
  ));

  return (
    <div
      ref={ref}
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        position: 'relative',
        padding: `8px 16px 8px ${indentPadding}px`,
        cursor: 'pointer',
        // Emphasis, strongest first: the selected row (its background, a blue bar
        // and a blue frame), then the suggestions — blue for this PDF's own
        // suggestion (★), green for the corpus provider's (📚).
        backgroundColor: isSelected && isSuggested
          ? '#dbeafe'
          : isSelected
          ? 'var(--rn-clr-background-tertiary)'
          : isSuggested
          ? 'var(--rn-clr-blue-light, #eff6ff)'
          : corpusSuggestion
          ? CORPUS_TINT
          : 'transparent',
        borderLeft: isSelected && isSuggested
          ? '3px solid #1d4ed8'
          : isSelected
          ? '3px solid #3b82f6'
          : isSuggested
          ? '3px solid var(--rn-clr-blue, #3b82f6)'
          : corpusSuggestion
          ? `3px solid ${CORPUS_GREEN}`
          : '3px solid transparent',
        boxShadow: isSelected ? 'inset 0 0 0 1px rgba(59, 130, 246, 0.55)' : 'none',
        outline: isSelected && isSuggested
          ? '1px dashed #93c5fd'
          : isSelected && corpusSuggestion
          ? `1px dashed ${CORPUS_GREEN}`
          : 'none',
        outlineOffset: '-2px',
        transition: 'background-color 0.1s ease',
      }}
    >
      {keysInGutter && (
        <span
          style={{
            position: 'absolute',
            left: indentPadding - 6 - keysWidth,
            top: '50%',
            transform: 'translateY(-55%)',
            display: 'flex',
            gap: '3px',
          }}
        >
          {keycaps}
        </span>
      )}

      <ExpandButton
        hasChildren={node.hasChildren}
        isExpanded={node.isExpanded}
        isLoading={isLoadingChildren}
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpand();
        }}
      />

      {keys.length > 0 && !keysInGutter && keycaps}

      {node.isIncremental && (
        <span style={{ fontSize: '12px' }} title="Incremental Rem">
          ⚡
        </span>
      )}

      {isSuggested && (
        <span style={{ fontSize: '11px', color: isSelected ? '#1d4ed8' : 'var(--rn-clr-blue, #3b82f6)' }} title="Suggested: this rem's page range contains the highlighted page">
          ★
        </span>
      )}



      <span
        style={{
          flex: 1,
          fontSize: '13px',
          color: isSuggested ? (isSelected ? '#1d4ed8' : 'var(--rn-clr-blue, #1e40af)') : 'var(--rn-clr-content-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontWeight: isSuggested || corpusSuggestion ? 600 : 400,
        }}
        title={
          isSuggested
            ? `Suggested — its page range contains page ${node.name}`
            : corpusSuggestion
            ? corpusSuggestionTip(corpusSuggestion)
            : node.name
        }
      >
        <RemTextSegments segments={node.nameSegments} />
      </span>

      {corpusSuggestion && (
        <span
          style={{
            flexShrink: 0,
            padding: '1px 7px',
            borderRadius: '9px',
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
            color: 'white',
            backgroundColor: CORPUS_GREEN,
            opacity: corpusSuggestion.confidence === 'high' ? 1 : 0.7,
          }}
          title={corpusSuggestionTip(corpusSuggestion)}
        >
          📚 {corpusSuggestion.confidence === 'high' ? 'Suggested' : 'Suggested?'}
        </span>
      )}

      <AddChildButton
        onClick={(e) => {
          e.stopPropagation();
          onAddChild();
        }}
        isVisible={isSelected}
      />

      {node.isPortal && <PortalBadge breadcrumb={node.portalBreadcrumb} />}

      {/* Only headings get a badge here — the shared component's paragraph
          marker (¶) would be noise on every non-heading row. */}
      {node.headingLevel != null && <HeadingBadge level={node.headingLevel} />}

      <PriorityBadge
        priority={node.priority}
        percentile={node.percentile}
        isIncremental={node.isIncremental}
      />
    </div>
  );
});

// ============================================================================
// NEW CHILD INPUT COMPONENT
// ============================================================================

interface NewChildInputRowProps {
  depth: number;
  parentName: string;
  isCreating: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

const NewChildInputRow: React.FC<NewChildInputRowProps> = ({
  depth,
  parentName,
  isCreating,
  onConfirm,
  onCancel,
}) => {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const indentPadding = 16 + (depth + 1) * 20; // Indent one level deeper than parent

  useEffect(() => {
    // Focus the input when mounted
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      e.stopPropagation();
      onConfirm(inputValue.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: `8px 16px 8px ${indentPadding}px`,
        backgroundColor: 'var(--rn-clr-background-secondary)',
        borderLeft: '3px solid #22c55e',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <span style={{ width: '20px', display: 'inline-block' }} /> {/* Placeholder for expand button */}

      <span style={{ fontSize: '12px', color: '#22c55e' }}>+</span>

      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={`New child for "${parentName.slice(0, 20)}..."`}
        disabled={isCreating}
        style={{
          flex: 1,
          fontSize: '13px',
          padding: '4px 8px',
          border: '1px solid var(--rn-clr-border-primary)',
          borderRadius: '4px',
          backgroundColor: 'var(--rn-clr-background-primary)',
          color: 'var(--rn-clr-content-primary)',
          outline: 'none',
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = '#22c55e';
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = 'var(--rn-clr-border-primary)';
        }}
      />

      <button
        onClick={() => inputValue.trim() && onConfirm(inputValue.trim())}
        disabled={!inputValue.trim() || isCreating}
        style={{
          padding: '4px 8px',
          fontSize: '11px',
          borderRadius: '4px',
          backgroundColor: isCreating ? '#9ca3af' : '#22c55e',
          border: 'none',
          color: 'white',
          cursor: isCreating ? 'not-allowed' : 'pointer',
        }}
      >
        {isCreating ? '...' : 'Create'}
      </button>

      <button
        onClick={onCancel}
        disabled={isCreating}
        style={{
          padding: '4px 8px',
          fontSize: '11px',
          borderRadius: '4px',
          backgroundColor: 'transparent',
          border: '1px solid var(--rn-clr-border-primary)',
          color: 'var(--rn-clr-content-secondary)',
          cursor: 'pointer',
        }}
      >
        Cancel
      </button>
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
  const [suggestedRemId, setSuggestedRemId] = useState<RemId | null>(null);
  // The corpus provider's suggestion (docs/Corpus-Provider.md): arrives after the
  // list is shown, never replaces the other suggestions.
  const [corpusSuggestion, setCorpusSuggestion] = useState<CorpusParentSuggestion | null>(null);
  const corpusAskedRef = useRef(false);
  const corpusSelectPendingRef = useRef<RemId | null>(null);
  const initialSelectedRemRef = useRef<RemId | null | undefined>(undefined);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const hasInitiallyScrolled = useRef(false);
  const listContainerRef = useRef<HTMLDivElement>(null);

  // --- Hover arming -------------------------------------------------------
  // The popup opens under the cursor and then scrolls the suggested row into
  // view, which drags rows *underneath a stationary mouse* and fires
  // mouseenter — silently throwing away the suggestion before the user has
  // done anything. So hover only takes over once the pointer has genuinely
  // moved (beyond jitter) and the popup has settled. Keyboard navigation
  // disarms it again, so arrow keys can't be undone by a resting cursor.
  const HOVER_GRACE_MS = 400;
  const HOVER_MOVE_THRESHOLD_PX = 5;
  const hoverArmedRef = useRef(false);
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);
  const mountedAtRef = useRef(Date.now());

  const disarmHover = useCallback(() => {
    hoverArmedRef.current = false;
    // Re-baseline: the next move must clear the threshold from here.
    lastMousePosRef.current = null;
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const prev = lastMousePosRef.current;
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };
      if (!prev) return;
      if (Date.now() - mountedAtRef.current < HOVER_GRACE_MS) return;
      const moved = Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
      if (moved >= HOVER_MOVE_THRESHOLD_PX) hoverArmedRef.current = true;
    };
    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, []);


  // NEW: State for inline child creation
  const [creatingChildForNodeId, setCreatingChildForNodeId] = useState<RemId | null>(null);
  const [isCreatingChild, setIsCreatingChild] = useState(false);

  const handleRowHover = useCallback(
    (index: number) => {
      if (!hoverArmedRef.current || creatingChildForNodeId) return;
      setSelectedIndex(index);
    },
    [creatingChildForNodeId]
  );

  // Per-device display settings for expanded branches (see consts).
  // `settingsLoaded` gates initialization so the first selected index is
  // computed against the same list the user will actually see.
  const [headingsOnly, setHeadingsOnly] = useState(false);
  const [headingsFirst, setHeadingsFirst] = useState(true);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [only, first] = await Promise.all([
        plugin.storage.getLocal<boolean>(parentSelectorHeadingsOnlyKey),
        plugin.storage.getLocal<boolean>(parentSelectorHeadingsFirstKey),
      ]);
      if (cancelled) return;
      setHeadingsOnly(only === true);     // default OFF
      setHeadingsFirst(first !== false);  // default ON
      setSettingsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [plugin]);

  const toggleHeadingsOnly = useCallback(async () => {
    const next = !headingsOnly;
    setHeadingsOnly(next);
    plugin.storage.setLocal(parentSelectorHeadingsOnlyKey, next);
    containerRef.current?.focus();

    // Branches expanded while the filter was off were never probed, so we don't
    // yet know which of their plain rems lead to headings. Fill that in now;
    // until it lands those rems stay visible, which is the safe direction.
    if (next) {
      const annotated = await annotateHeadingDescendants(plugin, tree, { recurse: true });
      setTree(annotated);
    }
  }, [headingsOnly, plugin, tree]);

  const toggleHeadingsFirst = useCallback(() => {
    setHeadingsFirst((prev) => {
      const next = !prev;
      plugin.storage.setLocal(parentSelectorHeadingsFirstKey, next);
      return next;
    });
    containerRef.current?.focus();
  }, [plugin]);

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
      return data ?? null;
    },
    []
  );

  const allIncrementalRems = useTrackerPlugin(
    async (rp) => {
      const data = await rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey);
      // Normalize: null = resolved-empty, undefined = still loading.
      // The init effect uses this distinction to wait for the cache exactly once.
      return data ?? null;
    },
    []
  );

  // Rems the filter must never hide: the remembered destination and whatever
  // we're suggesting. Both are often plain rems, and hiding the row the popup
  // is actively recommending would be the worst possible filter behavior.
  const pinnedRemIds = useMemo(() => {
    const ids = new Set<RemId>();
    if (contextData?.lastSelectedDestination) ids.add(contextData.lastSelectedDestination);
    if (contextData?.contextRemId) ids.add(contextData.contextRemId);
    if (suggestedRemId) ids.add(suggestedRemId);
    if (corpusSuggestion) ids.add(corpusSuggestion.remId);
    return ids;
  }, [contextData, suggestedRemId, corpusSuggestion]);

  const displayOptions = useMemo(
    () => ({ headingsOnly, headingsFirst, alwaysShowRemIds: pinnedRemIds }),
    [headingsOnly, headingsFirst, pinnedRemIds]
  );

  const displayList = useMemo(
    () => flattenTreeForDisplay(tree, displayOptions),
    [tree, displayOptions]
  );
  const selectedNode = displayList[selectedIndex] || null;

  // Keep the highlight on the same rem when the display options reorder or
  // filter the list; if that rem is gone, just keep the index in range.
  const selectedRemIdRef = useRef<RemId | null>(null);

  // The corpus suggestion asked to be selected: do it once its row is in the list.
  useEffect(() => {
    const pending = corpusSelectPendingRef.current;
    if (!pending) return;
    const idx = displayList.findIndex((n) => n.remId === pending);
    if (idx >= 0) {
      corpusSelectPendingRef.current = null;
      setSelectedIndex(idx);
    }
  }, [displayList, corpusSuggestion]);

  useEffect(() => {
    if (!isInitialized) return;
    const targetId = selectedRemIdRef.current;
    const idx = targetId ? displayList.findIndex((n) => n.remId === targetId) : -1;
    if (idx >= 0) {
      setSelectedIndex((prev) => (prev === idx ? prev : idx));
    } else {
      setSelectedIndex((prev) => Math.min(prev, Math.max(0, displayList.length - 1)));
    }
  }, [displayList, isInitialized]);

  // Record the selected rem AFTER the re-locate effect above: when the list changes,
  // that effect must see the rem selected before the change, not whatever row now
  // sits at the old index (effects run in the order they are declared).
  useEffect(() => {
    if (selectedNode) selectedRemIdRef.current = selectedNode.remId;
  }, [selectedNode]);

  // Scroll to selected item whenever selectedIndex changes or after initialization
  useEffect(() => {
    if (!isInitialized || itemRefs.current.length === 0) return;

    let attempts = 0;
    const maxAttempts = 20; // Allow up to 1 second of retries to outlast UI animations

    // We use a retry mechanism because inside the sandboxed iframe, the DOM layout 
    // might not have non-zero dimensions immediately after the render commit.
    const tryScroll = () => {
      const selectedEl = itemRefs.current[selectedIndex];
      const container = listContainerRef.current;

      if (selectedEl && container) {
        // If layout hasn't populated, wait for next paint
        if (selectedEl.clientHeight === 0 && attempts < maxAttempts) {
          attempts++;
          setTimeout(tryScroll, 50);
          return;
        }

        if (hasInitiallyScrolled.current) {
          // Manual nearest block logic for keyboard navigation
          const elRect = selectedEl.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();

          if (elRect.top < containerRect.top) {
            container.scrollTop -= (containerRect.top - elRect.top);
          } else if (elRect.bottom > containerRect.bottom) {
            container.scrollTop += (elRect.bottom - containerRect.bottom);
          }
        } else {
          // Manual center block logic for initial load
          // We use offsetTop because getBoundingClientRect gives incorrect warped
          // coordinates while the popup is scaling/animating into view natively.
          const scrollOffset = selectedEl.offsetTop - container.clientHeight / 2 + selectedEl.clientHeight / 2;
          container.scrollTop = scrollOffset;
          hasInitiallyScrolled.current = true;
        }
      } else if (attempts < maxAttempts) {
        attempts++;
        setTimeout(tryScroll, 50);
      }
    };

    // Wait slightly bit initially to allow DOM to attach inside the plugin iframe
    const initialTimer = setTimeout(tryScroll, 100);

    return () => clearTimeout(initialTimer);
  }, [selectedIndex, isInitialized, displayList.length]);

  // ---------------------------------------------------------------------------
  // INITIALIZATION - FIXED VERSION
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Gate: enter init only when BOTH async reads have resolved, and we
    // haven't already initialized. `useTrackerPlugin` returns `undefined`
    // while still loading; the loaders normalize empty results to `null`,
    // so `=== undefined` cleanly distinguishes "loading" from "resolved-empty".
    // Without this gate the effect ran 3–4× per popup as each dep resolved
    // separately, redoing the full tree expansion each time.
    if (contextData === undefined || allIncrementalRems === undefined) return;
    // Display settings decide the row order, so the initial selected index is
    // only meaningful once they've loaded.
    if (!settingsLoaded) return;
    if (!contextData?.rootCandidates || isInitialized) return;

    const initializeTree = async () => {
      setIsLoading(true);

      let initialTree = [...contextData.rootCandidates];
      const incrementalRemsToUse = allIncrementalRems || [];

      // The rem to land on. expandToLastDestination reports an index into an
      // unfiltered, editor-order list, so we track the id and resolve it to an
      // index once the tree is final — against the list the user will see.
      let targetRemId: RemId | null = null;

      if (contextData.lastSelectedDestination) {
        try {
          const { tree: expandedTree } = await expandToLastDestination(
            plugin,
            initialTree,
            contextData.lastSelectedDestination,
            incrementalRemsToUse
          );

          initialTree = expandedTree;
          targetRemId = contextData.lastSelectedDestination;
        } catch (error) {
          console.error('[ParentSelector:Widget] Error expanding to last destination:', error);
        }
      } else if (contextData.contextRemId) {
        // No prior memory but we know which IncRem the user is currently reviewing
        // (from queue or editor review timer) — suggest that one.
        try {
          const { tree: expandedTree } = await expandToLastDestination(
            plugin,
            initialTree,
            contextData.contextRemId,
            incrementalRemsToUse
          );

          initialTree = expandedTree;
          setSuggestedRemId(contextData.contextRemId);
          targetRemId = contextData.contextRemId;
        } catch (error) {
          console.error('[ParentSelector:Widget] Error expanding to contextRemId:', error);
        }
      } else {
        // No prior memory and no active IncRem context: suggest the tightest-range
        // IncRem whose page range contains the highlight page.
        const pageIndex = (contextData as any).highlightPageIndex as number | null | undefined;
        if (pageIndex != null && contextData.pdfRemId) {
          try {
            let bestRemId: RemId | null = null;
            let bestSize = Infinity;

            // Scan every candidate, not just the visible ones — a filtered-out
            // rem can still be the tightest page-range match, and pinning it
            // below makes it visible.
            const flatAll = flattenTreeForDisplay(initialTree);
            for (const node of flatAll) {
              if (!node.isIncremental) continue;
              const range = await getIncrementalPageRange(plugin, node.remId, contextData.pdfRemId);
              if (!range) continue;
              const rangeEnd = range.end ?? Infinity;
              if (pageIndex >= range.start && pageIndex <= rangeEnd) {
                const size = rangeEnd - range.start;
                if (size < bestSize) {
                  bestSize = size;
                  bestRemId = node.remId;
                }
              }
            }

            if (bestRemId) {
              setSuggestedRemId(bestRemId);
              targetRemId = bestRemId;
            }
          } catch (e) {
            console.error('[ParentSelector:Widget] Error computing suggestion:', e);
          }
        }
      }

      // expandToLastDestination loads children without the probe, so annotate
      // whatever it pre-expanded before the filtered view is first rendered.
      if (headingsOnly) {
        try {
          initialTree = await annotateHeadingDescendants(plugin, initialTree, {
            recurse: true,
          });
        } catch (error) {
          console.error('[ParentSelector:Widget] Error probing heading descendants:', error);
        }
      }

      // Resolve the landing row against the final tree and the same display
      // options the first render will use.
      if (targetRemId) {
        const foundIndex = flattenTreeForDisplay(initialTree, {
          ...displayOptions,
          // suggestedRemId lands in state asynchronously, so pin the target
          // explicitly rather than waiting for displayOptions to catch up.
          alwaysShowRemIds: new Set([...pinnedRemIds, targetRemId]),
        }).findIndex((n) => n.remId === targetRemId);
        if (foundIndex >= 0) setSelectedIndex(foundIndex);
      }

      setTree(initialTree);
      setIsLoading(false);
      setIsInitialized(true);
    };

    initializeTree();
    // displayOptions/pinnedRemIds are deliberately not dependencies: they only
    // seed the initial selected index here, and later changes are handled by
    // the re-locate effect.
  }, [contextData, allIncrementalRems, plugin, isInitialized, settingsLoaded]);

  // Loading the tree can outlast the grace period, and any mouse jitter while
  // the user waits would leave hover armed for the moment the list appears and
  // scrolls. So restart the guard from when there is actually a list to hover.
  useEffect(() => {
    if (!isInitialized) return;
    mountedAtRef.current = Date.now();
    disarmHover();
  }, [isInitialized, disarmHover]);

  // ---------------------------------------------------------------------------
  // CORPUS PROVIDER SUGGESTION (docs/Corpus-Provider.md)
  // ---------------------------------------------------------------------------
  // Asked once the list is on screen, never awaited before it. The suggested rem is
  // revealed (expanded to, or given a row of its own at the top) and marked 📚. It
  // is selected only when the popup had nothing else to suggest and the user has
  // not moved the selection meanwhile.
  const treeRef = useRef<ParentTreeNode[]>([]);
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    []
  );

  useEffect(() => {
    if (!isInitialized || !contextData || corpusAskedRef.current) return;
    corpusAskedRef.current = true;
    initialSelectedRemRef.current = selectedRemIdRef.current;
    const { extractRemId, extractContent, pdfRemId } = contextData;
    if (!pdfRemId || !extractRemId) return;
    const hadOtherSuggestion =
      !!contextData.lastSelectedDestination || !!contextData.contextRemId || !!suggestedRemId;

    (async () => {
      const text = await plugin.richText.toString(extractContent ?? []).catch(() => '');
      const suggestion = await suggestParentFromCorpus(plugin, {
        remId: extractRemId,
        sourceRemId: pdfRemId,
        page: contextData.highlightPageIndex ?? null,
        texts: [text],
      });
      if (!aliveRef.current || !suggestion) return;

      const base = treeRef.current;
      let next = base;
      try {
        const alwaysShow = new Set([...pinnedRemIds, suggestion.remId]);
        const { tree: expanded } = await expandToLastDestination(
          plugin,
          base,
          suggestion.remId,
          allIncrementalRems || []
        );
        const visible = flattenTreeForDisplay(expanded, { ...displayOptions, alwaysShowRemIds: alwaysShow }).some(
          (n) => n.remId === suggestion.remId
        );
        if (visible) {
          next = expanded;
        } else {
          // Outside the tree this PDF's candidates span: a row of its own at the top.
          const rem = await plugin.rem.findOne(suggestion.remId);
          if (rem) next = [await createTreeNode(plugin, rem, allIncrementalRems || [], 0, null), ...base];
        }
        if (headingsOnly && next !== base) {
          next = await annotateHeadingDescendants(plugin, next, { recurse: true });
        }
      } catch (error) {
        console.error('[ParentSelector:Widget] Error revealing the corpus suggestion:', error);
      }
      if (!aliveRef.current) return;

      const userMoved = selectedRemIdRef.current !== initialSelectedRemRef.current;
      const selectIt = !hadOtherSuggestion && !userMoved;
      // The row to keep selected. Expanding to the suggestion can insert rows above
      // the selection (a chapter opened above the last destination), so its index
      // is recomputed against the new tree and set in the same batch as the tree.
      const keepRemId = selectIt ? suggestion.remId : selectedRemIdRef.current;
      setCorpusSuggestion(suggestion);
      // Only if the user has not expanded or collapsed anything meanwhile.
      if (next !== base && treeRef.current === base) {
        const idx = keepRemId
          ? flattenTreeForDisplay(next, {
              ...displayOptions,
              alwaysShowRemIds: new Set([...pinnedRemIds, suggestion.remId]),
            }).findIndex((n) => n.remId === keepRemId)
          : -1;
        if (keepRemId) selectedRemIdRef.current = keepRemId;
        setTree(next);
        if (idx >= 0) setSelectedIndex(idx);
      } else if (selectIt) {
        selectedRemIdRef.current = suggestion.remId;
        corpusSelectPendingRef.current = suggestion.remId;
      }
    })();
    // The other values are read once, when the list is first shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized, contextData]);

  // ---------------------------------------------------------------------------
  // HANDLERS
  // ---------------------------------------------------------------------------

  const handleToggleExpand = useCallback(
    // Takes the clicked row, not just its id: the same rem can occupy several
    // rows at different depths, and looking it up by remId would pick an
    // arbitrary one — loading its children against the wrong depth and
    // indenting them under the wrong row.
    async (nodeInList: ParentTreeNode) => {
      if (loadingNodeId) return;

      const nodeRemId = nodeInList.remId;

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
          nodeInList.depth,
          { detectHeadingDescendants: headingsOnly }
        );

        setTree((prevTree) =>
          updateNodeInTree(prevTree, nodeRemId, (node) => ({
            ...node,
            // updateNodeInTree matches on remId, so every copy of this rem gets
            // these children. Re-depth them per copy (and give each its own
            // array) so a copy sitting at another level still indents its
            // children correctly instead of inheriting the clicked row's depth.
            children:
              node.depth === nodeInList.depth
                ? children
                : children.map((c) => ({ ...c, depth: node.depth + 1 })),
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
    [loadingNodeId, plugin, allIncrementalRems, headingsOnly]
  );

  // NEW: Handler to start creating a child for the selected node
  const handleStartAddChild = useCallback(() => {
    if (!selectedNode || isCreating || isCreatingChild) return;

    console.log('[ParentSelector:Widget] Starting add child for:', selectedNode.name);

    // If the node is not expanded and has children, expand it first
    if (selectedNode.hasChildren && !selectedNode.isExpanded) {
      handleToggleExpand(selectedNode);
    }

    setCreatingChildForNodeId(selectedNode.remId);
  }, [selectedNode, isCreating, isCreatingChild, handleToggleExpand]);

  // NEW: Handler to create the child rem
  const handleCreateChild = useCallback(
    async (childName: string) => {
      if (!creatingChildForNodeId || isCreatingChild) return;

      const parentNode = displayList.find((n) => n.remId === creatingChildForNodeId);
      if (!parentNode) {
        setCreatingChildForNodeId(null);
        return;
      }

      console.log('[ParentSelector:Widget] Creating child rem:', childName, 'under:', parentNode.name);
      setIsCreatingChild(true);

      try {
        // Create the new rem
        const newRem = await plugin.rem.createRem();
        if (!newRem) {
          await plugin.app.toast('Failed to create rem');
          setIsCreatingChild(false);
          return;
        }

        // Set the text and parent
        await newRem.setText([childName]);
        await newRem.setParent(creatingChildForNodeId);

        // Pick a heading level that respects the parent's heading hierarchy by
        // nesting one level deeper than the ancestor. Although the SDK types only
        // advertise H1–H3, RemNote also supports (and returns) H4–H6, so we handle
        // the full range. If the ancestor isn't a header, fall back to H4.
        const parentRem = await plugin.rem.findOne(creatingChildForNodeId);
        const parentLevel = parentRem ? await getHeadingLevel(parentRem) : null;
        // Nest one level deeper than the ancestor, clamped to the deepest level
        // RemNote supports (H6). If the ancestor isn't a header, fall back to H4.
        const headingLevel = (
          parentLevel ? Math.min(parentLevel + 1, 6) : 4
        ) as 1 | 2 | 3 | 4 | 5 | 6;
        try {
          await applyHeadingLevel(newRem, headingLevel);
        } catch (headingErr) {
          // Never let a heading-styling failure abort child creation. Worst
          // case the rem is created as normal text and can be styled manually.
          console.warn(
            `[ParentSelector:Widget] Failed to set heading level H${headingLevel}; leaving rem unstyled.`,
            headingErr
          );
        }

        console.log(`[ParentSelector:Widget] Child rem created: ${newRem._id} (H${headingLevel}, parent was ${parentLevel ? `H${parentLevel}` : 'normal'})`);

        // Create a tree node for the new child using the helper function
        // Note: We need to fetch the rem again to get the full PluginRem object
        const createdRem = await plugin.rem.findOne(newRem._id);
        if (!createdRem) {
          await plugin.app.toast('Failed to find created rem');
          setIsCreatingChild(false);
          return;
        }

        const newChildNode: ParentTreeNode = await createTreeNode(
          plugin,
          createdRem,
          allIncrementalRems || [],
          parentNode.depth + 1,
          creatingChildForNodeId
        );

        // Store the new rem id for selecting it after state update
        const newRemId = newRem._id;
        const parentNodeId = creatingChildForNodeId;

        // Update the tree: add the new child and mark parent as having children
        setTree((prevTree) => {
          const updatedTree = updateNodeInTree(prevTree, parentNodeId, (node) => ({
            ...node,
            hasChildren: true,
            childrenLoaded: true,
            isExpanded: true,
            children: [...node.children, newChildNode],
          }));

          // Calculate the new display list and find the index of the new child
          const newDisplayList = flattenTreeForDisplay(updatedTree, displayOptions);
          const newChildIndex = newDisplayList.findIndex((n) => n.remId === newRemId);

          console.log('[ParentSelector:Widget] New child index in updated tree:', newChildIndex);

          // Schedule the selection update
          setTimeout(() => {
            if (newChildIndex >= 0) {
              setSelectedIndex(newChildIndex);
            }
            // Re-focus the container
            containerRef.current?.focus();
          }, 50);

          return updatedTree;
        });

        await plugin.app.toast(`Created "${childName}"`);

      } catch (error) {
        console.error('[ParentSelector:Widget] Error creating child rem:', error);
        await plugin.app.toast('Error creating rem');
      } finally {
        setIsCreatingChild(false);
        setCreatingChildForNodeId(null);
      }
    },
    [creatingChildForNodeId, isCreatingChild, displayList, plugin, allIncrementalRems, displayOptions]
  );

  // NEW: Handler to cancel child creation
  const handleCancelAddChild = useCallback(() => {
    setCreatingChildForNodeId(null);
    // Re-focus the container after canceling
    setTimeout(() => {
      containerRef.current?.focus();
    }, 50);
  }, []);

  const handleSelect = useCallback(
    async (node: ParentTreeNode) => {
      if (!contextData || isCreating || creatingChildForNodeId) return;
      // The popup opens under the cursor that just clicked the toolbar button,
      // so a quick second click would land on whatever row happens to be there
      // and create the rem for real. Ignore clicks until the popup settles.
      if (Date.now() - mountedAtRef.current < HOVER_GRACE_MS) return;

      setIsCreating(true);

      try {
        const { extractRemId, extractContent, makeIncremental, pdfRemId, contextRemId } =
          contextData;

        // Check if we need to show priority popup after creating
        const showPriorityPopup = (contextData as any).showPriorityPopupAfterCreate === true;

        // Create the new rem using the centralized function
        // This ensures creating proper tags, priority handling, etc.
        const highlightRem = await plugin.rem.findOne(extractRemId);
        if (!highlightRem) {
          await plugin.app.toast('Could not find original highlight');
          setIsCreating(false);
          return;
        }

        await createRemUnderParent(
          plugin as ReactRNPlugin,
          highlightRem,
          node.remId,
          makeIncremental,
          pdfRemId,
          contextRemId,
          node.name,
          showPriorityPopup // Pass this flag to handle priority popup logic inside the function
        );

        // If NOT showing popup, we need to manually close the current parent_selector popup
        // createRemUnderParent handles OPENING the priority popup if needed (which replaces this one)
        // but if no priority popup is needed, we should close this one.
        if (!showPriorityPopup || !makeIncremental) {
          plugin.widget.closePopup();
        }

      } catch (error) {
        console.error('[ParentSelector:Widget] Error creating rem:', error);
        await plugin.app.toast('Error creating rem');
        setIsCreating(false);
      }
    },
    [contextData, isCreating, creatingChildForNodeId, plugin]
  );

  const handleClose = useCallback(() => {
    plugin.widget.closePopup();
  }, [plugin]);

  // Hand the choice over to the editor: this popup closes and a floating card
  // waits for the user to confirm a destination there (lib/parent_pick.ts).
  const handlePickInEditor = useCallback(async () => {
    if (isCreating || creatingChildForNodeId) return;
    await startParentPick(plugin);
  }, [plugin, isCreating, creatingChildForNodeId]);

  // The rem the popup opened on: the remembered destination if there is one,
  // otherwise whatever we suggested. This is what "restore" jumps back to.
  const recoverTarget = useMemo(() => {
    if (contextData?.lastSelectedDestination) {
      return { remId: contextData.lastSelectedDestination, label: 'Last destination' };
    }
    if (suggestedRemId) {
      return { remId: suggestedRemId, label: 'Suggested' };
    }
    if (corpusSuggestion) {
      return { remId: corpusSuggestion.remId, label: 'Suggested by your corpus index' };
    }
    return null;
  }, [contextData, suggestedRemId, corpusSuggestion]);

  const jumpToRem = useCallback(async (remId: RemId) => {
    if (isCreating || creatingChildForNodeId) return;

    // Restoring is a keyboard action, so stop a resting cursor from immediately
    // undoing it the next time a row slides under the pointer.
    disarmHover();
    selectedRemIdRef.current = remId;

    const idx = displayList.findIndex((n) => n.remId === remId);
    if (idx >= 0) {
      setSelectedIndex(idx);
      return;
    }

    // Not visible — the user collapsed the path since. Re-expand to it.
    try {
      const { tree: expandedTree } = await expandToLastDestination(
        plugin,
        tree,
        remId,
        allIncrementalRems || []
      );
      let nextTree = expandedTree;
      if (headingsOnly) {
        nextTree = await annotateHeadingDescendants(plugin, nextTree, { recurse: true });
      }
      setTree(nextTree);

      const foundIndex = flattenTreeForDisplay(nextTree, {
        ...displayOptions,
        alwaysShowRemIds: new Set([...pinnedRemIds, remId]),
      }).findIndex((n) => n.remId === remId);
      if (foundIndex >= 0) setSelectedIndex(foundIndex);
    } catch (error) {
      console.error('[ParentSelector:Widget] Error restoring selection:', error);
    }
  }, [
    isCreating,
    creatingChildForNodeId,
    displayList,
    tree,
    plugin,
    allIncrementalRems,
    headingsOnly,
    displayOptions,
    pinnedRemIds,
    disarmHover,
  ]);

  const handleRecoverSelection = useCallback(() => {
    if (recoverTarget) jumpToRem(recoverTarget.remId);
  }, [recoverTarget, jumpToRem]);

  // The corpus provider's section: its own button and key (S), because it is
  // often not the rem the popup opened on (a remembered destination wins that).
  const handleJumpToCorpus = useCallback(() => {
    if (corpusSuggestion) jumpToRem(corpusSuggestion.remId);
  }, [corpusSuggestion, jumpToRem]);

  // ---------------------------------------------------------------------------
  // KEYBOARD NAVIGATION
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // If we're in child creation mode, don't handle keyboard events here
      if (creatingChildForNodeId) return;
      if (isLoading || isCreating) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          disarmHover();
          setSelectedIndex((prev) => Math.min(prev + 1, displayList.length - 1));
          break;

        case 'ArrowUp':
          e.preventDefault();
          disarmHover();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;

        case 'ArrowRight':
        case 'Tab':
          e.preventDefault();
          if (selectedNode?.hasChildren && !selectedNode.isExpanded) {
            handleToggleExpand(selectedNode);
          }
          break;

        case 'ArrowLeft':
          e.preventDefault();
          if (selectedNode?.isExpanded) {
            handleToggleExpand(selectedNode);
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

        // 'l' (last) jumps back to the remembered/suggested destination.
        case 'l':
        case 'L':
          e.preventDefault();
          handleRecoverSelection();
          break;

        case 'e':
        case 'E':
          e.preventDefault();
          handlePickInEditor();
          break;

        // 's' jumps to the section the corpus provider suggests.
        case 's':
        case 'S':
          if (!corpusSuggestion) break;
          e.preventDefault();
          handleJumpToCorpus();
          break;

        // NEW: '+' or 'n' to add a child to the selected node
        case '+':
        case '=': // Handle both + and = (without shift)
        case 'n':
        case 'N':
          e.preventDefault();
          handleStartAddChild();
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
    creatingChildForNodeId,
    handleToggleExpand,
    handleSelect,
    handleClose,
    handleStartAddChild,
    handleRecoverSelection,
    handleJumpToCorpus,
    corpusSuggestion,
    handlePickInEditor,
    disarmHover,
  ]);

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div
        ref={containerRef}
        tabIndex={-1}
        style={{ ...containerStyle, outline: 'none' }}
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
        style={{ ...containerStyle, outline: 'none' }}
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

  // Build the display list with the new child input row if active
  const renderTreeWithInput = () => {
    const elements: React.ReactNode[] = [];
    let inputRendered = false;

    // We just maintain the length to avoid keeping dead references
    if (itemRefs.current.length > displayList.length) {
      itemRefs.current.length = displayList.length;
    }

    for (let index = 0; index < displayList.length; index++) {
      const node = displayList[index];

      // Render the node row
      elements.push(
        <TreeNodeRow
          // Position-based (see ParentTreeNode.displayKey). The same rem can
          // occupy several rows, and every identity-derived field is identical
          // between those rows — only the ancestor path tells them apart.
          key={node.displayKey ?? `${index}-${node.remId}`}
          ref={(el) => {
            if (itemRefs.current) {
              itemRefs.current[index] = el;
            }
          }}
          node={node}
          isSelected={index === selectedIndex && !creatingChildForNodeId}
          isSuggested={node.remId === suggestedRemId}
          corpusSuggestion={corpusSuggestion && node.remId === corpusSuggestion.remId ? corpusSuggestion : null}
          shortcutKeys={[
            ...(recoverTarget && node.remId === recoverTarget.remId
              ? [{ key: 'L', tip: `Press L to come back here (${recoverTarget.label.toLowerCase()})` }]
              : []),
            ...(corpusSuggestion && node.remId === corpusSuggestion.remId
              ? [{ key: 'S', tip: 'Press S to come back here (suggested by your corpus index)' }]
              : []),
          ]}
          isLoadingChildren={loadingNodeId === node.remId}
          onSelect={() => handleSelect(node)}
          onToggleExpand={() => handleToggleExpand(node)}
          onMouseEnter={() => handleRowHover(index)}
          onAddChild={() => {
            setSelectedIndex(index);
            setCreatingChildForNodeId(node.remId);
          }}
        />
      );

      // If this node is the one we're creating a child for, render the input row
      // The input should appear after this node and all its visible children
      if (creatingChildForNodeId === node.remId && !inputRendered) {
        // Find the last visible descendant of this node
        let lastDescendantIndex = index;
        if (node.isExpanded && node.children.length > 0) {
          // Traverse to find the last visible descendant
          for (let j = index + 1; j < displayList.length; j++) {
            if (displayList[j].depth > node.depth) {
              lastDescendantIndex = j;
            } else {
              break;
            }
          }
        }

        // Render the input after the last descendant (or immediately after if collapsed/no children)
        if (index === lastDescendantIndex) {
          elements.push(
            <NewChildInputRow
              key={`new-child-input-${node.remId}`}
              depth={node.depth}
              parentName={node.name}
              isCreating={isCreatingChild}
              onConfirm={handleCreateChild}
              onCancel={handleCancelAddChild}
            />
          );
          inputRendered = true;
        }
      }

      // Check if we just passed the last descendant of the node we're creating a child for
      if (creatingChildForNodeId && !inputRendered) {
        const parentNode = displayList.find((n) => n.remId === creatingChildForNodeId);
        if (parentNode) {
          // Check if the next node (if exists) is not a descendant
          const nextNode = displayList[index + 1];
          const currentIsDescendant = node.parentId === creatingChildForNodeId ||
            (displayList.slice(displayList.findIndex(n => n.remId === creatingChildForNodeId) + 1, index + 1)
              .some(n => n.remId === node.parentId));

          const nextIsNotDescendant = !nextNode || nextNode.depth <= parentNode.depth;

          if (currentIsDescendant && nextIsNotDescendant) {
            elements.push(
              <NewChildInputRow
                key={`new-child-input-${creatingChildForNodeId}`}
                depth={parentNode.depth}
                parentName={parentNode.name}
                isCreating={isCreatingChild}
                onConfirm={handleCreateChild}
                onCancel={handleCancelAddChild}
              />
            );
            inputRendered = true;
          }
        }
      }
    }

    // If input still not rendered (edge case - parent is last item), render it at the end
    if (creatingChildForNodeId && !inputRendered) {
      const parentNode = displayList.find((n) => n.remId === creatingChildForNodeId);
      if (parentNode) {
        elements.push(
          <NewChildInputRow
            key={`new-child-input-${creatingChildForNodeId}`}
            depth={parentNode.depth}
            parentName={parentNode.name}
            isCreating={isCreatingChild}
            onConfirm={handleCreateChild}
            onCancel={handleCancelAddChild}
          />
        );
      }
    }

    return elements;
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      style={{ ...containerStyle, outline: 'none' }}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {/* The corpus provider's suggestion, when it is not what's selected. */}
          {corpusSuggestion && selectedNode?.remId !== corpusSuggestion.remId && (
            <button
              onClick={handleJumpToCorpus}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: '3px 8px',
                fontSize: '11px',
                fontWeight: 600,
                borderRadius: '4px',
                border: `1px solid ${CORPUS_GREEN}`,
                background: CORPUS_TINT,
                color: CORPUS_GREEN,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              title={`${corpusSuggestionTip(corpusSuggestion)}\n(press S)`}
            >
              📚 Suggested section
            </button>
          )}
          {/* Jump back to where the popup opened, for when the selection got
              knocked off by a stray hover. Hidden once it's already selected. */}
          {recoverTarget && selectedNode?.remId !== recoverTarget.remId && (
            <button
              onClick={handleRecoverSelection}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: '3px 8px',
                fontSize: '11px',
                fontWeight: 500,
                borderRadius: '4px',
                border: '1px solid var(--rn-clr-border-primary)',
                background: 'transparent',
                color: 'var(--rn-clr-content-secondary)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
              title={`Reselect ${recoverTarget.label.toLowerCase()} (press L)`}
            >
              ↩ {recoverTarget.label}
            </button>
          )}
          <button
            onClick={handleClose}
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: '18px',
              cursor: 'pointer',
              color: 'var(--rn-clr-content-secondary)',
              padding: '4px',
              borderRadius: '4px',
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Instructions */}
      <div
        style={{
          flexShrink: 0,
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
          <kbd style={kbdStyle}>Enter</kbd> to select,{' '}
          <kbd style={kbdStyle}>+</kbd>/<kbd style={kbdStyle}>n</kbd> to add child,{' '}
          <kbd style={kbdStyle}>E</kbd> to pick in the editor
          {recoverTarget && (
            <>
              , <kbd style={kbdStyle}>L</kbd> to reselect {recoverTarget.label.toLowerCase()}
            </>
          )}
          {corpusSuggestion && (
            <>
              , <kbd style={kbdStyle}>S</kbd> to go to the suggested section
            </>
          )}
        </p>

        {/* Both options apply only to expanded branches — the IncRem candidates
            at the root are always shown, in their original order. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', marginTop: '10px' }}>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '11px' }}
            title="Inside expanded branches, show only rems with a heading (H1–H6)"
          >
            <input
              type="checkbox"
              checked={headingsOnly}
              onChange={toggleHeadingsOnly}
              style={{ cursor: 'pointer', margin: 0 }}
            />
            Filter only headers
          </label>

          <label
            style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '11px' }}
            title="Inside expanded branches, list headings before other rems, shallowest level first"
          >
            <input
              type="checkbox"
              checked={headingsFirst}
              onChange={toggleHeadingsFirst}
              style={{ cursor: 'pointer', margin: 0 }}
            />
            List headings first
          </label>

          <button
            onClick={handlePickInEditor}
            title="Close this list and pick the parent in the editor (E)"
            style={{
              marginLeft: 'auto',
              padding: '2px 8px',
              fontSize: '11px',
              fontWeight: 500,
              borderRadius: '4px',
              border: '1px solid var(--rn-clr-border-primary)',
              background: 'transparent',
              color: 'var(--rn-clr-content-secondary)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            📍 Pick in editor
          </button>
        </div>
      </div>

      {/* Tree List */}
      <div style={listContainerStyle} ref={listContainerRef}>
        {renderTreeWithInput()}
      </div>

      {/* Footer */}
      <div
        style={{
          flexShrink: 0,
          padding: '12px 16px',
          borderTop: '1px solid var(--rn-clr-border-primary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <span
          style={{
            minWidth: 0,
            fontSize: '11px',
            color: 'var(--rn-clr-content-tertiary)',
          }}
        >
          {displayList.length} item{displayList.length !== 1 ? 's' : ''}
          {contextData.lastSelectedDestination && ' • Last destination remembered'}
          {corpusSuggestion && ' • 📚 Section suggested by your corpus index'}
        </span>
        <button
          onClick={() => selectedNode && handleSelect(selectedNode)}
          disabled={!selectedNode || isCreating || !!creatingChildForNodeId}
          style={{
            padding: '8px 16px',
            fontSize: '12px',
            fontWeight: 600,
            borderRadius: '6px',
            backgroundColor: isCreating || creatingChildForNodeId ? '#9ca3af' : '#3b82f6',
            border: 'none',
            color: 'white',
            cursor: isCreating || creatingChildForNodeId ? 'not-allowed' : 'pointer',
            transition: 'background-color 0.15s ease',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {isCreating ? 'Creating...' : actionText}
        </button>
      </div>
    </div>
  );
}

renderWidget(withHoverTips(ParentSelectorWidget));
