import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useState } from 'react';
import '../style.css';
import '../App.css';
import {
  OUTLINE_SNAPSHOT_KEY,
  OutlineSnapshot,
  revertSnapshot,
} from '../lib/outline_restructure';

export const OutlineRestructureUndo = () => {
  const plugin = usePlugin();
  // Tracks the snapshot reactively from session storage so the widget appears
  // immediately after a restructure and disappears after revert / dismiss.
  const snapshot = useTrackerPlugin(
    async (rp) =>
      (await rp.storage.getSession<OutlineSnapshot>(OUTLINE_SNAPSHOT_KEY)) ||
      null,
    []
  );

  const [reverting, setReverting] = useState(false);

  if (!snapshot) return null;

  const onUndo = async () => {
    if (reverting) return;
    setReverting(true);
    try {
      await revertSnapshot(plugin, snapshot);
      await plugin.storage.setSession(OUTLINE_SNAPSHOT_KEY, undefined);
      await plugin.app.toast('Outline restructure reverted.');
    } catch (e) {
      console.error('[outline-restructure] revert failed:', e);
      await plugin.app.toast(`Revert failed: ${(e as any)?.message ?? e}`);
    } finally {
      setReverting(false);
    }
  };

  // Deliberate close = dismiss. Clear the snapshot from session storage so the
  // banner stays gone across widget remounts (volatile component state would
  // reset on remount and let it reappear). The next restructure overwrites the
  // key and brings the banner back for that new snapshot.
  const onDismiss = () =>
    plugin.storage.setSession(OUTLINE_SNAPSHOT_KEY, undefined);

  const movedCount = snapshot.ops.length;
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
    <div
      style={containerStyle}
      className="flex flex-col gap-2 p-3 rounded-lg mb-2"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 16 }}>↩</span>
          <span className="font-semibold text-sm">Outline Restructured</span>
        </div>
        <button
          onClick={onDismiss}
          className="hover:opacity-75"
          style={{ color: 'var(--rn-clr-content-tertiary)' }}
          title="Dismiss this notification (does not undo the restructure)"
        >
          ✕
        </button>
      </div>

      <div
        className="text-xs"
        style={{ color: 'var(--rn-clr-content-secondary)' }}
      >
        <span className="font-bold">{movedCount}</span>{' '}
        rem{movedCount === 1 ? '' : 's'} moved in{' '}
        <span style={{ fontStyle: 'italic' }}>{snapshot.scopeRootText}</span>{' '}
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
        {reverting ? 'Reverting…' : 'Undo Restructure'}
      </button>
    </div>
  );
};

renderWidget(OutlineRestructureUndo);
