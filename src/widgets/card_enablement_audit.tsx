// widgets/card_enablement_audit.tsx
//
// Card Enablement Audit — the batch form of the debug widget's single-Rem
// "Probe Card Enablement", with the two switches it finds broken wired up to a
// bulk fix.
//
// The case it was built for: an Anki import that lands hundreds of Rems with
// `enablePractice=true, practiceDirection=none`. Those Rems own no card records
// at all, so nothing card-driven — the Suppressed Cards tab included — can see
// them, and RemNote's own search cannot express the question. See
// lib/card_enablement/scan.ts for why the walk is Rem-driven.

import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cardEnablementAnchorKey } from '../lib/consts';
import {
  ACTIONABLE_VERDICTS,
  AuditResult,
  AuditScope,
  DEFAULT_AUDIT_SCOPE,
  DEFAULT_VERDICT_FILTER,
  EnablementRow,
  EnablementVerdict,
  PracticeDirection,
  ScanProgress,
  VERDICT_LABELS,
  VERDICT_SHORT,
  auditCardEnablement,
  emptyCounts,
} from '../lib/card_enablement/scan';
import {
  ApplyProgress,
  ApplyResult,
  EnablementAction,
  EnablementSnapshot,
  applyEnablement,
  describeAction,
  downloadSnapshot,
  undoEnablement,
} from '../lib/card_enablement/apply';
import { openRemInBrowserTab } from '../lib/remHelpers';

const VERDICT_ORDER: EnablementVerdict[] = [
  'direction-none',
  'practice-off',
  'in-table',
  'not-surfaced',
  'disabled-by-ancestor',
  'in-paused-deck',
  'ok',
  'no-card-material',
];

const VERDICT_COLOR: Record<EnablementVerdict, string> = {
  'direction-none': '#DC2626',
  'practice-off': '#EA580C',
  'in-table': '#CA8A04',
  'not-surfaced': '#9333EA',
  'disabled-by-ancestor': '#0891B2',
  'in-paused-deck': '#2563EB',
  ok: '#16A34A',
  'no-card-material': '#6B7280',
};

const GRID = '28px minmax(0, 1fr) 64px 78px 92px 132px';

const subtle: React.CSSProperties = {
  color: 'var(--rn-clr-content-secondary)',
};

const panel: React.CSSProperties = {
  border: '1px solid var(--rn-clr-border-primary, #e5e7eb)',
  borderRadius: 8,
  background: 'var(--rn-clr-background-elevation-10)',
};

