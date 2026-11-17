import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { MessageDialog } from '../lib/message_dialog';
import { MessageBody } from '../components/MessageBody';

/** The Enter that ran a command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;

const ring: React.CSSProperties = {
  outline: '2px solid var(--rn-clr-border-accent, #3B82F6)',
  outlineOffset: '2px',
};

/**
 * A plain message dialog (lib/message_dialog.ts): an OK button, Enter or Esc closes it.
 * With `openRemId`, an "Open Rem" button too, reached with ←→. OK keeps the ring at
 * first: an Enter typed for something else must not navigate away (from the queue, say).
 */
export function MessagePopup() {
  const plugin = usePlugin();
  const [dialog, setDialog] = useState<MessageDialog | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(Date.now());
  const [selected, setSelected] = useState<'ok' | 'open'>('ok');

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      setDialog((ctx?.contextData?.dialog as MessageDialog) ?? null);
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

  const close = () => plugin.widget.closePopup();

  const openRemId = dialog?.openRemId;
  const openRem = async () => {
    if (!openRemId) return;
    const rem = await plugin.rem.findOne(openRemId);
    if (rem) await plugin.window.openRem(rem);
    else await plugin.app.toast('That Rem no longer exists.');
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (openRemId && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setSelected((s) => (s === 'ok' ? 'open' : 'ok'));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current < ENTER_GRACE_MS) return;
      if (selected === 'open') void openRem();
      else close();
    }
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{ outline: 'none', color: 'var(--rn-clr-content-primary)' }}
    >
      <MessageBody dialog={dialog} />
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
          {openRemId ? '←→ choose · Enter confirm · Esc close' : 'Enter or Esc to close'}
        </span>
        <div className="flex items-center gap-3">
          {openRemId && (
            <button
              onClick={() => void openRem()}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSelected('open')}
              className="py-1.5 px-4 text-sm font-medium rounded"
              style={{
                background: 'var(--rn-clr-background-secondary)',
                color: 'var(--rn-clr-content-primary)',
                border: 'none',
                cursor: 'pointer',
                ...(selected === 'open' ? ring : { outline: 'none' }),
              }}
            >
              Open Rem
            </button>
          )}
          <button
            onClick={close}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setSelected('ok')}
            className="py-1.5 px-4 text-sm font-medium rounded"
            style={{
              background: '#3B82F6',
              color: 'white',
              border: 'none',
              cursor: 'pointer',
              ...(selected === 'ok' ? ring : { outline: 'none' }),
            }}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

renderWidget(withHoverTips(MessagePopup));
