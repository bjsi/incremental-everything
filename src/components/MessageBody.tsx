import React from 'react';
import { MessageDialog } from '../lib/message_dialog';

/**
 * Title, message, quoted passage and detail of a MessageDialog — shared by the
 * message popup and by popups that report a failure inline.
 *
 * Lives here rather than in widgets/message_popup.tsx on purpose: a widget file
 * calls renderWidget() when it loads, so importing anything from one starts that
 * widget inside the importing popup too (the wrong popup renders, then React
 * error #40 on unmount).
 */
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
