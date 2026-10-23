// Drives a YouTube embed that RemNote itself renders, from inside the plugin.
//
// A YouTube player can't run in the plugin's own iframe: RemNote sandboxes it
// without allow-same-origin, nested frames inherit that, and YouTube's embed
// script dies reading `window.caches` (findings/VIDEO_PLAYBACK.md). RemNote's
// Embed Website powerup, though, is rendered by the host with allow-same-origin.
// A raw /embed/ URL there answers YouTube's widget postMessage protocol from any
// frame, so we find it through window.top.frames and talk to it from here.
//
// Never put `origin=` in the embed URL: an origin-locked player ignores both
// the handshake and commands from other frames (verified against a copy of
// RemNote's own wrapper, which is why RemNote's player can't be driven).

export interface YouTubeEmbedInfo {
  currentTime?: number;
  duration?: number;
  /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued */
  playerState?: number;
  playbackRate?: number;
}

export interface YouTubeEmbedConnection {
  /** Calls a YouTube player method, e.g. send('seekTo', [120, true]). */
  send: (func: string, args?: unknown[]) => void;
  isConnected: () => boolean;
  close: () => void;
}

export function buildBridgeableEmbedUrl(
  videoId: string,
  opts: { start?: number; end?: number; autoplay?: boolean } = {}
): string {
  const params = new URLSearchParams({ enablejsapi: '1', playsinline: '1', rel: '0' });
  if (opts.start) params.set('start', `${Math.floor(opts.start)}`);
  if (opts.end) params.set('end', `${Math.ceil(opts.end)}`);
  if (opts.autoplay) params.set('autoplay', '1');
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

const WIDGET_CHANNEL = { id: 1, channel: 'widget' };

function collectFrames(root: Window, depth: number, out: Window[]) {
  if (depth > 3) return;
  let count = 0;
  try {
    count = root.frames.length;
  } catch {
    return;
  }
  for (let i = 0; i < count; i++) {
    let frame: Window | undefined;
    try {
      frame = root.frames[i];
    } catch {
      continue;
    }
    if (!frame || frame === window) continue;
    out.push(frame);
    collectFrames(frame, depth + 1, out);
  }
}

const parseMessage = (data: unknown): any => {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

/** The video id a YouTube widget message reports, when it reports one. */
const reportedVideoId = (info: any): string | undefined =>
  info?.videoData?.video_id ?? info?.videoUrl?.match(/[?&]v=([^&]{11})/)?.[1];

/**
 * Finds the embed playing `videoId` and streams its state to `onInfo`. Keeps
 * re-sending the handshake while nothing answers, which also covers the iframe
 * being re-created when RemNote re-renders it.
 */
export function connectYouTubeEmbed(
  videoId: string,
  onInfo: (info: YouTubeEmbedInfo) => void,
  /** Every message from the connected embed, for diagnostics. */
  onRawMessage?: (event: string, info: unknown) => void
): YouTubeEmbedConnection {
  let target: Window | null = null;
  let lastReplyAt = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const post = (frame: Window, payload: object) => {
    try {
      frame.postMessage(JSON.stringify({ ...payload, ...WIDGET_CHANNEL }), '*');
    } catch {
      // A frame can go away between enumeration and posting.
    }
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source === window) return;
    const msg = parseMessage(event.data);
    // Other frames (another instance of this plugin, say) send 'listening' too.
    if (!msg || typeof msg.event !== 'string' || msg.event === 'listening') return;
    const source = event.source as Window | null;
    if (!source) return;
    const info = msg.info && typeof msg.info === 'object' ? msg.info : {};
    if (source !== target) {
      // Not every message names its video; a different id is the only veto.
      // Embeds without enablejsapi (RemNote's inline videos) never answer.
      const id = reportedVideoId(info);
      if (id && id !== videoId) return;
      target = source;
    }
    lastReplyAt = Date.now();
    onRawMessage?.(msg.event, msg.info);
    const out: YouTubeEmbedInfo = {};
    if (typeof info.currentTime === 'number') out.currentTime = info.currentTime;
    if (typeof info.duration === 'number') out.duration = info.duration;
    if (typeof info.playerState === 'number') out.playerState = info.playerState;
    if (typeof info.playbackRate === 'number') out.playbackRate = info.playbackRate;
    if (msg.event === 'onStateChange' && typeof msg.info === 'number') out.playerState = msg.info;
    if (Object.keys(out).length) onInfo(out);
  };

  const handshake = () => {
    if (closed) return;
    const silent = Date.now() - lastReplyAt > 3000;
    if (silent) {
      target = null;
      const frames: Window[] = [];
      collectFrames(window.top ?? window, 0, frames);
      frames.forEach((frame) => post(frame, { event: 'listening' }));
    }
    timer = setTimeout(handshake, silent ? 500 : 2000);
  };

  window.addEventListener('message', onMessage);
  handshake();

  return {
    send: (func, args = []) => {
      if (target) post(target, { event: 'command', func, args });
    },
    isConnected: () => !!target && Date.now() - lastReplyAt < 3000,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    },
  };
}
