// widgets/parent_pick_floating.tsx
//
// The card shown while a new Rem waits for a parent picked in the editor (see
// lib/parent_pick.ts). It follows the Rem holding the editing cursor, warns when
// that Rem is outside the IncRem under review, and places the new Rem when the
// user confirms — with the shortcut (via the confirm command, which bumps
// parentPickConfirmRequestKey) or with its own button.

import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  AppEvents,
  ReactRNPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import '../rn_theme_vars.css';
import { parentPickConfirmRequestKey, parentPickContextKey } from '../lib/consts';
import { ParentSelectorContext } from '../lib/hierarchical_parent_selector/types';
import {
  describePickTarget,
  endParentPick,
  PickTargetInfo,
  remDisplayName,
  returnToParentList,
} from '../lib/parent_pick';
import { createRemUnderParent } from '../lib/highlightActions';
import { safeRemTextToString } from '../lib/pdfUtils';
import { HeadingBadge } from '../components/HeadingBadge';

// The focus event is the main signal; this poll only covers a missed one.
const FOCUS_POLL_MS = 1000;
const EXCERPT_LENGTH = 70;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const CONFIRM_KEYS = isMac ? '⌥⇧↵' : 'Alt+Shift+Enter';

type ButtonId = 'place' | 'back' | 'cancel';
const BUTTONS: ButtonId[] = ['place', 'back', 'cancel'];

