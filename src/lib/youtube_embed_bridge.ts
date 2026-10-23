// Drives a YouTube player that RemNote itself renders, from inside the plugin.
//
// A YouTube player can't run in the plugin's own iframe: RemNote sandboxes it
// without allow-same-origin, nested frames inherit that, and YouTube's embed
// script dies reading `window.caches` (findings/VIDEO_PLAYBACK.md). RemNote's
// Embed Website powerup, though, is rendered by the host with allow-same-origin.
//
// What goes into Embed Website is our own player page (docs/player/youtube.html,
// published with the docs site), not a YouTube URL:
// - a youtube.com / youtu.be URL is swapped for RemNote's own YouTube player,
//   which is locked to its origin and ignores every other frame;
// - a raw youtube-nocookie.com embed works in the browser, but in the desktop
//   app (app://js) it gets YouTube Error 153: no Referer. Our https page gives
//   YouTube a referrer and relays commands and state over postMessage.
// We find that page through window.top.frames and talk to it from here.

export const YOUTUBE_PLAYER_PAGE_URL =
  'https://hugomarins.github.io/incremental-remnote/player/youtube.html';

const MESSAGE_TYPE = 'ie-youtube-player';

export interface YouTubeEmbedInfo {
  currentTime?: number;
  duration?: number;
  /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued */
  playerState?: number;
  playbackRate?: number;
  muted?: boolean;
  /** YouTube error code, e.g. 153 (no referrer), 101/150 (embedding disabled). */
  errorCode?: number;
  /** New on every load of the player page: a change means it was reloaded. */
  instance?: string;
}

export type YouTubePlayerCommand =
  | { command: 'play' }
  | { command: 'pause' }
  | { command: 'mute' }
  | { command: 'unMute' }
  | { command: 'seekTo'; seconds: number }
  | { command: 'setPlaybackRate'; playbackRate: number };

export interface YouTubeEmbedConnection {
  send: (command: YouTubePlayerCommand) => void;
  isConnected: () => boolean;
  close: () => void;
}

export function buildPlayerPageUrl(
  videoId: string,
  opts: { start?: number; end?: number; autoplay?: boolean; pageUrl?: string } = {}
): string {
  const params = new URLSearchParams({ v: videoId });
  if (opts.start) params.set('start', `${Math.floor(opts.start)}`);
  if (opts.end) params.set('end', `${Math.ceil(opts.end)}`);
  if (opts.autoplay) params.set('autoplay', '1');
  return `${opts.pageUrl ?? YOUTUBE_PLAYER_PAGE_URL}?${params.toString()}`;
}

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

/**
 * Finds the player page showing `videoId` and streams its state to `onInfo`.
 * Keeps saying hello while nothing answers, which also covers the iframe being
 * re-created when RemNote re-renders it.
 */
export function connectYouTubeEmbed(
  videoId: string,
  onInfo: (info: YouTubeEmbedInfo) => void,
  /** Every event from the connected page, for diagnostics. */
  onEvent?: (event: string) => void
): YouTubeEmbedConnection {
  let target: Window | null = null;
  let lastReplyAt = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const post = (frame: Window, payload: object) => {
    try {
      frame.postMessage({ type: MESSAGE_TYPE, ...payload }, '*');
    } catch {
      // A frame can go away between enumeration and posting.
    }
  };

  const onMessage = (event: MessageEvent) => {
    const msg = event.data;
    if (!msg || msg.type !== MESSAGE_TYPE || typeof msg.event !== 'string') return;
    if (msg.videoId !== videoId || !event.source) return;
    target = event.source as Window;
    lastReplyAt = Date.now();
    onEvent?.(msg.event);
    const info: YouTubeEmbedInfo = {};
    for (const key of [
      'currentTime',
      'duration',
      'playerState',
      'playbackRate',
      'errorCode',
    ] as const) {
      if (typeof msg[key] === 'number') info[key] = msg[key];
    }
    if (typeof msg.muted === 'boolean') info.muted = msg.muted;
    if (typeof msg.instance === 'string') info.instance = msg.instance;
    onInfo(info);
  };

  // The page reports progress every 250 ms only while playing, so silence is
  // normal when paused. Re-handshake only when it has been quiet for a while,
  // and say hello to the known page anyway so a paused player stays connected.
  const handshake = () => {
    if (closed) return;
    if (Date.now() - lastReplyAt > 3000) {
      const frames: Window[] = [];
      collectFrames(window.top ?? window, 0, frames);
      frames.forEach((frame) => post(frame, { command: 'hello' }));
    }
    timer = setTimeout(handshake, target ? 2000 : 500);
  };

  window.addEventListener('message', onMessage);
  handshake();

  return {
    send: (command) => {
      if (target) post(target, command);
    },
    isConnected: () => !!target && Date.now() - lastReplyAt < 5000,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    },
  };
}
