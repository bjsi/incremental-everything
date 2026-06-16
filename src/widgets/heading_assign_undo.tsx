import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useState } from 'react';
import '../style.css';
import '../App.css';
import {
  HEADING_SNAPSHOT_KEY,
  HeadingSnapshot,
  revertHeadingSnapshot,
} from '../lib/heading_assign';

export const HeadingAssignUndo = () => {
  const plugin = usePlugin();
  // Reactively track the snapshot from session storage so the banner appears
  // right after an apply and disappears on revert / dismiss.
  const snapshot = useTrackerPlugin(
    async (rp) =>
      (await rp.storage.getSession<HeadingSnapshot>(HEADING_SNAPSHOT_KEY)) || null,
    []
  );

  const [reverting, setReverting] = useState(false);

  if (!snapshot) return null;

  const onUndo = async () => {
    if (reverting) return;
    setReverting(true);
    try {
      await revertHeadingSnapshot(plugin, snapshot);
      await plugin.storage.setSession(HEADING_SNAPSHOT_KEY, undefined);
      await plugin.app.toast('Heading levels reverted.');
    } catch (e) {
      console.error('[heading-assign] revert failed:', e);
      await plugin.app.toast(`Revert failed: ${(e as any)?.message ?? e}`);
    } finally {
      setReverting(false);
    }
  };

  // Deliberate close = dismiss. Clearing the snapshot keeps the banner gone
  // across widget remounts (volatile state would let it reappear). The next
  // apply overwrites the key and brings the banner back.
  const onDismiss = () =>
    plugin.storage.setSession(HEADING_SNAPSHOT_KEY, undefined);

  const changedCount = snapshot.ops.length;
  const when = new Date(snapshot.timestamp);
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');

  const containerStyle: React.CSSProperties = {
    backgroundColor: 'var(--rn-clr-background-elevation-10)',
    border: '1px solid var(--rn-clr-border-subtle)',
    color: 'var(--rn-clr-content-primary)',
    boxShadow: 'var(--rn-box-shadow-1)',
  };

  return (
    <div style={containerStyle} className="flex flex-col gap-2 p-3 rounded-lg mb-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 16 }}>↩</span>
          <span className="font-semibold text-sm">Heading Levels Applied</span>
        </div>
        <button
          onClick={onDismiss}
          className="hover:opacity-75"
          style={{ color: 'var(--rn-clr-content-tertiary)' }}
          title="Dismiss this notification (does not undo the change)"
        >
          ✕
        </button>
      </div>

      <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
        <span className="font-bold">{changedCount}</span>{' '}
        rem{changedCount === 1 ? '' : 's'} changed in{' '}
        <span style={{ fontStyle: 'italic' }}>{snapshot.scopeText}</span>{' '}
        at {hh}:{mm}.
      </div>

      <button
        onClick={onUndo}
        disabled={reverting}
        className="w-full py-1 px-2 text-white text-sm font-medium rounded transition-colors"
        style={{
          background: reverting ? '#94a3b8' : '#ef4444',
          cursor: reverting ? 'not-allowed' : 'pointer',
          border: 'none',
        }}
      >
        {reverting ? 'Reverting…' : 'Undo Heading Changes'}
      </button>
    </div>
  );
};

renderWidget(HeadingAssignUndo);
