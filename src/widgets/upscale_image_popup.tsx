import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import {
  getUpscaleTask,
  replaceRemImage,
  startUpscale,
  UpscalePopupContext,
  UpscaleResult,
} from '../lib/upscale_image';

const POLL_MS = 2000;

type Phase =
  | { kind: 'loading' }
  | { kind: 'running'; stage: string; elapsed: number }
  | { kind: 'done'; result: UpscaleResult }
  | { kind: 'error'; message: string }
  | { kind: 'replacing'; result: UpscaleResult };

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
 * Upscale image with ChatGPT: runs the helper's /upscale on each image of the
 * rem in turn, shows the original beside the result and the fidelity check, and
 * swaps the image in the rem only on "Replace image" (lib/upscale_image.ts).
 */
export function UpscaleImagePopup() {
  const plugin = usePlugin();
  const [context, setContext] = useState<UpscalePopupContext | null>(null);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [view, setView] = useState<'side' | 'diff'>('side');
  const [extra, setExtra] = useState('');
  const [replaced, setReplaced] = useState(0);
  const run = useRef(0);

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      setContext((ctx?.contextData as UpscalePopupContext) ?? null);
    })();
    return () => {
      run.current++; // stop polling when the popup closes
    };
  }, []);

  const start = async (ctx: UpscalePopupContext, i: number, extraText: string) => {
    const mine = ++run.current;
    setPhase({ kind: 'running', stage: 'starting', elapsed: 0 });
    setView('side');
    try {
      const taskId = await startUpscale(ctx, ctx.images[i], extraText);
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (mine !== run.current) return;
        const task = await getUpscaleTask(taskId);
        if (mine !== run.current) return;
        if (task.status === 'done') {
          const result = task.result ?? { ok: false, message: 'no result' };
          setPhase(
            result.ok
              ? { kind: 'done', result }
              : { kind: 'error', message: result.message ?? 'failed' }
          );
          return;
        }
        setPhase({ kind: 'running', stage: task.stage, elapsed: task.elapsed });
      }
    } catch (err) {
      if (mine === run.current) setPhase({ kind: 'error', message: String(err) });
    }
  };

  useEffect(() => {
    if (context) void start(context, 0, '');
  }, [context]);

  const close = () => plugin.widget.closePopup();

  const nextOrClose = async (count: number) => {
    if (!context) return;
    if (index + 1 < context.images.length) {
      setIndex(index + 1);
      setExtra('');
      void start(context, index + 1, '');
    } else {
      if (count > 0)
        await plugin.app.toast(
          `Replaced ${count} image${count === 1 ? '' : 's'} with the upscaled version.`
        );
      close();
    }
  };

  const replace = async (result: UpscaleResult) => {
    if (!context) return;
    setPhase({ kind: 'replacing', result });
    try {
      await replaceRemImage(plugin, context.remId, context.images[index], result);
      const count = replaced + 1;
      setReplaced(count);
      await nextOrClose(count);
    } catch (err) {
      setPhase({ kind: 'error', message: `Replacing failed: ${String(err)}` });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const total = context?.images.length ?? 0;
  const result = phase.kind === 'done' || phase.kind === 'replacing' ? phase.result : null;

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
        {(phase.kind === 'loading' || phase.kind === 'running') && (
          <div className="py-8 text-center text-sm" style={muted}>
            {phase.kind === 'running'
              ? `${phase.stage[0]?.toUpperCase()}${phase.stage.slice(1)}… ${phase.elapsed} s (usually about 45 s)`
              : 'Starting…'}
            <div className="mt-2 text-xs">
              ChatGPT is regenerating the figure at a higher resolution.
            </div>
            <div className="mt-1 text-xs font-semibold">
              Keep this window open until the result appears: if you close it, nothing is replaced
              (the result is only saved to the folder on disk).
            </div>
          </div>
        )}

        {phase.kind === 'error' && (
          <div
            className="rounded px-3 py-2 text-sm"
            style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.5)' }}
          >
            {phase.message}
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

      {(phase.kind === 'done' || phase.kind === 'error') && (
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
        {(phase.kind === 'done' || phase.kind === 'error') && context && (
          <Button label="Try again" onClick={() => void start(context, index, extra)} />
        )}
        {total > 1 && index + 1 < total && (phase.kind === 'done' || phase.kind === 'error') && (
          <Button label="Skip this image" onClick={() => void nextOrClose(replaced)} />
        )}
        <Button label={phase.kind === 'running' ? 'Stop waiting' : 'Cancel'} onClick={close} />
        {phase.kind === 'done' && (
          <Button label="Replace image" primary onClick={() => void replace(phase.result)} />
        )}
      </div>
    </div>
  );
}

renderWidget(UpscaleImagePopup);
