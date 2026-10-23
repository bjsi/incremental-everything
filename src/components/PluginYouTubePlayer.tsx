import { DocumentViewer, RNPlugin, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  buildPlayerPageUrl,
  connectYouTubeEmbed,
  YouTubeEmbedConnection,
  YouTubeEmbedInfo,
  YouTubePlayerCommand,
} from '../lib/youtube_embed_bridge';
import { getPlayerRem, PlayerRemIds, setPlayerSize, setPlayerUrl } from '../lib/video_player_rem';

// The plugin's YouTube player: our player page in the shared Embed Website Rem
// (lib/video_player_rem.ts), shown through a DocumentViewer and driven over
// postMessage (lib/youtube_embed_bridge.ts).

/** 1 = playing in YouTube's player states. */
export const YT_PLAYING = 1;

export interface YouTubeBridge {
  info: YouTubeEmbedInfo;
  connected: boolean;
  send: (command: YouTubePlayerCommand) => void;
}

/**
 * Connects to the player page showing `videoId`. On the first answer from each
 * page load it seeks to `start`, sets the speed and plays: the page may be one
 * left over from an earlier card that showed the same video, so its URL's start
 * time can't be relied on. A page answers 'hello' only until its player is
 * ready, so a 'hello' after that means the page was reloaded.
 */
export function useYouTubeBridge(
  videoId: string | null,
  opts: { start?: number; playbackRate?: number } = {}
): YouTubeBridge {
  const [info, setInfo] = React.useState<YouTubeEmbedInfo>({});
  const [connected, setConnected] = React.useState(false);
  const conn = React.useRef<YouTubeEmbedConnection | null>(null);
  const optsRef = React.useRef(opts);
  optsRef.current = opts;

  React.useEffect(() => {
    if (!videoId) return;
    let greeted = false;
    let reloaded = false;
    const c = connectYouTubeEmbed(
      videoId,
      (next) => {
        if (!greeted || reloaded) {
          greeted = true;
          reloaded = false;
          const { start = 0, playbackRate } = optsRef.current;
          // A fresh page starts at its URL's start time; an old one could be anywhere.
          if (next.currentTime === undefined ? start > 0 : Math.abs(next.currentTime - start) > 2) {
            c.send({ command: 'seekTo', seconds: start });
          }
          if (playbackRate && playbackRate !== 1)
            c.send({ command: 'setPlaybackRate', playbackRate });
          c.send({ command: 'play' });
        }
        setInfo((prev) => ({ ...prev, ...next }));
      },
      (event) => {
        if (event === 'hello' && greeted) reloaded = true;
      }
    );
    conn.current = c;
    const t = setInterval(() => setConnected(c.isConnected()), 500);
    return () => {
      clearInterval(t);
      c.send({ command: 'pause' });
      c.close();
      conn.current = null;
      setInfo({});
      setConnected(false);
    };
  }, [videoId]);

  const send = React.useCallback(
    (command: YouTubePlayerCommand) => conn.current?.send(command),
    []
  );
  return { info, connected, send };
}

// Space the DocumentViewer takes around the embed: the document title above
// it and the editor's side padding. Measured on desktop; the embed is capped
// at the document width anyway, so too small a padding only costs a scrollbar.
const TITLE_OVERHEAD = 110;
const SIDE_PADDING = 72;
const MIN_WIDTH = 240;

function fitPlayer(width: number, height: number) {
  const w = Math.max(MIN_WIDTH, width - SIDE_PADDING);
  const h = Math.max(135, Math.min(height - TITLE_OVERHEAD, (w * 9) / 16));
  return { width: Math.min(w, (h * 16) / 9), height: h };
}

/** Fills its parent with the shared player Rem, pointed at `videoId`. */
export const PluginYouTubePlayerFrame: React.FC<{ videoId: string; start?: number }> = ({
  videoId,
  start,
}) => {
  const plugin = usePlugin() as RNPlugin;
  const [ids, setIds] = React.useState<PlayerRemIds | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const lastSize = React.useRef<{ width: number; height: number } | null>(null);

  // The start time only matters for a fresh page; later seeks go through the
  // bridge, so it isn't a dependency.
  const startRef = React.useRef(start);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const found = await getPlayerRem(plugin);
        await setPlayerUrl(
          plugin,
          found.embedId,
          buildPlayerPageUrl(videoId, { start: startRef.current, autoplay: true })
        );
        if (!cancelled) setIds(found);
      } catch (e) {
        console.error('[PluginYouTubePlayer]', e);
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  // Size the embed to the space available. Every resize is a synced slot
  // write, so wait for the resize to settle and skip small changes.
  React.useEffect(() => {
    const box = boxRef.current;
    if (!ids || !box) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      const size = fitPlayer(box.clientWidth, box.clientHeight);
      const prev = lastSize.current;
      if (
        prev &&
        Math.abs(prev.width - size.width) < 12 &&
        Math.abs(prev.height - size.height) < 12
      )
        return;
      lastSize.current = size;
      setPlayerSize(plugin, ids.embedId, size.width, size.height);
    };
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(apply, 400);
    });
    observer.observe(box);
    apply();
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [ids?.embedId]);

  return (
    <div ref={boxRef} style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
      {error ? (
        <div className="p-4">Could not open the video player: {error}</div>
      ) : ids ? (
        <DocumentViewer documentId={ids.docId} width="100%" height="100%" />
      ) : (
        <div className="p-4">Loading the player…</div>
      )}
    </div>
  );
};
