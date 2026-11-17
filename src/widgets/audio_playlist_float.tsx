import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import {
  audioPlaylistPlayingKey,
  audioPlaylistRequestKey,
} from '../lib/consts';
import {
  AudioPlaylistRequest,
  buildPlaylist,
  BuiltPlaylist,
  closeAudioPlayer,
  Durations,
  knownTags,
  loadDurations,
  loadPlayerState,
  measureMissing,
  playerPosition,
  saveDurations,
  savePlayerState,
} from '../lib/audio_playlist';
import {
  emptyPlayerState,
  formatClock,
  globalTimeOf,
  isValidSpec,
  locate,
  MIN_TRACK_SECONDS,
  pathLine,
  PlayerState,
  PlaylistSpec,
  resumePoint,
  specKey,
  timelineOf,
  Track,
  urlKey,
  withPosition,
  withTag,
} from '../lib/audio_playlist_core';
import { FloatingPosition, useFloatingWidgetDrag } from '../lib/floating_widget_drag';

/**
 * The Audio Playlist player (lib/audio_playlist.ts): one <audio> element playing a
 * list of files as a single recording.
 *
 * The element lives here, in a floating widget, because that is the one plugin frame
 * the host keeps mounted across documents and the queue, on a phone as well, and
 * because the Play tap then happens in the same frame as the element (a phone lets a
 * tapped element keep playing; it may refuse one that was never tapped).
 *
 * The audio is driven imperatively, with React only mirroring it: when a track ends
 * the next one is given to the same element and played inside the `ended` handler
 * itself, so playback carries on with the screen locked, where a render-then-effect
 * round trip may never be scheduled.
 *
 * What is remembered: the position (synced storage, so a playlist paused on the
 * computer resumes on the phone) as the track's key and the time within it, never
 * the track number, since the list is rebuilt from the tree every time it is opened.
 */

const LOG = '[AudioPlaylist]';
const SKIP_SECONDS = 15;
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
/** While playing, the position goes to synced storage this often, and to session storage far more. */
const SAVE_EVERY_MS = 15000;
const LIVE_EVERY_MS = 2500;

/** Where the player was a moment ago, for a player the host closed and the index reopened. */
interface LivePosition {
  playing: boolean;
  key?: string;
  trackKey?: string;
  time?: number;
  at: number;
}

const C = {
  bg: 'var(--rn-clr-background-primary)',
  bg2: 'var(--rn-clr-background-secondary)',
  bg3: 'var(--rn-clr-background-tertiary)',
  text: 'var(--rn-clr-content-primary)',
  text2: 'var(--rn-clr-content-secondary)',
  text3: 'var(--rn-clr-content-tertiary)',
  border: 'var(--rn-clr-border-primary)',
  accent: 'var(--rn-clr-content-accent, #3B82F6)',
};

const Icon = ({ d, size = 20, fill = true }: { d: string; size?: number; fill?: boolean }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill ? 'currentColor' : 'none'}
    stroke={fill ? 'none' : 'currentColor'}
    strokeWidth={fill ? 0 : 2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);
const PATH = {
  play: 'M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  prev: 'M6 5h2.5v14H6zM20 6.2v11.6a1 1 0 0 1-1.55.83L10 13v6-14 6l8.45-5.63A1 1 0 0 1 20 6.2z',
  next: 'M15.5 5H18v14h-2.5zM4 6.2v11.6a1 1 0 0 0 1.55.83L14 13v6V5v6L5.55 5.37A1 1 0 0 0 4 6.2z',
  down: 'M6 9l6 6 6-6',
  up: 'M6 15l6-6 6 6',
  close: 'M6 6l12 12M18 6L6 18',
  open: 'M14 5h5v5M19 5l-8 8M11 7H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-5',
};

const iconButton = (size = 36): React.CSSProperties => ({
  width: size,
  height: size,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderRadius: size / 2,
  background: 'transparent',
  color: C.text,
  cursor: 'pointer',
  padding: 0,
  flex: 'none',
  fontSize: 12,
  fontWeight: 600,
});

const selectStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 30,
  fontSize: 12,
  color: C.text,
  background: C.bg2,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: '0 6px',
};

const ellipsis: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

