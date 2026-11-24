// widgets/history_move_floating.tsx
//
// The card shown while a Repetition History record waits for the Rem that gets
// its time (lib/history_move_pick.ts). It follows the Rem holding the editing
// cursor, says whether that Rem can take the time, lets the user move only part
// of it, and moves when the user confirms — with ⌥⇧↵ (the Confirm Pick in
// Editor command, which bumps historyMoveConfirmRequestKey) or its own button.
// The move itself is moveHistoryEntryTime (lib/history_edit.ts): neither Rem's
// schedule changes.

import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  AppEvents,
  ReactRNPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { withHoverTips } from '../components/HoverTipLayer';
import '../rn_theme_vars.css';
import { historyMoveConfirmRequestKey, historyMoveContextKey } from '../lib/consts';
import {
  endHistoryMove,
  HistoryMoveContext,
  remBreadcrumb,
  returnToHistory,
} from '../lib/history_move_pick';
import { checkMoveTarget, moveHistoryEntryTime, MoveTarget } from '../lib/history_edit';
import { formatDuration } from '../lib/utils';

// The focus event is the main signal; this poll only covers a missed one.
const FOCUS_POLL_MS = 1000;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const CONFIRM_KEYS = isMac ? '⌥⇧↵' : 'Alt+Shift+Enter';

type ButtonId = 'move' | 'back' | 'cancel';
const BUTTONS: ButtonId[] = ['move', 'back', 'cancel'];

interface TargetInfo extends MoveTarget {
  remId: string;
  breadcrumb: string[];
}

/** Minutes as typed ("20", "12.5", "1h 20", "1:20") → seconds, or NaN. */
function parseMinutes(text: string): number {
  const t = text.trim().toLowerCase();
  if (!t) return NaN;
  const colon = /^(\d+):(\d{1,2})$/.exec(t);
  if (colon) return (Number(colon[1]) * 60 + Number(colon[2])) * 60;
  const hm = /^(?:(\d+(?:[.,]\d+)?)\s*h)?\s*(?:(\d+(?:[.,]\d+)?)\s*m?(?:in)?)?$/.exec(t);
  if (!hm || (!hm[1] && !hm[2])) return NaN;
  const hours = hm[1] ? Number(hm[1].replace(',', '.')) : 0;
  const minutes = hm[2] ? Number(hm[2].replace(',', '.')) : 0;
  return Math.round((hours * 60 + minutes) * 60);
}

