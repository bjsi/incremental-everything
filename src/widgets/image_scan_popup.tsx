import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useState } from 'react';
import '../style.css';
import '../App.css';
import {
  ImageScanResult,
  ImageScanScope,
  scanAndTagImages,
} from '../lib/image_scan';
import { hasImagePowerupName } from '../lib/consts';
import { IE_DOCS_BASE_URL } from '../lib/settings';

const DOCS_PATH = 'Utilities/#filter-a-document-by-images';

/**
 * Opens the docs section for this feature. `window.open` is blocked in some
 * embedded contexts, so fall back to a synthesised anchor click — same helper
 * shape as the IE Settings popup.
 */
const openDocs = () => {
  const url = `${IE_DOCS_BASE_URL}${DOCS_PATH}`;
  const opened = window.open(url, '_blank');
  if (!opened || opened.closed) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => document.body.removeChild(link), 100);
  }
};

type Phase = 'confirm' | 'running' | 'done' | 'error';

/**
 * Confirmation + report for the "Tag Rems With Images" command.
 *
 * A popup rather than `confirm()` for two reasons. The dialog has to offer a
 * third choice — scan this scope, or scan the whole knowledge base — which a
 * two-button native confirm cannot express. And the report has to survive being
 * read: the original toast pair raced, so the "scanning…" toast replaced the
 * result before it could be seen. Here the result stays on screen until closed.
 */
