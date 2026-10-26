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
import { localVideoQueueNotesKey } from '../lib/consts';
import { showMessageDialog } from '../lib/message_dialog';
import { useHtmlVideo } from './useHtmlVideo';
import {
  useExtractResume,
  useSavedVideoSettings,
  useSaveVideoRate,
  useVideoPositionSaver,
} from './useVideoPosition';
import { extractPositionKey, videoPositionKey } from '../lib/video_position';
import { VideoNotesSplit } from './VideoNotesSplit';
import { PlayerControls } from './PlayerControls';
import { PluginExtractButtons } from './PluginExtractButtons';
import { VideoSnapshotButtons, START_HELPER } from './VideoSnapshotButtons';
import { VideoTranscriptButton } from './VideoTranscriptButton';

// A video file on this computer, played in the plugin's own frame from the
// local helper (lib/local_video.ts): resume, speed, extracts, screenshots and
// transcripts from the audio, as for YouTube. An extract plays its range and
// pauses at its end. In the queue the notes sit beside the video; in the
// editor (widgets/local_video_editor.tsx) the document is the notes, so the
// video comes alone, above it.

const barButton: React.CSSProperties = {
  cursor: 'pointer',
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid #d1d5db',
  backgroundColor: '#f3f4f6',
  fontSize: 12,
};

export const QUEUE_NOTES_REFRESH_MS = 2000;

/** Why the file can't play, found out once the <video> reports an error. */
type Problem =
  | { kind: 'helper' }
  | { kind: 'library'; library: VideoLibrary | undefined }
  | { kind: 'file' }
  | { kind: 'format'; code: number };

export const LocalVideoViewer: React.FC<{
  actionItem: LocalVideoActionItem | LocalVideoHighlightActionItem;
  /** Under the document's title: no notes pane, the video at 16:9 of the width. */
  inEditor?: boolean;
  /** Start playing once loaded (default). */
  autoplay?: boolean;
}> = ({ actionItem, inEditor, autoplay = true }) => {
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

  // The notes pane below hosts the editor player widget too; tell it to stay
  // empty. Refreshed, so a frame torn down without cleanup lets it go.
  React.useEffect(() => {
    if (inEditor) return;
    const announce = () =>
      plugin.storage.setSession(localVideoQueueNotesKey, { remId: notesRemId, at: Date.now() });
    announce();
    const timer = setInterval(announce, QUEUE_NOTES_REFRESH_MS);
    return () => {
      clearInterval(timer);
      plugin.storage.setSession(localVideoQueueNotesKey, null);
    };
  }, [notesRemId, inEditor]);

  const saved = useSavedVideoSettings(url);
  const saveRate = useSaveVideoRate(url);
  // An extract has its own position: where its last review stopped, or its start.
  const extractResume = useExtractResume(segment && notesRemId, segment);
  const start = segment ? extractResume?.start : saved?.position;
  const ready = !!saved && (!segment || !!extractResume);
  const src = ready ? `${localVideoMediaUrl(file)}${reload ? `?r=${reload}` : ''}` : null;
  const { info, connected, send, videoRef } = useHtmlVideo(src, {
    start,
    playbackRate: saved?.playbackRate,
    autoplay,
    onRateChange: saveRate,
  });
  const position = info.currentTime ?? start ?? 0;
  useVideoPositionSaver(
    segment ? extractPositionKey(notesRemId) : videoPositionKey(url),
    info,
    start
  );

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

  const player = problem ? (
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
  );

  return (
    <div
      style={{ height: inEditor ? undefined : '100%', display: 'flex', flexDirection: 'column' }}
    >
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
        {!inEditor && (
          <button onClick={() => setNotesOpen((open) => !open)} title="Show or hide the notes">
            📝
          </button>
        )}

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
            {extractResume?.resumed && (
              <button
                style={barButton}
                title="Where the last review of this extract stopped. Click to go back there."
                onClick={() => {
                  send({ command: 'seekTo', seconds: extractResume.start });
                  send({ command: 'play' });
                }}
              >
                ⏮ Resumed at {formatVideoTime(extractResume.start)}
              </button>
            )}
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
      {inEditor ? (
        <div style={{ width: '100%', aspectRatio: problem ? undefined : '16 / 9', marginTop: 4 }}>
          {player}
        </div>
      ) : (
        <VideoNotesSplit
          notes={<DocumentViewer width={'100%'} height={'100%'} documentId={notesRemId} />}
          notesOpen={notesOpen}
        >
          {/* The video side takes what the notes leave; width 100% alone would be the whole split. */}
          <div style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>{player}</div>
        </VideoNotesSplit>
      )}
    </div>
  );
};