export function HistoryMoveFloating() {
  const plugin = usePlugin() as ReactRNPlugin;

  const [ctx, setCtx] = useState<HistoryMoveContext | null>(null);
  const [floatingWidgetId, setFloatingWidgetId] = useState<string | null>(null);
  const [target, setTarget] = useState<TargetInfo | null>(null);
  // Untouched = move all of it, to the second.
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ring, setRing] = useState(0);

  const targetRef = useRef<TargetInfo | null>(null);
  targetRef.current = target;
  const lastFocusedIdRef = useRef<string | null>(null);

  const available = ctx?.entry.reviewTimeSeconds ?? 0;

  useEffect(() => {
    const init = async () => {
      const wctx = await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>();
      setFloatingWidgetId(wctx?.floatingWidgetId ?? null);
      const data = await plugin.storage.getSession<HistoryMoveContext>(historyMoveContextKey);
      if (!data) return;
      setCtx(data);
      setAmount(String(Math.round((data.entry.reviewTimeSeconds ?? 0) / 60)));
    };
    init().catch((e) => console.error('[history_move_floating] init error', e));
  }, [plugin]);

  // Re-reads the Rem holding the cursor. When focus leaves the editor (e.g. to
  // type in this card) there is none, and the last target stays.
  const readFocusedTarget = useCallback(async (): Promise<TargetInfo | null> => {
    if (!ctx) return targetRef.current;
    const rem = await plugin.focus.getFocusedRem();
    if (!rem || rem._id === lastFocusedIdRef.current) return targetRef.current;

    lastFocusedIdRef.current = rem._id;
    const [check, breadcrumb] = await Promise.all([
      checkMoveTarget(plugin, ctx.sourceRemId, rem._id),
      remBreadcrumb(plugin, rem),
    ]);
    // A newer focus change may have landed while this one was described.
    if (lastFocusedIdRef.current !== rem._id) return targetRef.current;
    const info: TargetInfo = { ...check, remId: rem._id, breadcrumb };
    targetRef.current = info;
    setTarget(info);
    setError(null);
    return info;
  }, [plugin, ctx]);

  useEffect(() => {
    if (!ctx) return;
    const refresh = () => {
      readFocusedTarget().catch((e) => console.error('[history_move_floating] focus error', e));
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
    await endHistoryMove(plugin);
  }, [plugin]);

  const backToHistory = useCallback(async () => {
    await returnToHistory(plugin);
  }, [plugin]);

  const move = useCallback(async () => {
    if (!ctx || busy) return;
    const info = await readFocusedTarget();
    if (!info) {
      setError('Put the cursor in the Rem that should get the time first.');
      return;
    }
    if (!info.ok) {
      setError(info.error ?? 'That Rem cannot take the time.');
      return;
    }

    let seconds: number | undefined;
    if (amountTouched) {
      const parsed = parseMinutes(amount);
      if (!(parsed > 0)) {
        setError('Enter the minutes to move, e.g. 20 or 1h 5.');
        return;
      }
      // Typing the whole amount (rounded) back in still means "all of it".
      seconds = parsed >= available - 30 ? undefined : parsed;
      if (parsed > available + 30) {
        setError(`This record holds ${formatDuration(available)}.`);
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      const result = await moveHistoryEntryTime(plugin, ctx.sourceRemId, ctx.entry, info.remId, seconds, ctx.index);
      if (!result.ok) {
        setError(result.error ?? 'Could not move the record.');
        setBusy(false);
        return;
      }
      await plugin.app.toast(
        `↪ Moved ${formatDuration(result.movedSeconds ?? 0)} to "${result.targetName}" — schedules unchanged`
      );
      // Closes this card, so it goes last.
      await endHistoryMove(plugin);
    } catch (e) {
      console.error('[history_move_floating] move error', e);
      setError(String(e));
      setBusy(false);
    }
  }, [plugin, ctx, busy, amount, amountTouched, available, readFocusedTarget]);

  // The confirm command fires in the index widget and asks us through session
  // storage. Only requests made after this card opened count.
  const confirmRequest = useTrackerPlugin(
    (rp) => rp.storage.getSession<number>(historyMoveConfirmRequestKey),
    []
  );
  const handledRequestRef = useRef<number | null | undefined>(undefined);
  const moveRef = useRef(move);
  moveRef.current = move;
  useEffect(() => {
    if (handledRequestRef.current === undefined) {
      handledRequestRef.current = confirmRequest ?? null;
      return;
    }
    if (confirmRequest && confirmRequest !== handledRequestRef.current) {
      handledRequestRef.current = confirmRequest;
      moveRef.current();
    }
  }, [confirmRequest]);

  const activate = useCallback(
    (id: ButtonId) => {
      if (id === 'move') move();
      else if (id === 'back') backToHistory();
      else cancel();
    },
    [move, backToHistory, cancel]
  );

  // Esc cancels even while the editor has the keyboard: stealKeys routes it to
  // us as a StealKeyEvent keyed by this widget's id. When the card itself has
  // focus, arrows move the ring and Enter presses the ringed button — except in
  // the minutes field, where arrows and Enter belong to the field (Enter moves).
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
      const inField = (e.target as HTMLElement | null)?.tagName === 'INPUT';
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          cancel();
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          if (inField) return;
          e.preventDefault();
          setRing((r) => (r + 1) % BUTTONS.length);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          if (inField) return;
          e.preventDefault();
          setRing((r) => (r + BUTTONS.length - 1) % BUTTONS.length);
          break;
        case 'Enter':
          e.preventDefault();
          if (inField) move();
          else activate(BUTTONS[ring]);
          break;
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      plugin.event.removeListener(AppEvents.StealKeyEvent, floatingWidgetId, onStealKey);
      document.removeEventListener('keydown', onKeyDown);
      plugin.window.releaseKeys(floatingWidgetId, ['Escape']).catch(() => {});
    };
  }, [floatingWidgetId, plugin, cancel, activate, move, ring]);

  if (!ctx) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: 'var(--rn-clr-content-secondary)' }}>
          No history record is waiting to be moved.
        </div>
      </div>
    );
  }

  const entry = ctx.entry;
  const invalid = !!target && !target.ok;

  const buttonStyle = (id: ButtonId, primary = false): React.CSSProperties => ({
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: primary ? 600 : 500,
    borderRadius: 6,
    cursor: busy ? 'not-allowed' : 'pointer',
    whiteSpace: 'nowrap',
    border: primary ? 'none' : '1px solid var(--rn-clr-border-primary)',
    backgroundColor: primary ? '#3b82f6' : 'var(--rn-clr-background-secondary)',
    color: primary ? 'white' : 'var(--rn-clr-content-primary)',
    opacity: primary && (invalid || !target) ? 0.6 : 1,
    outline: BUTTONS[ring] === id ? '2px solid #93c5fd' : 'none',
    outlineOffset: 1,
  });

  return (
    <div style={cardStyle}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--rn-clr-content-primary)' }}>
          ↪ Move a record's time to another Rem
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

      {/* The record */}
      <div style={{ fontSize: 11, color: 'var(--rn-clr-content-secondary)', lineHeight: 1.45 }}>
        <div>
          {dayjs(entry.date).format('MMM D, YYYY HH:mm')} · <strong>{formatDuration(available) || '0s'}</strong>
          {' '}on <span style={{ fontStyle: 'italic' }}>{ctx.sourceName}</span>
        </div>
        {entry.notes && (
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.notes}>
            📝 {entry.notes}
          </div>
        )}
      </div>

      {/* Target */}
      <div
        style={{
          borderRadius: 6,
          padding: '8px 10px',
          backgroundColor: 'var(--rn-clr-background-secondary)',
          border: `1px solid ${invalid ? '#dc2626' : 'var(--rn-clr-border-primary)'}`,
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
            <div
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
            </div>
            {target.ok ? (
              <div style={{ fontSize: 11, marginTop: 4, color: '#16a34a' }}>
                ✓ {target.kind === 'dismissed' ? 'Dismissed Rem' : 'Incremental Rem'}
                {target.nextRepDate ? ` · due ${dayjs(target.nextRepDate).format('MMM D')}` : ''}
                {' '}— its schedule stays as it is
              </div>
            ) : (
              <div style={{ fontSize: 11, marginTop: 4, color: '#dc2626', lineHeight: 1.4 }}>✕ {target.error}</div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--rn-clr-content-secondary)' }}>
            Click into the Rem you actually studied.
          </div>
        )}
      </div>

      {/* How much */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--rn-clr-content-primary)' }}>
        Move
        <input
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setAmountTouched(true);
            setError(null);
          }}
          style={{
            width: 56,
            padding: '3px 6px',
            fontSize: 12,
            borderRadius: 4,
            border: '1px solid var(--rn-clr-border-primary)',
            backgroundColor: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
          }}
        />
        <span style={{ color: 'var(--rn-clr-content-secondary)' }}>
          min of {formatDuration(available) || '0s'}
        </span>
      </label>

      {error && <div style={{ fontSize: 11, color: '#dc2626', lineHeight: 1.4 }}>{error}</div>}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={() => { setRing(0); move(); }}
          disabled={busy || !target}
          style={buttonStyle('move', true)}
          title={`Move the time to the Rem with the cursor (${CONFIRM_KEYS})`}
        >
          {busy ? 'Moving…' : 'Move here'} · {CONFIRM_KEYS}
        </button>
        <button onClick={() => { setRing(1); backToHistory(); }} style={buttonStyle('back')}>
          Back to history
        </button>
        <button onClick={() => { setRing(2); cancel(); }} style={buttonStyle('cancel')}>
          Cancel
        </button>
      </div>

      <div style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary)', lineHeight: 1.4 }}>
        Expand, collapse and navigate freely: nothing moves until {CONFIRM_KEYS}. The record keeps its place in
        this Rem's schedule; only its time goes. Esc cancels.
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

renderWidget(withHoverTips(HistoryMoveFloating));
