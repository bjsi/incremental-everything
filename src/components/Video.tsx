import {
  BuiltInPowerupCodes,
  PowerupSlotCodeMap,
  Rem,
  RemHierarchyEditorTree,
  renderWidget,
  usePlugin,
  useRunAsync,
} from '@remnote/plugin-sdk';
import React from 'react';
import ReactPlayer from 'react-player/youtube';
import { Resizable } from 're-resizable';
import { useSyncedStorageState } from '@remnote/plugin-sdk';
import { YoutubeActionItem } from '../lib/types';

// Only loads the YouTube player

interface VideoViewerProps {
  actionItem: YoutubeActionItem;
}

type VideoState = {
  position: number; // current position in the video
  speed: number; // playback speed
};

const getBoundedWidth = (width: number, minWidth: number, maxWidth: number) =>
  Math.min(Math.max(width, minWidth), maxWidth);

export const VideoViewer: React.FC<VideoViewerProps> = (props) => {
  const [width, setWidthInner] = React.useState<number>();

  const startWidth = React.useRef<number>();
  const containerRef = React.useRef<HTMLDivElement>(null);

  const setWidth = (width: number, minWidth: number, maxWidth: number) => {
    setWidthInner(getBoundedWidth(width, minWidth, maxWidth));
  };

  const [videoState, setVideoState] = useSyncedStorageState<VideoState>(props.actionItem.url, {
    position: 0,
    speed: 1,
  });

  const plugin = usePlugin();
  const player = React.useRef<ReactPlayer>(null);

  return (
    <div>
      <div className="top-bar p-1">
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
              width={'100%'}
              height={`calc(100%)`}
              maxHeight={`calc(100%)`}
              remId={props.actionItem.rem._id}
            ></RemHierarchyEditorTree>
          </Resizable>
        )}
        <ReactPlayer
          ref={player}
          url={props.actionItem.url}
          width="100%"
          height="100%"
          onProgress={(state) => {}}
          onPlaybackRateChange={() => {}}
        />
      </div>
    </div>
  );
};
