import '../lib/stall_diagnostics';
import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import { dismissNotices } from '../lib/notice';
import {
  enqueueUpscaleJob,
  replaceRemImage,
  UpscaleResult,
  UpscaleReviewContext,
} from '../lib/upscale_image';

type Phase =
  | { kind: 'loading' }
  | { kind: 'review' }
  | { kind: 'replacing' }
  /** Replacing failed; the result can still be tried again or skipped. */
  | { kind: 'error'; message: string };

const muted = { color: 'var(--rn-clr-content-secondary)' };

function Button({
  label,
  onClick,
  primary,
  disabled,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      className="py-1.5 px-3 text-sm font-medium rounded"
      style={{
        background: primary ? '#3B82F6' : 'var(--rn-clr-background-secondary)',
        color: primary ? 'white' : 'var(--rn-clr-content-primary)',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function Verdict({ result }: { result: UpscaleResult }) {
  const pass = result.verdict === 'pass';
  return (
    <div
      className="rounded px-3 py-2 text-sm"
      style={{
        background: pass ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.15)',
        border: `1px solid ${pass ? 'rgba(34,197,94,0.5)' : 'rgba(245,158,11,0.6)'}`,
      }}
    >
      <div className="font-semibold">
        {pass
          ? '✓ Same content — the automatic check found no changes'
          : '⚠ Check before replacing'}
      </div>
      {!pass && (result.flags ?? []).length > 0 && (
        <ul className="mt-1 ml-4 list-disc">
          {(result.flags ?? []).map((flag) => (
            <li key={flag}>{flag}</li>
          ))}
        </ul>
      )}
      <div className="mt-1 text-xs" style={muted}>
        The check compares lines, colours and plain words; it cannot read formulas. Compare digits,
        symbols and formulas with your own eyes before replacing.
      </div>
    </div>
  );
}

/**
 * Upscale image with ChatGPT, the review: opened by the Review button of the notice the
 * background job posts (lib/upscale_image.ts), with every image's finished result. Shows
 * the original beside the result and the fidelity check, and swaps the image in the rem
 * only on "Replace image". Try again sends the image back to the background (a new notice
 * follows); Cancel keeps the notice, so the review can be opened again.
 */
export function UpscaleImagePopup() {
  const plugin = usePlugin();
  const [context, setContext] = useState<UpscaleReviewContext | null>(null);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [view, setView] = useState<'side' | 'diff'>('side');
  const [extra, setExtra] = useState('');
  const replaced = useRef(0);
  const retried = useRef(0);

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      const data = (ctx?.contextData as UpscaleReviewContext) ?? null;
      setContext(data);
      setPhase(
        data?.results?.length
          ? { kind: 'review' }
          : { kind: 'error', message: 'No result to review.' }
      );
    })();
  }, []);

  const close = () => plugin.widget.closePopup();

  /** On to the next image, or, after the last, dismiss the notice and close. */
  const next = async () => {
    if (!context) return;
    if (index + 1 < context.images.length) {
      setIndex(index + 1);
      setExtra('');
      setView('side');
      setPhase({ kind: 'review' });
      return;
    }
    // Awaited before closing: a popup's teardown cuts a read-then-write short.
    if (context.noticeId) await dismissNotices(plugin, context.noticeId);
    const done = [
      replaced.current
        ? `replaced ${replaced.current} image${replaced.current === 1 ? '' : 's'}`
        : '',
      retried.current ? `trying ${retried.current} again in the background` : '',
    ].filter(Boolean);
    if (done.length) await plugin.app.toast(`🖼 ${done.join('; ')}.`);
    close();
  };

  const replace = async () => {
    if (!context) return;
    setPhase({ kind: 'replacing' });
    try {
      await replaceRemImage(plugin, context.remId, context.images[index], context.results[index]);
      replaced.current++;
      await next();
    } catch (err) {
      setPhase({ kind: 'error', message: `Replacing failed: ${String(err)}` });
    }
  };

  const tryAgain = async () => {
    if (!context) return;
    const { remId, title, kbId } = context;
    await enqueueUpscaleJob(plugin, { remId, title, kbId, images: [context.images[index]] }, extra);
    retried.current++;
    await next();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const total = context?.images.length ?? 0;
  const current = phase.kind === 'loading' ? undefined : context?.results[index];
  const result = current?.ok ? current : null;
  const failure = current && !current.ok ? (current.message ?? 'failed') : null;
  const decided = phase.kind === 'review' || phase.kind === 'error';

  return (
    <div
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{
        outline: 'none',
        color: 'var(--rn-clr-content-primary)',
        height: '100vh',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <div style={{ flexShrink: 0 }}>
        <div className="text-base font-semibold">Upscale image with ChatGPT</div>
        <div className="text-xs" style={muted}>
          {context?.title || 'Untitled rem'}
          {total > 1 ? ` — image ${index + 1} of ${total}` : ''}
        </div>
      </div>

      <div className="flex flex-col gap-3" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {phase.kind === 'loading' && (
          <div className="py-8 text-center text-sm" style={muted}>
            Loading…
          </div>
        )}

        {(failure || phase.kind === 'error') && (
          <div
            className="rounded px-3 py-2 text-sm"
            style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.5)' }}
          >
            {phase.kind === 'error' ? phase.message : `ChatGPT gave no result: ${failure}`}
          </div>
        )}

        {result && (
          <>
            <Verdict result={result} />
            <div className="flex items-center gap-3 text-xs" style={muted}>
              <span>
                Original {result.origSize?.join('×')} → new {result.newSize?.join('×')} px
                {result.seconds ? ` · ${result.seconds} s` : ''}
              </span>
              <span style={{ flex: 1 }} />
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" checked={view === 'side'} onChange={() => setView('side')} />{' '}
                Side by side
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" checked={view === 'diff'} onChange={() => setView('diff')} />{' '}
                Differences
              </label>
            </div>
            <img
              src={view === 'side' ? result.sideBySideUrl : result.diffUrl}
              style={{
                width: '100%',
                border: '1px solid var(--rn-clr-border-primary)',
                borderRadius: 4,
                background: 'white',
              }}
            />
            <div className="text-xs" style={muted}>
              {view === 'side'
                ? 'Left: the original. Right: the upscaled image.'
                : 'Grey: drawn in both. Red: only in the original. Blue: only in the new image.'}
            </div>
            {(result.crops ?? []).length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-xs font-semibold" style={muted}>
                  Regions that changed, zoomed (original | new):
                </div>
                <div className="flex flex-wrap gap-2">
                  {(result.crops ?? []).map((crop) => (
                    <img
                      key={crop.url}
                      src={crop.url}
                      title={`${crop.kind === 'added' ? 'added' : 'missing'} ink, ${crop.px} px`}
                      style={{
                        maxHeight: 120,
                        border: '1px solid var(--rn-clr-border-primary)',
                        borderRadius: 4,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {decided && (
        <input
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="Optional, for Try again: what to keep (e.g. “the dashed lines must stay dashed”)"
          className="text-sm rounded px-2 py-1"
          style={{
            flexShrink: 0,
            border: '1px solid var(--rn-clr-border-primary)',
            background: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
          }}
        />
      )}

      <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
        {result?.folder && (
          <span className="text-xs" style={{ ...muted, flex: 1 }} title={result.folder}>
            Saved, original included: {result.folder.replace(/^\/Users\/[^/]+/, '~')}
          </span>
        )}
        {!result?.folder && <span style={{ flex: 1 }} />}
        {phase.kind === 'replacing' && (
          <span className="text-sm" style={muted}>
            Storing in RemNote…
          </span>
        )}
        {decided && context && <Button label="Try again" onClick={() => void tryAgain()} />}
        {decided && total > 1 && (
          <Button
            label={index + 1 < total ? 'Skip this image' : 'Skip'}
            onClick={() => void next()}
          />
        )}
        <Button label="Cancel" onClick={close} />
        {phase.kind === 'review' && result && (
          <Button label="Replace image" primary onClick={() => void replace()} />
        )}
      </div>
    </div>
  );
}

renderWidget(UpscaleImagePopup);
