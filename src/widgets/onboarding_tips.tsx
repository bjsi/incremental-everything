import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { IE_DOCS_BASE_URL } from '../lib/settings';
import {
  AcknowledgedTipMap,
  ONBOARDING_TIPS,
  OnboardingTip,
  TIP_CATEGORY_ORDER,
  acknowledgeTip,
  getAcknowledgedTipMap,
} from '../lib/onboarding_tips';

/**
 * The whole tip pile, behind the sidebar hub's "All Tips" button.
 *
 * The hub deliberately shows ONE tip per session, which is right for learning
 * the plugin and useless for two other things the user actually wants: checking
 * what they have already been told, and reading ahead. This popup is the escape
 * hatch for both. Nothing is drawn at random here and nothing is paced — the
 * pile is simply laid out.
 *
 * The order is the answer to "what have I seen?": acknowledged tips first, most
 * recently answered at the top, so the list reads as a history. Everything still
 * unanswered follows in the order the hub would offer it — `basics` before
 * `utilities`, list order within each — so reading down the second half is
 * reading ahead, not browsing a shuffled set.
 *
 * Tips answered before the acknowledgement date was recorded have no timestamp
 * (see `TipsState.acknowledged`); they sort to the bottom of the seen half and
 * say so, rather than borrowing a date they never had.
 */

/** `window.open` is blocked in some embedded contexts — same fallback as the hub. */
const openDocs = (path: string) => {
  const url = `${IE_DOCS_BASE_URL}${path}`;
  const opened = window.open(url, '_blank');
  if (!opened || opened.closed) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => document.body.removeChild(link), 100);
  }
};

const CATEGORY_LABELS: Record<(typeof TIP_CATEGORY_ORDER)[number], string> = {
  basics: 'Basics',
  statistics: 'Statistics',
  utilities: 'Utilities',
  advanced: 'Advanced',
};

const formatDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

interface TipRow {
  tip: OnboardingTip;
  /** null → acknowledged before dates were recorded. undefined → not acknowledged. */
  at: number | null | undefined;
}

/**
 * Seen first (newest answer at the top, undated last), then unseen in the order
 * the hub would draw them. Returns one flat list because the keyboard walks it
 * as one — the two halves are separated by a heading, not by a second list.
 */
function buildRows(map: AcknowledgedTipMap): { seen: TipRow[]; unseen: TipRow[] } {
  const seen: TipRow[] = [];
  const unseen: TipRow[] = [];

  for (const tip of ONBOARDING_TIPS) {
    if (tip.id in map) seen.push({ tip, at: map[tip.id] });
    else unseen.push({ tip, at: undefined });
  }

  seen.sort((a, b) => {
    // Undated entries are older than anything with a date, by definition: the
    // dates only started being written later.
    if (a.at == null && b.at == null) return 0;
    if (a.at == null) return 1;
    if (b.at == null) return -1;
    return b.at - a.at;
  });

  unseen.sort((a, b) => {
    const byCategory =
      TIP_CATEGORY_ORDER.indexOf(a.tip.category) - TIP_CATEGORY_ORDER.indexOf(b.tip.category);
    if (byCategory !== 0) return byCategory;
    return ONBOARDING_TIPS.indexOf(a.tip) - ONBOARDING_TIPS.indexOf(b.tip);
  });

  return { seen, unseen };
}