/** The list of tracks. Memoized: the clock ticks four times a second and must not redraw it. */
const TrackList = React.memo(function TrackList(props: {
  tracks: Track[];
  durations: Durations;
  currentKey?: string;
  failed: Set<string>;
  onJump: (index: number) => void;
}) {
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' });
  }, [props.currentKey]);
  return (
    <div style={{ maxHeight: 232, overflowY: 'auto', borderTop: `1px solid ${C.border}` }}>
      {props.tracks.map((track, i) => {
        const current = track.key === props.currentKey;
        return (
          <button
            key={track.key}
            ref={current ? currentRef : undefined}
            onClick={() => props.onJump(i)}
            title={track.path?.length ? `${track.title} ‹ ${pathLine(track)}` : track.title}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              minHeight: 40,
              padding: '4px 12px',
              border: 'none',
              borderRadius: 0,
              textAlign: 'left',
              cursor: 'pointer',
              fontSize: 13,
              background: current ? C.bg3 : 'transparent',
              color: props.failed.has(track.key) ? C.text3 : C.text,
              fontWeight: current ? 600 : 400,
            }}
          >
            <span style={{ width: 22, flex: 'none', textAlign: 'right', fontSize: 11, color: current ? C.accent : C.text3 }}>
              {current ? '▸' : i + 1}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', ...ellipsis }}>{track.title}</span>
              {!!track.path?.length && (
                <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: C.text3, ...ellipsis }}>
                  {pathLine(track)}
                </span>
              )}
            </span>
            <span style={{ flex: 'none', fontSize: 11, color: C.text3, fontVariantNumeric: 'tabular-nums' }}>
              {props.failed.has(track.key) ? 'unavailable' : formatClock(props.durations[urlKey(track.url)])}
            </span>
          </button>
        );
      })}
    </div>
  );
});

