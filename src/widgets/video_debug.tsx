import React, { useEffect, useRef, useState } from 'react';
import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  useSessionStorageState,
  WidgetLocation,
  BuiltInPowerupCodes,
  DocumentViewer,
  PluginRem,
  RNPlugin,
} from '@remnote/plugin-sdk';
import { readNativeVideoInfo, writeLastWatchedTime } from '../lib/native_video';
import {
  buildPlayerPageUrl,
  YOUTUBE_PLAYER_PAGE_URL,
  connectYouTubeEmbed,
  YouTubeEmbedConnection,
  YouTubeEmbedInfo,
} from '../lib/youtube_embed_bridge';
import { extractVideoId } from '../lib/youtube_transcript';
import {
  videoFloatingProbeIdKey,
  videoProbeOriginalLastWatchedKey,
  videoProbeRemsSessionKey,
} from '../lib/consts';

// Probes for the Incremental Video redesign (findings/VIDEO_PLAYBACK.md). Each
// section answers one question that can only be settled inside RemNote:
//   1. can the plugin read RemNote's video slots (URL, last watched time)?
//   2. does a plugin write to the last watched time reach RemNote's player?
//   3. does an Embed Website Rem give the plugin a YouTube player it can drive?
//   4. does a floating widget stay on screen over RemNote's video page? (A
//      PaneHeader widget does not: it shows on editor panes only.)

type UrlSource = 'vi.u' | 'Link URL' | 'source Link URL';

async function findYouTubeUrl(rem: PluginRem): Promise<{ url: string; from: UrlSource } | null> {
  const native = await readNativeVideoInfo(rem);
  if (native.url) return { url: native.url, from: 'vi.u' };
  const linkUrl = async (r: PluginRem) =>
    (await r.hasPowerup(BuiltInPowerupCodes.Link))
      ? await r.getPowerupProperty(BuiltInPowerupCodes.Link, 'URL')
      : undefined;
  const own = await linkUrl(rem);
  if (own && extractVideoId(own)) return { url: own, from: 'Link URL' };
  for (const source of await rem.getSources()) {
    const url = await linkUrl(source);
    if (url && extractVideoId(url)) return { url, from: 'source Link URL' };
  }
  return null;
}

const fmt = (s: number | undefined) => {
  if (s === undefined) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')} (${s.toFixed(1)} s)`;
};

const PLAYER_STATES: Record<number, string> = {
  [-1]: 'unstarted',
  0: 'ended',
  1: 'playing',
  2: 'paused',
  3: 'buffering',
  5: 'cued',
};

const section: React.CSSProperties = {
  border: '1px solid var(--rn-clr-border-opaque, #ddd)',
  borderRadius: 6,
  padding: 8,
  marginTop: 10,
};
const btn: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid var(--rn-clr-border-opaque, #ccc)',
  cursor: 'pointer',
  marginRight: 6,
  marginTop: 4,
};

interface ProbeRems {
  docId: string;
  embedId: string;
  videoId: string;
}

async function createProbePlayer(
  plugin: RNPlugin,
  videoId: string,
  start: number,
  pageUrl: string
): Promise<ProbeRems | null> {
  const doc = await plugin.rem.createRem();
  const embed = await plugin.rem.createRem();
  if (!doc || !embed) return null;
  await doc.setText(['🧪 Incremental Video probe — safe to delete']);
  await doc.setIsDocument(true);
  await embed.setParent(doc._id);
  await embed.addPowerup(BuiltInPowerupCodes.EmbedWebsite);
  await embed.setPowerupProperty(BuiltInPowerupCodes.EmbedWebsite, 'URL', [
    buildPlayerPageUrl(videoId, { start, pageUrl }),
  ]);
  await embed.setPowerupProperty(BuiltInPowerupCodes.EmbedWebsite, 'WIDTH', ['460']);
  await embed.setPowerupProperty(BuiltInPowerupCodes.EmbedWebsite, 'HEIGHT', ['260']);
  return { docId: doc._id, embedId: embed._id, videoId };
}

