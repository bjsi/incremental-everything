import React from 'react';
import { YouTubeEmbedInfo, YouTubePlayerCommand } from '../lib/youtube_embed_bridge';
import { YT_PLAYING } from './PluginYouTubePlayer';

// Play/pause, ±30 s and speed buttons for the plugin's YouTube player, for the
// top bar of the video views. A speed set here is saved like one set in
// YouTube's own menu: the bridge reports it as the user's change.

const SKIP_SECONDS = 30;
const RATE_STEP = 0.25;
const MIN_RATE = 0.25;
const MAX_RATE = 2;

const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const btn: React.CSSProperties = {
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: 4,
  border: '1px solid #d1d5db',
  backgroundColor: '#f3f4f6',
  fontSize: 12,
  minWidth: 26,
};

interface PlayerControlsProps {
  info: YouTubeEmbedInfo;
  connected: boolean;
  send: (command: YouTubePlayerCommand) => void;
}

export const PlayerControls: React.FC<PlayerControlsProps> = ({ info, connected, send }) => {
  const playing = info.playerState === YT_PLAYING;
  const rate = info.playbackRate ?? 1;
  const time = info.currentTime ?? 0;

  const skip = (delta: number) => {
    const max = info.duration ? info.duration - 1 : Infinity;
    send({ command: 'seekTo', seconds: Math.max(0, Math.min(max, time + delta)) });
  };
  const setRate = (next: number) => {
    const clamped = Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, next)) * 100) / 100;
    if (clamped !== rate) send({ command: 'setPlaybackRate', playbackRate: clamped });
  };

  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 3,
        alignItems: 'center',
        opacity: connected ? 1 : 0.5,
        pointerEvents: connected ? undefined : 'none',
      }}
    >
      <button style={btn} onClick={() => skip(-SKIP_SECONDS)} title={`Back ${SKIP_SECONDS} s`}>
        −30s
      </button>
      <button
        style={{ ...btn, minWidth: 30 }}
        onClick={() => send({ command: playing ? 'pause' : 'play' })}
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <button style={btn} onClick={() => skip(SKIP_SECONDS)} title={`Forward ${SKIP_SECONDS} s`}>
        +30s
      </button>
      <span
        style={{ fontSize: 12, color: '#6b7280', fontVariantNumeric: 'tabular-nums', margin: '0 4px' }}
      >
        {formatTime(time)}
        {info.duration ? ` / ${formatTime(info.duration)}` : ''}
      </span>
      <button
        style={btn}
        onClick={() => setRate(rate - RATE_STEP)}
        disabled={rate <= MIN_RATE}
        title="Slower"
      >
        −
      </button>
      <button
        style={{ ...btn, minWidth: 44, fontVariantNumeric: 'tabular-nums' }}
        onClick={() => setRate(1)}
        title="Speed (click for 1×)"
      >
        {rate}×
      </button>
      <button
        style={btn}
        onClick={() => setRate(rate + RATE_STEP)}
        disabled={rate >= MAX_RATE}
        title="Faster"
      >
        +
      </button>
    </div>
  );
};