function AudioPlaylistFloat() {
  const plugin = usePlugin();
  const audioRef = useRef<HTMLAudioElement>(null);

  // --- what is stored -------------------------------------------------------
  const stateRef = useRef<PlayerState>(emptyPlayerState());
  const [stored, setStored] = useState<PlayerState | null>(null);
  const durationsRef = useRef<Durations>({});
  const [durations, setDurations] = useState<Durations>({});
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);

  // --- the playlist ---------------------------------------------------------
  const [playlist, setPlaylist] = useState<BuiltPlaylist | null>(null);
  const [status, setStatus] = useState<'starting' | 'idle' | 'building' | 'ready' | 'empty' | 'error'>('starting');
  const [message, setMessage] = useState('');
  const [measuring, setMeasuring] = useState(0);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const buildToken = useRef(0);

  // --- playback -------------------------------------------------------------
  const [currentKey, setCurrentKey] = useState<string | undefined>();
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [rate, setRateState] = useState(1);
  const [includeShort, setIncludeShort] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [lastPlay, setLastPlay] = useState('not tried');

  // --- derived --------------------------------------------------------------
  const all = playlist?.tracks ?? [];
  const lengthOf = useCallback((track: Track) => durations[urlKey(track.url)], [durations]);
  const isShort = useCallback(
    (track: Track) => {
      const seconds = lengthOf(track);
      return seconds !== undefined && seconds < MIN_TRACK_SECONDS;
    },
    [lengthOf]
  );
  // The track playing stays in the list even when it turns out to be a short clip, so
  // a length arriving late never pulls the track out from under the player.
  const shortCount = useMemo(() => all.filter(isShort).length, [all, isShort]);
  // A list made of nothing but short clips (a vocabulary page) is played as it is.
  const onlyShort = all.length > 0 && shortCount === all.length;
  const visible = useMemo(
    () => (includeShort || onlyShort ? all : all.filter((t) => !isShort(t) || t.key === currentKey)),
    [all, includeShort, onlyShort, isShort, currentKey]
  );
  const lengths = useMemo(() => visible.map(lengthOf), [visible, lengthOf]);
  const timeline = useMemo(() => timelineOf(lengths), [lengths]);
  const index = Math.max(0, visible.findIndex((t) => t.key === currentKey));
  const track: Track | undefined = visible[index];
  const globalTime = globalTimeOf(timeline, index, time);

  // What the audio's event handlers read: always this render's values.
  const live = useRef({ visible, lengths, timeline, index, playlist, rate, includeShort });
  live.current = { visible, lengths, timeline, index, playlist, rate, includeShort };

  // --- the float itself -----------------------------------------------------
  const [floatingWidgetId, setFloatingWidgetId] = useState<string | null>(null);
  const positionRef = useRef<FloatingPosition | null>(null);
  useEffect(() => {
    plugin.widget
      .getWidgetContext<WidgetLocation.FloatingWidget>()
      .then((ctx) => setFloatingWidgetId(ctx?.floatingWidgetId ?? null))
      .catch((e) => console.warn(LOG, 'no drag: widget context unavailable', e));
    playerPosition(plugin).then((p) => (positionRef.current = p)).catch(() => {});
  }, [plugin]);
  const startDrag = useFloatingWidgetDrag(plugin, floatingWidgetId, positionRef);
  // The iframe is as wide as this element (the widget is registered with width 'auto').
  const width = useMemo(() => Math.min(380, (window.screen?.availWidth || 400) - 16), []);

  // --- saving ---------------------------------------------------------------
  /** The track the element holds, the seek it still owes, and failures in a row. */
  const loadedKey = useRef<string | undefined>();
  const seekTarget = useRef<number | null>(null);
  const seekTries = useRef(0);
  const errorsInARow = useRef(0);
  const lastSaved = useRef(0);
  const lastLive = useRef(0);
  const playIntent = useRef(false);

  const positionNow = useCallback(() => {
    const { visible: list, timeline: tl, index: i, playlist: pl } = live.current;
    const audio = audioRef.current;
    const current = list[i];
    // Between two playlists, or before a track is loaded, there is no position to write.
    if (!pl || !current || !audio || loadedKey.current !== current.key) return undefined;
    if (!pl.tracks.some((t) => t.key === current.key)) return undefined;
    const t = seekTarget.current ?? (audio.currentTime || 0);
    return {
      spec: pl.spec,
      title: pl.title,
      trackKey: current.key,
      time: t,
      globalTime: globalTimeOf(tl, i, t),
      total: tl.total,
      updatedAt: Date.now(),
    };
  }, []);

  const writeLive = useCallback(
    (isPlaying: boolean) => {
      const pos = positionNow();
      lastLive.current = Date.now();
      const value: LivePosition = {
        playing: isPlaying,
        key: pos ? specKey(pos.spec) : undefined,
        trackKey: pos?.trackKey,
        time: pos?.time,
        at: Date.now(),
      };
      plugin.storage.setSession(audioPlaylistPlayingKey, value).catch(() => {});
    },
    [plugin, positionNow]
  );

  /** Position, speed and options to synced storage, over whatever another device wrote meanwhile. */
  const persist = useCallback(
    async (override?: { trackKey: string; time: number }) => {
      const pos = positionNow();
      lastSaved.current = Date.now();
      try {
        let next = await loadPlayerState(plugin);
        next = { ...next, rate: live.current.rate, includeShort: live.current.includeShort, tags: stateRef.current.tags };
        if (pos) next = withPosition(next, override ? { ...pos, ...override, globalTime: undefined } : pos);
        stateRef.current = next;
        setStored(next);
        await savePlayerState(plugin, next);
      } catch (err) {
        console.warn(LOG, 'could not save the position', err);
      }
    },
    [plugin, positionNow]
  );

  // --- the audio element ----------------------------------------------------
  const announce = useCallback((current: Track) => {
    const session = (navigator as any).mediaSession;
    const Metadata = (window as any).MediaMetadata;
    if (!session || !Metadata) return;
    try {
      session.metadata = new Metadata({
        title: current.title,
        artist: current.path?.[0] ?? live.current.playlist?.title ?? 'Audio playlist',
        album: live.current.playlist?.title ?? 'RemNote',
      });
    } catch {
      /* the lock screen keeps the previous title */
    }
  }, []);

  const tryPlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    playIntent.current = true;
    const started = audio.play();
    if (!started) return;
    started
      .then(() => {
        setNeedsTap(false);
        setLastPlay('ok');
      })
      .catch((err: DOMException) => {
        if (err?.name === 'AbortError') return; // a newer track took the element
        setLastPlay(err?.name || String(err));
        if (err?.name === 'NotAllowedError') setNeedsTap(true);
        setPlaying(false);
      });
  }, []);

  /** Give the element a track and a starting point. Everything that changes track goes through here. */
  const startTrack = useCallback(
    (next: Track | undefined, at: number, play: boolean) => {
      const audio = audioRef.current;
      if (!audio || !next) return;
      loadedKey.current = next.key;
      seekTarget.current = at > 0.5 ? at : null;
      seekTries.current = 0;
      audio.src = next.url;
      audio.defaultPlaybackRate = live.current.rate;
      audio.playbackRate = live.current.rate;
      setCurrentKey(next.key);
      setTime(at);
      setBuffering(false);
      announce(next);
      if (play) tryPlay();
      else {
        playIntent.current = false;
        setPlaying(false);
      }
    },
    [announce, tryPlay]
  );

  const noteLength = useCallback((url: string, seconds: number) => {
    if (!isFinite(seconds) || seconds <= 0) return;
    const key = urlKey(url);
    const rounded = Math.round(seconds * 10) / 10;
    if (Math.abs((durationsRef.current[key] ?? -1) - rounded) < 0.5) return;
    durationsRef.current = { ...durationsRef.current, [key]: rounded };
    setDurations(durationsRef.current);
    saveDurations(plugin, { [key]: rounded }).catch(() => {});
  }, [plugin]);

  const onLoadedMetadata = () => {
    const audio = audioRef.current;
    const current = live.current.visible.find((t) => t.key === loadedKey.current);
    if (!audio || !current) return;
    noteLength(current.url, audio.duration);
    if (seekTarget.current !== null) {
      const limit = isFinite(audio.duration) ? Math.max(0, audio.duration - 0.5) : seekTarget.current;
      audio.currentTime = Math.min(seekTarget.current, limit);
    }
    // A new source resets the rate on some engines.
    audio.playbackRate = live.current.rate;
  };

  const onTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (seekTarget.current !== null) {
      // Changing the source fires a timeupdate at 0 before anything has loaded: the
      // seek is still owed, and is made at loadedmetadata.
      if (audio.readyState < 1) return;
      // A seek asked for at load can be dropped by the engine: ask again, a few times at most.
      if (audio.currentTime < seekTarget.current - 1.5 && seekTries.current < 3) {
        seekTries.current++;
        audio.currentTime = seekTarget.current;
        return;
      }
      seekTarget.current = null;
    }
    setTime(audio.currentTime);
    errorsInARow.current = 0;
    const now = Date.now();
    if (!audio.paused && now - lastLive.current > LIVE_EVERY_MS) writeLive(true);
    if (!audio.paused && now - lastSaved.current > SAVE_EVERY_MS) void persist();
    const session = (navigator as any).mediaSession;
    if (session?.setPositionState && isFinite(audio.duration) && audio.duration > 0) {
      try {
        session.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: Math.min(audio.currentTime, audio.duration),
        });
      } catch {
        /* an engine that rejects the state keeps its own clock */
      }
    }
  };

  const finish = useCallback(() => {
    // The end of the list: back to the start, stopped, so the next Play starts over.
    const first = live.current.visible[0];
    playIntent.current = false;
    setPlaying(false);
    writeLive(false);
    if (first) {
      startTrack(first, 0, false);
      void persist({ trackKey: first.key, time: 0 });
    }
  }, [persist, startTrack, writeLive]);

  const onEnded = () => {
    const { visible: list, index: i } = live.current;
    if (i + 1 < list.length) {
      startTrack(list[i + 1], 0, true);
      void persist({ trackKey: list[i + 1].key, time: 0 });
    } else finish();
  };

  const onError = () => {
    const audio = audioRef.current;
    const key = loadedKey.current;
    if (!audio || !key || !audio.getAttribute('src')) return;
    seekTarget.current = null;
    console.warn(LOG, 'could not play', key, audio.error?.message);
    setFailed((prev) => new Set(prev).add(key));
    errorsInARow.current++;
    const { visible: list } = live.current;
    const at = list.findIndex((t) => t.key === key);
    // One missing file is skipped; several in a row is the network, not the files.
    if (playIntent.current && errorsInARow.current < 3 && at >= 0 && at + 1 < list.length) {
      startTrack(list[at + 1], 0, true);
    } else {
      playIntent.current = false;
      setPlaying(false);
      setMessage(errorsInARow.current >= 3 ? 'Several audios in a row would not load. Check the connection.' : 'This audio would not load.');
    }
  };

  // --- controls -------------------------------------------------------------
  const toggle = useCallback(() => {
    const audio = audioRef.current;
    const current = live.current.visible[live.current.index];
    if (!audio || !current) return;
    setMessage('');
    if (loadedKey.current !== current.key) startTrack(current, 0, true);
    else if (audio.paused) tryPlay();
    else {
      playIntent.current = false;
      audio.pause();
    }
  }, [startTrack, tryPlay]);

  const seekWithin = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.readyState >= 1) {
      seekTarget.current = null;
      audio.currentTime = seconds;
    } else {
      seekTarget.current = seconds;
      seekTries.current = 0;
    }
    setTime(seconds);
  }, []);

  const seekGlobal = useCallback(
    (seconds: number) => {
      const { visible: list, lengths: ls, timeline: tl, index: i } = live.current;
      const target = locate(tl, ls, seconds);
      if (target.index === i && loadedKey.current === list[i]?.key) seekWithin(target.time);
      else startTrack(list[target.index], target.time, playIntent.current);
    },
    [seekWithin, startTrack]
  );

  const skip = useCallback(
    (delta: number) => {
      const audio = audioRef.current;
      const { visible: list, timeline: tl, index: i } = live.current;
      if (!audio || !list[i]) return;
      // A seek still owed (the track is loading) is where the listener already is.
      const now = seekTarget.current ?? (audio.currentTime || 0);
      const within = now + delta;
      const length = isFinite(audio.duration) && audio.readyState >= 1 ? audio.duration : Infinity;
      // Inside the track the element's own clock is exact; across a boundary the timeline decides.
      if (loadedKey.current === list[i].key && within >= 0 && within < length - 0.3) seekWithin(within);
      else seekGlobal(globalTimeOf(tl, i, now) + delta);
    },
    [seekGlobal, seekWithin]
  );

  const jump = useCallback(
    (to: number) => {
      const next = live.current.visible[to];
      if (!next) return;
      setMessage('');
      startTrack(next, 0, true);
    },
    [startTrack]
  );
  const previous = useCallback(() => {
    const audio = audioRef.current;
    const { visible: list, index: i } = live.current;
    // Like any player: the first press goes back to the start of this track.
    if (audio && (audio.currentTime > 3 || i === 0)) seekWithin(0);
    else startTrack(list[i - 1], 0, playIntent.current);
  }, [seekWithin, startTrack]);
  const next = useCallback(() => {
    const { visible: list, index: i } = live.current;
    if (i + 1 < list.length) startTrack(list[i + 1], 0, playIntent.current);
  }, [startTrack]);

  const setRate = (value: number) => {
    setRateState(value);
    live.current.rate = value;
    const audio = audioRef.current;
    if (audio) {
      audio.defaultPlaybackRate = value;
      audio.playbackRate = value;
    }
    void persist();
  };

  // The lock screen and headset buttons. Previous/next are tracks there; the bar
  // seeks within the track playing.
  useEffect(() => {
    const session = (navigator as any).mediaSession;
    if (!session?.setActionHandler) return;
    const handlers: [string, ((details: any) => void) | null][] = [
      ['play', () => tryPlay()],
      ['pause', () => { playIntent.current = false; audioRef.current?.pause(); }],
      ['previoustrack', () => previous()],
      ['nexttrack', () => next()],
      ['seekbackward', (d) => skip(-(d?.seekOffset || SKIP_SECONDS))],
      ['seekforward', (d) => skip(d?.seekOffset || SKIP_SECONDS)],
      ['seekto', (d) => typeof d?.seekTime === 'number' && seekWithin(d.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* an action this engine does not know */
      }
    }
  }, [next, previous, seekWithin, skip, tryPlay]);

  // --- building a playlist --------------------------------------------------
  const load = useCallback(
    async (request: Pick<AudioPlaylistRequest, 'spec' | 'fallbackRootId'>, opts: { play: boolean; resume?: LivePosition }) => {
      const token = ++buildToken.current;
      const audio = audioRef.current;
      if (live.current.playlist) await persist();
      if (token !== buildToken.current) return;
      audio?.pause();
      playIntent.current = false;
      setPlaying(false);
      setFailed(new Set());
      setMessage('');
      setStatus('building');
      try {
        const built = await buildPlaylist(plugin, request);
        if (token !== buildToken.current) return;
        setPlaylist(built);
        if (!built.tracks.length) {
          setCurrentKey(undefined);
          setStatus('empty');
          return;
        }
        if (built.spec.tagId) {
          const name = built.title.includes('#') ? built.title.slice(built.title.lastIndexOf('#') + 1) : built.title;
          stateRef.current = withTag(stateRef.current, { id: built.spec.tagId, name });
          knownTags(plugin, stateRef.current).then(setTags).catch(() => {});
        }
        // Resume: the live position of a player that was closed under us, else the saved one.
        const key = specKey(built.spec);
        const saved =
          opts.resume?.key === key && opts.resume.trackKey
            ? { trackKey: opts.resume.trackKey, time: opts.resume.time ?? 0 }
            : stateRef.current.playlists[key];
        const known = durationsRef.current;
        const playable = built.tracks.filter((t) => {
          const seconds = known[urlKey(t.url)];
          return stateRef.current.includeShort || seconds === undefined || seconds >= MIN_TRACK_SECONDS;
        });
        // The saved track if the list still has it; otherwise the first that is not a short clip.
        const from = resumePoint(built.tracks.map((t) => t.key), saved);
        const resumed = !!saved?.trackKey && built.tracks[from.index]?.key === saved.trackKey;
        const start = resumed
          ? { track: built.tracks[from.index], time: from.time }
          : { track: playable[0] ?? built.tracks[0], time: 0 };
        live.current.playlist = built;
        setStatus('ready');
        startTrack(start.track, start.time, opts.play);
        if (built.usedFallback) setMessage('Nothing to play under the cursor: playing the whole document.');

        const missing = new Set(built.tracks.map((t) => urlKey(t.url)).filter((k) => known[k] === undefined));
        setMeasuring(missing.size);
        const added: Durations = {};
        let flush: ReturnType<typeof setTimeout> | undefined;
        await measureMissing(
          built.tracks,
          known,
          (k, seconds) => {
            if (token !== buildToken.current) return;
            missing.delete(k);
            if (seconds !== undefined) {
              added[k] = seconds;
              durationsRef.current = { ...durationsRef.current, [k]: seconds };
            }
            // Lengths land in bursts; one redraw per burst.
            if (!flush) {
              flush = setTimeout(() => {
                flush = undefined;
                setDurations(durationsRef.current);
                setMeasuring(missing.size);
              }, 400);
            }
          },
          () => token !== buildToken.current
        );
        if (Object.keys(added).length) await saveDurations(plugin, added).catch(() => {});
        if (token === buildToken.current) {
          setDurations(durationsRef.current);
          setMeasuring(0);
        }
      } catch (err) {
        if (token !== buildToken.current) return;
        console.error(LOG, 'could not build the playlist', err);
        setStatus('error');
        setMessage(err instanceof Error ? err.message : String(err));
      }
    },
    [persist, plugin, startTrack]
  );

  // Start: what is stored, then the playlist asked for, or the one last heard.
  const handledRequest = useRef(0);
  const ready = stored !== null;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [state, lengthsStored] = await Promise.all([loadPlayerState(plugin), loadDurations(plugin)]);
      if (cancelled) return;
      stateRef.current = state;
      durationsRef.current = lengthsStored;
      setDurations(lengthsStored);
      setRateState(state.rate);
      setIncludeShort(state.includeShort);
      live.current.rate = state.rate;
      live.current.includeShort = state.includeShort;
      setStored(state);
      knownTags(plugin, state).then((t) => !cancelled && setTags(t)).catch(() => {});

      const request = await plugin.storage.getSession<AudioPlaylistRequest>(audioPlaylistRequestKey);
      if (cancelled) return;
      if (request && isValidSpec(request.spec)) {
        handledRequest.current = request.at;
        await plugin.storage.setSession(audioPlaylistRequestKey, null);
        void load(request, { play: request.play });
        return;
      }
      // No request: this player was opened to resume, or reopened after the host closed it.
      const before = await plugin.storage.getSession<LivePosition>(audioPlaylistPlayingKey);
      const lastSpec = (before?.key && state.playlists[before.key]?.spec) || (state.last && state.playlists[state.last]?.spec);
      if (lastSpec) void load({ spec: lastSpec }, { play: !!before?.playing, resume: before ?? undefined });
      else setStatus('idle');
    })().catch((err) => {
      console.error(LOG, 'could not start', err);
      setStored(emptyPlayerState());
      setStatus('error');
      setMessage(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin]);

  // A playlist asked for while the player is already open.
  const request = useTrackerPlugin((rp) => rp.storage.getSession<AudioPlaylistRequest>(audioPlaylistRequestKey), []);
  useEffect(() => {
    if (!ready || !request || !isValidSpec(request.spec) || request.at === handledRequest.current) return;
    handledRequest.current = request.at;
    plugin.storage.setSession(audioPlaylistRequestKey, null).catch(() => {});
    setCollapsed(false);
    void load(request, { play: request.play });
  }, [ready, request, load, plugin]);

  // Leaving: a hidden page (the app sent to the background) may be suspended at any time.
  useEffect(() => {
    const save = () => {
      if (document.visibilityState === 'hidden') void persist();
    };
    document.addEventListener('visibilitychange', save);
    window.addEventListener('pagehide', save);
    return () => {
      document.removeEventListener('visibilitychange', save);
      window.removeEventListener('pagehide', save);
    };
  }, [persist]);

  const close = async () => {
    audioRef.current?.pause();
    playIntent.current = false;
    await persist();
    await plugin.storage.setSession(audioPlaylistPlayingKey, { playing: false, at: Date.now() } satisfies LivePosition);
    await closeAudioPlayer(plugin);
    // The index closes it; this is for an index that is not answering.
    if (floatingWidgetId) setTimeout(() => plugin.window.closeFloatingWidget(floatingWidgetId).catch(() => {}), 1500);
  };

  const openRem = async () => {
    if (!track) return;
    const rem = await plugin.rem.findOne(track.remId);
    // The audio rem alone is an empty page: open what it belongs to.
    const target = (rem?.parent ? await plugin.rem.findOne(rem.parent) : undefined) ?? rem;
    if (target) await plugin.window.openRem(target);
    else await plugin.app.toast('That rem no longer exists.');
  };

  const toggleShort = () => {
    const value = !includeShort;
    setIncludeShort(value);
    live.current.includeShort = value;
    stateRef.current = { ...stateRef.current, includeShort: value };
    void persist();
  };

  const commitScrub = () => {
    setScrub((value) => {
      if (value !== null) seekGlobal(value);
      return null;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') return;
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      skip(-SKIP_SECONDS);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      skip(SKIP_SECONDS);
    }
  };

  // --- the pickers ----------------------------------------------------------
  const spec: PlaylistSpec | undefined = playlist?.spec;
  const currentSpecKey = spec ? specKey(spec) : '';
  const recents = useMemo(() => {
    const saved = Object.entries(stored?.playlists ?? {})
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .map(([key, p]) => ({
        key,
        spec: p.spec,
        label: `${p.title || 'Playlist'}${p.total ? ` · ${formatClock(p.globalTime ?? 0)} / ${formatClock(p.total)}` : ''}`,
      }));
    // Every known tag can be played across the knowledge base, heard before or not.
    for (const tag of tags) {
      const key = specKey({ tagId: tag.id });
      if (!saved.some((s) => s.key === key)) saved.push({ key, spec: { tagId: tag.id }, label: `#${tag.name} · whole knowledge base` });
    }
    return saved;
  }, [stored, tags]);

  const pickPlaylist = (key: string) => {
    const chosen = recents.find((r) => r.key === key);
    if (chosen && key !== currentSpecKey) void load({ spec: chosen.spec }, { play: false });
  };
  const pickTag = (tagId: string) => {
    if (!spec?.rootIds?.length) return;
    void load({ spec: { rootIds: spec.rootIds, tagId: tagId || undefined } }, { play: false });
  };

  const total = timeline.total;
  const shown = scrub ?? globalTime;
  const clock = `${formatClock(shown)} / ${timeline.unknown && measuring ? '~' : ''}${formatClock(total)}`;
  const busy = status === 'building' || status === 'starting';
  const playLabel = playing ? 'Pause' : 'Play';

  const audioElement = (
    <audio
      ref={audioRef}
      preload="auto"
      onLoadedMetadata={onLoadedMetadata}
      onDurationChange={onLoadedMetadata}
      onTimeUpdate={onTimeUpdate}
      onPlay={() => {
        setPlaying(true);
        setNeedsTap(false);
        writeLive(true);
      }}
      onPause={() => {
        // The pause some engines fire just before `ended` is not the listener pausing.
        if (audioRef.current?.ended) return;
        setPlaying(false);
        writeLive(false);
        void persist();
      }}
      onWaiting={() => setBuffering(true)}
      onPlaying={() => setBuffering(false)}
      onCanPlay={() => setBuffering(false)}
      onEnded={onEnded}
      onError={onError}
      style={{ display: 'none' }}
    />
  );

  const playButton = (size: number) => (
    <button
      onClick={toggle}
      disabled={!track || busy}
      title={playLabel}
      aria-label={playLabel}
      style={{
        ...iconButton(size),
        background: C.accent,
        color: 'white',
        opacity: !track || busy ? 0.5 : 1,
      }}
    >
      <Icon d={playing ? PATH.pause : PATH.play} size={size * 0.55} />
    </button>
  );

  const frame: React.CSSProperties = {
    width,
    boxSizing: 'border-box',
    background: C.bg,
    color: C.text,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
    fontSize: 13,
    overflow: 'hidden',
    outline: 'none',
  };
  const progress = (
    <div style={{ height: 3, background: C.bg3 }}>
      <div style={{ height: 3, width: `${total > 0 ? Math.min(100, (globalTime / total) * 100) : 0}%`, background: C.accent }} />
    </div>
  );

  if (collapsed) {
    return (
      <div style={frame} tabIndex={-1} onKeyDown={onKeyDown}>
        {audioElement}
        <div
          onPointerDown={startDrag}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 6px 6px 8px', touchAction: 'none', userSelect: 'none' }}
        >
          {playButton(36)}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, ...ellipsis }}>{track?.title ?? playlist?.title ?? 'Audio playlist'}</div>
            <div style={{ fontSize: 11, color: C.text2, fontVariantNumeric: 'tabular-nums', ...ellipsis }}>
              {busy
                ? 'Building the playlist…'
                : needsTap
                  ? 'Tap play to start'
                  : `${clock}${visible.length ? ` · ${index + 1}/${visible.length}` : ''}${track?.path?.[0] ? ` · ${track.path[0]}` : ''}`}
            </div>
          </div>
          <button onClick={next} disabled={index + 1 >= visible.length} title="Next audio" style={iconButton(34)}>
            <Icon d={PATH.next} size={18} />
          </button>
          <button onClick={() => setCollapsed(false)} title="Show the playlist" style={iconButton(34)}>
            <Icon d={PATH.up} size={18} fill={false} />
          </button>
          <button onClick={() => void close()} title="Close the player" style={iconButton(34)}>
            <Icon d={PATH.close} size={16} fill={false} />
          </button>
        </div>
        {progress}
      </div>
    );
  }

  return (
    <div style={frame} tabIndex={-1} onKeyDown={onKeyDown}>
      {audioElement}
      <div
        onPointerDown={startDrag}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 6px 6px 12px',
          background: C.bg2,
          borderBottom: `1px solid ${C.border}`,
          cursor: 'move',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, ...ellipsis }} title={playlist?.title}>
            🎧 {playlist?.title ?? 'Audio playlist'}
          </div>
          <div style={{ fontSize: 11, color: C.text2 }}>
            {busy
              ? 'Building the playlist…'
              : `${visible.length} ${visible.length === 1 ? 'audio' : 'audios'}${total ? ` · ${formatClock(total)}` : ''}${measuring ? ` · measuring ${measuring}…` : ''}`}
          </div>
        </div>
        <button onClick={() => setCollapsed(true)} title="Shrink to a bar" style={iconButton(34)}>
          <Icon d={PATH.down} size={18} fill={false} />
        </button>
        <button onClick={() => void close()} title="Close the player" style={iconButton(34)}>
          <Icon d={PATH.close} size={16} fill={false} />
        </button>
      </div>

      {(recents.length > 1 || (!!spec?.rootIds?.length && tags.length > 0)) && (
        <div style={{ display: 'flex', gap: 6, padding: '8px 12px 0' }}>
          {recents.length > 1 && (
            <select value={currentSpecKey} onChange={(e) => pickPlaylist(e.target.value)} style={selectStyle} title="Playlists heard before">
              {!recents.some((r) => r.key === currentSpecKey) && <option value={currentSpecKey}>{playlist?.title ?? 'Choose a playlist'}</option>}
              {recents.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
          {!!spec?.rootIds?.length && tags.length > 0 && (
            <select value={spec.tagId ?? ''} onChange={(e) => pickTag(e.target.value)} style={{ ...selectStyle, flex: '0 1 44%' }} title="Only audios in rems with this tag">
              <option value="">All audios</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  Only #{t.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {status === 'idle' && (
        <div style={{ padding: 14, color: C.text2, lineHeight: 1.45 }}>
          No playlist yet. Open a document and choose <b>Audio Playlist</b> in its <b>⋯ → Incremental RemNote…</b> menu, or run
          the command <b>Audio Playlist: Play This Branch</b>.
        </div>
      )}
      {status === 'empty' && (
        <div style={{ padding: 14, color: C.text2, lineHeight: 1.45 }}>
          No audio found {spec?.tagId ? 'with this tag' : 'in this branch'}.
        </div>
      )}
      {status === 'error' && <div style={{ padding: 14, color: '#EF4444', lineHeight: 1.45 }}>{message || 'Something went wrong.'}</div>}

      {(status === 'ready' || (status === 'building' && track)) && (
        <>
          <div style={{ padding: '10px 12px 0' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {track?.title ?? '…'}
                </div>
                {!!track?.path?.length && (
                  <div
                    title={pathLine(track)}
                    style={{ fontSize: 12, color: C.text2, lineHeight: 1.35, marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                  >
                    {pathLine(track)}
                  </div>
                )}
                <div style={{ fontSize: 11, color: C.text3, marginTop: 2, ...ellipsis }}>
                  {visible.length ? `${index + 1} of ${visible.length}` : ''}
                  {buffering && playing ? ' · loading…' : ''}
                </div>
              </div>
              <button onClick={() => void openRem()} disabled={!track} title="Open this rem" style={iconButton(32)}>
                <Icon d={PATH.open} size={17} fill={false} />
              </button>
            </div>

            <input
              type="range"
              aria-label="Position in the playlist"
              min={0}
              max={Math.max(1, Math.floor(total))}
              step={1}
              value={Math.min(Math.floor(shown), Math.max(1, Math.floor(total)))}
              disabled={total <= 0}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={commitScrub}
              onTouchEnd={commitScrub}
              onKeyUp={commitScrub}
              onBlur={commitScrub}
              style={{ width: '100%', margin: '10px 0 2px', accentColor: C.accent, touchAction: 'none' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.text2, fontVariantNumeric: 'tabular-nums' }}>
              <span>{formatClock(shown)}</span>
              <span>
                {timeline.unknown && measuring ? '~' : ''}
                {formatClock(total)}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px 10px' }}>
            <select
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
              title="Playback speed"
              style={{ ...selectStyle, flex: 'none', width: 62 }}
            >
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button onClick={previous} title="Start of this audio, then the previous one" style={iconButton(38)}>
                <Icon d={PATH.prev} />
              </button>
              <button onClick={() => skip(-SKIP_SECONDS)} title={`Back ${SKIP_SECONDS} s`} style={iconButton(38)}>
                −{SKIP_SECONDS}
              </button>
              {playButton(46)}
              <button onClick={() => skip(SKIP_SECONDS)} title={`Forward ${SKIP_SECONDS} s`} style={iconButton(38)}>
                +{SKIP_SECONDS}
              </button>
              <button onClick={next} disabled={index + 1 >= visible.length} title="Next audio" style={{ ...iconButton(38), opacity: index + 1 >= visible.length ? 0.4 : 1 }}>
                <Icon d={PATH.next} />
              </button>
            </div>
            <button onClick={() => setShowInfo((v) => !v)} title="Details" style={{ ...iconButton(32), color: C.text3, width: 62 }}>
              ⓘ
            </button>
          </div>

          {(needsTap || message) && (
            <div style={{ padding: '0 12px 8px', fontSize: 12, color: needsTap ? C.accent : C.text2 }}>
              {needsTap ? 'Tap play to start: this device only plays after a tap.' : message}
            </div>
          )}

          <TrackList tracks={visible} durations={durations} currentKey={track?.key} failed={failed} onJump={jump} />

          {((shortCount > 0 && !onlyShort) || showInfo) && (
            <div style={{ padding: '6px 12px', fontSize: 11, color: C.text3, borderTop: `1px solid ${C.border}`, lineHeight: 1.5 }}>
              {shortCount > 0 && !onlyShort && (
                <div>
                  {shortCount} {shortCount === 1 ? 'clip' : 'clips'} under {MIN_TRACK_SECONDS} s {includeShort ? 'included' : 'left out'} ·{' '}
                  <button onClick={toggleShort} style={{ border: 'none', background: 'none', padding: 0, color: C.accent, cursor: 'pointer', fontSize: 11 }}>
                    {includeShort ? 'leave them out' : 'include them'}
                  </button>
                </div>
              )}
              {showInfo && (
                <div>
                  Lock-screen controls: {(navigator as any).mediaSession ? 'available' : 'not available in this frame'} · last play(): {lastPlay} ·
                  lengths known: {lengths.filter((l) => l !== undefined).length}/{lengths.length}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

renderWidget(AudioPlaylistFloat);