export function ParentPickFloating() {
  const plugin = usePlugin() as ReactRNPlugin;

  const [ctx, setCtx] = useState<ParentSelectorContext | null>(null);
  const [floatingWidgetId, setFloatingWidgetId] = useState<string | null>(null);
  const [excerpt, setExcerpt] = useState('');
  const [contextName, setContextName] = useState<string | null>(null);
  const [target, setTarget] = useState<PickTargetInfo | null>(null);
  // The outside-the-IncRem target the user has already been warned about once;
  // confirming it again places the Rem. Moving to another Rem disarms it.
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ring, setRing] = useState(0);

  const targetRef = useRef<PickTargetInfo | null>(null);
  targetRef.current = target;
  const lastFocusedIdRef = useRef<string | null>(null);

  useEffect(() => {
    const init = async () => {
      const wctx = await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>();
      setFloatingWidgetId(wctx?.floatingWidgetId ?? null);

      const data = await plugin.storage.getSession<ParentSelectorContext>(parentPickContextKey);
      if (!data) return;
      setCtx(data);

      const text = (await safeRemTextToString(plugin, data.extractContent)).trim();
      setExcerpt(text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text);

      if (data.contextRemId) {
        const incRem = await plugin.rem.findOne(data.contextRemId);
        if (incRem) setContextName(await remDisplayName(plugin, incRem));
      }
    };
    init().catch((e) => console.error('[parent_pick_floating] init error', e));
  }, [plugin]);

  // Re-reads the Rem holding the cursor. When focus leaves the editor (e.g. to
  // click this card) there is none, and the last target stays.
  const readFocusedTarget = useCallback(async (): Promise<PickTargetInfo | null> => {
    if (!ctx) return targetRef.current;
    const rem = await plugin.focus.getFocusedRem();
    if (!rem || rem._id === lastFocusedIdRef.current) return targetRef.current;

    lastFocusedIdRef.current = rem._id;
    const info = await describePickTarget(plugin, rem, ctx);
    // A newer focus change may have landed while this one was described.
    if (lastFocusedIdRef.current !== rem._id) return targetRef.current;
    targetRef.current = info;
    setTarget(info);
    setArmedFor(null);
    return info;
  }, [plugin, ctx]);

  useEffect(() => {
    if (!ctx) return;
    const refresh = () => {
      readFocusedTarget().catch((e) => console.error('[parent_pick_floating] focus error', e));
    };
    refresh();
    plugin.event.addListener(AppEvents.FocusedRemChange, undefined, refresh);
    const poll = setInterval(refresh, FOCUS_POLL_MS);
    return () => {
      plugin.event.removeListener(AppEvents.FocusedRemChange, undefined, refresh);
      clearInterval(poll);
    };
  }, [plugin, ctx, readFocusedTarget]);

  const cancel = useCallback(async () => {
    await endParentPick(plugin);
  }, [plugin]);

  const backToList = useCallback(async () => {
    await returnToParentList(plugin);
  }, [plugin]);

  const place = useCallback(async () => {
    if (!ctx || busy) return;
    const info = await readFocusedTarget();
    if (!info) {
      await plugin.app.toast('Put the cursor in the Rem that should become the parent first');
      return;
    }
    if (info.invalidReason) {
      await plugin.app.toast(`Can't place it there: ${info.invalidReason}`);
      return;
    }
    // Outside the IncRem under review: warn on the first confirm, place on the second.
    if (info.insideContext === false && armedFor !== info.remId) {
      setArmedFor(info.remId);
      return;
    }

    setBusy(true);
    try {
      const highlightRem = await plugin.rem.findOne(ctx.extractRemId);
      if (!highlightRem) {
        await plugin.app.toast('Could not find the original highlight');
        setBusy(false);
        return;
      }
      await createRemUnderParent(
        plugin,
        highlightRem,
        info.remId,
        ctx.makeIncremental,
        ctx.pdfRemId,
        ctx.contextRemId,
        info.name,
        ctx.showPriorityPopupAfterCreate === true
      );
      // Closes this card, so it goes last.
      await endParentPick(plugin);
    } catch (e) {
      console.error('[parent_pick_floating] place error', e);
      await plugin.app.toast('Error creating rem');
      setBusy(false);
    }
  }, [plugin, ctx, busy, armedFor, readFocusedTarget]);

  // The confirm command fires in the index widget and asks us through session
  // storage. Only requests made after this card opened count.
  const confirmRequest = useTrackerPlugin(
    (rp) => rp.storage.getSession<number>(parentPickConfirmRequestKey),
    []
  );
  const handledRequestRef = useRef<number | null | undefined>(undefined);
  const placeRef = useRef(place);
  placeRef.current = place;
  useEffect(() => {
    if (handledRequestRef.current === undefined) {
      handledRequestRef.current = confirmRequest ?? null;
      return;
    }
    if (confirmRequest && confirmRequest !== handledRequestRef.current) {
      handledRequestRef.current = confirmRequest;
      placeRef.current();
    }
  }, [confirmRequest]);

  const activate = useCallback(
    (id: ButtonId) => {
      if (id === 'place') place();
      else if (id === 'back') backToList();
      else cancel();
    },
    [place, backToList, cancel]
  );

  // Esc cancels even while the editor has the keyboard: stealKeys routes it to
  // us as a StealKeyEvent keyed by this widget's id. When the card itself has
  // focus, arrows move the ring and Enter presses the ringed button.
  useEffect(() => {
    if (!floatingWidgetId) return;
    plugin.window.stealKeys(floatingWidgetId, ['Escape']).catch(() => {});

    const isEsc = (e: any): boolean => {
      const raw = e?.key ?? e?.code ?? e?.keys ?? e?.data?.key ?? e?.data?.keys ?? '';
      const s = Array.isArray(raw) ? raw.join(',') : String(raw);
      return /esc/i.test(s);
    };
    const onStealKey = (e: any) => {
      if (isEsc(e)) cancel();
    };
    plugin.event.addListener(AppEvents.StealKeyEvent, floatingWidgetId, onStealKey);

    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          cancel();
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          setRing((r) => (r + 1) % BUTTONS.length);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          setRing((r) => (r + BUTTONS.length - 1) % BUTTONS.length);
          break;
        case 'Enter':
          e.preventDefault();
          activate(BUTTONS[ring]);
          break;
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      plugin.event.removeListener(AppEvents.StealKeyEvent, floatingWidgetId, onStealKey);
      document.removeEventListener('keydown', onKeyDown);
      plugin.window.releaseKeys(floatingWidgetId, ['Escape']).catch(() => {});
    };
  }, [floatingWidgetId, plugin, cancel, activate, ring]);

  if (!ctx) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: 'var(--rn-clr-content-secondary)' }}>
          No Rem is waiting for a parent.
        </div>
      </div>
    );
  }

  const armed = !!target && armedFor === target.remId;
  const outside = target?.insideContext === false;

  const buttonStyle = (id: ButtonId, primary = false): React.CSSProperties => ({
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: primary ? 600 : 500,
    borderRadius: 6,
    cursor: busy ? 'not-allowed' : 'pointer',
    whiteSpace: 'nowrap',
    border: primary ? 'none' : '1px solid var(--rn-clr-border-primary)',
    backgroundColor: primary
      ? armed
        ? '#dc2626'
        : '#3b82f6'
      : 'var(--rn-clr-background-secondary)',
    color: primary ? 'white' : 'var(--rn-clr-content-primary)',
    outline: BUTTONS[ring] === id ? '2px solid #93c5fd' : 'none',
    outlineOffset: 1,
  });

  return (
    <div style={cardStyle}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--rn-clr-content-primary)' }}>
          📍 Pick a parent in the editor
        </span>
        <button
          onClick={cancel}
          title="Cancel (Esc)"
          style={{
            border: 'none',
            background: 'transparent',
            fontSize: 16,
            cursor: 'pointer',
            color: 'var(--rn-clr-content-secondary)',
            padding: '0 4px',
          }}
        >
          ×
        </button>
      </div>

      <div style={{ fontSize: 11, color: 'var(--rn-clr-content-secondary)', lineHeight: 1.4 }}>
        New {ctx.makeIncremental ? 'IncRem' : 'Rem'}: <span style={{ fontStyle: 'italic' }}>“{excerpt}”</span>
      </div>

      {/* Target */}
      <div
        style={{
          borderRadius: 6,
          padding: '8px 10px',
          backgroundColor: 'var(--rn-clr-background-secondary)',
          border: `1px solid ${armed ? '#dc2626' : outside ? '#d97706' : 'var(--rn-clr-border-primary)'}`,
        }}
      >
        {target ? (
          <>
            {target.breadcrumb.length > 0 && (
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--rn-clr-content-tertiary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginBottom: 2,
                }}
                title={target.breadcrumb.join(' › ')}
              >
                {target.breadcrumb.join(' › ')}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {target.headingLevel !== null && <HeadingBadge level={target.headingLevel} />}
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--rn-clr-content-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={target.name}
              >
                {target.name}
              </span>
            </div>
            {target.invalidReason ? (
              <div style={{ fontSize: 11, marginTop: 4, color: '#dc2626' }}>✕ {target.invalidReason}</div>
            ) : target.insideContext === true ? (
              <div style={{ fontSize: 11, marginTop: 4, color: '#16a34a' }}>
                ✓ Inside {contextName ?? 'the IncRem under review'}
              </div>
            ) : outside ? (
              <div style={{ fontSize: 11, marginTop: 4, color: armed ? '#dc2626' : '#d97706', lineHeight: 1.4 }}>
                ⚠ Outside {contextName ?? 'the IncRem under review'}.
                {armed && <> Press {CONFIRM_KEYS} again to place it here anyway.</>}
              </div>
            ) : null}
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--rn-clr-content-secondary)' }}>
            Click into the Rem that should become the parent.
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={() => { setRing(0); place(); }}
          disabled={busy || !target}
          style={buttonStyle('place', true)}
          title={`Place the new Rem under the target (${CONFIRM_KEYS})`}
        >
          {busy ? 'Creating…' : armed ? 'Place anyway' : 'Place here'} · {CONFIRM_KEYS}
        </button>
        <button onClick={() => { setRing(1); backToList(); }} style={buttonStyle('back')}>
          Back to list
        </button>
        <button onClick={() => { setRing(2); cancel(); }} style={buttonStyle('cancel')}>
          Cancel
        </button>
      </div>

      <div style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary)', lineHeight: 1.4 }}>
        Expand, collapse and navigate freely: nothing is placed until {CONFIRM_KEYS}. Esc cancels.
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  backgroundColor: 'var(--rn-clr-background-primary)',
  border: '1px solid var(--rn-clr-border-primary)',
  borderRadius: 10,
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

renderWidget(ParentPickFloating);
