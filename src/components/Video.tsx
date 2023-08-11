import { RemHierarchyEditorTree, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import ReactPlayer from 'react-player/youtube';
import { Resizable } from 're-resizable';
import { useSyncedStorageState } from '@remnote/plugin-sdk';
import { YoutubeActionItem } from '../lib/types';

interface VideoViewerProps {
  actionItem: YoutubeActionItem;
}

const getBoundedWidth = (width: number, minWidth: number, maxWidth: number) =>
  Math.min(Math.max(width, minWidth), maxWidth);

export const VideoViewer: React.FC<VideoViewerProps> = (props) => {
  const [width, setWidthInner] = React.useState<number>();

  const startWidth = React.useRef<number>();
  const containerRef = React.useRef<HTMLDivElement>(null);

  const setWidth = (width: number, minWidth: number, maxWidth: number) => {
    setWidthInner(getBoundedWidth(width, minWidth, maxWidth));
  };

  const [playing, setPlaying] = React.useState(true);

  const playbackRateStorageKey = `${props.actionItem.url}-playbackRate`;
  const positionStorageKey = `${props.actionItem.url}-position`;
  const [position, setPosition] = useSyncedStorageState<number>(positionStorageKey, 0);
  const [playbackRate, setPlaybackRate] = useSyncedStorageState<number>(
    playbackRateStorageKey,
    1.0
  );

  const player = React.useRef<ReactPlayer>(null);

  React.useEffect(() => {
    if (player.current) {
      player.current.seekTo(position);
    }
  }, [player?.current]);

  return (
    <div>
      <div className="top-bar">
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
      </div>
      <div ref={containerRef} className="flex h-[100%] video-container w-[100%]">
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
            <RemHierarchyEditorTree
              className="px-2 box-border"
              width={'100%'}
              height={`calc(100%)`}
              maxHeight={`calc(100%)`}
              remId={props.actionItem.rem._id}
            ></RemHierarchyEditorTree>
          </Resizable>
        )}
        <ReactPlayer
          controls
          playing={playing}
          playbackRate={playbackRate}
          ref={player}
          url={props.actionItem.url}
          width="100%"
          height="100%"
          onProgress={(state) => {
            setPosition(state.playedSeconds);
          }}
          onPlaybackRateChange={(speed: any) => {
            setPlaybackRate(parseFloat(speed));
          }}
        />
      </div>
    </div>
  );
};
