import '../lib/stall_diagnostics';
import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import { withHoverTips } from '../components/HoverTipLayer';
import { dismissNotices } from '../lib/notice';
import {
  enqueueAskFollowUp,
  FindSourcesExtras,
  FindSourcesReview,
  PassageRole,
  queueFindSourcesWrite,
  ReviewPassage,
} from '../lib/find_sources';
import { Verdict, VERDICTS } from '../lib/find_sources/check';
import { emphasisSegments } from '../lib/find_sources/quote_text';

/** Remembered per device: what to write besides the pins (an old boolean meant quotes or not). */
const EXTRAS_KEY = 'find-sources-with-quotes';
/** Check Statement and Ask Your Sources: their own choice, Pins only or Pins + quotes. */
const EXPLAINED_EXTRAS_KEY = 'find-sources-explained-extras';
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

/** Claude's **bold** shown as bold. */
function Bold({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*.+?\*\*)/g).map((part, k) =>
        part.startsWith('**') && part.endsWith('**') ? <b key={k}>{part.slice(2, -2)}</b> : <React.Fragment key={k}>{part}</React.Fragment>
      )}
    </>
  );
}
const VERDICT_COLOR: Record<Verdict, string> = {
  consistent: '#10B981',
  partly: '#F59E0B',
  contradicts: '#EF4444',
  'not-covered': '#9CA3AF',
};
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
  /** Ask Your Sources: what to improve or add, sent with Ask again. */
  const [followUp, setFollowUp] = useState('');
  const followUpRef = useRef<HTMLInputElement>(null);
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
          // Sources scoring 8+, and the passages a Check Statement verdict rests on.
          if (((p.role === 'source' && p.score >= 8) || p.basis) && (p.pdfRemId || p.basis)) initial.add(`${i}:${j}`);
        })
      );
      setSelected(initial);
      try {
        // Check Statement and Ask Your Sources remember their own choice (no AI notes there).
        const explained = !!data?.rems.some((r) => r.check || r.checkError || r.answer || r.answerError);
        const saved = await plugin.storage.getLocal<FindSourcesExtras | boolean>(explained ? EXPLAINED_EXTRAS_KEY : EXTRAS_KEY);
        setExtras(saved === true ? 'quotes' : EXTRAS.some((e) => e.value === saved) ? (saved as FindSourcesExtras) : explained ? 'quotes' : 'pins');
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

  /** A batch (a tree run): per-Rem keys and the count in the header. */
  const multi = (review?.rems.length ?? 0) > 1;

  /** Check Statement: some Rem has a verdict (or the verdict failed). */
  const isAsk = !!review?.rems.some((r) => r.answer || r.answerError);
  /** A verdict or an answer is written even with no passage selected. */
  const isCheck = isAsk || !!review?.rems.some((r) => r.check || r.checkError);

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

  /** A: select the passages scoring 9+ (and only those); with `rem`, in that Rem only, the others untouched. */
  const acceptHigh = (rem?: number) =>
    setSelected((s) => {
      const keep = rem === undefined ? [] : [...s].filter((k) => !k.startsWith(`${rem}:`));
      const high = rows.filter((r) => (rem === undefined || r.rem === rem) && r.p.score >= ACCEPT_SCORE && selectable(r));
      return new Set([...keep, ...high.map(keyOf)]);
    });

  /** PageDown / PageUp: the first row of the next or previous Rem that has passages. */
  const jumpRem = (step: 1 | -1) => {
    const current = rows[cursor]?.rem ?? 0;
    const target = step === 1 ? rows.findIndex((r) => r.rem > current) : rows.findIndex((r) => r.rem === (rows.slice(0, cursor).reverse().find((x) => x.rem < current)?.rem ?? -1));
    if (target !== -1) setCursor(target);
  };

  /**
   * Pins only → Pins + quotes → Pins + quotes + AI notes → Pins only. The AI notes only in
   * Find Sources: Check Statement's observation and Ask Your Sources' answer already explain.
   */
  const choices = isCheck ? EXTRAS.filter((e) => e.value !== 'notes') : EXTRAS;
  const extrasChoice: FindSourcesExtras = choices.some((e) => e.value === extras) ? extras : 'quotes';
  const cycleExtras = () => {
    const next = choices[(choices.findIndex((e) => e.value === extrasChoice) + 1) % choices.length].value;
    setExtras(next);
    // Unpinnable rows cannot stay selected without quote Rems.
    if (next === 'pins') setSelected((s) => new Set([...s].filter((k) => rows.find((r) => keyOf(r) === k)?.p.pdfRemId)));
    void plugin.storage.setLocal(isCheck ? EXPLAINED_EXTRAS_KEY : EXTRAS_KEY, next).catch(() => {});
  };

  const close = () => plugin.widget.closePopup();

  /** The Rem a follow-up asks again: the one under the cursor (the only one, usually). */
  const followUpRem = rows[cursor]?.rem ?? review?.rems.findIndex((r) => r.answer || r.answerError) ?? 0;

  /**
   * Ask again with the follow-up: queued for the tracker like the first run (a new notice
   * opens a new review). With one Rem, this review's notice goes: its answer is replaced.
   */
  const askAgain = async () => {
    if (!review || busy) return;
    const text = followUp.trim();
    if (!text) {
      await plugin.app.toast('Write what to improve or add first.');
      followUpRef.current?.focus();
      return;
    }
    const rem = review.rems[followUpRem];
    if (!rem) return;
    setBusy(true);
    // All awaited before closing: a popup's teardown cuts a read-then-write short.
    const queued = await enqueueAskFollowUp(plugin, rem, text, review.openSourceRemId);
    if (!queued) {
      setBusy(false);
      await plugin.app.toast('That Rem is gone or has no text to ask about.');
      return;
    }
    if (review.rems.length === 1) await dismissNotices(plugin, review.noticeId);
    await plugin.app.toast(
      '\ud83d\udcac Asking your sources again with the follow-up, in the background (about 60 s). A notice will say when it is ready to review.'
    );
    close();
  };

  const write = async () => {
    if (!review || busy) return;
    const chosen = rows.filter((r) => selected.has(keyOf(r)) && selectable(r));
    if (!chosen.length && !isCheck) {
      await plugin.app.toast('Select at least one passage (Space), or press Esc to close.');
      return;
    }
    setBusy(true);
    const rems = review.rems
      .map((r, i) => ({
        remId: r.remId,
        lang: r.lang,
        passages: chosen.filter((c) => c.rem === i).map((c) => c.p),
        check: r.check,
        members: r.members,
        answer: r.answer,
      }))
      .filter((r) => r.passages.length || r.check);
    // One hand-off write, awaited before closing (a popup's teardown cuts longer work short).
    await queueFindSourcesWrite(plugin, {
      id: `${review.jobId}-write-${Date.now()}`,
      noticeId: review.noticeId,
      extras: extrasChoice,
      rems,
    });
    await plugin.app.toast(`📌 Pinning ${chosen.length} passage${chosen.length === 1 ? '' : 's'}…`);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
    // The follow-up field: typing stays in it; Enter asks again, Esc goes back to the list.
    if ((e.target as HTMLElement).tagName === 'INPUT' && e.target === followUpRef.current) {
      if (e.key === 'Enter') {
        e.preventDefault();
        void askAgain();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        containerRef.current?.focus();
      }
      return;
    }
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
      acceptHigh(e.shiftKey ? row?.rem : undefined);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      jumpRem(e.key === 'PageDown' ? 1 : -1);
    } else if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      cycleExtras();
    } else if (isAsk && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      followUpRef.current?.focus();
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
        <span style={{ fontSize: 18 }}>{isAsk ? '💬' : isCheck ? '⚖️' : '🔎'}</span>
        <span className="font-semibold text-base">{isAsk ? 'Ask Your Sources' : isCheck ? 'Check Statement' : 'Find Sources'}</span>
        <span className="text-xs ml-auto" style={muted}>
          {isAsk
            ? 'Your question answered from the passages of your library'
            : isCheck
            ? 'Your note checked against the passages of your library'
            : 'Passages that say what your note says, found by meaning'}
          {multi && ` \u00b7 ${review.rems.length} Rems, ${rows.length} passages`}
        </span>
      </div>

      <div className="flex flex-col gap-1 overflow-y-auto" style={{ flex: 1, minHeight: 0 }}>
        {review.rems.map((rem, i) => (
          <div key={rem.remId} className="flex flex-col gap-1 mb-2">
            <div className="text-sm font-semibold" style={{ borderBottom: '1px solid var(--rn-clr-border-primary)', paddingBottom: 2 }}>
              {rem.title}
            </div>
            {(rem.outline || rem.context) && (
              <div className="text-xs" style={muted} data-tip="Where the note sits, as sent with it: the outline path to the AI only, a descriptor's concept to the search too">
                {[rem.outline, rem.context].filter(Boolean).join(' › ')} › <i>this note</i>
              </div>
            )}
            {rem.followUp && (
              <div className="text-xs" style={muted}>
                Follow-up: “{rem.followUp}”
              </div>
            )}
            {rem.error && (
              <div className="text-xs" style={{ color: '#EF4444' }}>
                {rem.error}
              </div>
            )}
            {rem.check && (
              <div
                className="flex flex-col gap-1 p-2 rounded text-sm"
                style={{
                  background: 'var(--rn-clr-background-secondary)',
                  borderLeft: `3px solid ${VERDICT_COLOR[rem.check.verdict]}`,
                }}
              >
                <div className="font-semibold">
                  {VERDICTS[rem.check.verdict].icon} {VERDICTS[rem.check.verdict][rem.lang]}
                  <span className="text-xs font-normal ml-2" style={muted}>
                    {rem.check.model ?? ''}
                  </span>
                </div>
                {rem.check.observation && <div>{rem.check.observation}</div>}
                <div className="text-xs" style={muted}>
                  Written under the Rem as a Check Rem; the passages marked ◆ go under it.
                </div>
              </div>
            )}
            {rem.checkError && (
              <div className="text-xs" style={{ color: '#EF4444' }}>
                No verdict: {rem.checkError}
              </div>
            )}
            {rem.answer && (
              <div
                className="flex flex-col gap-1.5 p-2 rounded text-sm"
                style={{ background: 'var(--rn-clr-background-secondary)', borderLeft: '3px solid #8B5CF6' }}
              >
                <div className="font-semibold">
                  <Bold text={rem.answer.answer} />
                  <span className="text-xs font-normal ml-2" style={muted}>
                    {rem.answer.covered !== 'full' ? `(${rem.answer.covered === 'none' ? 'not covered' : 'partly covered'}) ` : ''}
                    {rem.answer.model ?? ''}
                  </span>
                </div>
                {rem.answer.sections.map((sec, k) => (
                  <div key={k}>
                    <Bold text={sec.text} />
                    {sec.basis.length > 0 && <span className="text-xs ml-1" style={muted}>[{sec.basis.map((b) => b + 1).join(', ')}]</span>}
                    {(sec.quotes ?? []).map((q, n) => (
                      <div key={n} className="text-xs italic ml-3 mt-0.5" style={muted}>
                        [{q.index + 1}] “
                        {emphasisSegments(q.excerpts.join(' […] '), q.emphasis, q.key).map((seg, m) =>
                          seg.bold ? <b key={m}>{seg.text}</b> : <React.Fragment key={m}>{seg.text}</React.Fragment>
                        )}
                        ”
                      </div>
                    ))}
                  </div>
                ))}
                {rem.answer.divergences.length > 0 && (
                  <div className="flex flex-col gap-1" style={{ borderTop: '1px solid var(--rn-clr-border-primary)', paddingTop: 4 }}>
                    <div className="text-xs font-semibold" style={{ color: '#EF4444' }}>
                      {rem.lang === 'pt' ? 'Divergências' : 'Divergences'}
                    </div>
                    {rem.answer.divergences.map((sec, k) => (
                      <div key={k}>
                        <Bold text={sec.text} />
                        {sec.basis.length > 0 && <span className="text-xs ml-1" style={muted}>[{sec.basis.map((b) => b + 1).join(', ')}]</span>}
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-xs" style={muted}>
                  Written under the Rem as a dated answer; each section gets the quotes of the passages selected below.
                </div>
              </div>
            )}
            {rem.answerError && (
              <div className="text-xs" style={{ color: '#EF4444' }}>
                No answer: {rem.answerError}
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
                      {review.rems[row.rem].answer && p.index !== undefined && (
                        <span style={{ color: 'var(--rn-clr-content-primary)', fontWeight: 600 }}>[{p.index + 1}]</span>
                      )}
                      <span>{p.score}/10</span>
                      <span>·</span>
                      <span className="font-medium" style={{ color: 'var(--rn-clr-content-primary)' }}>
                        {p.book.cite || p.book.title}
                      </span>
                      <span>{p.pdfPage ? `PDF p. ${p.pdfPage}` : p.page ? `p. ${p.page}` : ''}</span>
                      {p.edital && p.edital !== 'sim' && <span>· fora do edital</span>}
                      {p.unpinnable && <span style={{ color: '#F59E0B' }}>· no pin: {p.unpinnable}</span>}
                      {p.diverges && p.role !== 'diverges' && <span style={{ color: '#EF4444' }}>· ⚠ diverges</span>}
                      {p.basis && (
                        <span style={{ color: 'var(--rn-clr-content-primary)' }}>
                          · ◆ {review.rems[row.rem].answer ? 'answer' : 'verdict'}
                        </span>
                      )}
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

      {isAsk && (
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <input
            ref={followUpRef}
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            placeholder={`Optional follow-up${multi ? ` for “${review.rems[followUpRem]?.title ?? ''}”` : ''}: what to improve or add (e.g. “include the effect of the ice thickness”), then Enter`}
            className="text-sm rounded px-2 py-1"
            style={{
              flex: 1,
              minWidth: 0,
              border: '1px solid var(--rn-clr-border-primary)',
              background: 'var(--rn-clr-background-primary)',
              color: 'var(--rn-clr-content-primary)',
            }}
          />
          <button
            onClick={() => void askAgain()}
            onMouseDown={(e) => e.preventDefault()}
            disabled={busy || !followUp.trim()}
            className="py-1 px-3 rounded text-sm"
            style={{
              border: '1px solid var(--rn-clr-border-primary)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              opacity: busy || !followUp.trim() ? 0.5 : 1,
            }}
            data-tip="Ask again with this follow-up: a new search and a rewritten answer, reviewed from a new notice. Nothing is written now."
          >
            Ask again
          </button>
        </div>
      )}

      <div className="flex items-center gap-3 text-sm" style={{ borderTop: '1px solid var(--rn-clr-border-primary)', paddingTop: 8 }}>
        <button
          onClick={cycleExtras}
          onMouseDown={(e) => e.preventDefault()}
          className="py-1 px-2 rounded text-xs"
          style={{ border: '1px solid var(--rn-clr-border-primary)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
          data-tip={`Q: ${EXTRAS.find((e) => e.value === extrasChoice)?.tip}. Press again for the next choice.`}
        >
          {EXTRAS.find((e) => e.value === extrasChoice)?.label} ▾
        </button>
        <span className="text-xs" style={muted}>
          <span style={keyStyle}>↑↓</span> move · <span style={keyStyle}>Space</span> select · <span style={keyStyle}>A</span> all ≥ {ACCEPT_SCORE} ·{' '}
          {multi && (
            <>
              <span style={keyStyle}>⇧A</span> this Rem · <span style={keyStyle}>PgDn</span> next Rem ·{' '}
            </>
          )}
          <span style={keyStyle}>Q</span> what to add ·{' '}
          {isAsk && (
            <>
              <span style={keyStyle}>F</span> follow-up ·{' '}
            </>
          )}
          <span style={keyStyle}>Esc</span> later
        </span>
        <button
          onClick={() => void write()}
          onMouseDown={(e) => e.preventDefault()}
          disabled={busy || (!count && !isCheck)}
          className="ml-auto py-1.5 px-4 text-sm font-medium rounded"
          style={{
            background: '#3B82F6',
            color: 'white',
            border: 'none',
            cursor: 'pointer',
            opacity: busy || (!count && !isCheck) ? 0.5 : 1,
          }}
        >
          {isCheck
            ? `Write ${isAsk ? 'answer' : 'verdict'}${count ? ` + ${count} passage${count === 1 ? '' : 's'}` : ''}`
            : `Pin ${count || ''}`}{' '}
          (Enter)
        </button>
      </div>
    </div>
  );
}

renderWidget(withHoverTips(FindSourcesPopup));
