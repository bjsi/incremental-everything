import { useEffect, useState } from 'react';
import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  useSessionStorageState,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import { isNativeVideoRem, readNativeVideoInfo } from '../lib/native_video';
import { videoPaneProbeSessionKey } from '../lib/consts';

// Probe for the Incremental Video redesign: does a PaneHeader widget stay on
// screen on RemNote's video page, where the editor review timer is not shown?
// Renders nothing unless switched on from the Debug Video Detection popup.
function VideoPaneProbe() {
  const plugin = usePlugin();
  const [on] = useSessionStorageState<boolean>(videoPaneProbeSessionKey, false);
  const ctx = useRunAsync(async () => await plugin.widget.getWidgetContext<WidgetLocation.PaneHeader>(), []);
  const paneId = ctx?.paneId;

  // getOpenPaneRemId is not reactive, so poll while the probe is on.
  const [remId, setRemId] = useState<string | undefined>();
  useEffect(() => {
    if (!on || !paneId) return;
    let alive = true;
    const tick = async () => {
      const id = await plugin.window.getOpenPaneRemId(paneId).catch(() => undefined);
      if (alive) setRemId(id);
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [on, paneId]);

  const info = useTrackerPlugin(
    async (rp) => {
      if (!on || !remId) return null;
      const rem = await rp.rem.findOne(remId);
      if (!rem) return null;
      const name = (await rp.richText.toString(rem.text || [])).slice(0, 24);
      const isVideo = await isNativeVideoRem(rem);
      return { name, isVideo, last: isVideo ? (await readNativeVideoInfo(rem)).lastWatchedTime : undefined };
    },
    [on, remId]
  );

  if (!on) return null;
  return (
    <div
      style={{
        fontSize: 11,
        whiteSpace: 'nowrap',
        padding: '2px 6px',
        borderRadius: 4,
        background: '#fef3c7',
        color: '#78350f',
      }}
    >
      🧪 {info?.name ?? remId ?? 'no rem'}
      {info?.isVideo ? ` · vi · ip.l ${info.last?.toFixed(0) ?? '—'} s` : info ? ' · not a video' : ''}
    </div>
  );
}

renderWidget(VideoPaneProbe);
