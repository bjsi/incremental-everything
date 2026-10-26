import { DocumentViewer, PluginRem, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  getNativeVideoPosition,
  getPluginVideoPosition,
  setNativeVideoPosition,
  setPluginVideoPosition,
} from '../lib/video_position';
import { formatVideoTime } from '../lib/video_snapshot';
import { useNativeVideoMirror } from './useNativeVideoMirror';
import { NativeExtractButtons } from './NativeExtractButtons';
import { VideoTranscriptButton } from './VideoTranscriptButton';

interface NativeVideoViewerProps {
  actionItem: {
    rem: PluginRem;
    type: string;
  };
  /**
   * The video's URL, when the plugin's player can show it too. Positions are
   * then kept in step with the plugin's player, and `onSwitchPlayer` offers it.
   */
  url?: string;
  onSwitchPlayer?: () => void;
  /**
   * Shows a Video Extract of this video: RemNote's player is offered its start
   * instead of the video's position, which is left alone.
   */
  segment?: { start: number; end: number };
  /** The extract's Rem, when `segment` is shown: 📜 puts the range's transcript under it. */
  extractId?: string;
}

const barButton: React.CSSProperties = {
  cursor: 'pointer',
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid #d1d5db',
  backgroundColor: '#f3f4f6',
  fontSize: 12,
};

const LOG = '[NativeVideo]';

/**
 * RemNote's own video page for a video Rem: a DocumentViewer of the Rem shows
 * its player, transcript, Highlight Moment, AI Tutor and Summary.
 */
export const NativeVideoViewer: React.FC<NativeVideoViewerProps> = ({
  actionItem,
  url,
  onSwitchPlayer,
  segment,
  extractId,
}) => {
  const plugin = usePlugin();
  const remId = actionItem.rem._id;
  // Without a URL there is nothing to keep in step: show the page at once.
  const [prepared, setPrepared] = React.useState(!url);
  // While RemNote's player plays, its position is copied back; not while an
  // extract plays, which isn't where the video was left.
  const { position, mirrored } = useNativeVideoMirror(remId, url, prepared && !segment);
  // An extract's end counts as reached only once the player has reported a
  // time inside it: until then ip.l may still hold where the video was before.
  const [segmentState, setSegmentState] = React.useState<'waiting' | 'inside' | 'reached'>('waiting');
  React.useEffect(() => {
    if (!segment || !prepared || position === undefined) return;
    if (segmentState === 'waiting' && position >= segment.start - 1 && position < segment.end) setSegmentState('inside');
    if (segmentState === 'inside' && position >= segment.end) setSegmentState('reached');
  }, [position, prepared, segmentState]);
  const endReached = segmentState === 'reached';

  // Before the page opens, put the plugin's position (or the extract's start)
  // in "Resume watching at…".
  React.useEffect(() => {
    if (!url) return;
    let cancelled = false;
    (async () => {
      try {
        const seconds = segment ? segment.start : await getPluginVideoPosition(plugin, url);
        if (seconds > 0) {
          await setNativeVideoPosition(actionItem.rem, seconds);
          mirrored.current = seconds;
        }
      } catch (e) {
        console.error(LOG, 'Could not set the resume time:', e);
      }
      if (!cancelled) setPrepared(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [remId, url, segment?.start]);

  const switchToPlugin = async () => {
    if (url && !segment) {
      try {
        const rem = await plugin.rem.findOne(remId);
        const seconds = rem ? await getNativeVideoPosition(rem) : undefined;
        if (seconds) await setPluginVideoPosition(plugin, url, seconds);
      } catch (e) {
        console.error(LOG, 'Could not save the position:', e);
      }
    }
    onSwitchPlayer?.();
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {(onSwitchPlayer || url) && (
        <div
          className="top-bar"
          style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', flexShrink: 0, fontSize: 12 }}
        >
          {onSwitchPlayer && (
            <button
              onClick={switchToPlugin}
              title={
                segment
                  ? "Watch the extract in the plugin's player, which stops at its end."
                  : "Watch in the plugin's player: resume, speed, extracts and screenshots. It resumes where RemNote's player is now."
              }
              style={barButton}
            >
              ▶️ Plugin player
            </button>
          )}
          {segment ? (
            <>
              <span
                style={{ padding: '2px 8px', borderRadius: 4, backgroundColor: '#fecaca', color: '#7f1d1d', fontWeight: 600 }}
                title="RemNote's player is offered the start as “Resume watching at…”, once it has played this video before. It can't be stopped at the end: watch for “reached”."
              >
                ✂️ {formatVideoTime(segment.start)} – {formatVideoTime(segment.end)}
              </span>
              <span style={{ color: endReached ? '#15803d' : '#6b7280' }}>
                {endReached
                  ? '✓ end of extract reached'
                  : `ends at ${formatVideoTime(segment.end)} · now ${position !== undefined ? formatVideoTime(position) : '—'}`}
              </span>
              {url && extractId && <VideoTranscriptButton target={{ parentId: extractId, url, range: segment }} />}
            </>
          ) : (
            url && (
              <>
                <NativeExtractButtons parentId={remId} url={url} position={position} />
                <VideoTranscriptButton target={{ parentId: remId, url }} />
              </>
            )
          )}
        </div>
      )}
      <div className="flex video-container w-[100%]" style={{ flex: 1, minHeight: 0 }}>
        {prepared && <DocumentViewer width={'100%'} height={'100%'} documentId={remId} />}
      </div>
    </div>
  );
};
