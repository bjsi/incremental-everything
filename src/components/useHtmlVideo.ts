import React from 'react';
import { YouTubeEmbedInfo, YouTubePlayerCommand } from '../lib/youtube_embed_bridge';
import { YT_PAUSED, YT_PLAYING } from './PluginYouTubePlayer';

// YouTube's playerState codes, which the shared video controls read.
const YT_ENDED = 0;
const YT_BUFFERING = 3;

/**
 * A `<video>` element behind the same interface as the YouTube bridge
 * (useYouTubeBridge), so PlayerControls, the resume chip, position saving and
 * extract auto-pause work on local videos as they are. Attach `videoRef` to
 * the element. The element is in the plugin's own frame, so commands act at
 * once and every event is the element's own.
 *
 * On load it seeks to `start`, applies `playbackRate` and plays, unless
 * `autoplay` is false. Like the bridge, `onRateChange` hears only speed
 * changes made afterwards.
 */
export function useHtmlVideo(
  src: string | null,
  opts: {
    start?: number;
    playbackRate?: number;
    autoplay?: boolean;
    onRateChange?: (rate: number) => void;
  } = {}
) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [info, setInfo] = React.useState<YouTubeEmbedInfo>({});
  const [connected, setConnected] = React.useState(false);
  const optsRef = React.useRef(opts);
  optsRef.current = opts;

  React.useEffect(() => {
    const v = videoRef.current;
    if (!src || !v) return;
    // The speed set on load raises one ratechange of its own, which isn't the user's.
    let ownRateChange = false;

    const report = () =>
      setInfo({
        currentTime: v.currentTime,
        duration: Number.isFinite(v.duration) ? v.duration : undefined,
        playerState: v.ended
          ? YT_ENDED
          : v.paused
            ? YT_PAUSED
            : v.readyState < 3
              ? YT_BUFFERING
              : YT_PLAYING,
        playbackRate: v.playbackRate,
        muted: v.muted,
        errorCode: v.error?.code,
      });
    const onLoaded = () => {
      const { start, playbackRate, autoplay = true } = optsRef.current;
      if (start && start > 0) v.currentTime = Math.min(start, Math.max(0, v.duration - 1));
      if (playbackRate && playbackRate !== 1) {
        ownRateChange = true;
        v.playbackRate = playbackRate;
      }
      setConnected(true);
      if (autoplay) v.play().catch(() => report()); // autoplay refused: stay paused
      report();
    };
    const onRate = () => {
      if (ownRateChange) ownRateChange = false;
      else optsRef.current.onRateChange?.(v.playbackRate);
      report();
    };
    const events = [
      'timeupdate',
      'play',
      'playing',
      'pause',
      'seeked',
      'waiting',
      'ended',
      'error',
      'volumechange',
    ];
    v.addEventListener('loadedmetadata', onLoaded);
    v.addEventListener('ratechange', onRate);
    events.forEach((e) => v.addEventListener(e, report));
    return () => {
      v.pause();
      v.removeEventListener('loadedmetadata', onLoaded);
      v.removeEventListener('ratechange', onRate);
      events.forEach((e) => v.removeEventListener(e, report));
      setInfo({});
      setConnected(false);
    };
  }, [src]);

  const send = React.useCallback((command: YouTubePlayerCommand) => {
    const v = videoRef.current;
    if (!v) return;
    switch (command.command) {
      case 'play':
        v.play().catch(() => {});
        break;
      case 'pause':
        v.pause();
        break;
      case 'seekTo':
        v.currentTime = command.seconds;
        break;
      case 'setPlaybackRate':
        v.playbackRate = command.playbackRate;
        break;
      case 'mute':
        v.muted = true;
        break;
      case 'unMute':
        v.muted = false;
        break;
    }
  }, []);

  return { info, connected, send, videoRef };
}
