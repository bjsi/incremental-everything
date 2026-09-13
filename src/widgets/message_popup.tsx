import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { MessageDialog } from '../lib/message_dialog';

/** The Enter that ran a command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;

/** A plain message dialog (lib/message_dialog.ts): one OK button, Enter or Esc closes it. */
export function MessagePopup() {
  const plugin = usePlugin();
  const [dialog, setDialog] = useState<MessageDialog | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(Date.now());

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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current >= ENTER_GRACE_MS) close();
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
          Enter or Esc to close
        </span>
        <button
          onClick={close}
          onMouseDown={(e) => e.preventDefault()}
          className="py-1.5 px-4 text-sm font-medium rounded"
          style={{
            background: '#3B82F6',
            color: 'white',
            border: 'none',
            cursor: 'pointer',
            outline: '2px solid var(--rn-clr-border-accent, #3B82F6)',
            outlineOffset: '2px',
          }}
        >
          OK
        </button>
      </div>
    </div>
  );
}

/** Title, message, quoted passage and detail — shared with popups that report a failure inline. */
export function MessageBody({ dialog }: { dialog: MessageDialog | null }) {
  if (!dialog) return null;
  return (
    <>
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 18 }}>{dialog.tone === 'error' ? '⚠️' : 'ℹ️'}</span>
        <span className="font-semibold text-base">{dialog.title}</span>
      </div>
      <div className="text-sm">{dialog.message}</div>
      {dialog.quote && (
        <div
          className="text-xs italic p-2 rounded"
          style={{ background: 'var(--rn-clr-background-elevation-10)', color: 'var(--rn-clr-content-secondary)' }}
        >
          {dialog.quote}
        </div>
      )}
      {dialog.detail && (
        <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          {dialog.detail}
        </div>
      )}
    </>
  );
}

renderWidget(MessagePopup);
