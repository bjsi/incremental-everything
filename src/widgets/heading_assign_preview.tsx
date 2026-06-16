import {
  renderWidget,
  usePlugin,
  useRunAsync,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { HeadingLevel } from '../lib/outline_restructure';
import {
  collectTocForest,
  computeTocPlan,
  computeShiftPlan,
  applyHeadingPlan,
  HeadingPlan,
  HeadingPlanNode,
  HEADING_SNAPSHOT_KEY,
} from '../lib/heading_assign';
import { safeRemTextToString } from '../lib/pdfUtils';
import { HeadingBadge } from '../components/HeadingBadge';

// ─── Context ────────────────────────────────────────────────────────────────

type TocContext = {
  mode: 'toc';
  scopeRootId: string;
  inputRemIds: string[];
};
type ShiftContext = {
  mode: 'shift';
  remIds: string[];
  delta: number; // +1 = demote (deeper / bigger H number), -1 = promote
};
type WidgetContextData = TocContext | ShiftContext;

// ─── Row ──────────────────────────────────────────────────────────────────

// One row. In the After panel a level change renders "old → new"; unchanged
// rows just show the (single) level badge so the diff is easy to scan.
function Row(props: {
  oldLevel: HeadingLevel | null;
  newLevel?: HeadingLevel | null;
  depth: number;
  text: string;
  changed?: boolean;
}) {
  const { oldLevel, newLevel, depth, text, changed } = props;
  const showTransition = newLevel !== undefined && changed;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        paddingLeft: 4 + depth * 14,
        paddingTop: 1,
        paddingBottom: 1,
        borderLeft: changed ? '2px solid #f59e0b' : '2px solid transparent',
        background: changed ? 'rgba(245, 158, 11, 0.08)' : 'transparent',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <HeadingBadge level={showTransition ? oldLevel : newLevel ?? oldLevel} />
        {showTransition ? (
          <>
            <span style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: 11 }}>→</span>
            <HeadingBadge level={newLevel ?? null} />
          </>
        ) : null}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 12,
          color: 'var(--rn-clr-content-primary)',
          wordBreak: 'break-word',
          lineHeight: 1.35,
        }}
      >
        {text || 'Untitled'}
      </span>
    </div>
  );
}

// ─── Widget ──────────────────────────────────────────────────────────────────

const LEVELS: HeadingLevel[] = [1, 2, 3, 4, 5, 6];

