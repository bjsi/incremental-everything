import { DocumentViewer, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { LocalVideoActionItem, LocalVideoHighlightActionItem } from '../lib/incremental_rem/types';
import {
  checkLocalVideo,
  listVideoLibraries,
  localVideoMediaUrl,
  relinkVideoLibrary,
  VideoLibrary,
} from '../lib/local_video';
import { checkVideoHelper, formatVideoTime } from '../lib/video_snapshot';
import { showMessageDialog } from '../lib/message_dialog';
import { useHtmlVideo } from './useHtmlVideo';
import { useSavedVideoSettings, useSaveVideoRate, useVideoPositionSaver } from './useVideoPosition';
import { VideoNotesSplit } from './VideoNotesSplit';
import { PlayerControls } from './PlayerControls';
import { PluginExtractButtons } from './PluginExtractButtons';
import { VideoSnapshotButtons, START_HELPER } from './VideoSnapshotButtons';
import { VideoTranscriptButton } from './VideoTranscriptButton';

// A video file on this computer, played in the plugin's own frame from the
// local helper (lib/local_video.ts): resume, speed, extracts, screenshots and
// transcripts from the audio, as for YouTube. An extract plays its range and
// pauses at its end.

const barButton: React.CSSProperties = {
  cursor: 'pointer',
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid #d1d5db',
  backgroundColor: '#f3f4f6',
  fontSize: 12,
};

/** Why the file can't play, found out once the <video> reports an error. */
type Problem =
  | { kind: 'helper' }
  | { kind: 'library'; library: VideoLibrary | undefined }
  | { kind: 'file' }
  | { kind: 'format'; code: number };

export const LocalVideoViewer: React.FC<{
  actionItem: LocalVideoActionItem | LocalVideoHighlightActionItem;
}> = ({ actionItem }) => {
  const plugin = usePlugin();
  const { file, url } = actionItem;
  const segment =
    actionItem.type === 'local-video-highlight'
      ? { start: actionItem.startTime, end: actionItem.endTime }
      : undefined;
  const notesRemId =
    actionItem.type === 'local-video-highlight' ? actionItem.extract._id : actionItem.rem._id;
  const [notesOpen, setNotesOpen] = React.useState(true);
  // Bumped after a library is re-pointed, to load the file again.
  const [reload, setReload] = React.useState(0);
  const [problem, setProblem] = React.useState<Problem | null>(null);

  const saved = useSavedVideoSettings(url);
  const saveRate = useSaveVideoRate(url);
  const start = segment ? segment.start : saved?.position;
  const src = saved ? `${localVideoMediaUrl(file)}${reload ? `?r=${reload}` : ''}` : null;
  const { info, connected, send, videoRef } = useHtmlVideo(src, {
    start,
    playbackRate: saved?.playbackRate,
    onRateChange: saveRate,
  });
  const position = info.currentTime ?? start ?? 0;
  // A whole video remembers where it was left; an extract always starts at its start.
  useVideoPositionSaver(segment ? `${url}#extract` : url, segment ? {} : info, saved?.position);

  // An extract pauses at its end, once the player has been inside it (before
  // the start seek lands, the time can be anywhere).
  const [armed, setArmed] = React.useState<'waiting' | 'inside' | 'done'>('waiting');
  React.useEffect(() => {
    const t = info.currentTime;
    if (!segment || t === undefined) return;
    if (armed === 'waiting' && t >= segment.start - 1 && t < segment.end) setArmed('inside');
    if (armed === 'inside' && t >= segment.end) {
      send({ command: 'pause' });
      setArmed('done');
    }
  }, [info.currentTime, armed]);

  React.useEffect(() => {
    if (info.errorCode === undefined) return;
    (async () => {
      if (!(await checkVideoHelper()).reachable) return setProblem({ kind: 'helper' });
      const library = (await listVideoLibraries()).find((l) => l.name === file.library);
      if (!library?.available) return setProblem({ kind: 'library', library });
      // MEDIA_ERR_SRC_NOT_SUPPORTED is also what a 404 from the helper gives.
      const fileThere = await checkLocalVideo(file).then(
        () => true,
        () => false
      );
      setProblem(fileThere ? { kind: 'format', code: info.errorCode! } : { kind: 'file' });
    })();
  }, [info.errorCode]);

  const relink = async () => {
    try {
      if (await relinkVideoLibrary(file.library)) {
        setProblem(null);
        setReload((n) => n + 1);
      }
    } catch (e) {
      await showMessageDialog(plugin, {
        title: 'Could not re-point the library',
        message: e instanceof Error ? e.message : String(e),
        tone: 'error',
      });
    }
  };

  const problemText = (p: Problem): React.ReactNode => {
    switch (p.kind) {
      case 'helper':
        return `Local videos are played by the Incremental RemNote helper, which isn't running. ${START_HELPER}`;
      case 'library':
        return p.library ? (
          <>
            The folder of the video library “{file.library}” isn't available: {p.library.root}.
            Connect the disk it is on, or, if the folder has moved,{' '}
            <button style={barButton} onClick={relink}>
              📁 show where it is now
            </button>
          </>
        ) : (
          `The helper has no video library called “${file.library}”. Link the video again with Link Local Video.`
        );
      case 'file':
        return `The file isn't in the library “${file.library}” any more: ${file.path}. Link it again with Link Local Video.`;
      case 'format':
        return `The video can't be played here (media error ${p.code}): RemNote's player opens MP4, M4V, MOV and WebM in the codecs Chromium supports.`;
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        className="top-bar"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px',
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <button onClick={() => setNotesOpen((open) => !open)} title="Show or hide the notes">
          📝
        </button>

        {segment ? (
          <>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                backgroundColor: '#fecaca',
                color: '#7f1d1d',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              ✂️ {formatVideoTime(segment.start)} – {formatVideoTime(segment.end)}
            </span>
            <button
              style={barButton}
              title="Replay this segment"
              onClick={() => {
                send({ command: 'seekTo', seconds: segment.start });
                send({ command: 'play' });
                setArmed('waiting');
              }}
            >
              🔄 Replay
            </button>
          </>
        ) : (
          saved && (
            <button
              style={barButton}
              title="Where the last session stopped. Click to go back there."
              onClick={() => {
                send({ command: 'seekTo', seconds: saved.position });
                send({ command: 'play' });
              }}
            >
              {saved.position > 0
                ? `⏮ Resumed at ${formatVideoTime(saved.position)}`
                : '⏮ From the start'}
            </button>
          )
        )}

        <PlayerControls info={info} connected={connected} send={send} />
        <VideoSnapshotButtons source={{ file }} time={info.currentTime} parentId={notesRemId} />
        <VideoTranscriptButton target={{ parentId: notesRemId, url, range: segment }} />
        {!segment && (
          <PluginExtractButtons
            position={position}
            pause={() => send({ command: 'pause' })}
            parentId={actionItem.rem._id}
            url={url}
          />
        )}
        {armed === 'done' && (
          <span style={{ fontSize: 12, color: '#6b7280' }}>✓ end of extract reached</span>
        )}
      </div>
      <VideoNotesSplit
        notes={<DocumentViewer width={'100%'} height={'100%'} documentId={notesRemId} />}
        notesOpen={notesOpen}
      >
        {/* The video side takes what the notes leave; width 100% alone would be the whole split. */}
        <div style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
          {problem ? (
            <div className="p-4" style={{ fontSize: 13, lineHeight: 1.5 }}>
              {problemText(problem)}
            </div>
          ) : (
            src && (
              <video
                key={src}
                ref={videoRef}
                src={src}
                controls
                preload="metadata"
                style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
              />
            )
          )}
        </div>
      </VideoNotesSplit>
    </div>
  );
};
