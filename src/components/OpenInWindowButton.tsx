import { AppEvents, usePlugin, ReactRNPlugin } from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { followQueueBarIdKey } from '../lib/consts';
import { isQueueFollowed } from '../lib/follow_queue_sources';
import {
  canOpenInAnotherWindow,
  cancelOpenRequest,
  isOpenRequestClaimed,
  isQueueUrl,
  OPEN_REQUEST_TTL_MS,
  requestFollowInAnotherWindow,
  requestOpenInAnotherWindow,
} from '../lib/open_in_window';
import { getOperatingSystem } from '../lib/mobileUtils';

const CLAIM_POLL_MS = 1000;

type Status = 'idle' | 'waiting' | 'opened';

/** Shared by the Source viewer's header buttons, so the two-line one matches the others. */
export const HEADER_BUTTON_HEIGHT = 28;

const BUTTON_STYLE: React.CSSProperties = {
  height: HEADER_BUTTON_HEIGHT,
  padding: '0 10px',
  fontSize: '12px',
  fontWeight: 600,
  backgroundColor: 'transparent',
  color: 'var(--rn-clr-content-secondary)',
  border: '2px solid var(--rn-clr-content-tertiary, #6b7280)',
  borderRadius: '4px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

/** A request left for another window (lib/open_in_window.ts): sends it, watches for a window taking it, cancels it. */
function useWindowRequest(send: (plugin: ReactRNPlugin) => Promise<string>) {
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
      requestId.current = await send(plugin);
      setStatus('waiting');
    } catch (e) {
      console.error('[OpenInWindowButton] request failed', e);
      await plugin.app.toast('Could not reach the other windows. Reload the plugin and try again.');
    }
  }, [plugin, status, send]);

  return { plugin, available, newWindowKeys, status, setStatus, onClick };
}

/** Hands the source to another RemNote window (lib/open_in_window.ts). Desktop only. */
export function OpenInWindowButton({
  remId,
  highlightRemId,
}: {
  remId: string;
  highlightRemId: string | null;
}) {
  const send = useCallback(
    (plugin: ReactRNPlugin) => requestOpenInAnotherWindow(plugin, remId, highlightRemId),
    [remId, highlightRemId]
  );
  const { available, newWindowKeys, status, onClick } = useWindowRequest(send);

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
    <button onClick={onClick} title={title} style={BUTTON_STYLE}>
      {label}
    </button>
  );
}

/** Makes another RemNote window follow the queue (lib/follow_queue_sources.ts). Desktop only, and only over an open queue. */
export function FollowQueueButton() {
  const { plugin, available, newWindowKeys, status, setStatus, onClick } =
    useWindowRequest(requestFollowInAnotherWindow);
  const [inQueue, setInQueue] = useState(false);
  // This window is the follower, so "another window" has no meaning here.
  const [isFollower, setIsFollower] = useState(false);

  useEffect(() => {
    plugin.storage.getSession<string>(followQueueBarIdKey).then((id) => setIsFollower(!!id));
    isQueueFollowed(plugin).then((followed) => {
      if (followed) setStatus('opened');
    });
  }, [plugin, setStatus]);

  useEffect(() => {
    const check = () => plugin.window.getURL().then((url) => setInQueue(isQueueUrl(url)));
    check();
    plugin.event.addListener(AppEvents.URLChange, undefined, check);
    return () => plugin.event.removeListener(AppEvents.URLChange, undefined, check);
  }, [plugin]);

  if (!available || isFollower || !inQueue) return null;

  const [firstLine, secondLine] =
    status === 'waiting'
      ? [`⏳ Waiting: ${newWindowKeys}`, 'for a new window']
      : status === 'opened'
        ? ['✅ Following the Queue', 'in another window']
        : ['🧭 Follow the Queue', 'in another window'];
  const title =
    status === 'waiting'
      ? `Another open RemNote window will follow the queue. If none is open, press ${newWindowKeys}. Click to cancel.`
      : status === 'opened'
        ? 'Another RemNote window shows the sources of the queue\'s cards. Use Stop on its bar to end this.'
        : "Show the sources of the queue's cards in another RemNote window";

  return (
    <button
      onClick={status === 'opened' ? undefined : onClick}
      title={title}
      style={{ ...BUTTON_STYLE, lineHeight: 1, cursor: status === 'opened' ? 'default' : 'pointer' }}
    >
      <span style={{ display: 'block', fontSize: '11px' }}>{firstLine}</span>
      <span style={{ display: 'block', fontSize: '8.5px', marginTop: '1px' }}>{secondLine}</span>
    </button>
  );
}
