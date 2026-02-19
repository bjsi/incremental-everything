import { DocumentViewer, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import ReactPlayer from 'react-player/youtube';
import { Resizable } from 're-resizable';
import { useSyncedStorageState } from '@remnote/plugin-sdk';
import { YoutubeHighlightActionItem } from '../lib/incremental_rem/types';

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

    const [playing, setPlaying] = React.useState(true);

    const playbackRateStorageKey = `${url}-playbackRate`;
    const [playbackRate, setPlaybackRate] = useSyncedStorageState<number>(
        playbackRateStorageKey,
        1.0
    );

    const player = React.useRef<ReactPlayer>(null);
    const didInitialSeek = React.useRef(false);

    // Seek to startTime on mount
    React.useEffect(() => {
        if (player.current && !didInitialSeek.current) {
            didInitialSeek.current = true;
            player.current.seekTo(startTime, 'seconds');
        }
    }, [player?.current, startTime]);

    // Pause when reaching endTime
    const handleProgress = (state: { playedSeconds: number }) => {
        if (state.playedSeconds >= endTime) {
            setPlaying(false);
        }
    };

    // Allow replaying the segment
    const handleReplay = () => {
        if (player.current) {
            player.current.seekTo(startTime, 'seconds');
            setPlaying(true);
        }
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
                <ReactPlayer
                    controls
                    playing={playing}
                    playbackRate={playbackRate}
                    ref={player}
                    url={url}
                    width="100%"
                    height="100%"
                    onProgress={handleProgress}
                    onPlaybackRateChange={(speed: any) => {
                        setPlaybackRate(parseFloat(speed));
                    }}
                />
            </div>
        </div>
    );
};
