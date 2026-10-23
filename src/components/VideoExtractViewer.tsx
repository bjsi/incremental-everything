import { DocumentViewer, usePlugin, useRunAsync } from '@remnote/plugin-sdk';
import React from 'react';
import { Resizable } from 're-resizable';
import { YoutubeHighlightActionItem } from '../lib/incremental_rem/types';
import { extractVideoId } from '../lib/youtube_transcript';
import { PluginYouTubePlayerFrame, useYouTubeBridge } from './PluginYouTubePlayer';

interface VideoExtractViewerProps {
    actionItem: YoutubeHighlightActionItem;
}

const getBoundedWidth = (width: number, minWidth: number, maxWidth: number) =>
    Math.min(Math.max(width, minWidth), maxWidth);

/** Format seconds to MM:SS */
const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

export const VideoExtractViewer: React.FC<VideoExtractViewerProps> = (props) => {
    const { url, startTime, endTime, extract } = props.actionItem;
    const plugin = usePlugin();
    const [width, setWidthInner] = React.useState<number>();

    const startWidth = React.useRef<number>();
    const containerRef = React.useRef<HTMLDivElement>(null);

    const setWidth = (w: number, minW: number, maxW: number) => {
        setWidthInner(getBoundedWidth(w, minW, maxW));
    };

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
                <button
                    onClick={() => {
                        if (width === 0) {
                            setWidthInner(containerRef.current!.clientWidth / 2);
                        } else {
                            setWidthInner(0);
                        }
                    }}
                >
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
            <div ref={containerRef} className="flex video-container w-[100%]" style={{ flex: 1, minHeight: 0 }}>
                {width !== 0 && (
                    <Resizable
                        minWidth="30%"
                        maxWidth="70%"
                        enable={{ right: true }}
                        size={{ width: width || `50%`, height: '100%' }}
                        handleClasses={{ right: '!w-[15px] !right-[-15px] z-[3]' }}
                        onResizeStart={() => {
                            startWidth.current = width;
                        }}
                        onResize={(___, __, _, delta) => {
                            const containerRefCurrent = containerRef.current;
                            if (!startWidth.current || !containerRefCurrent) return;
                            const newWidth = startWidth.current + delta.width;
                            setWidth(
                                newWidth || containerRefCurrent.clientWidth * 0.5,
                                containerRefCurrent.clientWidth * 0.3,
                                containerRefCurrent.clientWidth * 0.7
                            );
                        }}
                        onResizeStop={(___, __, _, delta) => {
                            const containerRefCurrent = containerRef.current;
                            if (!startWidth.current || !containerRefCurrent) return;
                            const newWidth = startWidth.current + delta.width;
                            setWidth(
                                newWidth || containerRefCurrent.clientWidth * 0.5,
                                containerRefCurrent.clientWidth * 0.3,
                                containerRefCurrent.clientWidth * 0.7
                            );
                        }}
                    >
                        <DocumentViewer width={'100%'} height={'100%'} documentId={extract._id} />
                    </Resizable>
                )}
                {!videoId ? (
                    <div className="p-4">Not a YouTube video URL: {url}</div>
                ) : savedRate !== undefined ? (
                    <PluginYouTubePlayerFrame videoId={videoId} start={startTime} />
                ) : null}
            </div>
        </div>
    );
};
