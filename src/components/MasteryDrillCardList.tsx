/**
 * Mastery Drill card list — every card the drill holds for this knowledge base,
 * with whether RemNote will actually serve it.
 *
 * Opened from the drill popup's toolbar and shown under it, in the space the
 * embedded <Queue> normally fills. The Queue is not unmounted — that would end
 * the drill session and start a new one on the way back — the widget moves it
 * off-screen instead (see mastery_drill.tsx).
 *
 * The rows are resolved by lib/mastery_drill_audit.ts. Cards RemNote will never
 * present sort to the top, since those are the reason anyone opens this list —
 * a drill that says "1 Remaining" above "You've finished practicing all your
 * cards!". Next come the cards that are due now (not cooling): those should be
 * in the drill's queue, so one the drill never showed stands out there. The
 * three filter chips (keys 1–3) hide whole groups, to leave just the ones
 * being checked.
 */

import { usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { AncestorChainCache } from '../lib/card_enablement/scan';
import { buildCardLabels } from '../lib/card_labels';
import {
  DRILL_STATUS_HINTS,
  DRILL_STATUS_LABELS,
  DrillCardAudit,
  DrillCardStatus,
  FinalDrillItem,
  UNPLAYABLE_STATUSES,
  auditDrillItem,
  drillItemCardId,
} from '../lib/mastery_drill_audit';
import { DrillCooling, drillReadyAt, formatDrillWait } from '../lib/mastery_drill_status';
import { scoreColor, scoreLabel } from '../lib/rating_labels';
import { openRemInBrowserTab } from '../lib/remHelpers';
import { formatTimeAgo } from '../lib/utils';
import { PriorityBadge } from './PriorityBadge';
import { RemText } from './RemText';

/** Drill items resolved in parallel. Small, to keep the bridge responsive. */
const AUDIT_CONCURRENCY = 4;

type Row = DrillCardAudit & { label: string };

function statusColor(status: DrillCardStatus): string {
  if (status === 'ok') return '#16a34a';
  if (status === 'rated-good' || status === 'in-paused-deck') return '#f59e0b';
  return '#ef4444';
}

/** Which filter chip a row falls under. Unplayable wins: cooling ends, unplayable does not. */
type Group = 'unplayable' | 'ready' | 'cooling';

const GROUPS: { id: Group; label: string; key: string; color: string; hint: string }[] = [
  {
    id: 'ready',
    label: 'Due now',
    key: '1',
    color: '#16a34a',
    hint: 'Cards past their cooling period — the drill should be serving these now (key 1)',
  },
  {
    id: 'cooling',
    label: 'Cooling',
    key: '2',
    color: '#3b82f6',
    hint: 'Cards resting after a recent rating — the drill holds them back until the time is up (key 2)',
  },
  {
    id: 'unplayable',
    label: 'Unplayable',
    key: '3',
    color: '#ef4444',
    hint: 'Cards RemNote will never show, whatever the drill does (key 3)',
  },
];

const GROUP_RANK: Record<Group, number> = { unplayable: 0, ready: 1, cooling: 2 };

/** Within a group: the ones that should have left the drill, then the rest. */
function statusRank(status: DrillCardStatus): number {
  return status === 'ok' ? 1 : 0;
}

const selectionRing = (isSelected: boolean): React.CSSProperties =>
  isSelected ? { outline: '2px solid var(--rn-clr-border-accent, #3B82F6)', outlineOffset: '-2px' } : {};

const smallButton: React.CSSProperties = {
  padding: '1px 7px',
  fontSize: '11px',
  lineHeight: 1.5,
  borderRadius: '4px',
  border: '1px solid var(--rn-clr-background-tertiary)',
  background: 'var(--rn-clr-background-primary)',
  color: 'var(--rn-clr-content-secondary)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export function MasteryDrillCardList({
  items,
  cooling,
  onRemove,
  onGoToRem,
  onClose,
}: {
  /** The drill items of the current knowledge base. */
  items: FinalDrillItem[];
  cooling: DrillCooling;
  onRemove: (cardIds: string[]) => Promise<void>;
  onGoToRem: (remId: string) => Promise<void>;
  onClose: () => void;
}) {
  const plugin = usePlugin();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [audits, setAudits] = React.useState<Map<string, Row>>(new Map());
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [shown, setShown] = React.useState<Record<Group, boolean>>({ ready: true, cooling: true, unplayable: true });
  // Shared for the life of the list, so re-auditing after a sync only walks new ancestors.
  const chainsRef = React.useRef(new AncestorChainCache(plugin));

  // Audit only the ids not resolved yet: removing a card rewrites the whole
  // synced list, and re-resolving every row for that would flash the list.
  React.useEffect(() => {
    let cancelled = false;
    const wanted = new Set(items.map(drillItemCardId));
    setAudits((prev) => {
      const next = new Map(Array.from(prev).filter(([id]) => wanted.has(id)));
      return next.size === prev.size ? prev : next;
    });
    const pending = items.filter((item) => !audits.has(drillItemCardId(item)));
    if (pending.length === 0) return;

    (async () => {
      for (let i = 0; i < pending.length; i += AUDIT_CONCURRENCY) {
        const batch = await Promise.all(
          pending.slice(i, i + AUDIT_CONCURRENCY).map(async (item): Promise<Row | null> => {
            try {
              const audit = await auditDrillItem(plugin, item, chainsRef.current);
              const labels = audit.card ? await buildCardLabels(plugin, audit.rem, [audit.card]) : null;
              return { ...audit, label: labels?.get(audit.cardId)?.full ?? '' };
            } catch (e) {
              console.error('[MasteryDrillList] audit failed for', drillItemCardId(item), e);
              return null;
            }
          }),
        );
        if (cancelled) return;
        setAudits((prev) => {
          const next = new Map(prev);
          for (const row of batch) if (row) next.set(row.cardId, row);
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // `audits` is read only to skip resolved ids; re-running on its own updates would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, plugin]);

  const now = Date.now();
  const readyAtById = React.useMemo(
    () => new Map(items.map((item) => [drillItemCardId(item), drillReadyAt(item, cooling)])),
    [items, cooling],
  );
  const groupOf = (row: Row): Group => {
    if (UNPLAYABLE_STATUSES.has(row.status)) return 'unplayable';
    return (readyAtById.get(row.cardId) ?? 0) > now ? 'cooling' : 'ready';
  };
  const allRows = Array.from(audits.values()).sort(
    (a, b) =>
      GROUP_RANK[groupOf(a)] - GROUP_RANK[groupOf(b)] ||
      statusRank(a.status) - statusRank(b.status) ||
      (a.addedAt ?? 0) - (b.addedAt ?? 0),
  );
  const groupCounts: Record<Group, number> = { ready: 0, cooling: 0, unplayable: 0 };
  for (const row of allRows) groupCounts[groupOf(row)]++;
  const rows = allRows.filter((row) => shown[groupOf(row)]);
  const hiddenCount = allRows.length - rows.length;
  const loading = audits.size < items.length;
  const unplayable = allRows.filter((r) => UNPLAYABLE_STATUSES.has(r.status));
  const coolingCount = Array.from(readyAtById.values()).filter((readyAt) => readyAt > now).length;

  const toggleGroup = (group: Group) => {
    setShown((prev) => ({ ...prev, [group]: !prev[group] }));
    setSelectedIndex(0);
  };

  React.useEffect(() => {
    if (selectedIndex > rows.length - 1) setSelectedIndex(Math.max(rows.length - 1, 0));
  }, [rows.length, selectedIndex]);

  React.useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Same focus retry as the other popups: RemNote settles focus after the list appears.
  React.useEffect(() => {
    let cancelled = false;
    const tryFocus = (attemptsLeft: number) => {
      if (cancelled) return;
      containerRef.current?.focus();
      if (document.activeElement !== containerRef.current && attemptsLeft > 0) {
        setTimeout(() => tryFocus(attemptsLeft - 1), 50);
      }
    };
    tryFocus(8);
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = async (cardIds: string[]) => {
    if (busy || cardIds.length === 0) return;
    setBusy(true);
    try {
      await onRemove(cardIds);
    } finally {
      setBusy(false);
      containerRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if ((e.target as HTMLElement)?.tagName === 'BUTTON') return;
    const chip = GROUPS.find((g) => g.key === e.key);
    if (chip && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      toggleGroup(chip.id);
      return;
    }
    const row = rows[selectedIndex];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSelectedIndex((i) => Math.min(Math.max(i + step, 0), Math.max(rows.length - 1, 0)));
      return;
    }
    if (e.key === 'Enter' && row?.remId && row.rem) {
      e.preventDefault();
      onGoToRem(row.remId);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (e.shiftKey) remove(unplayable.map((r) => r.cardId));
      else if (row) remove([row.cardId]);
    }
  };

  return (
      <div
        ref={containerRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex-grow min-h-0 w-full flex flex-col"
        style={{
          outline: 'none',
          backgroundColor: 'var(--rn-clr-background-primary)',
          color: 'var(--rn-clr-content-primary)',
        }}
      >
        <div
          className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0"
          style={{
            gap: '10px',
            borderColor: 'var(--rn-clr-border-primary)',
            backgroundColor: 'var(--rn-clr-background-secondary)',
          }}
        >
          <div>
            <div className="font-semibold">Cards in the Mastery Drill</div>
            <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
              {items.length} card{items.length !== 1 ? 's' : ''} in this knowledge base
              {coolingCount > 0 && ` · ${coolingCount} cooling`}
              {loading ? ` · checking ${audits.size} / ${items.length}…` : (
                <span style={{ color: unplayable.length > 0 ? '#ef4444' : undefined, fontWeight: unplayable.length > 0 ? 600 : undefined }}>
                  {' '}· {unplayable.length} RemNote cannot show
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {unplayable.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => remove(unplayable.map((r) => r.cardId))}
                title="Remove every card RemNote will not show from the drill (Shift+Delete)"
                style={{ ...smallButton, borderColor: '#ef4444', color: '#ef4444', fontWeight: 600 }}
              >
                Remove {unplayable.length} unplayable
              </button>
            )}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onClose}
              className="text-sm px-2 py-1 rounded transition-colors"
              style={{ color: 'var(--rn-clr-content-secondary)', border: '1px solid var(--rn-clr-border-primary)' }}
            >
              ← Back
            </button>
          </div>
        </div>

        <div
          className="flex items-center flex-wrap flex-shrink-0 border-b"
          style={{ gap: '6px', padding: '6px 14px', borderColor: 'var(--rn-clr-border-primary)' }}
        >
          <span style={{ fontSize: '10.5px', color: 'var(--rn-clr-content-tertiary)', marginRight: '2px' }}>Show</span>
          {GROUPS.map((g) => {
            const on = shown[g.id];
            return (
              <button
                key={g.id}
                type="button"
                aria-pressed={on}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleGroup(g.id)}
                title={g.hint}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  padding: '1px 9px 1px 7px',
                  fontSize: '11px',
                  lineHeight: 1.6,
                  borderRadius: '999px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  border: `1px solid ${on ? g.color : 'var(--rn-clr-background-tertiary)'}`,
                  background: on ? `${g.color}1a` : 'transparent',
                  color: on ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-tertiary)',
                  fontWeight: on ? 600 : 400,
                }}
              >
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '2px',
                    border: `1.5px solid ${g.color}`,
                    background: on ? g.color : 'transparent',
                    flexShrink: 0,
                  }}
                />
                {g.label}
                <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.75 }}>{groupCounts[g.id]}</span>
              </button>
            );
          })}
          {hiddenCount > 0 && (
            <span style={{ fontSize: '10.5px', color: 'var(--rn-clr-content-tertiary)', marginLeft: '4px' }}>
              {hiddenCount} hidden
            </span>
          )}
        </div>

        <div ref={listRef} className="flex-grow min-h-0" style={{ overflowY: 'auto' }}>
          {rows.length === 0 && (
            <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--rn-clr-content-secondary)' }}>
              {loading && allRows.length === 0
                ? 'Loading…'
                : allRows.length > 0
                  ? 'No cards in the groups shown. Turn a filter back on above (keys 1–3).'
                  : 'No cards are in the Mastery Drill for this knowledge base.'}
            </div>
          )}
          {rows.map((row, index) => {
            const coolingLeftMs = (readyAtById.get(row.cardId) ?? 0) - now;
            const color = statusColor(row.status);
            return (
              <div
                key={row.cardId}
                data-row-index={index}
                onMouseEnter={() => setSelectedIndex(index)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '7px 14px',
                  borderBottom: '1px solid var(--rn-clr-background-secondary)',
                  fontSize: '11.5px',
                  lineHeight: 1.5,
                  background: index === selectedIndex ? 'rgba(59,130,246,0.07)' : 'transparent',
                  ...selectionRing(index === selectedIndex),
                }}
              >
                <span
                  title={DRILL_STATUS_HINTS[row.status]}
                  style={{
                    flexShrink: 0,
                    marginTop: '2px',
                    padding: '0 6px',
                    borderRadius: '3px',
                    border: `1px solid ${color}`,
                    color,
                    fontSize: '10px',
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    cursor: 'help',
                  }}
                >
                  {DRILL_STATUS_LABELS[row.status]}
                </span>

                <div style={{ minWidth: 0, flex: 1 }}>
                  {row.rem ? (
                    <div style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      <RemText text={row.rem.text} markClozes />
                    </div>
                  ) : (
                    <div style={{ color: 'var(--rn-clr-content-secondary)' }}>
                      {row.status === 'card-missing' ? 'Card no longer exists' : 'Rem no longer exists'}
                    </div>
                  )}
                  {row.label && (
                    <div style={{ fontSize: '10.5px', color: 'var(--rn-clr-content-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.label}
                    </div>
                  )}
                  {row.breadcrumb && (
                    <div style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.breadcrumb}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '10.5px', color: 'var(--rn-clr-content-tertiary)' }}>
                    {row.priority && (
                      <PriorityBadge
                        priority={row.priority.priority}
                        percentile={row.priority.kbPercentile ?? undefined}
                        compact
                        useAbsoluteColoring={row.priority.kbPercentile == null}
                        source={row.priority.source}
                        isCardPriority
                      />
                    )}
                    <span>{row.addedAt ? `added ${formatTimeAgo(row.addedAt)}` : 'added before dates were recorded'}</span>
                    {coolingLeftMs > 0 && <span>· cooling, {formatDrillWait(coolingLeftMs)} left</span>}
                    {row.lastScore !== null && row.lastRatedAt && (
                      <span>
                        · last <strong style={{ color: scoreColor(row.lastScore) }}>{scoreLabel(row.lastScore)}</strong>{' '}
                        {formatTimeAgo(row.lastRatedAt)}
                      </span>
                    )}
                    <span style={{ fontFamily: 'monospace', opacity: 0.7 }}>· {row.cardId}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                  {row.rem && row.remId && (
                    <>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onGoToRem(row.remId!)}
                        title="Go to this Rem (closes the drill)"
                        style={smallButton}
                      >
                        Go to Rem
                      </button>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => openRemInBrowserTab(plugin, row.remId!)}
                        title="Open this Rem in a new browser tab (keeps this list open)"
                        style={smallButton}
                      >
                        ↗
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => remove([row.cardId])}
                    title="Remove this card from the Mastery Drill"
                    style={{ ...smallButton, borderColor: '#fecaca', color: '#dc2626' }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            flexShrink: 0,
            padding: '7px 14px',
            borderTop: '1px solid var(--rn-clr-background-tertiary)',
            fontSize: '10.5px',
            color: 'var(--rn-clr-content-tertiary)',
          }}
        >
          ↑↓ choose · Enter go to Rem · 1–3 filter · Delete remove · Shift+Delete remove unplayable · Esc back to the drill
        </div>
      </div>
  );
}
