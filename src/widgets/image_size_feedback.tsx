import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import { IMAGE_SIZE_CYCLE, IMAGE_SIZE_STEP_LABEL, ImageSizeStep } from '../lib/image_sizing';
import {
  ImageSizeFeedback as Feedback,
  imageSizeFeedbackKey,
  ImageSizeRequest,
  imageSizeRequestKey,
  newImageSizeRequestId,
} from '../lib/image_size_session';

const HIDE_AFTER_MS = 4000;

/**
 * The size Cycle Image Size just set, and how many images it changed. Clicking a
 * size goes straight to it. Opened by lib/image_size_session.ts, which updates it
 * in place on every press; it closes itself once left alone.
 */
export function ImageSizeFeedback() {
  const plugin = usePlugin();
  const feedback = useTrackerPlugin(
    (rp) => rp.storage.getSession<Feedback>(imageSizeFeedbackKey),
    []
  );
  const widgetId = useRef<string | undefined>();
  const [hovered, setHovered] = useState(false);
  // The clicked size, shown at once while the resize runs.
  const [pending, setPending] = useState<ImageSizeStep | null>(null);

  const close = async () => {
    const id =
      widgetId.current ??
      (await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>())?.floatingWidgetId;
    if (id) await plugin.window.closeFloatingWidget(id);
  };

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>();
      widgetId.current = ctx?.floatingWidgetId;
    })();
  }, []);

  useEffect(() => setPending(null), [feedback?.at]);

  useEffect(() => {
    if (hovered || !feedback) return;
    const timer = setTimeout(close, HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [feedback?.at, hovered]);

  const choose = async (step: ImageSizeStep) => {
    if (!feedback) return;
    setPending(step);
    const request: ImageSizeRequest = {
      id: newImageSizeRequestId(),
      rootIds: feedback.rootIds,
      step,
    };
    await plugin.storage.setSession(imageSizeRequestKey, request);
  };

  if (!feedback) return null;
  const current = pending ?? feedback.step;
  // No size to choose when there is nothing under the target to resize.
  const canChoose = !!feedback.step;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="inline-flex flex-col gap-1 py-2 px-3 rounded-lg"
      style={{
        background: 'var(--rn-clr-background-primary)',
        color: 'var(--rn-clr-content-primary)',
        border: '1px solid var(--rn-clr-border-primary)',
        whiteSpace: 'nowrap',
      }}
    >
      <div className="flex items-center gap-1">
        <span style={{ marginRight: 4 }}>🖼</span>
        {IMAGE_SIZE_CYCLE.map((step) => {
          const active = step === current;
          return (
            <button
              key={step}
              disabled={!canChoose}
              onClick={() => choose(step)}
              // Keeps keyboard focus in RemNote, so the shortcut still works after a click.
              onMouseDown={(e) => e.preventDefault()}
              className="py-0.5 px-2 text-sm rounded"
              style={{
                background: active ? '#3B82F6' : 'transparent',
                color: active
                  ? 'white'
                  : canChoose
                    ? 'var(--rn-clr-content-secondary)'
                    : 'var(--rn-clr-content-tertiary)',
                fontWeight: active ? 600 : 400,
                border: 'none',
                cursor: canChoose ? 'pointer' : 'default',
              }}
            >
              {IMAGE_SIZE_STEP_LABEL[step]}
            </button>
          );
        })}
        <button
          onClick={close}
          onMouseDown={(e) => e.preventDefault()}
          title="Close"
          className="py-0.5 px-1 text-sm"
          style={{
            background: 'transparent',
            color: 'var(--rn-clr-content-tertiary)',
            border: 'none',
            cursor: 'pointer',
            marginLeft: 4,
          }}
        >
          ✕
        </button>
      </div>
      <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
        {[
          feedback.message ?? `${feedback.changed} image${feedback.changed === 1 ? '' : 's'}`,
          ...feedback.notes,
        ].join(' · ')}
      </div>
    </div>
  );
}

renderWidget(ImageSizeFeedback);
