import { RemId, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { getNativeVideoPosition, setExtractPosition, setPluginVideoPosition } from '../lib/video_position';

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

/**
 * A Video Extract played in RemNote's player, from its video's `position`:
 * whether the player got to the extract's end, and where it got to, saved as
 * the extract's position for its next review. Only once the player has
 * reported a time inside the extract (until then ip.l may still hold where the
 * video was before), and never a time before its start (the page resets ip.l
 * to 0 when it opens, after the resume time put there already counted).
 */
export function useNativeExtractProgress(
  extractId: RemId | undefined,
  segment: { start: number; end: number } | undefined,
  position: number | undefined,
  enabled = true
): 'waiting' | 'inside' | 'reached' {
  const plugin = usePlugin();
  const [state, setState] = React.useState<'waiting' | 'inside' | 'reached'>('waiting');
  const saved = React.useRef<number | undefined>();

  React.useEffect(() => {
    setState('waiting');
    saved.current = undefined;
  }, [extractId]);

  React.useEffect(() => {
    if (!segment || !enabled || position === undefined) return;
    let now = state;
    if (now === 'waiting' && position >= segment.start - 1 && position < segment.end) now = 'inside';
    if (now === 'inside' && position >= segment.end) now = 'reached';
    if (now !== state) setState(now);
    if (!extractId || now === 'waiting' || position < segment.start) return;
    if (saved.current !== undefined && Math.abs(position - saved.current) < MIN_MOVE_SECONDS) return;
    saved.current = position;
    setExtractPosition(plugin, extractId, position).catch((e) =>
      console.error('[NativeVideo] Could not save the extract position:', e)
    );
  }, [position, enabled, state, extractId, segment?.start, segment?.end]);

  return state;
}
