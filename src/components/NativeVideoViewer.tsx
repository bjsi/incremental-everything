import { DocumentViewer, PluginRem, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  getNativeVideoPosition,
  getPluginVideoPosition,
  setNativeVideoPosition,
  setPluginVideoPosition,
} from '../lib/video_position';

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
}

const LOG = '[NativeVideo]';
// ip.l is written every 3 s while playing; smaller moves aren't worth a write.
const MIN_MOVE_SECONDS = 2;

/**
 * RemNote's own video page for a video Rem: a DocumentViewer of the Rem shows
 * its player, transcript, Highlight Moment, AI Tutor and Summary.
 */
export const NativeVideoViewer: React.FC<NativeVideoViewerProps> = ({ actionItem, url, onSwitchPlayer }) => {
  const plugin = usePlugin();
  const remId = actionItem.rem._id;
  // Without a URL there is nothing to keep in step: show the page at once.
  const [prepared, setPrepared] = React.useState(!url);
  const mirrored = React.useRef<number | undefined>();

  // Before the page opens, put the plugin's position in "Resume watching at…".
  React.useEffect(() => {
    if (!url) return;
    let cancelled = false;
    (async () => {
      try {
        const seconds = await getPluginVideoPosition(plugin, url);
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
  }, [remId, url]);

  // While RemNote's player plays, copy its position back. Zero is skipped: the
  // page very likely resets ip.l to 0 when it opens, before anything is played.
  const nativePosition = useTrackerPlugin(
    async (rp) => {
      const rem = await rp.rem.findOne(remId);
      return rem ? getNativeVideoPosition(rem) : undefined;
    },
    [remId]
  );
  React.useEffect(() => {
    if (!url || !prepared || !nativePosition) return;
    if (mirrored.current !== undefined && Math.abs(nativePosition - mirrored.current) < MIN_MOVE_SECONDS) return;
    mirrored.current = nativePosition;
    setPluginVideoPosition(plugin, url, nativePosition).catch((e) =>
      console.error(LOG, 'Could not save the position:', e)
    );
  }, [nativePosition, prepared]);

  const switchToPlugin = async () => {
    if (url) {
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
      {onSwitchPlayer && (
        <div className="top-bar" style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
          <button
            onClick={switchToPlugin}
            title="Watch in the plugin's player: resume, speed, extracts and screenshots. It resumes where RemNote's player is now."
            style={{
              cursor: 'pointer',
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid #d1d5db',
              backgroundColor: '#f3f4f6',
              fontSize: 12,
            }}
          >
            ▶️ Plugin player
          </button>
        </div>
      )}
      <div className="flex video-container w-[100%]" style={{ flex: 1, minHeight: 0 }}>
        {prepared && <DocumentViewer width={'100%'} height={'100%'} documentId={remId} />}
      </div>
    </div>
  );
};
