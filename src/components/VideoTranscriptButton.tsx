import { RNPlugin, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { showMessageDialog } from '../lib/message_dialog';
import {
  addVideoTranscript,
  describeTranscript,
  shouldTidy,
  tidyTranscript,
  TranscriptTarget,
} from '../lib/video_transcript';
import { checkVideoHelper } from '../lib/video_snapshot';
import { START_HELPER, Unavailable, useVideoHelperStatus } from './VideoSnapshotButtons';

// 📜 for the video views' top bar: the transcript of the whole video, or of an
// extract's range, from the video's captions (or its audio, when it has none
// and Whisper is set up). Needs the local helper; while it can't do the job, a
// greyed-out icon stands in and its tooltip says why.

const DONE_MS = 5_000;

const btn: React.CSSProperties = {
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: 4,
  border: '1px solid #d1d5db',
  backgroundColor: '#f3f4f6',
  fontSize: 12,
};

export const VideoTranscriptButton: React.FC<{ target: TranscriptTarget }> = ({ target }) => {
  const plugin = usePlugin() as RNPlugin;
  const [status, setStatus] = useVideoHelperStatus();
  const [stage, setStage] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), DONE_MS);
    return () => clearTimeout(timer);
  }, [done]);

  const run = async () => {
    if (stage) return;
    setStage(status?.whisper ? '📜 fetching the transcript (transcribing the audio can take minutes)…' : '📜 fetching the transcript…');
    setDone(null);
    try {
      const written = await addVideoTranscript(plugin, target);
      const blocks = written.remIds.length;
      let tidied = '';
      if (await shouldTidy(plugin, written)) {
        try {
          await tidyTranscript(plugin, written, (n, total) => setStage(`✨ tidying ${n}/${total}…`));
          tidied = ', tidied';
        } catch (e) {
          console.warn('[VideoTranscript] Could not tidy:', e);
          tidied = ', not tidied';
        }
      }
      setDone(`✓ 📜 ${blocks} block${blocks > 1 ? 's' : ''} (${describeTranscript(written.transcript)}${tidied})`);
    } catch (e) {
      console.error('[VideoTranscript]', e);
      await showMessageDialog(plugin, {
        title: 'Transcript failed',
        message: e instanceof Error ? e.message : String(e),
        tone: 'error',
      });
      setStatus(await checkVideoHelper());
    } finally {
      setStage(null);
    }
  };

  if (!status) return null;
  if (!status.reachable)
    return <Unavailable icon="📜" reason={`Transcripts need the Incremental RemNote helper, which isn't running. ${START_HELPER}`} />;
  if (!status.transcripts)
    return (
      <Unavailable
        icon="📜"
        reason={
          "The helper is running but can't fetch transcripts: it needs yt-dlp (brew install yt-dlp) and a version " +
          'of scripts/ai_ocr_helper.py with transcript support. Restart the helper after installing or updating.'
        }
      />
    );
  if (stage) return <span style={{ fontSize: 12, color: '#6b7280' }}>{stage}</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      <button
        style={btn}
        onClick={run}
        title={
          (target.range
            ? "Transcript of this extract, from the video's captions, added under the extract"
            : "Transcript of the whole video, from its captions, added under the video's Rem in a 📜 Transcript Rem") +
          (status.whisper
            ? ". Without captions, the audio is transcribed on this computer. To transcribe the audio even when there are captions, use the command Add Video Transcript from Audio."
            : '.')
        }
      >
        📜
      </button>
      {done && <span style={{ fontSize: 12, color: '#15803d' }}>{done}</span>}
    </span>
  );
};
