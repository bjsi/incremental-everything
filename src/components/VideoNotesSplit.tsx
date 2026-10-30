import { usePlugin } from '@remnote/plugin-sdk';
import React from 'react';

// Notes on the left, the video on the right, with a draggable divider between
// them. Both sides are usually host-drawn layers over the plugin iframe, so the divider gets its own strip between them: a
// handle overlapping either side would sit under the host layer and never see
// the mouse. Pointer capture keeps the drag going when the pointer crosses
// onto a side.

const SPLIT_KEY = 'video-notes-split';
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;
const KEY_STEP = 0.05;

const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));

interface VideoNotesSplitProps {
  /** What the left side shows: usually a DocumentViewer of the IncRem. */
  notes: React.ReactNode;
  notesOpen: boolean;
  /** The video side. */
  children: React.ReactNode;
}

export const VideoNotesSplit: React.FC<VideoNotesSplitProps> = ({
  notes,
  notesOpen,
  children,
}) => {
  const plugin = usePlugin();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = React.useState(0.5);
  const [dragging, setDragging] = React.useState(false);
  const [hot, setHot] = React.useState(false);
  const ratioRef = React.useRef(ratio);
  ratioRef.current = ratio;

  // The split is per device: what fits depends on the screen.
  React.useEffect(() => {
    plugin.storage
      .getLocal<number>(SPLIT_KEY)
      .then((r) => {
        if (typeof r === 'number') setRatio(clampRatio(r));
      })
      .catch(() => {});
  }, []);
  const saveRatio = () => plugin.storage.setLocal(SPLIT_KEY, ratioRef.current).catch(() => {});

  const ratioAt = (clientX: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return ratioRef.current;
    return clampRatio((clientX - box.left) / box.width);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging) setRatio(ratioAt(e.clientX));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    saveRatio();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -KEY_STEP : e.key === 'ArrowRight' ? KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    ratioRef.current = clampRatio(ratioRef.current + step);
    setRatio(ratioRef.current);
    saveRatio();
  };

  return (
    <div
      ref={containerRef}
      className="flex video-container w-[100%]"
      style={{ flex: 1, minHeight: 0, cursor: dragging ? 'col-resize' : undefined }}
    >
      {notesOpen && (
        <>
          <div style={{ width: `${ratio * 100}%`, height: '100%', flexShrink: 0, overflow: 'auto' }}>
            {notes}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            tabIndex={0}
            title="Drag to resize (or focus and use ← →)"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onKeyDown}
            onPointerEnter={() => setHot(true)}
            onPointerLeave={() => setHot(false)}
            onFocus={() => setHot(true)}
            onBlur={() => setHot(false)}
            style={{
              width: 10,
              flexShrink: 0,
              cursor: 'col-resize',
              touchAction: 'none',
              display: 'flex',
              justifyContent: 'center',
              outline: 'none',
            }}
          >
            <div
              style={{
                width: dragging || hot ? 3 : 1,
                height: '100%',
                background: dragging || hot
                  ? 'var(--rn-clr-blue, #3b82f6)'
                  : 'var(--rn-clr-border-primary, #d1d5db)',
              }}
            />
          </div>
        </>
      )}
      {children}
    </div>
  );
};
