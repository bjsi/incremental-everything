import { usePlugin, useRunAsync } from '@remnote/plugin-sdk';
import React from 'react';
import { YouTubeEmbedInfo } from '../lib/youtube_embed_bridge';
import { YT_PAUSED, YT_PLAYING } from './PluginYouTubePlayer';

// Where a video was left and at what speed, per URL (synced storage), shared by
// the plugin's YouTube player and its local video player.

/** Read once, before the player opens: the position is where it starts, the speed is applied on load. */
export function useSavedVideoSettings(url: string) {
  const plugin = usePlugin();
  return useRunAsync(async () => {
    const [position, playbackRate] = await Promise.all([
      plugin.storage.getSynced<number>(`${url}-position`),
      plugin.storage.getSynced<number>(`${url}-playbackRate`),
    ]);
    return { position: position ?? 0, playbackRate: playbackRate ?? 1 };
  }, [url]);
}

/** Saves a speed the user chose for the video. */
export function useSaveVideoRate(url: string) {
  const plugin = usePlugin();
  return React.useCallback((rate: number) => plugin.storage.setSynced(`${url}-playbackRate`, rate), [url]);
}

/**
 * The position is a synced write: saved every few seconds while playing, at
 * once on pause, and when the card closes. Nothing is saved until the video
 * has played from where it should start: before the start seek lands, a player
 * reports 0, or the position an earlier card left it at.
 *
 * Returns the refs a caller needs to hand the position over elsewhere:
 * `armed` (the reported time can be trusted), `latestPosition`, `lastSaved`.
 */
export function useVideoPositionSaver(url: string, info: YouTubeEmbedInfo, startPosition: number | undefined) {
  const plugin = usePlugin();
  const positionKey = `${url}-position`;
  const lastSaved = React.useRef({ at: 0, position: -1 });
  const latestPosition = React.useRef<number | undefined>();
  const armed = React.useRef(false);
  React.useEffect(() => {
    const t = info.currentTime;
    // Only a playing or paused player says where the video is: a page that
    // has just (re)loaded reports its URL's start time until the seek lands.
    if (t === undefined || (info.playerState !== YT_PLAYING && info.playerState !== YT_PAUSED)) return;
    if (!armed.current && info.playerState === YT_PLAYING && Math.abs(t - (startPosition ?? 0)) <= 5) {
      armed.current = true;
    }
    if (!armed.current || t === lastSaved.current.position) return;
    latestPosition.current = t;
    const now = Date.now();
    if (info.playerState !== YT_PLAYING || now - lastSaved.current.at > 5000) {
      lastSaved.current = { at: now, position: t };
      plugin.storage.setSynced(positionKey, t);
    }
  }, [info.currentTime, info.playerState]);
  React.useEffect(
    () => () => {
      if (latestPosition.current !== undefined && latestPosition.current !== lastSaved.current.position)
        plugin.storage.setSynced(positionKey, latestPosition.current);
    },
    [positionKey]
  );
  return { armed, latestPosition, lastSaved };
}
