import { DocumentViewer, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import ReactPlayer from 'react-player/youtube';
import { Resizable } from 're-resizable';
import { useSyncedStorageState } from '@remnote/plugin-sdk';
import { YoutubeActionItem } from '../lib/incremental_rem';
import { initIncrementalRem } from '../lib/incremental_rem';
import { showPriorityPopupForRem } from '../lib/highlightActions';
import {
  videoExtractPowerupCode,
  videoExtractUrlSlotCode,
  videoExtractStartSlotCode,
  videoExtractEndSlotCode,
} from '../lib/consts';
import { getTranscriptForRange, extractVideoId } from '../lib/youtube_transcript';

interface VideoViewerProps {
  actionItem: YoutubeActionItem;
}

const getBoundedWidth = (width: number, minWidth: number, maxWidth: number) =>
  Math.min(Math.max(width, minWidth), maxWidth);

/** Format seconds to MM:SS */
const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

type ExtractState =
  | { phase: 'idle' }
  | { phase: 'capturing'; startTime: number }
  | { phase: 'creating' };

export const VideoViewer: React.FC<VideoViewerProps> = (props) => {
  const plugin = usePlugin();
  const [width, setWidthInner] = React.useState<number>();

  const startWidth = React.useRef<number>();
  const containerRef = React.useRef<HTMLDivElement>(null);

  const setWidth = (width: number, minWidth: number, maxWidth: number) => {
    setWidthInner(getBoundedWidth(width, minWidth, maxWidth));
  };

  const [playing, setPlaying] = React.useState(true);

  const playbackRateStorageKey = `${props.actionItem.url}-playbackRate`;
  const positionStorageKey = `${props.actionItem.url}-position`;
  const [position, setPosition] = useSyncedStorageState<number>(positionStorageKey, 0);
  const [playbackRate, setPlaybackRate] = useSyncedStorageState<number>(
    playbackRateStorageKey,
    1.0
  );

  const player = React.useRef<ReactPlayer>(null);

  const didInitialSeek = React.useRef(false);
  React.useEffect(() => {
    if (player.current && position && !didInitialSeek.current) {
      didInitialSeek.current = true;
      player.current.seekTo(position, 'seconds');
    }
  }, [player?.current, position]);

  // --- Video Extract state ---
  const [extractState, setExtractState] = React.useState<ExtractState>({ phase: 'idle' });

  const handleStartExtract = () => {
    const currentPos = position || 0;
    setExtractState({ phase: 'capturing', startTime: currentPos });
  };

  const handleCancelExtract = () => {
    setExtractState({ phase: 'idle' });
  };

  const handleSetEnd = async () => {
    if (extractState.phase !== 'capturing') return;
    const { startTime } = extractState;
    const endTime = position || 0;

    if (endTime <= startTime) {
      await plugin.app.toast('End time must be after start time');
      return;
    }

    setExtractState({ phase: 'creating' });

    try {
      // Create a new child Rem under the video Rem
      const newRem = await plugin.rem.createRem();
      if (!newRem) {
        await plugin.app.toast('Failed to create extract rem');
        setExtractState({ phase: 'idle' });
        return;
      }

      // Set the text to describe the extract
      const label = `Video Extract [${formatTime(startTime)} – ${formatTime(endTime)}]`;
      await newRem.setText([label]);
      await newRem.setParent(props.actionItem.rem._id);

      // Apply the VideoExtract powerup and set slots
      await newRem.addPowerup(videoExtractPowerupCode);
      await newRem.setPowerupProperty(videoExtractPowerupCode, videoExtractUrlSlotCode, [props.actionItem.url]);
      await newRem.setPowerupProperty(videoExtractPowerupCode, videoExtractStartSlotCode, [startTime.toString()]);
      await newRem.setPowerupProperty(videoExtractPowerupCode, videoExtractEndSlotCode, [endTime.toString()]);

      // Make it incremental
      await initIncrementalRem(plugin as any, newRem);

      await plugin.app.toast(`✅ Created video extract [${formatTime(startTime)} – ${formatTime(endTime)}]`);

      // Fetch transcript and add segments as children Rems
      try {
        const videoId = extractVideoId(props.actionItem.url);
        console.log('[VideoViewer] Attempting transcript fetch for videoId:', videoId, 'range:', startTime, '-', endTime);
        if (videoId) {
          const segments = await getTranscriptForRange(videoId, startTime, endTime);
          if (segments.length > 0) {
            for (const seg of segments) {
              const childRem = await plugin.rem.createRem();
              if (childRem) {
                await childRem.setText([seg.text]);
                await childRem.setParent(newRem._id);
              }
            }
            await plugin.app.toast(`📝 Added ${segments.length} transcript segment(s)`);
          } else {
            await plugin.app.toast('ℹ️ No transcript segments found for this range');
          }
        }
      } catch (transcriptErr) {
        console.warn('[VideoViewer] Could not fetch transcript:', transcriptErr);
        await plugin.app.toast('⚠️ Transcript unavailable (see console for details)');
      }

      // Show priority popup
      setTimeout(async () => {
        await showPriorityPopupForRem(plugin as any, newRem._id);
      }, 300);
    } catch (error) {
      console.error('[VideoViewer] Error creating video extract:', error);
      await plugin.app.toast('Error creating video extract');
    } finally {
      setExtractState({ phase: 'idle' });
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="top-bar" style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
        <button
          onClick={() => {
            if (width === 0) {
              setWidthInner(containerRef.current!.clientWidth / 2);
            } else {
              setWidthInner(0);
            }
          }}
        >
          📝
        </button>

        {/* Video Extract controls */}
        {extractState.phase === 'idle' && (
          <button
            onClick={handleStartExtract}
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
        )}

        {extractState.phase === 'capturing' && (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: 12 }}>
            <span style={{
              backgroundColor: '#dcfce7',
              padding: '2px 8px',
              borderRadius: 4,
              fontWeight: 600,
            }}>
              ▶ Start: {formatTime(extractState.startTime)}
            </span>
            <span style={{ color: '#6b7280' }}>→ now: {formatTime(position || 0)}</span>
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
              onClick={handleCancelExtract}
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
        )}

        {extractState.phase === 'creating' && (
          <span style={{ fontSize: 12, color: '#6b7280' }}>Creating extract...</span>
        )}
      </div>
      <div ref={containerRef} className="flex video-container w-[100%]" style={{ flex: 1, minHeight: 0 }}>
        {width !== 0 && (
          <Resizable
            minWidth="30%"
            maxWidth="70%"
            enable={{ right: true }}
            size={{ width: width || `50%`, height: '100%' }}
            handleClasses={{ right: '!w-[15px] !right-[-15px] z-[3]' }}
            onResizeStart={() => {
              startWidth.current = width;
            }}
            onResize={(___, __, _, delta) => {
              const containerRefCurrent = containerRef.current;

              if (!startWidth.current || !containerRefCurrent) return;
              const newWidth = startWidth.current + delta.width;

              setWidth(
                newWidth || containerRefCurrent.clientWidth * 0.5,
                containerRefCurrent.clientWidth * 0.3,
                containerRefCurrent.clientWidth * 0.7
              );
            }}
            onResizeStop={(___, __, _, delta) => {
              const containerRefCurrent = containerRef.current;

              if (!startWidth.current || !containerRefCurrent) return;
              const newWidth = startWidth.current + delta.width;

              setWidth(
                newWidth || containerRefCurrent.clientWidth * 0.5,
                containerRefCurrent.clientWidth * 0.3,
                containerRefCurrent.clientWidth * 0.7
              );
            }}
          >
            <DocumentViewer width={'100%'} height={'100%'} documentId={props.actionItem.rem._id} />
          </Resizable>
        )}
        <ReactPlayer
          controls
          playing={playing}
          playbackRate={playbackRate}
          ref={player}
          url={props.actionItem.url}
          width="100%"
          height="100%"
          onProgress={(state) => {
            setPosition(state.playedSeconds);
          }}
          onPlaybackRateChange={(speed: any) => {
            setPlaybackRate(parseFloat(speed));
          }}
        />
      </div>
    </div>
  );
};
