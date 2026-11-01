import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { duplicateSourceDecisionKey } from '../lib/consts';
import { DuplicateChoice, DuplicateDecision, DuplicateGroup, SourceMatch } from '../lib/duplicate_source/rules';

/** The Enter that ran a command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;
const MAX_OPEN_ROWS = 6;

interface Row {
  label: string;
  hint?: string;
  choice: DuplicateChoice;
  primary?: boolean;
}

const STATUS_LABEL: Record<SourceMatch['status'], string> = {
  incremental: 'Incremental',
  dismissed: 'Dismissed',
};

function buildRows(groups: DuplicateGroup[], total: number): Row[] {
  const seen = new Set<string>();
  const openRows: Row[] = [];
  for (const group of groups) {
    for (const match of group.matches) {
      if (seen.has(match.remId)) continue;
      seen.add(match.remId);
      openRows.push({
        label: `Open “${match.name}”`,
        hint: match.url === group.url ? STATUS_LABEL[match.status] : `${STATUS_LABEL[match.status]} · ${match.url}`,
        choice: { kind: 'open', remId: match.remId },
      });
    }
  }

  const rows = openRows.slice(0, MAX_OPEN_ROWS);
  if (rows.length) rows[0].primary = true;
  const others = total - groups.length;
  if (total === 1) {
    rows.push({ label: 'Make Incremental anyway', choice: { kind: 'proceed' } });
  } else {
    if (others > 0) {
      rows.push({
        label: `Skip ${groups.length === 1 ? 'this Rem' : `these ${groups.length} Rems`}`,
        hint: `Make the other ${others === 1 ? 'Rem' : `${others} Rems`} Incremental`,
        choice: { kind: 'skip' },
      });
    }
    rows.push({ label: `Make all ${total} Incremental anyway`, choice: { kind: 'proceed' } });
  }
  rows.push({ label: 'Cancel', choice: { kind: 'cancel' } });
  return rows;
}

/**
 * Shown by confirmNoDuplicateSource (lib/duplicate_source), which waits in the
 * index widget. This popup only reports the choice: the caller closes it and does
 * the work, so nothing here can be lost to the popup's own teardown, and closing
 * it cannot race with the priority popup that often follows.
 */
export function DuplicateSourcePopup() {
  const plugin = usePlugin();
  const [request, setRequest] = useState<{ requestId: string; groups: DuplicateGroup[]; total: number } | null>(null);
  const [selected, setSelected] = useState(0);
  const [decided, setDecided] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      const data = ctx?.contextData;
      if (data?.requestId) setRequest({ requestId: data.requestId, groups: data.groups ?? [], total: data.total ?? 1 });
    })();
  }, []);

  // Keys are read on the container, which has to win focus against RemNote
  // settling it after the popup opens.
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      containerRef.current?.focus();
      if (document.activeElement === containerRef.current || ++tries >= 8) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo(() => (request ? buildRows(request.groups, request.total) : []), [request]);

  const choose = (choice: DuplicateChoice) => {
    if (!request || decided) return;
    setDecided(true);
    const decision: DuplicateDecision = { requestId: request.requestId, choice };
    void plugin.storage.setSession(duplicateSourceDecisionKey, decision);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Once decided the caller closes this popup; Esc is the way out if it never does.
      if (request && !decided) choose({ kind: 'cancel' });
      else void plugin.widget.closePopup();
    } else if (!rows.length || decided) {
      return;
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      setSelected((s) => (s + 1) % rows.length);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setSelected((s) => (s + rows.length - 1) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current >= ENTER_GRACE_MS) choose(rows[selected].choice);
    }
  };

  const ring: React.CSSProperties = { outline: '2px solid var(--rn-clr-border-accent, #3B82F6)', outlineOffset: '2px' };
  const single = request?.total === 1 ? request.groups[0] : null;
  const hiddenMatches = request
    ? new Set(request.groups.flatMap((group) => group.matches.map((match) => match.remId))).size - MAX_OPEN_ROWS
    : 0;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{ outline: 'none', color: 'var(--rn-clr-content-primary)' }}
    >
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 18 }}>⚠️</span>
        <span className="font-semibold text-base">Already in your Incremental Rems</span>
      </div>

      <div className="text-sm">
        {single
          ? `“${single.name}” has the same web page as a source as:`
          : request &&
            `${request.groups.length === 1 ? '1 of the selected Rems has' : `${request.groups.length} of the selected Rems have`} the same web page as a source as:`}
      </div>
      {single && (
        <div
          className="text-xs p-2 rounded"
          style={{
            background: 'var(--rn-clr-background-elevation-10)',
            color: 'var(--rn-clr-content-secondary)',
            overflowWrap: 'anywhere',
          }}
        >
          {single.url}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <button
            key={`${row.label}-${index}`}
            onClick={() => choose(row.choice)}
            onMouseEnter={() => !decided && setSelected(index)}
            onMouseDown={(e) => e.preventDefault()}
            disabled={decided}
            className="w-full py-2 px-3 text-sm font-medium rounded text-left"
            style={{
              ...(row.primary
                ? { background: '#3B82F6', color: 'white', border: 'none' }
                : {
                    background: 'transparent',
                    color: 'var(--rn-clr-content-primary)',
                    border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))',
                  }),
              cursor: decided ? 'progress' : 'pointer',
              overflowWrap: 'anywhere',
              ...(selected === index ? ring : {}),
            }}
          >
            <div>{row.label}</div>
            {row.hint && (
              <div className="text-xs font-normal mt-0.5" style={{ opacity: 0.85 }}>
                {row.hint}
              </div>
            )}
          </button>
        ))}
      </div>

      {hiddenMatches > 0 && (
        <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          …and {hiddenMatches} more.
        </div>
      )}

      <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
        ↑↓ choose · Enter confirm · Esc cancel
      </div>
    </div>
  );
}

renderWidget(DuplicateSourcePopup);