function CardEnablementAudit() {
  const plugin = usePlugin();

  const anchorId = useTrackerPlugin(
    async (rp) => rp.storage.getSession<string>(cardEnablementAnchorKey),
    [],
  );

  const [scope, setScope] = useState<AuditScope>(DEFAULT_AUDIT_SCOPE);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [filter, setFilter] = useState<Set<EnablementVerdict>>(
    () => new Set(DEFAULT_VERDICT_FILTER),
  );
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);

  const [actionKind, setActionKind] = useState<'direction' | 'practice-on' | 'practice-off'>(
    'direction',
  );
  // 'forward' rather than 'both': a Rem found at direction=none is being given
  // cards it has never had, and 'both' would silently double the number that
  // lands in the queue. The backward direction is a deliberate choice, so it is
  // one the user picks rather than one the default makes for them.
  const [direction, setDirection] = useState<PracticeDirection>('forward');
  const [usePriority, setUsePriority] = useState(false);
  const [priority, setPriority] = useState(50);

  const [applyProgress, setApplyProgress] = useState<ApplyProgress | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [snapshot, setSnapshot] = useState<EnablementSnapshot | null>(null);
  const [undoing, setUndoing] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // --- scan ----------------------------------------------------------------

  const runScan = useCallback(async () => {
    if (!anchorId) return;
    if (!scope.tagged && !scope.referencing && !scope.descendants) {
      setError('Pick at least one scope.');
      return;
    }
    setError('');
    setNotice('');
    setResult(null);
    setApplyResult(null);
    setChecked(new Set());
    setCursor(0);
    cancelledRef.current = false;
    setScanProgress({ phase: 'scope', done: 0, total: 0 });
    try {
      const res = await auditCardEnablement(
        plugin,
        anchorId,
        scope,
        (p) => setScanProgress(p),
        () => cancelledRef.current,
      );
      setResult(res);
      // Pre-check exactly what the default filter shows and what a bulk write
      // can actually change — never a row whose verdict no button here fixes.
      setChecked(
        new Set(
          res.rows
            .filter((r) => DEFAULT_VERDICT_FILTER.has(r.verdict) && ACTIONABLE_VERDICTS.has(r.verdict))
            .map((r) => r.remId),
        ),
      );
    } catch (e: any) {
      console.error('[CardEnablement] scan failed', e);
      setError(e?.message ?? String(e));
    } finally {
      setScanProgress(null);
    }
  }, [anchorId, plugin, scope]);

  // First scan as soon as the anchor is known. Scope changes are explicit —
  // re-running a multi-thousand-Rem walk on every checkbox click is not.
  useEffect(() => {
    if (anchorId && !result && !scanProgress) void runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorId]);

  const counts = result?.counts ?? emptyCounts();

  const visibleRows = useMemo(() => {
    const rows = (result?.rows ?? []).filter((r) => filter.has(r.verdict));
    return rows.sort((a, b) => {
      const va = VERDICT_ORDER.indexOf(a.verdict);
      const vb = VERDICT_ORDER.indexOf(b.verdict);
      if (va !== vb) return va - vb;
      const bc = a.breadcrumb.localeCompare(b.breadcrumb);
      return bc !== 0 ? bc : a.text.localeCompare(b.text);
    });
  }, [result, filter]);

  useEffect(() => {
    if (cursor >= visibleRows.length) setCursor(Math.max(0, visibleRows.length - 1));
  }, [visibleRows.length, cursor]);

  const selectedRows = useMemo(
    () => visibleRows.filter((r) => checked.has(r.remId)),
    [visibleRows, checked],
  );

  /** Selected rows whose verdict this panel's two switches cannot fix. */
  const selectedUnfixable = useMemo(
    () => selectedRows.filter((r) => !ACTIONABLE_VERDICTS.has(r.verdict)),
    [selectedRows],
  );

  const action: EnablementAction =
    actionKind === 'direction'
      ? { kind: 'set-direction', direction }
      : { kind: 'set-practice', enabled: actionKind === 'practice-on' };

  // --- selection -----------------------------------------------------------

  const toggle = (remId: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(remId)) next.delete(remId);
      else next.add(remId);
      return next;
    });

  const setAll = (on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      for (const r of visibleRows) {
        if (on) next.add(r.remId);
        else next.delete(r.remId);
      }
      return next;
    });

  const toggleFilter = (v: EnablementVerdict) =>
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });

  // --- apply / undo --------------------------------------------------------

  const busy = !!scanProgress || !!applyProgress || undoing;

  const doApply = async () => {
    if (!result || busy) return;
    if (selectedRows.length === 0) {
      setError('Nothing selected.');
      return;
    }
    const enabling = action.kind === 'set-practice' ? action.enabled : action.direction !== 'none';
    const warn =
      selectedUnfixable.length > 0
        ? `\n\n${selectedUnfixable.length} of them are disabled by something this panel does not ` +
          `change (an ancestor, a paused deck, or a per-card switch). Writing the flag will not ` +
          `make those produce cards.`
        : '';
    const flood = enabling
      ? `\n\nThis can create up to ~${selectedRows.length * (direction === 'both' && actionKind === 'direction' ? 2 : 1)} new cards, all due immediately.`
      : '';
    const ok = confirm(
      `${describeAction(action)} on ${selectedRows.length} Rem(s)?${warn}${flood}\n\n` +
        `The current state of every one of them is recorded first, and can be undone from this panel.`,
    );
    if (!ok) return;

    setError('');
    setNotice('');
    setApplyResult(null);
    setApplyProgress({ phase: 'snapshot', done: 0, total: selectedRows.length });
    try {
      const res = await applyEnablement(
        plugin,
        result.anchorId,
        result.anchorText,
        selectedRows,
        action,
        { cardPriority: usePriority && enabling ? priority : null },
        (p) => setApplyProgress(p),
      );
      setSnapshot(res.snapshot);
      const saved = downloadSnapshot(res.snapshot);
      // The rescan clears the notice and the failure list on its way in, so the
      // report of what just happened is written after it, not before.
      await runScan();
      setApplyResult(res);
      setNotice(
        `${describeAction(action)} on ${res.changed} Rem(s). ` +
          `${res.cardsCreated} card(s) appeared. ` +
          (res.failed.length ? `${res.failed.length} failed — see console. ` : '') +
          (saved ? 'A snapshot was downloaded.' : 'The snapshot download was blocked.'),
      );
    } catch (e: any) {
      console.error('[CardEnablement] apply failed', e);
      setError(e?.message ?? String(e));
    } finally {
      setApplyProgress(null);
    }
  };

  const doUndo = async () => {
    if (!snapshot || busy) return;
    if (!confirm(`Put ${snapshot.rows.length} Rem(s) back to their state before the last apply?`))
      return;
    setUndoing(true);
    setError('');
    try {
      const res = await undoEnablement(plugin, snapshot);
      setSnapshot(null);
      setApplyResult(null);
      await runScan();
      setNotice(
        `Restored ${res.restored} Rem(s).` +
          (res.failed.length ? ` ${res.failed.length} failed — see console.` : ''),
      );
    } catch (e: any) {
      console.error('[CardEnablement] undo failed', e);
      setError(e?.message ?? String(e));
    } finally {
      setUndoing(false);
    }
  };

  // --- keyboard ------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The handler sits on the container (a popup has no other reliable place to
    // put it), so every keystroke inside the priority field or a dropdown lands
    // here too — 'a' would select every row while the user types a number, and
    // Space would toggle one while a select is open. Only Escape survives.
    const tag = (e.target as HTMLElement | null)?.tagName;
    const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (inField && e.key !== 'Escape') return;

    if (e.key === 'Escape') {
      // Not mid-write: Esc is a reflex, and tearing the iframe down during a
      // bulk apply loses the progress report and the undo snapshot with it.
      if (applyProgress || undoing) return;
      e.preventDefault();
      void plugin.widget.closePopup();
      return;
    }
    if (busy) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => {
        const next = e.key === 'ArrowDown' ? c + 1 : c - 1;
        return Math.max(0, Math.min(visibleRows.length - 1, next));
      });
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      const row = visibleRows[cursor];
      if (row) toggle(row.remId);
      return;
    }
    if (e.key === 'a' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      setAll(selectedRows.length < visibleRows.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void doApply();
    }
  };

  // --- render --------------------------------------------------------------

  const chip = (v: EnablementVerdict) => {
    const on = filter.has(v);
    return (
      <button
        key={v}
        onClick={() => toggleFilter(v)}
        title={VERDICT_LABELS[v]}
        className="px-2 py-1 rounded text-xs"
        style={{
          border: `1px solid ${VERDICT_COLOR[v]}`,
          background: on ? VERDICT_COLOR[v] : 'transparent',
          color: on ? '#fff' : VERDICT_COLOR[v],
          opacity: counts[v] === 0 ? 0.4 : 1,
          cursor: 'pointer',
        }}
      >
        {VERDICT_SHORT[v]} · {counts[v]}
      </button>
    );
  };

  const scopeBox = (
    key: keyof AuditScope,
    label: string,
    hint: string,
  ) => (
    <label className="flex items-start gap-2 text-xs" style={{ cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={scope[key]}
        onChange={(e) => setScope((s) => ({ ...s, [key]: e.target.checked }))}
        disabled={busy}
      />
      <span>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ ...subtle, marginLeft: 6 }}>{hint}</span>
      </span>
    </label>
  );

  const progressLine = scanProgress
    ? scanProgress.phase === 'scope'
      ? 'Gathering the population…'
      : scanProgress.phase === 'cards'
        ? 'Reading the card table…'
        : `Probing ${scanProgress.done}/${scanProgress.total}…`
    : applyProgress
      ? applyProgress.phase === 'counting'
        ? `Counting new cards ${applyProgress.done}/${applyProgress.total}…`
        : applyProgress.phase === 'priority'
          ? `Setting card priority ${applyProgress.done}/${applyProgress.total}…`
          : `Writing ${applyProgress.done}/${applyProgress.total}…`
      : undoing
        ? 'Undoing…'
        : '';

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{ outline: 'none', height: '100%', boxSizing: 'border-box', fontSize: 13 }}
    >
      <div>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Card Enablement Audit</div>
        <div className="text-xs" style={subtle}>
          {result ? result.anchorText : anchorId ? 'Loading…' : 'No anchor Rem'}
        </div>
      </div>

      <div style={{ ...panel, padding: 10 }} className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {scopeBox('tagged', 'Tagged with it', 'instances of this tag')}
          {scopeBox('referencing', 'Referencing it', 'Rems whose text links here')}
          {scopeBox('descendants', 'Its descendants', 'this Rem and everything under it')}
          {scopeBox('expandDescendants', 'Expand each match', 'add every match’s own subtree')}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void runScan()}
            disabled={busy || !anchorId}
            className="px-3 py-1 rounded text-xs"
            style={{
              background: 'var(--rn-clr-background-accent, #3B82F6)',
              color: '#fff',
              opacity: busy || !anchorId ? 0.5 : 1,
            }}
          >
            {result ? 'Rescan' : 'Scan'}
          </button>
          {progressLine && (
            <span className="text-xs" style={subtle}>
              {progressLine}
            </span>
          )}
          {result && !busy && (
            <span className="text-xs" style={subtle}>
              {result.rows.length} Rem(s) probed in {(result.tookMs / 1000).toFixed(1)}s
              {result.capped ? ` — capped from ${result.scanned}` : ''}
              {result.failed ? ` — ${result.failed} unreadable` : ''}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="text-xs p-2 rounded" style={{ background: '#FEE2E2', color: '#991B1B' }}>
          {error}
        </div>
      )}
      {notice && (
        <div className="text-xs p-2 rounded" style={{ background: '#DCFCE7', color: '#166534' }}>
          {notice}
        </div>
      )}

      {result && (
        <>
          <div className="flex flex-wrap gap-1 items-center">
            {VERDICT_ORDER.map(chip)}
            <span className="text-xs ml-2" style={subtle}>
              click to show / hide
            </span>
          </div>

          <div style={{ ...panel, overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div
              className="text-xs"
              style={{
                display: 'grid',
                gridTemplateColumns: GRID,
                fontWeight: 700,
                padding: '6px 0',
                background: 'var(--rn-clr-background-elevation-20)',
                ...subtle,
              }}
            >
              <div style={{ padding: '0 6px' }}>
                <input
                  type="checkbox"
                  checked={visibleRows.length > 0 && selectedRows.length === visibleRows.length}
                  onChange={(e) => setAll(e.target.checked)}
                  disabled={busy}
                />
              </div>
              <div style={{ padding: '0 6px' }}>Rem</div>
              <div style={{ padding: '0 6px' }}>Practice</div>
              <div style={{ padding: '0 6px' }}>Direction</div>
              <div style={{ padding: '0 6px' }}>Surf/Rec</div>
              <div style={{ padding: '0 6px' }}>Verdict</div>
            </div>

            <div style={{ overflowY: 'auto', flex: 1 }}>
              {visibleRows.length === 0 && (
                <div className="text-xs p-3" style={subtle}>
                  Nothing matches the current filter.
                </div>
              )}
              {visibleRows.map((row, i) => (
                <Row
                  key={row.remId}
                  row={row}
                  checked={checked.has(row.remId)}
                  isCursor={i === cursor}
                  onToggle={() => toggle(row.remId)}
                  onOpen={() => void openRemInBrowserTab(plugin, row.remId)}
                />
              ))}
            </div>
          </div>

          <div style={{ ...panel, padding: 10 }} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={actionKind}
                onChange={(e) => setActionKind(e.target.value as any)}
                disabled={busy}
                className="text-xs px-2 py-1 rounded"
              >
                <option value="direction">Set flashcard direction</option>
                <option value="practice-on">Switch cards ON</option>
                <option value="practice-off">Switch cards OFF</option>
              </select>

              {actionKind === 'direction' && (
                <select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as PracticeDirection)}
                  disabled={busy}
                  className="text-xs px-2 py-1 rounded"
                >
                  <option value="forward">forward</option>
                  <option value="both">both</option>
                  <option value="backward">backward</option>
                  <option value="none">none</option>
                </select>
              )}

              <label className="flex items-center gap-1 text-xs" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={usePriority}
                  onChange={(e) => setUsePriority(e.target.checked)}
                  disabled={busy}
                />
                card priority
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={priority}
                  onChange={(e) => setPriority(Math.max(0, Math.min(100, +e.target.value || 0)))}
                  disabled={busy || !usePriority}
                  style={{ width: 52 }}
                  className="px-1 py-0.5 rounded"
                />
                <span style={subtle}>on what this enables</span>
              </label>

              <div style={{ flex: 1 }} />

              {snapshot && (
                <button
                  onClick={() => void doUndo()}
                  disabled={busy}
                  className="px-3 py-1 rounded text-xs"
                  style={{ border: '1px solid var(--rn-clr-border-primary, #d1d5db)', opacity: busy ? 0.5 : 1 }}
                >
                  Undo last apply ({snapshot.rows.length})
                </button>
              )}

              <button
                onClick={() => void doApply()}
                disabled={busy || selectedRows.length === 0}
                className="px-3 py-1 rounded text-xs font-semibold"
                style={{
                  background: actionKind === 'practice-off' ? '#DC2626' : 'var(--rn-clr-background-accent, #3B82F6)',
                  color: '#fff',
                  opacity: busy || selectedRows.length === 0 ? 0.5 : 1,
                }}
              >
                Apply to {selectedRows.length}
              </button>
            </div>

            {selectedUnfixable.length > 0 && (
              <div className="text-xs" style={{ color: '#B45309' }}>
                {selectedUnfixable.length} selected Rem(s) are held off by something these two
                switches do not change — an ancestor’s “Disable Descendant Cards”, a paused deck,
                or a per-card switch. Writing the flag will not make them produce cards.
              </div>
            )}

            {applyResult && applyResult.failed.length > 0 && (
              <div className="text-xs" style={{ color: '#991B1B' }}>
                Failed: {applyResult.failed.slice(0, 5).map((f) => f.text).join(', ')}
                {applyResult.failed.length > 5 ? ` and ${applyResult.failed.length - 5} more` : ''}
              </div>
            )}

            <div className="text-xs" style={subtle}>
              ↑↓ move · Space select · A select all shown · Enter apply · Esc close
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  row,
  checked,
  isCursor,
  onToggle,
  onOpen,
}: {
  row: EnablementRow;
  checked: boolean;
  isCursor: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: GRID,
        borderTop: '1px solid var(--rn-clr-border-primary-30, #f3f4f6)',
        fontSize: 12,
        alignItems: 'center',
        background: isCursor ? 'var(--rn-clr-background-elevation-20)' : undefined,
        outline: isCursor ? '2px solid var(--rn-clr-border-accent, #3B82F6)' : 'none',
        outlineOffset: -2,
      }}
    >
      <div style={{ padding: '4px 6px' }}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
      </div>
      <div style={{ padding: '4px 6px', minWidth: 0 }}>
        <div
          onClick={onOpen}
          title="Open this Rem"
          style={{
            cursor: 'pointer',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.text}
          {row.backText && (
            <span style={subtle}> → {row.backText}</span>
          )}
        </div>
        {row.breadcrumb && (
          <div
            className="text-xs"
            style={{
              ...subtle,
              fontSize: 10,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.breadcrumb}
          </div>
        )}
      </div>
      <div style={{ padding: '4px 6px', color: row.enablePractice ? undefined : '#DC2626' }}>
        {row.enablePractice ? 'on' : 'off'}
      </div>
      <div
        style={{
          padding: '4px 6px',
          color: row.practiceDirection === 'none' ? '#DC2626' : undefined,
        }}
      >
        {row.practiceDirection ?? '—'}
      </div>
      <div style={{ padding: '4px 6px', ...subtle }}>
        {row.surfaced}/{row.records}
        {row.clozeCount > 0 ? ` · ${row.clozeCount}c` : ''}
      </div>
      <div style={{ padding: '4px 6px' }}>
        <span
          title={
            VERDICT_LABELS[row.verdict] +
            (row.disablingAncestorText ? ` — ${row.disablingAncestorText}` : '')
          }
          style={{
            color: VERDICT_COLOR[row.verdict],
            fontWeight: 600,
            fontSize: 11,
          }}
        >
          {VERDICT_SHORT[row.verdict]}
        </span>
      </div>
    </div>
  );
}

renderWidget(CardEnablementAudit);
