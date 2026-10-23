import { useEffect, useState } from 'react';
import { renderWidget, usePlugin, useTrackerPlugin, useSessionStorageState } from '@remnote/plugin-sdk';
import { isNativeVideoRem, readNativeVideoInfo } from '../lib/native_video';
import { videoFloatingProbeIdKey } from '../lib/consts';

// Probe for the Incremental Video redesign: can a floating widget carry the
// review controls over RemNote's video page? (A PaneHeader widget can't: the
// video page's header doesn't host them.) Opened from the Debug Video
// Detection popup.
function VideoFloatingProbe() {
  const plugin = usePlugin();
  const [floatingId, setFloatingId] = useSessionStorageState<string | null>(videoFloatingProbeIdKey, null);
  const [clicks, setClicks] = useState(0);

  // getOpenPaneRemIds is not reactive, so poll.
  const [paneRemIds, setPaneRemIds] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const ids = await plugin.window.getOpenPaneRemIds().catch(() => []);
      if (alive) setPaneRemIds((prev) => (prev.join() === ids.join() ? prev : ids));
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const video = useTrackerPlugin(
    async (rp) => {
      for (const id of paneRemIds) {
        const rem = await rp.rem.findOne(id);
        if (rem && (await isNativeVideoRem(rem))) {
          const name = (await rp.richText.toString(rem.text || [])).slice(0, 28);
          return { name, last: (await readNativeVideoInfo(rem)).lastWatchedTime };
        }
      }
      return null;
    },
    [paneRemIds.join()]
  );

  const close = async () => {
    if (floatingId) await plugin.window.closeFloatingWidget(floatingId);
    await setFloatingId(null);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        whiteSpace: 'nowrap',
        padding: '6px 10px',
        borderRadius: 8,
        background: '#fef3c7',
        color: '#78350f',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      }}
    >
      <span>
        🧪 {video ? `${video.name} · ip.l ${video.last?.toFixed(1) ?? '—'} s` : 'no RemNote video in an open pane'}
      </span>
      <button onClick={() => setClicks(clicks + 1)} style={{ cursor: 'pointer' }}>
        test click ({clicks})
      </button>
      <button onClick={close} style={{ cursor: 'pointer' }}>
        ✕
      </button>
    </div>
  );
}

renderWidget(VideoFloatingProbe);
