import { usePlugin, ReactRNPlugin } from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  canOpenInAnotherWindow,
  cancelOpenRequest,
  isOpenRequestClaimed,
  OPEN_REQUEST_TTL_MS,
  requestOpenInAnotherWindow,
} from '../lib/open_in_window';
import { getOperatingSystem } from '../lib/mobileUtils';

const CLAIM_POLL_MS = 1000;

type Status = 'idle' | 'waiting' | 'opened';

/** Hands the source to another RemNote window (lib/open_in_window.ts). Desktop only. */
export function OpenInWindowButton({
  remId,
  highlightRemId,
}: {
  remId: string;
  highlightRemId: string | null;
}) {
  const plugin = usePlugin() as ReactRNPlugin;
  const [available, setAvailable] = useState(false);
  const [newWindowKeys, setNewWindowKeys] = useState('Ctrl+Shift+N');
  const [status, setStatus] = useState<Status>('idle');
  const requestId = useRef<string | null>(null);

  useEffect(() => {
    canOpenInAnotherWindow(plugin).then(setAvailable);
    getOperatingSystem(plugin).then((os) => {
      if (os === 'mac') setNewWindowKeys('⌘⇧N');
    });
  }, [plugin]);

  // Watch for a window taking the request, until the request expires.
  useEffect(() => {
    if (status !== 'waiting') return;
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      const id = requestId.current;
      if (id && (await isOpenRequestClaimed(plugin, id))) {
        setStatus('opened');
      } else if (Date.now() - startedAt > OPEN_REQUEST_TTL_MS) {
        setStatus('idle');
      }
    }, CLAIM_POLL_MS);
    return () => clearInterval(timer);
  }, [status, plugin]);

  const onClick = useCallback(async () => {
    if (status === 'waiting') {
      setStatus('idle');
      if (requestId.current) await cancelOpenRequest(plugin, requestId.current);
      return;
    }
    try {
      requestId.current = await requestOpenInAnotherWindow(plugin, remId, highlightRemId);
      setStatus('waiting');
    } catch (e) {
      console.error('[OpenInWindowButton] request failed', e);
      await plugin.app.toast('Could not reach the other windows. Reload the plugin and try again.');
    }
  }, [plugin, status, remId, highlightRemId]);

  if (!available) return null;

  const label =
    status === 'waiting'
      ? `⏳ Waiting: ${newWindowKeys} for a new window`
      : status === 'opened'
        ? '✅ Opened in the other window'
        : '🪟 Open in Another Window';
  const title =
    status === 'waiting'
      ? `Another open RemNote window will show this source. If none is open, press ${newWindowKeys}. Click to cancel.`
      : status === 'opened'
        ? 'This source is open in another RemNote window. Click to send it again.'
        : 'Show this source in another RemNote window';

  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: '4px 10px',
        fontSize: '12px',
        fontWeight: 600,
        backgroundColor: 'transparent',
        color: 'var(--rn-clr-content-secondary)',
        border: '2px solid var(--rn-clr-content-tertiary, #6b7280)',
        borderRadius: '4px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
