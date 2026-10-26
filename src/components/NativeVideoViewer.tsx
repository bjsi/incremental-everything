import { DocumentViewer, PluginRem, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  getNativeVideoPosition,
  getPluginVideoPosition,
  setNativeVideoPosition,
  setPluginVideoPosition,
} from '../lib/video_position';
import { useNativeVideoMirror } from './useNativeVideoMirror';

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

/**
 * RemNote's own video page for a video Rem: a DocumentViewer of the Rem shows
 * its player, transcript, Highlight Moment, AI Tutor and Summary.
 */
export const NativeVideoViewer: React.FC<NativeVideoViewerProps> = ({ actionItem, url, onSwitchPlayer }) => {
  const plugin = usePlugin();
  const remId = actionItem.rem._id;
  // Without a URL there is nothing to keep in step: show the page at once.
  const [prepared, setPrepared] = React.useState(!url);
  // While RemNote's player plays, its position is copied back.
  const { mirrored } = useNativeVideoMirror(remId, url, prepared);

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
