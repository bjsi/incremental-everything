import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { copyTextFromGesture } from '../lib/clipboard';
import type { RemIdChoice, RemIdKind, RemIdRole } from '../lib/copy_rem_id';

/** The Enter that ran the command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;

const ROLE_LABEL: Record<RemIdRole, string> = {
  card: 'Queue card',
  focused: 'Focused Rem',
  source: 'Source',
  pane: 'Open in the pane',
};

const KIND_ICON: Record<RemIdKind, string> = { pdf: '📕', file: '📎', web: '🌐', rem: '•' };
const KIND_LABEL: Record<RemIdKind, string> = { pdf: 'PDF', file: 'File', web: 'Web page', rem: 'Rem' };

/**
 * Copy Rem ID's picker, opened when the command could mean more than one Rem:
 * the focused Rem (or queue card), its sources, and the PDF or web page open
 * in the pane. ↑↓ or 1–9 choose, Enter or a click copies, Esc cancels. The
 * key press itself lets the copy through (lib/clipboard.ts).
 */
export function CopyRemIdPopup() {
  const plugin = usePlugin();
  const [choices, setChoices] = useState<RemIdChoice[]>([]);
  const [selected, setSelected] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      const list = (ctx?.contextData?.choices as RemIdChoice[]) ?? [];
      setChoices(list);
      const preferred = ctx?.contextData?.preferred as number | undefined;
      if (typeof preferred === 'number' && preferred >= 0 && preferred < list.length) setSelected(preferred);
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

  useEffect(() => {
    rowRefs.current[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const close = () => plugin.widget.closePopup();

  // Synchronous up to the copy: the gesture is what lets execCommand through.
  const copy = (index: number) => {
    const choice = choices[index];
    if (!choice) return;
    copyTextFromGesture(plugin, choice.remId, 'Rem ID').then((done) => {
      if (done) close();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = choices.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (!n) {
      return;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => (s + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => (s + n - 1) % n);
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) {
      e.preventDefault();
      copy(Number(e.key) - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current >= ENTER_GRACE_MS) copy(selected);
    }
  };

  const ring: React.CSSProperties = { outline: '2px solid var(--rn-clr-border-accent, #3B82F6)', outlineOffset: '1px' };
  const muted: React.CSSProperties = { color: 'var(--rn-clr-content-tertiary)' };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{ outline: 'none', color: 'var(--rn-clr-content-primary)' }}
    >
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 18 }}>🆔</span>
        <span className="font-semibold text-base">Copy Rem ID</span>
      </div>

      <div className="flex flex-col gap-1.5" style={{ maxHeight: 360, overflowY: 'auto', padding: 3 }}>
        {choices.map((c, index) => (
          <button
            key={c.remId}
            ref={(el) => (rowRefs.current[index] = el)}
            onClick={() => copy(index)}
            onMouseEnter={() => setSelected(index)}
            onMouseDown={(e) => e.preventDefault()}
            className="w-full py-2 px-3 rounded text-left flex gap-2.5 items-start"
            style={{
              background: selected === index ? 'var(--rn-clr-background-elevation-10)' : 'transparent',
              border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))',
              color: 'var(--rn-clr-content-primary)',
              cursor: 'pointer',
              ...(selected === index ? ring : {}),
            }}
          >
            <span className="text-xs font-mono mt-0.5" style={{ ...muted, minWidth: 10 }}>
              {index < 9 ? index + 1 : ''}
            </span>
            <span style={{ fontSize: 15, lineHeight: '20px' }}>{KIND_ICON[c.kind]}</span>
            <span className="flex flex-col min-w-0" style={{ flex: 1 }}>
              <span className="text-sm font-medium" style={{ overflowWrap: 'anywhere' }}>
                {c.name}
              </span>
              <span className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                {ROLE_LABEL[c.role]} · {KIND_LABEL[c.kind]}
                {c.detail ? (c.kind === 'rem' ? ` · in ${c.detail}` : ` · ${c.detail}`) : ''}
              </span>
              <span
                className="text-xs"
                style={{ ...muted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflowWrap: 'anywhere' }}
              >
                {c.remId}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="text-xs" style={muted}>
        ↑↓ or 1–{Math.min(9, Math.max(1, choices.length))} choose · Enter or click copy · Esc cancel
      </div>
    </div>
  );
}

renderWidget(withHoverTips(CopyRemIdPopup));