export function OnboardingTipsPopup() {
  const plugin = usePlugin();

  const [map, setMap] = useState<AcknowledgedTipMap | null>(null);
  /** Index into the flat row list the keyboard is on. */
  const [cursor, setCursor] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = await getAcknowledgedTipMap(plugin);
      if (!cancelled) setMap(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [plugin]);

  // Keys are read on the container, not on the buttons: with focus on a button,
  // Enter would fire the browser's native activation AND bubble up here. The
  // retry loop wins against RemNote settling focus after the popup opens.
  useEffect(() => {
    let cancelled = false;
    const tryFocus = (attemptsLeft: number) => {
      if (cancelled) return;
      try {
        window.focus();
      } catch {
        /* ignore */
      }
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

  const { seen, unseen } = useMemo(() => buildRows(map ?? {}), [map]);
  /**
   * The keyboard walks both halves as one list, so the flat order here IS the
   * visual order — anything that reorders the render has to reorder this too.
   */
  const rows = useMemo(() => [...seen, ...unseen], [seen, unseen]);

  // Acknowledging re-sorts the list under the cursor (the tip jumps to the top
  // of the seen half), so the cursor follows the tip rather than the position.
  const handleGotIt = useCallback(
    async (tip: OnboardingTip) => {
      if (map && tip.id in map) return;
      await acknowledgeTip(plugin, tip.id);
      setMap(await getAcknowledgedTipMap(plugin));
      setCursor(0);
    },
    [plugin, map]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      plugin.widget.closePopup();
      return;
    }
    // A button reached by Tab handles its own keys — otherwise Enter would fire
    // both the native click and this handler.
    if ((e.target as HTMLElement)?.tagName === 'BUTTON') return;
    if (rows.length === 0) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(rows.length - 1, Math.max(0, cursor + delta));
      setCursor(next);
      rowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : rows.length - 1;
      setCursor(next);
      rowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const row = rows[cursor];
    if (!row) return;
    if (e.key === 'Enter') {
      // Enter is the destructive-ish one (a tip retired can only come back by
      // resetting), so it only acts on a tip that is still unseen.
      e.preventDefault();
      if (row.at === undefined) handleGotIt(row.tip);
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      if (row.tip.docsPath) openDocs(row.tip.docsPath);
    }
  };

  const selectionRing = (isSelected: boolean): React.CSSProperties =>
    isSelected
      ? { outline: '2px solid var(--rn-clr-border-accent, #3B82F6)', outlineOffset: '1px' }
      : {};

  const buttonStyle: React.CSSProperties = {
    padding: '2px 7px',
    borderRadius: 5,
    fontSize: 11,
    lineHeight: '16px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    flex: '0 0 auto',
  };

  const renderRow = (row: TipRow, flatIndex: number) => {
    const { tip, at } = row;
    const isSeen = at !== undefined;
    return (
      <div
        key={tip.id}
        ref={(el) => {
          rowRefs.current[flatIndex] = el;
        }}
        className="flex items-start gap-2 py-1.5 px-2 rounded"
        style={{
          background: 'var(--rn-clr-background-elevation-10, transparent)',
          border: '1px solid var(--rn-clr-border-subtle, rgba(128,128,128,0.2))',
          ...selectionRing(cursor === flatIndex),
        }}
      >
        <div className="flex flex-col gap-0.5 min-w-0" style={{ flex: '1 1 auto' }}>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span style={{ fontSize: 13, fontWeight: 600 }}>{tip.title}</span>
            <span style={{ fontSize: 11, color: 'var(--rn-clr-content-tertiary)' }}>
              {isSeen
                ? at === null
                  ? 'Got it — date not recorded'
                  : `Got it · ${formatDate(at)}`
                : CATEGORY_LABELS[tip.category]}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--rn-clr-content-secondary)' }}>{tip.body}</div>
        </div>

        <div className="flex items-center gap-1" style={{ flex: '0 0 auto' }}>
          {!isSeen && (
            <button
              onClick={() => handleGotIt(tip)}
              style={{ ...buttonStyle, background: '#3b82f6', color: '#fff', border: '1px solid transparent' }}
              className="hover:opacity-90"
              title="Acknowledge this tip — the sidebar will not offer it again"
            >
              I Got It
            </button>
          )}
          {tip.docsPath && (
            <button
              onClick={() => openDocs(tip.docsPath!)}
              style={{
                ...buttonStyle,
                background: 'transparent',
                color: 'var(--rn-clr-content-secondary)',
                border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
              }}
              className="hover:opacity-75"
              title="Open the documentation for this feature"
            >
              Learn More
            </button>
          )}
        </div>
      </div>
    );
  };

  const sectionHeading = (text: string, hint: string) => (
    <div className="flex items-baseline gap-2 mt-1">
      <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.2 }}>{text}</span>
      <span style={{ fontSize: 11, color: 'var(--rn-clr-content-tertiary)' }}>{hint}</span>
    </div>
  );

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2 p-4"
      style={{ outline: 'none' }}
    >
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 18 }}>💡</span>
        <span className="font-semibold text-base">All Tips</span>
        {map && (
          <span style={{ fontSize: 11, color: 'var(--rn-clr-content-tertiary)' }}>
            {seen.length} of {ONBOARDING_TIPS.length} acknowledged
          </span>
        )}
      </div>

      <div style={{ fontSize: 12, color: 'var(--rn-clr-content-secondary)' }}>
        The sidebar panel offers one of these per session. Pressing{' '}
        <strong>I Got It</strong> retires a tip: it is never shown in the panel again, and it
        moves to the top of the acknowledged list below. <strong>Learn More</strong> opens the
        documentation for that feature.
      </div>

      {map === null ? (
        <div style={{ fontSize: 12, color: 'var(--rn-clr-content-tertiary)' }}>Loading…</div>
      ) : (
        <div className="flex flex-col gap-2" style={{ maxHeight: 520, overflowY: 'auto' }}>
          {seen.length > 0 && sectionHeading('Acknowledged', 'most recent first')}
          {seen.map((row, i) => renderRow(row, i))}

          {unseen.length > 0 &&
            sectionHeading(
              'Not yet acknowledged',
              seen.length > 0 ? 'in the order the panel offers them' : 'nothing acknowledged yet'
            )}
          {unseen.map((row, i) => renderRow(row, seen.length + i))}

          {unseen.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--rn-clr-content-tertiary)' }}>
              Every tip has been acknowledged — the panel will not offer any more.
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--rn-clr-content-tertiary)' }}>
        ↑↓ move · Enter acknowledges · Space opens the docs · Esc closes
      </div>
    </div>
  );
}

renderWidget(OnboardingTipsPopup);
