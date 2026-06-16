import {
  renderWidget,
  usePlugin,
  useRunAsync,
  WidgetLocation,
  PluginRem,
} from '@remnote/plugin-sdk';
import React, { useMemo, useState } from 'react';
import '../style.css';
import '../App.css';
import {
  collectCandidates,
  buildPlan,
  applyPlan,
  getHeadingLevel,
  isMetaRem,
  HeadingLevel,
  ProposedNode,
  OUTLINE_SNAPSHOT_KEY,
} from '../lib/outline_restructure';
import { safeRemTextToString } from '../lib/pdfUtils';
import { HeadingBadge } from '../components/HeadingBadge';

// ─── Tree-row rendering helpers ─────────────────────────────────────────────

type BeforeNode = {
  remId: string;
  level: HeadingLevel | null;
  text: string;
  children: BeforeNode[];
};

// Recursively walks the CURRENT tree state for the given entry rems and
// builds a display-only tree. Mirrors what the user sees in RemNote today.
async function buildBeforeTree(
  plugin: any,
  entryRems: PluginRem[]
): Promise<BeforeNode[]> {
  const visit = async (rem: PluginRem): Promise<BeforeNode> => {
    const level = await getHeadingLevel(rem);
    const text = await safeRemTextToString(plugin, (rem as any).text);
    const rawChildren = (await rem.getChildrenRem()) || [];
    // Skip powerup-property bookkeeping rems (e.g. the auto-created "Size"
    // child every Header heading gets) so the Before panel matches what the
    // user sees in RemNote.
    const childRems: PluginRem[] = [];
    for (const c of rawChildren) {
      if (!(await isMetaRem(c))) childRems.push(c);
    }
    const children: BeforeNode[] = [];
    for (const c of childRems) children.push(await visit(c));
    return { remId: rem._id, level, text, children };
  };
  const out: BeforeNode[] = [];
  for (const r of entryRems) {
    if (await isMetaRem(r)) continue;
    out.push(await visit(r));
  }
  return out;
}

// One row in either Before or After tree. `changed` highlights rows whose
// parent in the proposed plan differs from the current parent.
function Row(props: {
  level: HeadingLevel | null;
  text: string;
  depth: number;
  changed?: boolean;
  toggle?: React.ReactNode;
  hiddenChildrenCount?: number;
}) {
  const { level, text, depth, changed, toggle, hiddenChildrenCount } = props;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        paddingLeft: 4 + depth * 14,
        paddingTop: 1,
        paddingBottom: 1,
        borderLeft: changed
          ? '2px solid #f59e0b'
          : '2px solid transparent',
        background: changed ? 'rgba(245, 158, 11, 0.08)' : 'transparent',
      }}
    >
      <HeadingBadge level={level} />
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
        {hiddenChildrenCount && hiddenChildrenCount > 0 ? (
          <span
            style={{
              marginLeft: 6,
              fontSize: 10,
              color: 'var(--rn-clr-content-tertiary)',
              fontStyle: 'italic',
            }}
          >
            +{hiddenChildrenCount} child{hiddenChildrenCount > 1 ? 'ren' : ''}
          </span>
        ) : null}
      </span>
      {toggle}
    </div>
  );
}

// ─── Widget ──────────────────────────────────────────────────────────────────

type WidgetContextData = {
  scopeRootId: string;
  inputRemIds: string[]; // top-level entry rems for the walk
};

