import '../lib/stall_diagnostics';
import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import { withHoverTips } from '../components/HoverTipLayer';
import {
  FindSourcesExtras,
  FindSourcesReview,
  PassageRole,
  queueFindSourcesWrite,
  ReviewPassage,
} from '../lib/find_sources';
import { emphasisSegments } from '../lib/find_sources/quote_text';

/** Remembered per device: what to write besides the pins (an old boolean meant quotes or not). */
const EXTRAS_KEY = 'find-sources-with-quotes';
const EXTRAS: { value: FindSourcesExtras; label: string; tip: string }[] = [
  { value: 'pins', label: 'Pins only', tip: 'Only the pins, on the Rem' },
  { value: 'quotes', label: 'Pins + quotes', tip: 'Also each quote as a child Rem, under Sources / Related material (Extra Card Detail)' },
  {
    value: 'notes',
    label: 'Pins + quotes + AI notes',
    tip: 'Also the reason each passage was chosen, under its quote, as a small AI Note',
  },
];
/** The Enter that opened the popup from the notice can reach it; ignore Enter this soon. */
const ENTER_GRACE_MS = 300;
/** Score at which `A` accepts a row. */
const ACCEPT_SCORE = 9;

const ROLE: Record<PassageRole, { label: string; color: string }> = {
  source: { label: 'Source', color: '#10B981' },
  diverges: { label: 'Diverges', color: '#EF4444' },
  related: { label: 'Related', color: '#3B82F6' },
};

interface Row {
  rem: number;
  passage: number;
  p: ReviewPassage;
}

const muted = { color: 'var(--rn-clr-content-secondary)' };
const keyStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11,
  padding: '0 4px',
  borderRadius: 3,
  border: '1px solid var(--rn-clr-border-primary)',
};

/**
 * Find Sources, the review (lib/find_sources): opened by the Review button of the
 * notice the background search posts. One row per passage, grouped by Rem then by
 * role; sources scoring 8+ start selected. Enter hands the selection to the tracker,
 * which pins it; Esc closes and keeps the notice, so the review can be reopened.
 */
