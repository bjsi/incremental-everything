// widgets/mc_scissors.tsx
//
// One ✂ for one option of a native multiple-choice card. Opened
// once per option by lib/mc_scissors.ts, which also pins it beside its option
// with CSS anchor positioning. The widget only learns which option it is (its
// place in the opened-ids list) and toggles that index in the struck set.
//
// Keep imports minimal: one copy of this iframe loads per option.

import '../lib/stall_diagnostics';
import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useState } from 'react';
import '../rn_theme_vars.css';
import { mcScissorsIdsKey as MC_SCISSORS_IDS_KEY, mcScissorsStruckKey as MC_SCISSORS_STRUCK_KEY } from '../lib/consts';

// Lucide "scissors" and "scissors-line-dashed" (ISC licence).
const ScissorsIcon = ({ struck }: { struck: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {struck ? (
      <>
        <path d="M5.42 9.42 8 12" />
        <circle cx="4" cy="8" r="2" />
        <path d="m14 6-8.58 8.58" />
        <circle cx="4" cy="16" r="2" />
        <path d="M10.8 14.8 14 18" />
        <path d="M16 12h-2" />
        <path d="M22 12h-2" />
      </>
    ) : (
      <>
        <circle cx="6" cy="6" r="3" />
        <path d="M8.12 8.12 12 12" />
        <path d="M20 4 8.12 15.88" />
        <circle cx="6" cy="18" r="3" />
        <path d="M14.8 14.8 20 20" />
      </>
    )}
  </svg>
);

function McScissors() {
  const plugin = usePlugin();
  const [ownId, setOwnId] = useState<string>();

  useEffect(() => {
    // The iframe is exactly the button's size; the default 8px body margin would push it out.
    document.body.style.margin = '0';
    document.body.style.background = 'transparent';
    plugin.widget
      .getWidgetContext<WidgetLocation.FloatingWidget>()
      .then((ctx) => setOwnId(ctx?.floatingWidgetId))
      .catch(() => undefined);
  }, [plugin]);

  const ids = useTrackerPlugin((rp) => rp.storage.getSession<string[]>(MC_SCISSORS_IDS_KEY), []) ?? [];
  const struck = useTrackerPlugin((rp) => rp.storage.getSession<number[]>(MC_SCISSORS_STRUCK_KEY), []) ?? [];
  const index = ownId ? ids.indexOf(ownId) : -1;
  const isStruck = index >= 0 && struck.includes(index);

  const toggle = async () => {
    if (index < 0) return;
    const current = (await plugin.storage.getSession<number[]>(MC_SCISSORS_STRUCK_KEY)) ?? [];
    const next = current.includes(index) ? current.filter((i) => i !== index) : [...current, index];
    await plugin.storage.setSession(MC_SCISSORS_STRUCK_KEY, next);
  };

  return (
    <button
      onClick={toggle}
      aria-label={isStruck ? 'Restore this option' : 'Eliminate this option'}
      aria-pressed={isStruck}
      style={{
        width: 28,
        height: 28,
        padding: 0,
        border: 'none',
        borderRadius: 6,
        background: 'transparent',
        color: isStruck ? 'var(--rn-clr-content-tertiary, #9ca3af)' : 'var(--rn-clr-content-secondary, #4b5563)',
        cursor: index < 0 ? 'default' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--rn-clr-background-secondary, rgba(0,0,0,0.06))')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <ScissorsIcon struck={isStruck} />
    </button>
  );
}

renderWidget(McScissors);
