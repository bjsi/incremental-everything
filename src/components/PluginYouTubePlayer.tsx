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

/** YouTube player states: 1 playing, 2 paused. */
export const YT_PLAYING = 1;
export const YT_PAUSED = 2;

const LOG = '[VideoPlayer]';

export interface YouTubeBridge {
  info: YouTubeEmbedInfo;
  connected: boolean;
  send: (command: YouTubePlayerCommand) => void;
}

// Where each video last was, kept outside React so it survives the player page
// being reloaded and this component being remounted: RemNote can re-create the
// embed's iframe (seen when the mouse first moves over it in the queue), and a
// fresh page would start over from its URL's start time at 1×. Keyed by video
// and start, so another card on the same video still starts where it should.
interface PlayerMemory {
  time: number;
  rate: number;
  playing: boolean;
  at: number;
}
const memory = new Map<string, PlayerMemory>();
const MEMORY_TTL_MS = 10 * 60 * 1000;

/**
 * Connects to the player page showing `videoId`. On the first answer from each
 * page load it seeks, sets the speed and plays (or stays paused): to where this
 * card's player last was if the page was reloaded, else to `start`. The page
 * may also be one left over from an earlier card on the same video, so its
 * URL's start time can't be relied on. A page answers 'hello' only until its
 * player is ready, so a 'hello' after that means the page was reloaded.
 *
 * `onRateChange` hears only speed changes the user makes: a page reports 1×
 * (or whatever an earlier card left) until the greeting's speed lands.
 */
export function useYouTubeBridge(
  videoId: string | null,
  opts: { start?: number; playbackRate?: number; onRateChange?: (rate: number) => void } = {}
): YouTubeBridge {
  const [info, setInfo] = React.useState<YouTubeEmbedInfo>({});
  const [connected, setConnected] = React.useState(false);
  const conn = React.useRef<YouTubeEmbedConnection | null>(null);
  const optsRef = React.useRef(opts);
  optsRef.current = opts;

  React.useEffect(() => {
    if (!videoId) return;
    const key = `${videoId}@${Math.floor(optsRef.current.start ?? 0)}`;
    let greeted = false;
    let reloaded = false;
    let instance: string | undefined;
    // Where the last greeting sent the player; nothing is remembered until the
    // player reports being there, so a left-over or reloaded page can't record
    // the position it had before the seek landed.
    let target: number | undefined;
    let settled = false;
    // The same for the speed: what the greeting asked for, and whether the
    // player has reported it yet. YouTube applies a new speed asynchronously.
    let rate = 1;
    let rateLanded = false;
    let greetedAt = 0;
    console.log(LOG, 'connect', key);

    const greet = (next: YouTubeEmbedInfo) => {
      const remembered = memory.get(key);
      const prev =
        remembered && Date.now() - remembered.at < MEMORY_TTL_MS ? remembered : undefined;
      target = prev?.time ?? optsRef.current.start ?? 0;
      settled = false;
      rate = prev?.rate ?? optsRef.current.playbackRate ?? 1;
      rateLanded = next.playbackRate === rate;
      greetedAt = Date.now();
      console.log(LOG, reloaded ? 'page reloaded, restoring' : 'greeting', key, {
        target,
        rate,
        prev,
      });
      // A fresh page starts at its URL's start time; an old one could be anywhere.
      if (next.currentTime === undefined ? target > 0 : Math.abs(next.currentTime - target) > 2) {
        c.send({ command: 'seekTo', seconds: target! });
      }
      if (rate !== 1) c.send({ command: 'setPlaybackRate', playbackRate: rate });
      c.send({ command: prev && !prev.playing ? 'pause' : 'play' });
    };

    const c = connectYouTubeEmbed(
      videoId,
      (next) => {
        if (next.instance) {
          if (instance && next.instance !== instance) reloaded = true;
          instance = next.instance;
        }
        if (!greeted || reloaded) {
          greet(next);
          greeted = true;
          reloaded = false;
        }
        // Only a playing or paused player says where the video is: a page
        // that has just loaded reports its URL's start time until the seek lands.
        const known =
          next.currentTime !== undefined &&
          (next.playerState === YT_PLAYING || next.playerState === YT_PAUSED);
        if (known && !settled && Math.abs(next.currentTime! - (target ?? 0)) <= 3) settled = true;
        if (next.playbackRate !== undefined) {
          if (!rateLanded && (next.playbackRate === rate || Date.now() - greetedAt > 5000)) {
            rateLanded = true;
          } else if (rateLanded && next.playbackRate !== rate) {
            console.log(LOG, 'speed changed', key, rate, '→', next.playbackRate);
            rate = next.playbackRate;
            optsRef.current.onRateChange?.(rate);
          }
        }
        if (known && settled) {
          memory.set(key, {
            time: next.currentTime!,
            rate,
            playing: next.playerState === YT_PLAYING,
            at: Date.now(),
          });
        }
        setInfo((prev) => ({ ...prev, ...next }));
      },
      // Pages from before `instance` existed: a 'hello' after the first greeting
      // also means a reload, though only while the new player is still loading.
      (event) => {
        if (event === 'hello' && greeted) reloaded = true;
      }
    );
    conn.current = c;
    const t = setInterval(() => setConnected(c.isConnected()), 500);
    return () => {
      console.log(LOG, 'disconnect', key);
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
    console.log(LOG, 'frame mount', videoId);
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
        console.error(LOG, e);
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      console.log(LOG, 'frame unmount', videoId);
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
      console.log(LOG, 'resize embed', size);
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
