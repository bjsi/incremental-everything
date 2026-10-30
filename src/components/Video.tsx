import { DocumentViewer, RemHierarchyEditorTree, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { YoutubeActionItem } from '../lib/incremental_rem';
import { extractVideoId } from '../lib/youtube_transcript';
import { PluginYouTubePlayerFrame, useYouTubeBridge } from './PluginYouTubePlayer';
import { PluginExtractButtons } from './PluginExtractButtons';
import { videoPositionKey } from '../lib/video_position';
import { useSavedVideoSettings, useSaveVideoRate, useVideoPositionSaver } from './useVideoPosition';
import { VideoNotesSplit } from './VideoNotesSplit';
import { PlayerControls } from './PlayerControls';
import { VideoSnapshotButtons } from './VideoSnapshotButtons';
import { VideoTranscriptButton } from './VideoTranscriptButton';
import { setNativeVideoPosition, setPluginVideoPosition } from '../lib/video_position';
import { safeRemTextToString } from '../lib/pdfUtils';

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

export const VideoViewer: React.FC<VideoViewerProps> = (props) => {
  const plugin = usePlugin();
  const [notesOpen, setNotesOpen] = React.useState(true);

  const videoId = extractVideoId(props.actionItem.url);
  // Where the last session stopped and at what speed, read once before the player opens.
  const saved = useSavedVideoSettings(props.actionItem.url);
  const saveRate = useSaveVideoRate(props.actionItem.url);

  const { info, connected, send } = useYouTubeBridge(saved ? videoId : null, {
    start: saved?.position,
    playbackRate: saved?.playbackRate,
    onRateChange: saveRate,
  });
  const position = info.currentTime ?? saved?.position ?? 0;
  const { armed, latestPosition, lastSaved } = useVideoPositionSaver(
    videoPositionKey(props.actionItem.url),
    info,
    saved?.position
  );

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
  // document's body without that switch: the Rem's children. The tree leaves
  // out the Rem itself, so its name is drawn here as the document title.
  const remId = props.actionItem.rem._id;
  const title = useTrackerPlugin(
    async (rp) => {
      if (!props.actionItem.nativeAvailable) return undefined;
      const rem = await rp.rem.findOne(remId);
      return rem ? safeRemTextToString(rp, rem.text) : undefined;
    },
    [remId, props.actionItem.nativeAvailable]
  );
  const notes = props.actionItem.nativeAvailable ? (
    <div style={{ padding: '12px 16px' }}>
      {title && (
        <h1
          style={{
            margin: '0 0 12px 22px',
            fontSize: 26,
            fontWeight: 700,
            lineHeight: 1.25,
            color: 'var(--rn-clr-content-primary)',
          }}
        >
          {title}
        </h1>
      )}
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
          <VideoSnapshotButtons source={{ videoId }} time={info.currentTime} parentId={props.actionItem.rem._id} />
        )}
        {videoId && <VideoTranscriptButton target={{ parentId: props.actionItem.rem._id, url: props.actionItem.url }} />}

        <PluginExtractButtons
          position={position}
          pause={() => send({ command: 'pause' })}
          parentId={props.actionItem.rem._id}
          url={props.actionItem.url}
        />

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