const OutlineRestructurePreview = () => {
  const plugin = usePlugin();

  const rawCtx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Popup>(),
    []
  );
  // openPopup's second arg arrives under contextData, not directly on the
  // context object — same shape RemNote uses for every popup in this codebase.
  const ctx = (rawCtx as any)?.contextData as WidgetContextData | undefined;

  // preserveMap: per-rem override of preserveChildren. Defaults true for
  // paragraph rems that have children (the algorithm's default). Toggling
  // a row to "Flatten" sets false, which makes the children appear as
  // independent candidates in the After tree.
  const [preserveMap, setPreserveMap] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0); // bumped on toggle to re-derive

  const data = useRunAsync(async () => {
    if (!ctx) return undefined;

    const inputRems = (await plugin.rem.findMany(ctx.inputRemIds)) || [];
    if (inputRems.length === 0) return undefined;

    const before = await buildBeforeTree(plugin, inputRems);
    const candidates = await collectCandidates(plugin, inputRems, preserveMap);
    const plan = buildPlan(candidates, ctx.scopeRootId);

    // Map original parent for each candidate so we can flag "changed" in the
    // After tree (newParent !== originalParent).
    const originalParentByRem: Record<string, string> = {};
    for (const c of candidates) originalParentByRem[c.remId] = c.originalParentId;
    const newParentByRem: Record<string, string> = {};
    for (const op of plan.ops) newParentByRem[op.remId] = op.newParentId;

    return {
      before,
      candidates,
      plan,
      originalParentByRem,
      newParentByRem,
    };
  }, [ctx, version]);

  // Headings/paragraphs counts for the status bar.
  const counts = useMemo(() => {
    if (!data) return { headings: 0, paragraphs: 0, moved: 0 };
    let h = 0;
    let p = 0;
    for (const c of data.candidates) {
      if (c.level !== null) h++;
      else p++;
    }
    let moved = 0;
    for (const c of data.candidates) {
      if (
        data.originalParentByRem[c.remId] !== data.newParentByRem[c.remId]
      ) {
        moved++;
      }
    }
    return { headings: h, paragraphs: p, moved };
  }, [data]);

  // Render the Before tree (current state, full subtrees).
  const renderBefore = (nodes: BeforeNode[], depth = 0): React.ReactNode => {
    return nodes.map((n) => (
      <React.Fragment key={n.remId}>
        <Row level={n.level} text={n.text} depth={depth} />
        {n.children.length > 0 ? renderBefore(n.children, depth + 1) : null}
      </React.Fragment>
    ));
  };

  // Render the After tree from the proposed plan. Each row shows the per-rem
  // preserve/flatten toggle when applicable.
  const renderAfter = (nodes: ProposedNode[], depth = 0): React.ReactNode => {
    if (!data) return null;
    return nodes.map((n) => {
      const c = n.candidate;
      const isChanged =
        data.originalParentByRem[c.remId] !== data.newParentByRem[c.remId];

      // The toggle appears only for non-heading rems that have children in
      // the original tree. Headings always recurse; childless rems have nothing
      // to preserve.
      const showToggle = c.level === null && c.hasChildren;
      const currentlyPreserving =
        preserveMap[c.remId] !== undefined ? preserveMap[c.remId] : true;

      // If preserveChildren is true, the rem's children are NOT in the candidate
      // list — they ride along as opaque subtree. Show a small "+N children" hint.
      // We don't know the count without re-querying; rough approximation: 1+.
      const hiddenChildHint =
        showToggle && currentlyPreserving ? 1 : 0;

      const toggle = showToggle ? (
        <button
          onClick={() => {
            setPreserveMap((prev) => ({
              ...prev,
              [c.remId]: !currentlyPreserving,
            }));
            setVersion((v) => v + 1);
          }}
          title={
            currentlyPreserving
              ? 'Children currently kept attached. Click to flatten and re-organize them by heading rules.'
              : 'Children currently flattened. Click to keep them attached as an opaque subtree.'
          }
          style={{
            fontSize: 10,
            padding: '1px 6px',
            borderRadius: 3,
            border: '1px solid var(--rn-clr-border-subtle)',
            background: currentlyPreserving
              ? 'var(--rn-clr-background-elevation-10)'
              : '#fef3c7',
            color: 'var(--rn-clr-content-secondary)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {currentlyPreserving ? '⏷ Preserve' : '⏵ Flatten'}
        </button>
      ) : undefined;

      return (
        <React.Fragment key={c.remId}>
          <Row
            level={c.level}
            text={c.text}
            depth={depth}
            changed={isChanged}
            toggle={toggle}
            hiddenChildrenCount={hiddenChildHint}
          />
          {n.children.length > 0 ? renderAfter(n.children, depth + 1) : null}
        </React.Fragment>
      );
    });
  };

  const onApply = async () => {
    if (!data || busy) return;
    setBusy(true);
    try {
      const snapshot = await applyPlan(plugin, data.plan);
      await plugin.storage.setSession(OUTLINE_SNAPSHOT_KEY, snapshot);
      await plugin.app.toast(
        `Outline restructured: ${counts.moved} rem${counts.moved === 1 ? '' : 's'} moved.`
      );
      await plugin.widget.closePopup();
    } catch (e) {
      console.error('[outline-restructure] apply failed:', e);
      await plugin.app.toast(`Restructure failed: ${(e as any)?.message ?? e}`);
      setBusy(false);
    }
  };

  const onCancel = () => {
    plugin.widget.closePopup();
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  if (!ctx) {
    return (
      <div style={{ padding: 16, color: 'var(--rn-clr-content-tertiary)' }}>
        No context.
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 16, color: 'var(--rn-clr-content-tertiary)' }}>
        Analyzing outline…
      </div>
    );
  }

  const noHeadings = data.plan.minHeadingLevel === 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--rn-clr-background-primary)',
        color: 'var(--rn-clr-content-primary)',
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--rn-clr-border-subtle)',
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          Restructure Outline by Headings
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--rn-clr-content-tertiary)',
            marginTop: 4,
          }}
        >
          {noHeadings
            ? 'No headings detected in the selection. Nothing to restructure.'
            : `${counts.headings} heading${counts.headings === 1 ? '' : 's'} · ${counts.paragraphs} paragraph${counts.paragraphs === 1 ? '' : 's'} · ${counts.moved} would move`}
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
          {renderBefore(data.before)}
        </div>
        <div
          style={{
            overflow: 'auto',
            padding: '8px 12px 8px 8px',
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
            After
          </div>
          {noHeadings ? (
            <div
              style={{
                fontSize: 12,
                color: 'var(--rn-clr-content-tertiary)',
                fontStyle: 'italic',
              }}
            >
              (no changes — no headings to anchor on)
            </div>
          ) : (
            renderAfter(data.plan.proposedTree)
          )}
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
          disabled={busy}
          style={{
            padding: '6px 14px',
            border: '1px solid var(--rn-clr-border-subtle)',
            background: 'transparent',
            color: 'var(--rn-clr-content-primary)',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          Cancel
        </button>
        <button
          onClick={onApply}
          disabled={busy || noHeadings || counts.moved === 0}
          style={{
            padding: '6px 14px',
            border: '1px solid transparent',
            background:
              busy || noHeadings || counts.moved === 0 ? '#94a3b8' : '#2563eb',
            color: 'white',
            borderRadius: 4,
            cursor:
              busy || noHeadings || counts.moved === 0
                ? 'not-allowed'
                : 'pointer',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {busy ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </div>
  );
};

renderWidget(OutlineRestructurePreview);