function VideoDebug() {
  const plugin = usePlugin();

  const ctx = useRunAsync(async () => await plugin.widget.getWidgetContext<WidgetLocation.Popup>(), []);
  const remId = ctx?.contextData?.remId;

  // --- 1. Slots (the tracker re-runs when RemNote rewrites ip.l while playing) ---
  const data = useTrackerPlugin(
    async (rp) => {
      if (!remId) return null;
      const rem = await rp.rem.findOne(remId);
      if (!rem) return null;
      return {
        text: await rp.richText.toString(rem.text || []),
        hasVideoPowerup: await rem.hasPowerup('vi'),
        native: await readNativeVideoInfo(rem),
        found: await findYouTubeUrl(rem),
      };
    },
    [remId]
  );
  const videoId = data?.found ? extractVideoId(data.found.url) : null;

  // --- 2. ip.l write ---
  const [writeSeconds, setWriteSeconds] = useState('60');
  const [writeLog, setWriteLog] = useState<string>('');
  // Kept in session storage so Restore still works after the popup is closed to
  // check RemNote's video page. Only the value before the first write is kept.
  const [originals, setOriginals] = useSessionStorageState<Record<string, number | null>>(
    videoProbeOriginalLastWatchedKey,
    {}
  );
  const original = remId && remId in originals ? originals[remId] : undefined;

  const doWrite = async (seconds: number) => {
    const rem = remId ? await plugin.rem.findOne(remId) : undefined;
    if (!rem || !remId) return;
    if (!(remId in originals)) {
      await setOriginals({ ...originals, [remId]: data?.native.lastWatchedTime ?? null });
    }
    try {
      await writeLastWatchedTime(rem, seconds);
      const back = (await readNativeVideoInfo(rem)).lastWatchedTime;
      setWriteLog(`wrote ${seconds} → read back ${back ?? 'nothing'}${back === seconds ? ' ✅' : ' ❌'}`);
    } catch (e) {
      setWriteLog(`write threw: ${String(e)}`);
    }
  };

  // --- 3. Embed Website player + bridge ---
  const [probe, setProbe] = useSessionStorageState<ProbeRems | null>(videoProbeRemsSessionKey, null);
  const [player, setPlayer] = useState<YouTubeEmbedInfo>({});
  const [events, setEvents] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  // `entered` stays false until the player reports a time inside the segment:
  // the last time known when the seek is sent is still the old position, often
  // already past `end`.
  const [segment, setSegment] = useState<{ start: number; end: number; entered: boolean } | null>(null);
  const conn = useRef<YouTubeEmbedConnection | null>(null);
  // The published page by default; a local copy (python3 -m http.server 8766
  // --directory docs) tests changes before the docs site is deployed.
  const [pageUrl, setPageUrl] = useState(YOUTUBE_PLAYER_PAGE_URL);

  const storedEmbedUrl = useTrackerPlugin(
    async (rp) => {
      if (!probe) return null;
      const embed = await rp.rem.findOne(probe.embedId);
      return embed ? await embed.getPowerupProperty(BuiltInPowerupCodes.EmbedWebsite, 'URL') : null;
    },
    [probe?.embedId]
  );

  useEffect(() => {
    if (!probe) return;
    const seen = new Set<string>();
    const c = connectYouTubeEmbed(
      probe.videoId,
      (info) => setPlayer((prev) => ({ ...prev, ...info })),
      (event) => {
        if (!seen.has(event)) {
          seen.add(event);
          setEvents((prev) => [...prev, event]);
        }
      }
    );
    conn.current = c;
    const t = setInterval(() => setConnected(c.isConnected()), 500);
    return () => {
      clearInterval(t);
      c.close();
      conn.current = null;
    };
  }, [probe?.embedId]);

  // End-of-segment control: the bridge's answer to "play from A until B".
  useEffect(() => {
    const t = player.currentTime;
    if (!segment || t === undefined) return;
    if (!segment.entered) {
      if (t >= segment.start - 1 && t < segment.end) setSegment({ ...segment, entered: true });
      return;
    }
    if (t >= segment.end) {
      conn.current?.send({ command: 'pause' });
      setSegment(null);
    }
  }, [player.currentTime, segment]);

  const createProbe = async () => {
    if (!videoId) return;
    const created = await createProbePlayer(plugin as RNPlugin, videoId, data?.native.lastWatchedTime ?? 0, pageUrl);
    if (!created) return void plugin.app.toast('Could not create the probe Rems');
    setEvents([]);
    setPlayer({});
    await setProbe(created);
  };

  const deleteProbe = async () => {
    if (!probe) return;
    const doc = await plugin.rem.findOne(probe.docId);
    await doc?.remove();
    await setProbe(null);
  };

  const playSegment = (start: number, length: number) => {
    conn.current?.send({ command: 'seekTo', seconds: start });
    conn.current?.send({ command: 'play' });
    setSegment({ start, end: start + length, entered: false });
  };

  // --- 4. Floating probe ---
  const [floatingId, setFloatingId] = useSessionStorageState<string | null>(videoFloatingProbeIdKey, null);
  const toggleFloating = async () => {
    if (floatingId && (await plugin.window.isFloatingWidgetOpen(floatingId))) {
      await plugin.window.closeFloatingWidget(floatingId);
      await setFloatingId(null);
      return;
    }
    // closeWhenClickOutside false: the probe must survive clicks on the video.
    const id = await plugin.window.openFloatingWidget('video_floating_probe', { bottom: 90, right: 40 }, undefined, false);
    await setFloatingId(id);
  };

  if (!remId) return <div className="p-4">No Rem in context — focus a video Rem and run the command again.</div>;
  if (!data) return <div className="p-4">Loading…</div>;

  const now = player.currentTime;

  // No max-height on the root: in an auto-height popup, vh is the iframe's own
  // height, so a vh cap and the iframe shrink each other into a sliver.
  return (
    <div
      className="p-4 font-mono text-xs"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') plugin.widget.closePopup();
      }}
    >
      <h2 className="font-bold text-lg">🎥 Video Detection &amp; Player Probes</h2>
      <div>
        <strong>{data.text}</strong> <span style={{ opacity: 0.6 }}>({remId})</span>
      </div>

      <div style={section}>
        <strong>1 · RemNote video slots</strong>
        <div>Video powerup (vi): {data.hasVideoPowerup ? '✅' : '❌'}</div>
        <div>vi.u URL: {data.native.url ?? '—'}</div>
        <div>vi.t title: {data.native.title ?? '—'}</div>
        <div>vi.tu transcript URL: {data.native.transcriptUrl ?? '—'}</div>
        <div>In Progress powerup (ip): {data.native.hasInProgress ? '✅' : '❌'}</div>
        <div>ip.l last watched: {fmt(data.native.lastWatchedTime)} <em>(live — play the video in RemNote and watch it move)</em></div>
        <div>ip.d duration: {fmt(data.native.totalDuration)}</div>
        <div>
          YouTube URL found: {data.found ? `${data.found.url} (from ${data.found.from})` : '❌ none'} · id{' '}
          {videoId ?? '—'}
        </div>
      </div>

      <div style={section}>
        <strong>2 · Write ip.l (RemNote's "Resume watching at…")</strong>
        <div>
          <input
            value={writeSeconds}
            onChange={(e) => setWriteSeconds(e.target.value)}
            style={{ width: 70, marginRight: 6 }}
          />
          s
          <button style={btn} onClick={() => doWrite(parseFloat(writeSeconds) || 0)}>
            Write ip.l
          </button>
          <button
            style={btn}
            disabled={original === undefined || original === null}
            onClick={() => original != null && doWrite(original)}
          >
            Restore original ({fmt(original ?? undefined)})
          </button>
        </div>
        <div>{writeLog}</div>
        <div style={{ opacity: 0.7 }}>
          Then close RemNote's video page if it is open and reopen it: the resume button should offer the written time.
        </div>
      </div>

      <div style={section}>
        <strong>3 · Plugin-driven player (Embed Website + postMessage)</strong>
        {!probe ? (
          <div>
            <div>
              Player page:{' '}
              <input
                value={pageUrl}
                onChange={(e) => setPageUrl(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            <button style={btn} disabled={!videoId} onClick={createProbe}>
              Create probe player
            </button>
            <span style={{ opacity: 0.7 }}>
              creates a top-level document "🧪 Incremental Video probe" with an Embed Website child
            </span>
            <div style={{ opacity: 0.7 }}>
              Until the docs site is deployed with player/youtube.html, run{' '}
              <code>python3 -m http.server 8766 --directory docs</code> in the repo and use
              http://localhost:8766/player/youtube.html
            </div>
          </div>
        ) : (
          <>
            <div style={{ height: 330, marginTop: 6 }}>
              <DocumentViewer documentId={probe.docId} width="100%" height={330} />
            </div>
            <div>
              Bridge: {connected ? '✅ connected' : '⏳ searching (press ▶ in the player if it stays here)'} · t{' '}
              {fmt(now)} · duration {fmt(player.duration)} · state{' '}
              {player.playerState !== undefined ? PLAYER_STATES[player.playerState] ?? player.playerState : '—'}
              {player.playbackRate ? ` · ${player.playbackRate}×` : ''}
              {player.muted ? ' · muted' : ''}
              {player.errorCode ? ` · ❌ YouTube error ${player.errorCode}` : ''}
            </div>
            <div>
              <button style={btn} onClick={() => conn.current?.send({ command: 'play' })}>
                ▶ Play
              </button>
              <button style={btn} onClick={() => conn.current?.send({ command: 'pause' })}>
                ⏸ Pause
              </button>
              <button style={btn} onClick={() => conn.current?.send({ command: 'seekTo', seconds: (now ?? 0) + 30 })}>
                +30 s
              </button>
              <button style={btn} onClick={() => playSegment(Math.max(0, (now ?? 0) - 10), 8)}>
                Segment test: −10 s, play 8 s, auto-pause
              </button>
              <button style={btn} onClick={() => conn.current?.send({ command: 'setPlaybackRate', playbackRate: 1.5 })}>
                1.5×
              </button>
              <button
                style={btn}
                onClick={() => conn.current?.send({ command: player.muted ? 'unMute' : 'mute' })}
              >
                {player.muted ? 'Unmute' : 'Mute'}
              </button>
              <button style={btn} onClick={deleteProbe}>
                🗑 Delete probe Rems
              </button>
            </div>
            {segment && <div>auto-pause armed at {fmt(segment.end)}</div>}
            <div style={{ opacity: 0.7 }}>Events seen: {events.join(' ') || '—'}</div>
            <div style={{ opacity: 0.7, wordBreak: 'break-all' }}>
              Embed URL: {storedEmbedUrl ?? '—'}
              {storedEmbedUrl && !storedEmbedUrl.includes('/player/youtube.html')
                ? ' ⚠️ made by an older probe — delete and recreate it'
                : ''}
            </div>
            <div style={{ opacity: 0.7 }}>
              In a browser, the first ▶ must be a click on the video itself (autoplay rule); the buttons work after
              that. The desktop app should not need it.
            </div>
          </>
        )}
      </div>

      <div style={section}>
        <strong>4 · Floating controls over RemNote's video page</strong>
        <div>
          <button style={btn} onClick={toggleFloating}>
            {floatingId ? 'Close' : 'Open'} floating probe
          </button>
        </div>
        <div style={{ opacity: 0.7 }}>
          Opens a small bar in the bottom-right corner. Close this popup, then open the video in RemNote's player
          (video only, then with Notes) and check: the bar stays, ip.l ticks while playing, and its test button
          responds. Also watch ip.l right after the video page loads, before pressing play — does it drop to 0?
        </div>
      </div>
    </div>
  );
}

renderWidget(VideoDebug);