const HeadingAssignPreview = () => {
  const plugin = usePlugin();

  const rawCtx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Popup>(),
    []
  );
  const ctx = (rawCtx as any)?.contextData as WidgetContextData | undefined;

  // ToC controls.
  const [startLevel, setStartLevel] = useState<HeadingLevel>(1);
  const [endLevel, setEndLevel] = useState<HeadingLevel>(3);
  const [busy, setBusy] = useState(false);

  // Keyboard-driven footer: Left/Right cycle the highlighted button, Enter
  // activates it. Defaults to Apply so Enter accepts straight away.
  const [focusedButton, setFocusedButton] = useState<'cancel' | 'apply'>('apply');
  const rootRef = useRef<HTMLDivElement>(null);

  const plan: HeadingPlan | undefined = useRunAsync(async () => {
    if (!ctx) return undefined;

    if (ctx.mode === 'toc') {
      const inputRems = (await plugin.rem.findMany(ctx.inputRemIds)) || [];
      if (inputRems.length === 0) return undefined;
      const scopeRoot = await plugin.rem.findOne(ctx.scopeRootId);
      const scopeText = scopeRoot
        ? await safeRemTextToString(plugin, (scopeRoot as any).text)
        : 'selection';
      const tree = await collectTocForest(plugin, inputRems);
      return computeTocPlan(tree, { startLevel, endLevel, scopeText });
    }

    // shift — recurse the full selected subtree. RemNote's outline selection
    // reports only the top-level (root) rems, so we expand to the whole subtree
    // (same as the ToC path) and shift every heading found within it;
    // paragraphs in the subtree are left untouched by computeShiftPlan.
    const rems = (await plugin.rem.findMany(ctx.remIds)) || [];
    if (rems.length === 0) return undefined;
    const scopeText = `${rems.length} selected rem${rems.length === 1 ? '' : 's'}`;
    const tree = await collectTocForest(plugin, rems);
    return computeShiftPlan(tree, { delta: ctx.delta, scopeText });
  }, [ctx, startLevel, endLevel]);

  // Grab keyboard focus once the real container has rendered (the rootRef div
  // only exists after `plan` resolves — before that the "Analyzing…" branch is
  // shown). Focus the iframe window first, then the div, and retry a few times
  // to win against RemNote settling focus after the popup opens.
  useEffect(() => {
    if (!plan) return;
    let cancelled = false;
    const tryFocus = (attemptsLeft: number) => {
      if (cancelled) return;
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      rootRef.current?.focus();
      if (document.activeElement !== rootRef.current && attemptsLeft > 0) {
        setTimeout(() => tryFocus(attemptsLeft - 1), 50);
      }
    };
    tryFocus(8);
    return () => {
      cancelled = true;
    };
  }, [plan]);

  const counts = useMemo(() => {
    if (!plan) return { total: 0, changed: 0 };
    let total = 0;
    const walk = (n: HeadingPlanNode) => {
      total++;
      n.children.forEach(walk);
    };
    plan.tree.forEach(walk);
    return { total, changed: plan.changedCount };
  }, [plan]);

  const renderTree = (
    nodes: HeadingPlanNode[],
    panel: 'before' | 'after'
  ): React.ReactNode =>
    nodes.map((n) => {
      const changed = n.oldLevel !== n.newLevel;
      return (
        <React.Fragment key={n.remId}>
          <Row
            depth={n.depth}
            text={n.text}
            oldLevel={n.oldLevel}
            newLevel={panel === 'after' ? n.newLevel : undefined}
            changed={panel === 'after' ? changed : false}
          />
          {n.children.length > 0 ? renderTree(n.children, panel) : null}
        </React.Fragment>
      );
    });

  const onApply = async () => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      const snapshot = await applyHeadingPlan(plugin, plan);
      await plugin.storage.setSession(HEADING_SNAPSHOT_KEY, snapshot);
      await plugin.app.toast(
        `Heading levels applied: ${counts.changed} rem${counts.changed === 1 ? '' : 's'} changed.`
      );
      await plugin.widget.closePopup();
    } catch (e) {
      console.error('[heading-assign] apply failed:', e);
      await plugin.app.toast(`Apply failed: ${(e as any)?.message ?? e}`);
      setBusy(false);
    }
  };

  const onCancel = () => plugin.widget.closePopup();

  const applyDisabled = busy || counts.changed === 0;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (busy) return;
    // Let the Top/Deepest level dropdowns keep their own arrow-key behavior.
    const onSelect = (e.target as HTMLElement)?.tagName === 'SELECT';
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (onSelect) return;
      e.preventDefault();
      setFocusedButton((b) => (b === 'apply' ? 'cancel' : 'apply'));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (focusedButton === 'cancel') onCancel();
      else if (!applyDisabled) onApply();
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  if (!ctx) {
    return (
      <div style={{ padding: 16, color: 'var(--rn-clr-content-tertiary)' }}>
        No context.
      </div>
    );
  }
  if (!plan) {
    return (
      <div style={{ padding: 16, color: 'var(--rn-clr-content-tertiary)' }}>
        Analyzing selection…
      </div>
    );
  }

  const title =
    ctx.mode === 'toc'
      ? 'Apply Heading Levels by Hierarchy'
      : ctx.delta > 0
      ? 'Demote Headings (one level deeper)'
      : 'Promote Headings (one level shallower)';

  const selectStyle: React.CSSProperties = {
    fontSize: 12,
    padding: '2px 6px',
    borderRadius: 4,
    border: '1px solid var(--rn-clr-border-subtle)',
    background: 'var(--rn-clr-background-primary)',
    color: 'var(--rn-clr-content-primary)',
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--rn-clr-background-primary)',
        color: 'var(--rn-clr-content-primary)',
        outline: 'none',
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--rn-clr-border-subtle)',
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>

        {ctx.mode === 'toc' ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 8,
              flexWrap: 'wrap',
            }}
          >
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              Top level
              <select
                value={startLevel}
                style={selectStyle}
                onChange={(e) => {
                  const v = Number(e.target.value) as HeadingLevel;
                  setStartLevel(v);
                  if (endLevel < v) setEndLevel(v);
                }}
              >
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    H{l}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              Deepest level
              <select
                value={endLevel}
                style={selectStyle}
                onChange={(e) => setEndLevel(Number(e.target.value) as HeadingLevel)}
              >
                {LEVELS.filter((l) => l >= startLevel).map((l) => (
                  <option key={l} value={l}>
                    H{l}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        <div
          style={{
            fontSize: 11,
            color: 'var(--rn-clr-content-tertiary)',
            marginTop: 8,
          }}
        >
          {counts.changed === 0
            ? 'No level changes for the current selection.'
            : `${counts.changed} of ${counts.total} rem${counts.total === 1 ? '' : 's'} would change.`}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 0,
        }}
      >
        <div
          style={{
            borderRight: '1px solid var(--rn-clr-border-subtle)',
            overflow: 'auto',
            padding: '8px 8px 8px 12px',
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--rn-clr-content-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            Before
          </div>
          {renderTree(plan.tree, 'before')}
        </div>
        <div style={{ overflow: 'auto', padding: '8px 12px 8px 8px' }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--rn-clr-content-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            After
          </div>
          {renderTree(plan.tree, 'after')}
        </div>
      </div>

      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--rn-clr-border-subtle)',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <button
          onClick={onCancel}
          onMouseEnter={() => setFocusedButton('cancel')}
          disabled={busy}
          style={{
            padding: '6px 14px',
            border: '1px solid var(--rn-clr-border-subtle)',
            background: 'transparent',
            color: 'var(--rn-clr-content-primary)',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 13,
            boxShadow:
              focusedButton === 'cancel'
                ? '0 0 0 2px var(--rn-clr-background-primary), 0 0 0 4px #3b82f6'
                : 'none',
          }}
        >
          Cancel
        </button>
        <button
          onClick={onApply}
          onMouseEnter={() => setFocusedButton('apply')}
          disabled={applyDisabled}
          style={{
            padding: '6px 14px',
            border: '1px solid transparent',
            background: applyDisabled ? '#94a3b8' : '#2563eb',
            color: 'white',
            borderRadius: 4,
            cursor: applyDisabled ? 'not-allowed' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
            boxShadow:
              focusedButton === 'apply'
                ? '0 0 0 2px var(--rn-clr-background-primary), 0 0 0 4px #3b82f6'
                : 'none',
          }}
        >
          {busy ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </div>
  );
};

renderWidget(HeadingAssignPreview);
