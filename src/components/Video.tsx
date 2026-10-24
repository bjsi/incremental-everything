import { DocumentViewer, RemHierarchyEditorTree, usePlugin, useRunAsync } from '@remnote/plugin-sdk';
import React from 'react';
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
import { PluginYouTubePlayerFrame, useYouTubeBridge, YT_PAUSED, YT_PLAYING } from './PluginYouTubePlayer';
import { VideoNotesSplit } from './VideoNotesSplit';
import { PlayerControls } from './PlayerControls';
import { VideoSnapshotButtons } from './VideoSnapshotButtons';
import { setNativeVideoPosition, setPluginVideoPosition } from '../lib/video_position';

interface VideoViewerProps {
  actionItem: YoutubeActionItem;
  /** Shown for RemNote video Rems: switches the card to RemNote's player. */
  onSwitchPlayer?: () => void;
}

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
  const [notesOpen, setNotesOpen] = React.useState(true);

  const videoId = extractVideoId(props.actionItem.url);
  const playbackRateStorageKey = `${props.actionItem.url}-playbackRate`;
  const positionStorageKey = `${props.actionItem.url}-position`;

  // Both are read once, before the player opens: the position is where it
  // starts, and the speed is applied when the page first answers.
  const saved = useRunAsync(async () => {
    const [position, playbackRate] = await Promise.all([
      plugin.storage.getSynced<number>(positionStorageKey),
      plugin.storage.getSynced<number>(playbackRateStorageKey),
    ]);
    return { position: position ?? 0, playbackRate: playbackRate ?? 1 };
  }, [positionStorageKey]);

  const { info, connected, send } = useYouTubeBridge(saved ? videoId : null, {
    start: saved?.position,
    playbackRate: saved?.playbackRate,
    onRateChange: (rate) => plugin.storage.setSynced(playbackRateStorageKey, rate),
  });
  const position = info.currentTime ?? saved?.position ?? 0;

  // The position is a synced write: save it every few seconds while playing,
  // at once on pause, and when the card closes. Nothing is saved until the
  // video has played from where it should start: before the start seek lands,
  // the page reports 0, or the position an earlier card left it at.
  const lastSaved = React.useRef({ at: 0, position: -1 });
  const latestPosition = React.useRef<number | undefined>();
  const armed = React.useRef(false);
  React.useEffect(() => {
    const t = info.currentTime;
    // Only a playing or paused player says where the video is: a page that
    // has just (re)loaded reports its URL's start time until the seek lands.
    if (t === undefined || (info.playerState !== YT_PLAYING && info.playerState !== YT_PAUSED)) return;
    if (!armed.current && info.playerState === YT_PLAYING && Math.abs(t - (saved?.position ?? 0)) <= 5) {
      armed.current = true;
    }
    if (!armed.current || t === lastSaved.current.position) return;
    latestPosition.current = t;
    const now = Date.now();
    if (info.playerState !== YT_PLAYING || now - lastSaved.current.at > 5000) {
      lastSaved.current = { at: now, position: t };
      plugin.storage.setSynced(positionStorageKey, t);
    }
  }, [info.currentTime, info.playerState]);
  React.useEffect(
    () => () => {
      if (latestPosition.current !== undefined && latestPosition.current !== lastSaved.current.position)
        plugin.storage.setSynced(positionStorageKey, latestPosition.current);
    },
    [positionStorageKey]
  );

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
    send({ command: 'pause' }); // Pause video so user can set priority freely
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

      // Make it incremental — pass explicitParentId so priority inheritance
      // can walk ancestors correctly (the local `newRem` object's .parent is
      // stale after setParent, same pattern as highlightActions.ts reload).
      await initIncrementalRem(plugin as any, newRem, { explicitParentId: props.actionItem.rem._id });

      await plugin.app.toast(`✅ Created video extract [${formatTime(startTime)} – ${formatTime(endTime)}]`);

      // Fetch transcript and add segments as children Rems
      try {
        console.log('[VideoViewer] Attempting transcript fetch for videoId:', videoId, 'range:', startTime, '-', endTime);
        if (videoId) {
          const segments = await getTranscriptForRange(videoId, startTime, endTime);
          if (segments.length > 0) {
            // Consolidate segments into larger chunks (~300 chars each)
            const MAX_CHUNK_CHARS = 300;
            const chunks: string[] = [];
            let current = '';

            for (const seg of segments) {
              const candidate = current ? `${current} ${seg.text}` : seg.text;
              if (current && candidate.length > MAX_CHUNK_CHARS) {
                chunks.push(current);
                current = seg.text;
              } else {
                current = candidate;
              }
            }
            if (current) chunks.push(current);

            for (const chunk of chunks) {
              const childRem = await plugin.rem.createRem();
              if (childRem) {
                await childRem.setText([chunk]);
                await childRem.setParent(newRem._id);
              }
            }
            await plugin.app.toast(`📝 Added transcript (${chunks.length} block${chunks.length > 1 ? 's' : ''})`);
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

  // Leaving for RemNote's player: save where this one is, and put it in
  // RemNote's "Resume watching at…". Before the player has played from the
  // saved start, the time it reports can't be trusted.
  const switchToNative = async () => {
    send({ command: 'pause' });
    const at = armed.current ? latestPosition.current ?? info.currentTime : undefined;
    const seconds = at ?? saved?.position ?? 0;
    try {
      await setPluginVideoPosition(plugin, props.actionItem.url, seconds);
      lastSaved.current = { at: Date.now(), position: seconds };
      await setNativeVideoPosition(props.actionItem.rem, seconds);
    } catch (e) {
      console.error('[VideoViewer] Could not hand the position over:', e);
    }
    props.onSwitchPlayer?.();
  };

  // A RemNote video Rem shown as a document is RemNote's video page, player
  // and all: the host's document view opens a "learning source" (a Rem with the
  // Video, Uploaded File or Link powerup) as its source unless told not to, and
  // the plugin's DocumentViewer can't tell it. The editable tree is the
  // document's body without that switch: the Rem and its children.
  const notes = props.actionItem.nativeAvailable ? (
    <div style={{ padding: '12px 16px' }}>
      <RemHierarchyEditorTree remId={props.actionItem.rem._id} width="100%" height="auto" />
    </div>
  ) : (
    <DocumentViewer width={'100%'} height={'100%'} documentId={props.actionItem.rem._id} />
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="top-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
        <button onClick={() => setNotesOpen((open) => !open)} title="Show or hide the notes">
          📝
        </button>

        {saved && (
          <button
            onClick={() => {
              send({ command: 'seekTo', seconds: saved.position });
              send({ command: 'play' });
            }}
            title="Where the last session stopped. Click to go back there."
            style={{
              cursor: 'pointer',
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid #d1d5db',
              backgroundColor: '#f3f4f6',
              fontSize: 12,
            }}
          >
            {saved.position > 0 ? `⏮ Resumed at ${formatTime(saved.position)}` : '⏮ From the start'}
          </button>
        )}

        {props.onSwitchPlayer && (
          <button
            onClick={switchToNative}
            title="Watch in RemNote's player: transcript, Highlight Moment, AI Tutor and Summary. It offers to resume where you are now."
            style={{
              cursor: 'pointer',
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid #d1d5db',
              backgroundColor: '#f3f4f6',
              fontSize: 12,
            }}
          >
            🎬 RemNote player
          </button>
        )}

        {videoId && <PlayerControls info={info} connected={connected} send={send} />}
        {videoId && (
          <VideoSnapshotButtons videoId={videoId} time={info.currentTime} parentId={props.actionItem.rem._id} />
        )}

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

        {videoId && !connected && (
          <span
            style={{ fontSize: 12, color: '#6b7280' }}
            title="Waiting for the player. In a browser, click play on the video once."
          >
            ⏳ connecting to the player…
          </span>
        )}
      </div>
      <VideoNotesSplit notes={notes} notesOpen={notesOpen}>
        {!videoId ? (
          <div className="p-4">Not a YouTube video URL: {props.actionItem.url}</div>
        ) : saved ? (
          <PluginYouTubePlayerFrame videoId={videoId} start={saved.position} />
        ) : null}
      </VideoNotesSplit>
    </div>
  );
};
