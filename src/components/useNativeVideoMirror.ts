import { RemId, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { getNativeVideoPosition, setPluginVideoPosition } from '../lib/video_position';

// ip.l is written every 3 s while playing; smaller moves aren't worth a write.
const MIN_MOVE_SECONDS = 2;

/**
 * RemNote's player position for a video Rem (`ip.l`, live), copied into the
 * plugin's position for `url` while `enabled`. Zero is skipped: the page very
 * likely resets ip.l to 0 when it opens, before anything is played.
 * `mirrored` is the last position written, which a caller that writes ip.l
 * itself sets so that its own write isn't copied back.
 */
export function useNativeVideoMirror(remId: RemId | undefined, url: string | undefined, enabled: boolean) {
  const plugin = usePlugin();
  const mirrored = React.useRef<number | undefined>();

  React.useEffect(() => {
    mirrored.current = undefined;
  }, [remId]);

  const position = useTrackerPlugin(
    async (rp) => {
      if (!remId) return undefined;
      const rem = await rp.rem.findOne(remId);
      return rem ? getNativeVideoPosition(rem) : undefined;
    },
    [remId]
  );

  React.useEffect(() => {
    if (!url || !enabled || !position) return;
    if (mirrored.current !== undefined && Math.abs(position - mirrored.current) < MIN_MOVE_SECONDS) return;
    mirrored.current = position;
    setPluginVideoPosition(plugin, url, position).catch((e) =>
      console.error('[NativeVideo] Could not save the position:', e)
    );
  }, [position, enabled, url]);

  return { position, mirrored };
}
