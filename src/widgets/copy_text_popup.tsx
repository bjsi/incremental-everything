import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';

/** The Enter that ran a command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;

/**
 * Fallback for lib/clipboard.ts when the Local Media Bridge is not available.
 * Plugin iframes cannot write the clipboard on their own, but a key pressed
 * inside this popup lets execCommand('copy') through: ⌘C / Ctrl+C or Enter
 * copies the pre-selected text and closes; Esc closes without copying.
 */
export function CopyTextPopup() {
  const plugin = usePlugin();
  const [text, setText] = useState<string | null>(null);
  const [label, setLabel] = useState('text');
  const [toast, setToast] = useState('📋 Copied');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      setText((ctx?.contextData?.text as string) ?? '');
      setLabel((ctx?.contextData?.label as string) ?? 'text');
      if (ctx?.contextData?.toast) setToast(ctx.contextData.toast as string);
    })();
  }, []);

  // Win focus against RemNote settling it after the popup opens, then select.
  useEffect(() => {
    if (text === null) return;
    let tries = 0;
    const timer = setInterval(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.select();
      if (document.activeElement === area || ++tries >= 8) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, [text]);

  const close = () => plugin.widget.closePopup();

  const copied = async () => {
    await plugin.app.toast(toast);
    await close();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current < ENTER_GRACE_MS) return;
      e.currentTarget.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      // On success the textarea's onCopy confirms and closes.
      if (!ok) plugin.app.toast('Copy failed — press ⌘C / Ctrl+C instead.');
    }
  };

  const rows = Math.min(8, Math.max(1, (text ?? '').split('\n').length));

  return (
    <div className="flex flex-col gap-2 p-4" style={{ color: 'var(--rn-clr-content-primary)' }}>
      <div className="text-sm font-medium">Copy the {label}</div>
      <textarea
        ref={areaRef}
        readOnly
        value={text ?? ''}
        rows={rows}
        onKeyDown={onKeyDown}
        // The native copy has already run when this fires.
        onCopy={() => setTimeout(copied, 0)}
        className="w-full p-2 rounded text-sm"
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          resize: 'none',
          background: 'var(--rn-clr-background-secondary)',
          color: 'var(--rn-clr-content-primary)',
          border: '1px solid var(--rn-clr-border-opaque)',
          outline: '2px solid var(--rn-clr-border-accent, #3B82F6)',
          outlineOffset: '1px',
        }}
      />
      <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
        Enter or ⌘C / Ctrl+C to copy · Esc to cancel
      </span>
    </div>
  );
}

renderWidget(withHoverTips(CopyTextPopup));
