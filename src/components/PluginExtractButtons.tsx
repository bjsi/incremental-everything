import { RemId, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { createVideoExtract } from '../lib/video_extract';
import { formatVideoTime } from '../lib/video_snapshot';

// ✂️ Extract for the plugin's own players, which report the exact time:
// Start at the current time, then Set End at the current time. The video is
// paused at the end so the priority can be set in peace.

type ExtractState = { phase: 'idle' } | { phase: 'capturing'; startTime: number } | { phase: 'creating' };

interface PluginExtractButtonsProps {
  /** The player's current time, in seconds. */
  position: number;
  pause: () => void;
  /** The video's Rem, or the extract being cut again: the new extract goes under it. */
  parentId: RemId;
  /** The video's URL, stored on the extract. */
  url: string;
}

export const PluginExtractButtons: React.FC<PluginExtractButtonsProps> = ({ position, pause, parentId, url }) => {
  const plugin = usePlugin();
  const [extractState, setExtractState] = React.useState<ExtractState>({ phase: 'idle' });

  const handleSetEnd = async () => {
    if (extractState.phase !== 'capturing') return;
    pause(); // Pause video so user can set priority freely
    const { startTime } = extractState;
    const endTime = position || 0;

    if (endTime <= startTime) {
      await plugin.app.toast('End time must be after start time');
      return;
    }

    setExtractState({ phase: 'creating' });
    try {
      await createVideoExtract(plugin, { parentId, url, startTime, endTime });
    } finally {
      setExtractState({ phase: 'idle' });
    }
  };

  if (extractState.phase === 'idle')
    return (
      <button
        onClick={() => setExtractState({ phase: 'capturing', startTime: position || 0 })}
        title="Create Video Extract from current position"
        style={{
          cursor: 'pointer',
          padding: '2px 8px',
          borderRadius: 4,
          border: '1px solid #d1d5db',
          backgroundColor: '#fef3c7',
          fontSize: 13,
        }}
      >
        ✂️ Extract
      </button>
    );

  if (extractState.phase === 'creating')
    return <span style={{ fontSize: 12, color: '#6b7280' }}>Creating extract...</span>;

  return (
    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: 12 }}>
      <span
        style={{
          backgroundColor: '#dcfce7',
          padding: '2px 8px',
          borderRadius: 4,
          fontWeight: 600,
        }}
      >
        ▶ Start: {formatVideoTime(extractState.startTime)}
      </span>
      <span style={{ color: '#6b7280' }}>→ now: {formatVideoTime(position || 0)}</span>
      <button
        onClick={handleSetEnd}
        style={{
          cursor: 'pointer',
          padding: '2px 8px',
          borderRadius: 4,
          border: '1px solid #86efac',
          backgroundColor: '#bbf7d0',
          fontWeight: 600,
          fontSize: 12,
        }}
      >
        ✓ Set End
      </button>
      <button
        onClick={() => setExtractState({ phase: 'idle' })}
        style={{
          cursor: 'pointer',
          padding: '2px 6px',
          borderRadius: 4,
          border: '1px solid #fca5a5',
          backgroundColor: '#fee2e2',
          fontSize: 12,
        }}
      >
        ✕
      </button>
    </div>
  );
};
