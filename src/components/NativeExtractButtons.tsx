import { RemId, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { createVideoExtract } from '../lib/video_extract';
import { formatVideoTime } from '../lib/video_snapshot';

// ✂️ Extract for RemNote's player, which the plugin can watch but not drive:
// Start and End are taken from the position it reports (ip.l), which trails
// the picture by up to 3 s, so each can be nudged before the extract is made.

const NUDGE_SECONDS = 5;

type State =
  | { phase: 'idle' }
  | { phase: 'started'; start: number }
  | { phase: 'ended'; start: number; end: number }
  | { phase: 'creating' };

const btn = (background: string, border: string): React.CSSProperties => ({
  cursor: 'pointer',
  padding: '2px 8px',
  borderRadius: 4,
  border: `1px solid ${border}`,
  backgroundColor: background,
  color: '#1f2937',
  fontSize: 12,
  whiteSpace: 'nowrap',
});

const nudgeBtn = btn('#f3f4f6', '#d1d5db');

const chip = (background: string): React.CSSProperties => ({
  backgroundColor: background,
  color: '#1f2937',
  padding: '2px 8px',
  borderRadius: 4,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
});

/** A time with −5 s / +5 s buttons around it. */
const Nudged: React.FC<{ label: string; value: number; onChange: (v: number) => void; background: string }> = ({
  label,
  value,
  onChange,
  background,
}) => (
  <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
    <button style={nudgeBtn} onClick={() => onChange(Math.max(0, value - NUDGE_SECONDS))} title={`${NUDGE_SECONDS} s earlier`}>
      −{NUDGE_SECONDS}
    </button>
    <span style={chip(background)}>
      {label} {formatVideoTime(value)}
    </span>
    <button style={nudgeBtn} onClick={() => onChange(value + NUDGE_SECONDS)} title={`${NUDGE_SECONDS} s later`}>
      +{NUDGE_SECONDS}
    </button>
  </span>
);

interface NativeExtractButtonsProps {
  /** The video Rem the extract goes under. */
  parentId: RemId;
  /** The video's URL, stored on the extract. */
  url: string;
  /** RemNote's player position (ip.l), in seconds. */
  position: number | undefined;
}

export const NativeExtractButtons: React.FC<NativeExtractButtonsProps> = ({ parentId, url, position }) => {
  const plugin = usePlugin();
  const [state, setState] = React.useState<State>({ phase: 'idle' });

  const create = async (start: number, end: number) => {
    if (end <= start) {
      await plugin.app.toast('End time must be after start time');
      return;
    }
    setState({ phase: 'creating' });
    try {
      await createVideoExtract(plugin, { parentId, url, startTime: start, endTime: end });
    } finally {
      setState({ phase: 'idle' });
    }
  };

  const cancel = (
    <button style={btn('#fee2e2', '#fca5a5')} onClick={() => setState({ phase: 'idle' })} title="Cancel the extract">
      ✕
    </button>
  );

  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
      {state.phase === 'idle' && (
        <button
          style={{ ...btn('#fef3c7', '#d1d5db'), opacity: position === undefined ? 0.5 : 1 }}
          disabled={position === undefined}
          onClick={() => position !== undefined && setState({ phase: 'started', start: position })}
          title={
            position === undefined
              ? "RemNote's player hasn't reported a position yet: play the video for a few seconds."
              : "Start an extract where RemNote's player is. Its position trails the picture by up to 3 s; nudge it if needed."
          }
        >
          ✂️ Extract
        </button>
      )}

      {state.phase === 'started' && (
        <>
          <Nudged
            label="▶"
            value={state.start}
            background="#dcfce7"
            onChange={(start) => setState({ phase: 'started', start })}
          />
          <span style={{ color: '#6b7280' }}>→ now {position !== undefined ? formatVideoTime(position) : '—'}</span>
          <button
            style={btn('#bbf7d0', '#86efac')}
            disabled={position === undefined}
            onClick={() => position !== undefined && setState({ phase: 'ended', start: state.start, end: position })}
            title="End the extract where RemNote's player is now"
          >
            ■ Set End
          </button>
          {cancel}
        </>
      )}

      {state.phase === 'ended' && (
        <>
          <span style={chip('#dcfce7')}>▶ {formatVideoTime(state.start)}</span>
          <Nudged
            label="■"
            value={state.end}
            background="#fecaca"
            onChange={(end) => setState({ ...state, end })}
          />
          <button
            style={{ ...btn('#bbf7d0', '#86efac'), fontWeight: 600 }}
            onClick={() => create(state.start, state.end)}
            title="Create the extract"
          >
            ✓ Create
          </button>
          {cancel}
        </>
      )}

      {state.phase === 'creating' && <span style={{ color: '#6b7280' }}>Creating extract…</span>}
    </span>
  );
};