export function ImageScanPopup() {
  const plugin = usePlugin();

  const [scopeRemId, setScopeRemId] = useState<string | null>(null);
  const [scopeName, setScopeName] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('confirm');
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<ImageScanResult | null>(null);
  const [ranOnKb, setRanOnKb] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const init = async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      setScopeRemId((ctx?.contextData?.scopeRemId as string) ?? null);
      setScopeName((ctx?.contextData?.scopeName as string) ?? '');
    };
    init();
  }, []);

  const run = async (scope: ImageScanScope) => {
    setRanOnKb(scope.kind === 'kb');
    setPhase('running');
    setProgress('Starting…');
    try {
      const r = await scanAndTagImages(plugin, scope, (message) => setProgress(message));
      setResult(r);
      setPhase('done');
    } catch (e) {
      console.error('[ImageScan] scan failed:', e);
      setError((e as any)?.message ?? String(e));
      setPhase('error');
    }
  };

  const close = () => plugin.widget.closePopup();

  const header = (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 18 }}>🖼️</span>
        <span className="font-semibold text-base">Tag Rems With Images</span>
      </div>
      <button
        onClick={openDocs}
        title="Open the documentation for this command"
        className="rounded-full w-6 h-6 flex items-center justify-center hover:opacity-75"
        style={{
          border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))',
          color: 'var(--rn-clr-content-secondary)',
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        ?
      </button>
    </div>
  );

  const primaryButton: React.CSSProperties = {
    background: '#3B82F6',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
  };
  const secondaryButton: React.CSSProperties = {
    background: 'transparent',
    color: 'var(--rn-clr-content-primary)',
    border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))',
    cursor: 'pointer',
  };

  /** Shown after a run: the two ways to make use of the tag that was just applied. */
  const howToFilter = (
    <div
      className="flex flex-col gap-2 text-xs p-3 rounded"
      style={{
        background: 'var(--rn-clr-background-elevation-10)',
        color: 'var(--rn-clr-content-secondary)',
      }}
    >
      <div>
        <span className="font-semibold">Filter one document:</span> open it, press{' '}
        <span className="font-mono">Cmd/Ctrl+Shift+F</span> (or{' '}
        <span className="font-mono">Cmd/Ctrl+F</span> and switch the search mode to{' '}
        <span className="font-semibold">Filter</span>), then pick{' '}
        <span className="font-semibold">{hasImagePowerupName}</span>. The document
        collapses to just the Rems holding an image.
      </div>
      <div>
        <span className="font-semibold">Collect them anywhere:</span> a{' '}
        <span className="font-semibold">Search Portal</span> on the{' '}
        <span className="font-semibold">{hasImagePowerupName}</span> tag gathers every
        tagged Rem into one place — combine it with a document or tag in the query to
        narrow it down.
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3 p-4">
      {header}

      {phase === 'confirm' && (
        <>
          <div className="text-sm" style={{ color: 'var(--rn-clr-content-primary)' }}>
            Scans for images in each Rem's <span className="font-semibold">front and back
            text</span> and tags every one that holds an image with{' '}
            <span className="font-semibold">#{hasImagePowerupName}</span>. Rems inside the
            scanned scope that carry the tag but no longer hold an image lose it.
          </div>

          <div className="flex flex-col gap-2">
            <button
              onClick={() => scopeRemId && run({ kind: 'rem', remId: scopeRemId })}
              disabled={!scopeRemId}
              className="w-full py-2 px-3 text-sm font-medium rounded text-left"
              style={scopeRemId ? primaryButton : { ...secondaryButton, opacity: 0.5, cursor: 'not-allowed' }}
            >
              <div>Scan this Rem and its descendants</div>
              <div className="text-xs font-normal opacity-90 mt-0.5" style={{ fontStyle: 'italic' }}>
                {scopeRemId ? scopeName || 'Untitled' : 'No focused Rem or open document'}
              </div>
            </button>

            <button
              onClick={() => run({ kind: 'kb' })}
              className="w-full py-2 px-3 text-sm font-medium rounded text-left"
              style={secondaryButton}
            >
              <div>Scan the whole knowledge base</div>
              <div
                className="text-xs font-normal mt-0.5"
                style={{ color: 'var(--rn-clr-content-tertiary)' }}
              >
                Every Rem, every document — slow on a large knowledge base
              </div>
            </button>
          </div>

          <div className="flex justify-end">
            <button onClick={close} className="px-3 py-1.5 text-sm rounded" style={secondaryButton}>
              Cancel
            </button>
          </div>
        </>
      )}

      {phase === 'running' && (
        <div className="flex flex-col gap-2 py-4">
          <div className="text-sm font-medium">
            🔍 Scanning {ranOnKb ? 'the whole knowledge base' : `"${scopeName || 'Untitled'}"`}…
          </div>
          <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            {progress}
          </div>
          {/* The scan runs inside this popup, so closing it stops the walk. The
              work already written stays valid — the command is idempotent — but
              the run would be incomplete, which matters most on a KB scan. */}
          <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            Keep this popup open until it finishes — closing it stops the scan
            (anything already tagged stays, and re-running resumes the work).
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <>
          <div className="text-sm">
            Scanned <span className="font-bold">{result.scanned}</span> Rem
            {result.scanned === 1 ? '' : 's'} in{' '}
            {ranOnKb ? 'the whole knowledge base' : `"${scopeName || 'Untitled'}"`}.
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <div>
              🖼️ <span className="font-bold">{result.withImages}</span> hold an image
            </div>
            <div>
              ➕ <span className="font-bold">{result.tagged}</span> newly tagged
            </div>
            <div>
              ➖ <span className="font-bold">{result.untagged}</span> cleared (no image any more)
            </div>
            {result.failed > 0 && (
              <div style={{ color: '#ef4444' }}>
                ⚠ <span className="font-bold">{result.failed}</span> failed to write — see the console
              </div>
            )}
          </div>

          {howToFilter}

          <div className="flex justify-end gap-2">
            <button
              onClick={() => setPhase('confirm')}
              className="px-3 py-1.5 text-sm rounded"
              style={secondaryButton}
            >
              Scan again
            </button>
            <button onClick={close} className="px-4 py-1.5 text-sm font-medium rounded" style={primaryButton}>
              Done
            </button>
          </div>
        </>
      )}

      {phase === 'error' && (
        <>
          <div className="text-sm" style={{ color: '#ef4444' }}>
            {error}
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setPhase('confirm')}
              className="px-3 py-1.5 text-sm rounded"
              style={secondaryButton}
            >
              Back
            </button>
            <button onClick={close} className="px-4 py-1.5 text-sm font-medium rounded" style={primaryButton}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}

renderWidget(ImageScanPopup);
