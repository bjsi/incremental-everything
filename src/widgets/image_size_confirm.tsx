import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import {
  ImageSizeConfirmContext,
  ImageSizeConfirmThumb,
  imageSizeRequestKey,
  ImageSizeRequest,
  newImageSizeRequestId,
} from '../lib/image_size_session';

/** The Enter that ran a command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;

const NOT_SIZED = 'Not sized';

function ImageGroup({
  title,
  group,
}: {
  title: string;
  group: ImageSizeConfirmContext['userSized'];
}) {
  if (group.count === 0) return null;
  const more = group.count - group.thumbs.length;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-secondary)' }}>
        {title} ({group.count})
      </div>
      <div className="flex flex-wrap gap-2">
        {group.thumbs.map((thumb, i) => (
          <Thumb key={i} thumb={thumb} />
        ))}
        {more > 0 && (
          <div
            className="flex items-center justify-center text-xs rounded"
            style={{
              width: 72,
              height: 54,
              color: 'var(--rn-clr-content-tertiary)',
              background: 'var(--rn-clr-background-secondary)',
            }}
          >
            +{more} more
          </div>
        )}
      </div>
    </div>
  );
}

function Thumb({ thumb }: { thumb: ImageSizeConfirmThumb }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex flex-col items-center gap-0.5" style={{ width: 72 }}>
      <div
        className="flex items-center justify-center rounded overflow-hidden"
        style={{
          width: 72,
          height: 54,
          background: 'var(--rn-clr-background-secondary)',
          border: '1px solid var(--rn-clr-border-primary)',
        }}
      >
        {thumb.src && !broken ? (
          <img
            src={thumb.src}
            onError={() => setBroken(true)}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        ) : (
          <span>🖼</span>
        )}
      </div>
      {thumb.label !== NOT_SIZED && (
        <div
          className="text-xs text-center"
          style={{ color: 'var(--rn-clr-content-secondary)', lineHeight: 1.2 }}
        >
          {thumb.label}
        </div>
      )}
    </div>
  );
}

/**
 * Cycle Image Size asking first: which images a press would change and how each
 * is sized now. The answer goes to lib/image_size_session.ts, which runs it.
 */
export function ImageSizeConfirm() {
  const plugin = usePlugin();
  const [context, setContext] = useState<ImageSizeConfirmContext | null>(null);
  const [selected, setSelected] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      setContext((ctx?.contextData as ImageSizeConfirmContext) ?? null);
    })();
  }, []);

  // Keys are read on the container, which has to win focus against RemNote
  // settling it after the popup opens.
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      containerRef.current?.focus();
      if (document.activeElement === containerRef.current || ++tries >= 8) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, []);

  const close = () => plugin.widget.closePopup();

  const answer = async (includeUserSized: boolean) => {
    if (!context) return;
    const request: ImageSizeRequest = {
      id: newImageSizeRequestId(),
      rootIds: context.rootIds,
      step: context.step,
      includeUserSized,
    };
    await plugin.storage.setSession(imageSizeRequestKey, request);
    close();
  };

  const userCount = context?.userSized.count ?? 0;
  const unsizedCount = context?.unsized.count ?? 0;
  const mixed = userCount > 0 && unsizedCount > 0;
  const buttons: { label: string; run: () => void; primary?: boolean }[] = [
    {
      label: mixed ? `Resize all ${userCount + unsizedCount}` : `Resize ${userCount + unsizedCount}`,
      run: () => answer(true),
      primary: true,
    },
    ...(mixed ? [{ label: `Only the ${unsizedCount} not sized`, run: () => answer(false) }] : []),
    { label: 'Cancel', run: close },
  ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current >= ENTER_GRACE_MS) buttons[selected]?.run();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => (i + 1) % buttons.length);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => (i - 1 + buttons.length) % buttons.length);
    }
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{ outline: 'none', color: 'var(--rn-clr-content-primary)' }}
    >
      <div className="text-base font-semibold">Resize these images?</div>
      {context && (
        <>
          <ImageGroup title="Sized by you" group={context.userSized} />
          <ImageGroup title="Not sized" group={context.unsized} />
          {context.skippedNotes.length > 0 && (
            <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              {context.skippedNotes.join(' · ')}
            </div>
          )}
          <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            Original puts back the sizes shown here. You won't be asked again for these images until
            10 minutes after your last press.
          </div>
        </>
      )}
      <div className="flex items-center justify-end gap-2">
        {buttons.map((button, i) => (
          <button
            key={button.label}
            onClick={button.run}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setSelected(i)}
            className="py-1.5 px-3 text-sm font-medium rounded"
            style={{
              background: button.primary ? '#3B82F6' : 'var(--rn-clr-background-secondary)',
              color: button.primary ? 'white' : 'var(--rn-clr-content-primary)',
              border: 'none',
              cursor: 'pointer',
              outline: selected === i ? '2px solid var(--rn-clr-border-accent, #3B82F6)' : 'none',
              outlineOffset: '2px',
            }}
          >
            {button.label}
          </button>
        ))}
      </div>
    </div>
  );
}

renderWidget(ImageSizeConfirm);
