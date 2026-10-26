import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useEffect, useState } from 'react';
import {
  dismissEditorReview,
  editorTimerElapsedMs,
  endEditorReview,
  formatEditorTimer,
  hasReturnOrigin,
  nextEditorReview,
  pauseEditorTimer,
  readEditorTimer,
  resumeEditorTimer,
} from '../lib/editor_review_session';
import { safeRemTextToString } from '../lib/pdfUtils';
import { startIncRemEngagement, endIncRemEngagement } from '../lib/queue_session';
import { formatVideoTime } from '../lib/video_snapshot';
import { nativeVideoUrl } from '../lib/video_position';
import { useNativeVideoMirror } from '../components/useNativeVideoMirror';
import { NativeExtractButtons } from '../components/NativeExtractButtons';
import { VideoTranscriptButton } from '../components/VideoTranscriptButton';

// The Editor Review Timer's controls over RemNote's video page, where the timer
// bar itself can't show. Opened and closed by lib/video_review_bar.ts.

const btn = (background: string): React.CSSProperties => ({
  padding: '5px 10px',
  fontSize: 12,
  fontWeight: 600,
  backgroundColor: background,
  color: 'white',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
});

function VideoReviewBar() {
  const plugin = usePlugin();
  const timer = useTrackerPlugin(async (rp) => readEditorTimer(rp), []);
  const remId = timer?.remId;
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // The timer bar counts the review for Practiced Queues; it isn't mounted here.
  useEffect(() => {
    if (!remId) return;
    startIncRemEngagement(plugin, remId);
    return () => {
      endIncRemEngagement(plugin);
    };
  }, [remId]);

  const video = useTrackerPlugin(
    async (rp) => {
      if (!remId) return null;
      const rem = await rp.rem.findOne(remId);
      if (!rem) return null;
      return { url: await nativeVideoUrl(rem), name: await safeRemTextToString(rp, rem.text) };
    },
    [remId]
  );
  // Keeps where RemNote's player is as the plugin's position, as it plays.
  const { position } = useNativeVideoMirror(remId, video?.url, true);

  if (!timer || !timer.startTime) return null;

  const isPaused = !!timer.pausedAt;
  const elapsedMs = editorTimerElapsedMs(timer, now);
  const reviewName = video?.name && video.name !== 'Untitled' ? video.name : timer.remName;
  const displayName = reviewName.length > 32 ? reviewName.substring(0, 29) + '…' : reviewName;
  const closing = { elapsedMs, host: undefined, reviewName };
  const queueLeft = timer.queueList.length;

  // One press at a time: each of these moves the review on.
  const run = (action: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        fontSize: 12,
        whiteSpace: 'nowrap',
        backgroundColor: '#dbeafe',
        color: '#1e3a8a',
        border: '1px solid #3b82f6',
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      }}
    >
      <span style={{ fontSize: 15 }}>{isPaused ? '⏸️' : '⏱️'}</span>
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
        <span style={{ fontWeight: 600, color: isPaused ? '#92400e' : '#1e40af' }} title={reviewName}>
          {displayName}
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          <b style={{ fontSize: 14 }}>{formatEditorTimer(elapsedMs)}</b>
          <span
            style={{ marginLeft: 8, color: '#475569' }}
            title="Where RemNote's player is (it reports every few seconds while playing). The plugin's player resumes from here."
          >
            🎬 {position ? formatVideoTime(position) : '—'}
          </span>
        </span>
      </span>

      {video?.url && <NativeExtractButtons parentId={timer.remId} url={video.url} position={position} />}
      {video?.url && <VideoTranscriptButton target={{ parentId: timer.remId, url: video.url }} />}

      <button
        style={btn(isPaused ? '#f59e0b' : '#6b7280')}
        onClick={run(() => (isPaused ? resumeEditorTimer(plugin, timer) : pauseEditorTimer(plugin, timer)))}
        title={isPaused ? 'Resume the review timer' : 'Pause the review timer'}
      >
        {isPaused ? '▶ Resume' : '⏸'}
      </button>
      {queueLeft > 0 && (
        <button
          style={btn('#10b981')}
          onClick={run(() => nextEditorReview(plugin, timer, closing))}
          title={`Save & move to the next item (${queueLeft} left)`}
        >
          Next ({queueLeft}) →
        </button>
      )}
      {hasReturnOrigin(timer) && (
        <button
          style={btn(queueLeft > 0 ? '#6b7280' : '#10b981')}
          onClick={run(() => endEditorReview(plugin, timer, closing, true))}
          title={timer.origin === 'queue' ? 'End the review and go back to the queue' : 'End the review and go back to the IncRem list'}
        >
          ✓ End & Back
        </button>
      )}
      <button
        style={btn(hasReturnOrigin(timer) ? '#6b7280' : '#10b981')}
        onClick={run(() => endEditorReview(plugin, timer, closing, false))}
        title="End the review and stay here"
      >
        ✓ End
      </button>
      <button
        style={btn('#ef4444')}
        onClick={run(() => dismissEditorReview(plugin, timer, closing))}
        title={
          queueLeft > 0
            ? 'Dismiss: remove incremental status, add Dismissed powerup, and advance to the next item'
            : 'Dismiss: remove incremental status, add Dismissed powerup, and end the timer'
        }
      >
        ✓ Dismiss
      </button>
    </div>
  );
}

renderWidget(VideoReviewBar);
