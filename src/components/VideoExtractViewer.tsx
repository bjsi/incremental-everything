import { usePlugin, useRunAsync } from '@remnote/plugin-sdk';
import React from 'react';
import { YoutubeHighlightActionItem } from '../lib/incremental_rem/types';
import { extractVideoId } from '../lib/youtube_transcript';
import { PluginYouTubePlayerFrame, useYouTubeBridge } from './PluginYouTubePlayer';
import { VideoNotesSplit } from './VideoNotesSplit';

interface VideoExtractViewerProps {
    actionItem: YoutubeHighlightActionItem;
}

/** Format seconds to MM:SS */
const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

export const VideoExtractViewer: React.FC<VideoExtractViewerProps> = (props) => {
    const { url, startTime, endTime, extract } = props.actionItem;
    const plugin = usePlugin();
    const [notesOpen, setNotesOpen] = React.useState(true);

    const videoId = extractVideoId(url);
    const playbackRateStorageKey = `${url}-playbackRate`;
    const savedRate = useRunAsync(
        async () => (await plugin.storage.getSynced<number>(playbackRateStorageKey)) ?? 1,
        [playbackRateStorageKey]
    );

    const { info, connected, send } = useYouTubeBridge(savedRate !== undefined ? videoId : null, {
        start: startTime,
        playbackRate: savedRate,
    });

    React.useEffect(() => {
        if (info.playbackRate && savedRate !== undefined && info.playbackRate !== savedRate) {
            plugin.storage.setSynced(playbackRateStorageKey, info.playbackRate);
        }
    }, [info.playbackRate]);

    // Pause at endTime. The auto-pause arms only once the player reports a time
    // inside the segment: until the start seek lands, the time it reports is
    // the old position, often already past the end.
    const [armed, setArmed] = React.useState<'waiting' | 'inside' | 'done'>('waiting');
    React.useEffect(() => {
        const t = info.currentTime;
        if (t === undefined) return;
        if (armed === 'waiting' && t >= startTime - 1 && t < endTime) setArmed('inside');
        if (armed === 'inside' && t >= endTime) {
            send({ command: 'pause' });
            setArmed('done');
        }
    }, [info.currentTime, armed]);

    // Allow replaying the segment
    const handleReplay = () => {
        send({ command: 'seekTo', seconds: startTime });
        send({ command: 'play' });
        setArmed('waiting');
    };

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div className="top-bar" style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
                <button onClick={() => setNotesOpen((open) => !open)} title="Show or hide the notes">
                    📝
                </button>

                {/* Segment info badge */}
                <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    borderRadius: 4,
                    backgroundColor: '#fecaca',
                    color: '#7f1d1d',
                    fontSize: 12,
                    fontWeight: 600,
                }}>
                    ✂️ {formatTime(startTime)} – {formatTime(endTime)}
                </span>

                <button
                    onClick={handleReplay}
                    title="Replay this segment"
                    style={{
                        cursor: 'pointer',
                        padding: '2px 8px',
                        borderRadius: 4,
                        border: '1px solid #d1d5db',
                        backgroundColor: '#f3f4f6',
                        fontSize: 12,
                    }}
                >
                    🔄 Replay
                </button>

                {armed === 'done' && (
                    <span style={{ fontSize: 12, color: '#6b7280' }}>✓ end of extract reached</span>
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
            <VideoNotesSplit notesDocId={extract._id} notesOpen={notesOpen}>
                {!videoId ? (
                    <div className="p-4">Not a YouTube video URL: {url}</div>
                ) : savedRate !== undefined ? (
                    <PluginYouTubePlayerFrame videoId={videoId} start={startTime} />
                ) : null}
            </VideoNotesSplit>
        </div>
    );
};
