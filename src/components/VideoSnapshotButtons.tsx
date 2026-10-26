import { RemId, RNPlugin, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { AI_OCR_HELPER_URL } from '../lib/ai_ocr';
import { showMessageDialog } from '../lib/message_dialog';
import {
  checkVideoHelper,
  formatVideoTime,
  saveVideoSnapshot,
  VideoHelperStatus,
} from '../lib/video_snapshot';

// 📸 (screenshot) and ✨ (screenshot + transcription) for the video views' top
// bar. Both need the local helper, which is polled: while it can't do the job,
// a greyed-out icon stands in for the button and its tooltip says why.

const POLL_MS = 10_000;
const DONE_MS = 4_000;

export const START_HELPER = `Start it with: python3 scripts/ai_ocr_helper.py (it listens on ${AI_OCR_HELPER_URL}).`;

function unavailableReason(status: VideoHelperStatus, ai: boolean): string | null {
  if (!status.reachable)
    return `Screenshots need the Incremental RemNote helper, which isn't running. ${START_HELPER}`;
  if (!status.frames)
    return (
      "The helper is running but can't take screenshots: it needs yt-dlp and ffmpeg " +
      '(brew install yt-dlp ffmpeg) and a version of scripts/ai_ocr_helper.py with video support. ' +
      'Restart the helper after installing or updating.'
    );
  if (ai && !status.ai)
    return "The helper can't find the claude CLI, so it can take screenshots but not transcribe them.";
  return null;
}

const btn: React.CSSProperties = {
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: 4,
  border: '1px solid #d1d5db',
  backgroundColor: '#f3f4f6',
  fontSize: 12,
};

/** A greyed-out, struck-through icon whose tooltip explains why. */
export const Unavailable: React.FC<{ icon: string; reason: string }> = ({ icon, reason }) => (
  <span
    title={reason}
    style={{
      position: 'relative',
      display: 'inline-block',
      padding: '2px 6px',
      fontSize: 12,
      cursor: 'help',
      filter: 'grayscale(1)',
      opacity: 0.45,
    }}
  >
    {icon}
    <span
      style={{
        position: 'absolute',
        left: 3,
        right: 3,
        top: '50%',
        borderTop: '2px solid #dc2626',
        transform: 'rotate(-35deg)',
      }}
    />
  </span>
);

/** What the helper can do now, polled; null until the first answer. The setter takes a fresh check. */
export function useVideoHelperStatus() {
  const [status, setStatus] = React.useState<VideoHelperStatus | null>(null);
  React.useEffect(() => {
    let alive = true;
    const poll = async () => {
      const next = await checkVideoHelper();
      if (alive) setStatus(next);
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return [status, setStatus] as const;
}

type Stage = 'grabbing' | 'saving' | 'transcribing';
const STAGE_TEXT: Record<Stage, string> = {
  grabbing: '📸 grabbing the frame…',
  saving: '📸 saving…',
  transcribing: '✨ transcribing…',
};

interface VideoSnapshotButtonsProps {
  videoId: string;
  /** The player's current time; read when a button is pressed. */
  time: number | undefined;
  /** Where the "📸 MM:SS" Rems go: the IncRem under review. */
  parentId: RemId;
}

export const VideoSnapshotButtons: React.FC<VideoSnapshotButtonsProps> = ({
  videoId,
  time,
  parentId,
}) => {
  const plugin = usePlugin() as RNPlugin;
  const [status, setStatus] = useVideoHelperStatus();
  const [stage, setStageState] = React.useState<Stage | null>(null);
  // The stage a failure happened in, for its message.
  const stageRef = React.useRef<Stage | null>(null);
  const setStage = (next: Stage | null) => {
    stageRef.current = next;
    setStageState(next);
  };
  const [done, setDone] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), DONE_MS);
    return () => clearTimeout(timer);
  }, [done]);

  const run = async (transcribe: boolean) => {
    if (stage || time === undefined) return;
    const seconds = time;
    setDone(null);
    try {
      const { lines } = await saveVideoSnapshot(plugin, {
        videoId,
        seconds,
        parentId,
        transcribe,
        onProgress: setStage,
      });
      setDone(
        `✓ 📸 ${formatVideoTime(seconds)} added` +
          (transcribe
            ? lines
              ? ` with ${lines} line${lines > 1 ? 's' : ''}`
              : ', no text found'
            : '')
      );
    } catch (e) {
      console.error('[VideoSnapshot]', e);
      await showMessageDialog(plugin, {
        title: transcribe ? 'Screenshot transcription failed' : 'Screenshot failed',
        message: e instanceof Error ? e.message : String(e),
        detail:
          stageRef.current === 'transcribing'
            ? 'The screenshot itself was saved; only the text is missing.'
            : undefined,
        tone: 'error',
      });
      setStatus(await checkVideoHelper());
    } finally {
      setStage(null);
    }
  };

  if (!status) return null;
  if (stage) return <span style={{ fontSize: 12, color: '#6b7280' }}>{STAGE_TEXT[stage]}</span>;

  // Without frames neither button can work: one icon says so for both.
  const shotReason = unavailableReason(status, false);
  if (shotReason) return <Unavailable icon="📸" reason={shotReason} />;
  const aiReason = unavailableReason(status, true);
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      <button
        style={btn}
        onClick={() => run(false)}
        disabled={time === undefined}
        title="Screenshot: save this frame under the IncRem, in a 📸 Rem named after the time"
      >
        📸
      </button>
      {aiReason ? (
        <Unavailable icon="✨" reason={aiReason} />
      ) : (
        <button
          style={btn}
          onClick={() => run(true)}
          disabled={time === undefined}
          title="Screenshot + AI transcription: save this frame and its text, as an outline, under the IncRem"
        >
          📸✨
        </button>
      )}
      {done && <span style={{ fontSize: 12, color: '#15803d' }}>{done}</span>}
    </span>
  );
};