function FindSourcesPopup() {
  const plugin = usePlugin();
  const [review, setReview] = useState<FindSourcesReview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [extras, setExtras] = useState<FindSourcesExtras>('pins');
  const withQuotes = extras !== 'pins';
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      const data = (ctx?.contextData as FindSourcesReview) ?? null;
      setReview(data);
      const initial = new Set<string>();
      data?.rems.forEach((r, i) =>
        r.passages.forEach((p, j) => {
          if (p.role === 'source' && p.score >= 8 && p.pdfRemId) initial.add(`${i}:${j}`);
        })
      );
      setSelected(initial);
      try {
        const saved = await plugin.storage.getLocal<FindSourcesExtras | boolean>(EXTRAS_KEY);
        setExtras(saved === true ? 'quotes' : EXTRAS.some((e) => e.value === saved) ? (saved as FindSourcesExtras) : 'pins');
      } catch {
        /* per-device convenience only */
      }
    })();
  }, []);

  // Keys are read on the container, which has to win focus against RemNote settling it.
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      containerRef.current?.focus();
      if (document.activeElement === containerRef.current || ++tries >= 8) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, []);

  /** Rows in display order: per Rem, sources, then diverging, then related. */
  const rows = useMemo<Row[]>(() => {
    const order: PassageRole[] = ['source', 'diverges', 'related'];
    const out: Row[] = [];
    review?.rems.forEach((r, i) => {
      for (const role of order) r.passages.forEach((p, j) => p.role === role && out.push({ rem: i, passage: j, p }));
    });
    return out;
  }, [review]);

  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const keyOf = (row: Row) => `${row.rem}:${row.passage}`;
  /** Without a PDF in RemNote, a passage can only be written as a quote Rem. */
  const selectable = (row: Row) => !!row.p.pdfRemId || withQuotes;

  const toggle = (row: Row) => {
    if (!selectable(row)) return;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(keyOf(row))) next.delete(keyOf(row));
      else next.add(keyOf(row));
      return next;
    });
  };

  const acceptHigh = () =>
    setSelected(new Set(rows.filter((r) => r.p.score >= ACCEPT_SCORE && selectable(r)).map(keyOf)));

  /** Pins only → Pins + quotes → Pins + quotes + AI notes → Pins only. */
  const cycleExtras = () => {
    const next = EXTRAS[(EXTRAS.findIndex((e) => e.value === extras) + 1) % EXTRAS.length].value;
    setExtras(next);
    // Unpinnable rows cannot stay selected without quote Rems.
    if (next === 'pins') setSelected((s) => new Set([...s].filter((k) => rows.find((r) => keyOf(r) === k)?.p.pdfRemId)));
    void plugin.storage.setLocal(EXTRAS_KEY, next).catch(() => {});
  };

  const close = () => plugin.widget.closePopup();

  const write = async () => {
    if (!review || busy) return;
    const chosen = rows.filter((r) => selected.has(keyOf(r)) && selectable(r));
    if (!chosen.length) {
      await plugin.app.toast('Select at least one passage (Space), or press Esc to close.');
      return;
    }
    setBusy(true);
    const rems = review.rems
      .map((r, i) => ({
        remId: r.remId,
        lang: r.lang,
        passages: chosen.filter((c) => c.rem === i).map((c) => c.p),
      }))
      .filter((r) => r.passages.length);
    // One hand-off write, awaited before closing (a popup's teardown cuts longer work short).
    await queueFindSourcesWrite(plugin, {
      id: `${review.jobId}-write-${Date.now()}`,
      noticeId: review.noticeId,
      extras,
      rems,
    });
    await plugin.app.toast(`📌 Pinning ${chosen.length} passage${chosen.length === 1 ? '' : 's'}…`);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
    const row = rows[cursor];
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(rows.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === ' ') {
      e.preventDefault();
      if (row) toggle(row);
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      acceptHigh();
    } else if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      cycleExtras();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current >= ENTER_GRACE_MS) void write();
    }
  };

  if (!review) return <div className="p-4 text-sm">Loading…</div>;
  const count = rows.filter((r) => selected.has(keyOf(r)) && selectable(r)).length;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{ outline: 'none', color: 'var(--rn-clr-content-primary)', height: '100%', boxSizing: 'border-box' }}
    >
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 18 }}>🔎</span>
        <span className="font-semibold text-base">Find Sources</span>
        <span className="text-xs ml-auto" style={muted}>
          Passages that say what your note says, found by meaning
        </span>
      </div>

      <div className="flex flex-col gap-1 overflow-y-auto" style={{ flex: 1, minHeight: 0 }}>
        {review.rems.map((rem, i) => (
          <div key={rem.remId} className="flex flex-col gap-1 mb-2">
            <div className="text-sm font-semibold" style={{ borderBottom: '1px solid var(--rn-clr-border-primary)', paddingBottom: 2 }}>
              {rem.title}
            </div>
            {rem.error && (
              <div className="text-xs" style={{ color: '#EF4444' }}>
                {rem.error}
              </div>
            )}
            {!rem.error && !rem.passages.length && (
              <div className="text-xs" style={muted}>
                No passage of your library says this.
              </div>
            )}
            {rows.map((row, k) => {
              if (row.rem !== i) return null;
              const p = row.p;
              const on = selected.has(keyOf(row)) && selectable(row);
              const role = ROLE[p.role];
              return (
                <div
                  key={keyOf(row)}
                  ref={(el) => (rowRefs.current[k] = el)}
                  onClick={() => {
                    setCursor(k);
                    toggle(row);
                  }}
                  className="flex gap-2 p-2 rounded text-sm"
                  style={{
                    cursor: selectable(row) ? 'pointer' : 'default',
                    opacity: selectable(row) ? 1 : 0.55,
                    background: on ? 'var(--rn-clr-background-elevation-10, rgba(59,130,246,0.08))' : 'transparent',
                    borderLeft: `3px solid ${role.color}`,
                    outline: k === cursor ? '2px solid var(--rn-clr-border-accent, #3B82F6)' : 'none',
                    outlineOffset: -1,
                  }}
                >
                  <input type="checkbox" readOnly checked={on} disabled={!selectable(row)} tabIndex={-1} style={{ marginTop: 3 }} />
                  <div className="flex flex-col gap-0.5" style={{ minWidth: 0 }}>
                    <div className="flex items-center gap-2 text-xs" style={muted}>
                      <span style={{ color: role.color, fontWeight: 600 }}>{role.label}</span>
                      <span>{p.score}/10</span>
                      <span>·</span>
                      <span className="font-medium" style={{ color: 'var(--rn-clr-content-primary)' }}>
                        {p.book.cite || p.book.title}
                      </span>
                      <span>{p.pdfPage ? `PDF p. ${p.pdfPage}` : p.page ? `p. ${p.page}` : ''}</span>
                      {p.edital && p.edital !== 'sim' && <span>· fora do edital</span>}
                      {p.unpinnable && <span style={{ color: '#F59E0B' }}>· no pin: {p.unpinnable}</span>}
                    </div>
                    <div className="italic">
                      “
                      {emphasisSegments(p.quote, p.emphasis, p.key).map((seg, n) =>
                        seg.bold ? (
                          <b key={n} style={seg.italic ? { textDecoration: 'underline' } : undefined}>
                            {seg.text}
                          </b>
                        ) : (
                          <React.Fragment key={n}>{seg.text}</React.Fragment>
                        )
                      )}
                      ”
                    </div>
                    {p.why && <div className="text-xs" style={muted}>{p.why}</div>}
                    {p.covers && p.role === 'source' && (
                      <div className="text-xs" style={muted}>
                        Supports: “{p.covers.length > 120 ? `${p.covers.slice(0, 119)}…` : p.covers}”
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 text-sm" style={{ borderTop: '1px solid var(--rn-clr-border-primary)', paddingTop: 8 }}>
        <button
          onClick={cycleExtras}
          onMouseDown={(e) => e.preventDefault()}
          className="py-1 px-2 rounded text-xs"
          style={{ border: '1px solid var(--rn-clr-border-primary)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
          data-tip={`Q: ${EXTRAS.find((e) => e.value === extras)?.tip}. Press again for the next choice.`}
        >
          {EXTRAS.find((e) => e.value === extras)?.label} ▾
        </button>
        <span className="text-xs" style={muted}>
          <span style={keyStyle}>↑↓</span> move · <span style={keyStyle}>Space</span> select · <span style={keyStyle}>A</span> all ≥ {ACCEPT_SCORE} ·{' '}
          <span style={keyStyle}>Q</span> what to add · <span style={keyStyle}>Esc</span> later
        </span>
        <button
          onClick={() => void write()}
          onMouseDown={(e) => e.preventDefault()}
          disabled={busy || !count}
          className="ml-auto py-1.5 px-4 text-sm font-medium rounded"
          style={{ background: '#3B82F6', color: 'white', border: 'none', cursor: 'pointer', opacity: busy || !count ? 0.5 : 1 }}
        >
          Pin {count || ''} (Enter)
        </button>
      </div>
    </div>
  );
}

renderWidget(withHoverTips(FindSourcesPopup));
