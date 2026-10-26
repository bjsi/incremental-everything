import { ReactRNPlugin, renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { scanVideoFolder, VideoFolder } from '../lib/local_video';
import {
  countVideos,
  existingLocalVideos,
  importLocalVideos,
  LocalVideoImportProgress,
  newVideosInOrder,
} from '../lib/local_video_import';
import { getIESetting } from '../lib/settings';
import { defaultPriorityId } from '../lib/consts';

// Import Local Videos: the folder the user picked in the helper's dialog,
// scanned, shown, and imported as a document of Incremental Rems. Opened by
// the command with { library, path, root, parentId?, parentName? }.

/** The Enter that ran a command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;
const SAMPLE_NAMES = 4;

interface ImportContext {
  library: string;
  path: string;
  root: string;
  parentId?: string;
  parentName?: string;
}

type Phase =
  | { kind: 'scanning' }
  | { kind: 'ready'; tree: VideoFolder; total: number; fresh: number }
  | { kind: 'importing'; progress: LocalVideoImportProgress }
  | { kind: 'done'; documentId: string; created: number; skipped: number }
  | { kind: 'failed'; message: string };

const muted: React.CSSProperties = { color: 'var(--rn-clr-content-tertiary)' };

/** Subfolders with their video counts, one level per indent. */
const FolderSummary: React.FC<{ folder: VideoFolder; depth?: number }> = ({ folder, depth = 0 }) => (
  <>
    {folder.folders.map((sub) => (
      <React.Fragment key={sub.path}>
        <div style={{ paddingLeft: depth * 14 }}>
          📁 {sub.name} <span style={muted}>({countVideos(sub)})</span>
        </div>
        <FolderSummary folder={sub} depth={depth + 1} />
      </React.Fragment>
    ))}
  </>
);

export function LocalVideoImportPopup() {
  const plugin = usePlugin();
  const [ctx, setCtx] = useState<ImportContext | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' });
  const [insideParent, setInsideParent] = useState(true);
  const [makeIncremental, setMakeIncremental] = useState(true);
  const [priority, setPriority] = useState(10);
  const [spread, setSpread] = useState(true);
  const [spreadDays, setSpreadDays] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      const widget = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      const data = widget?.contextData as ImportContext | undefined;
      if (!data) return;
      setCtx(data);
      setPriority(Math.min(100, Math.max(0, (await getIESetting(plugin, defaultPriorityId)) || 10)));
      try {
        const [tree, existing] = await Promise.all([
          scanVideoFolder(data.library, data.path),
          existingLocalVideos(plugin),
        ]);
        setPhase({
          kind: 'ready',
          tree,
          total: countVideos(tree),
          fresh: newVideosInOrder(data.library, tree, existing).length,
        });
      } catch (e) {
        setPhase({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
      }
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

  const start = async () => {
    if (!ctx || phase.kind !== 'ready' || !phase.fresh) return;
    const tree = phase.tree;
    setPhase({ kind: 'importing', progress: { stage: 'checking', done: 0, total: phase.fresh } });
    try {
      const result = await importLocalVideos(
        plugin as unknown as ReactRNPlugin,
        {
          library: ctx.library,
          tree,
          parentId: insideParent ? ctx.parentId : undefined,
          makeIncremental,
          priority,
          spreadDays: spread ? Math.max(1, spreadDays) : 0,
        },
        (progress) => setPhase({ kind: 'importing', progress })
      );
      setPhase({ kind: 'done', ...result });
    } catch (e) {
      setPhase({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const openDocument = async () => {
    if (phase.kind !== 'done') return;
    const rem = await plugin.rem.findOne(phase.documentId);
    if (rem) await plugin.window.openRem(rem);
    await close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && phase.kind !== 'importing') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current < ENTER_GRACE_MS) return;
      if (phase.kind === 'ready') start();
      else if (phase.kind === 'done') openDocument();
      else if (phase.kind === 'failed') close();
    }
  };

  const folderName = ctx ? (ctx.path ? ctx.path.split('/').pop() : ctx.root.split('/').pop()) : '';
  const primary: React.CSSProperties = {
    background: '#3B82F6',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    outline: '2px solid var(--rn-clr-border-accent, #3B82F6)',
    outlineOffset: '2px',
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4 text-sm"
      style={{ outline: 'none', color: 'var(--rn-clr-content-primary)' }}
    >
      <div className="text-base font-semibold">📂 Import Local Videos</div>
      {ctx && (
        <div style={muted} title={`${ctx.root}${ctx.path ? '/' + ctx.path : ''}`}>
          {folderName} · library “{ctx.library}”
        </div>
      )}

      {phase.kind === 'scanning' && <div>Reading the folder…</div>}

      {phase.kind === 'failed' && <div style={{ color: '#dc2626' }}>{phase.message}</div>}

      {phase.kind === 'ready' && (
        <>
          <div>
            <b>{phase.total}</b> video{phase.total === 1 ? '' : 's'}
            {phase.fresh < phase.total && (
              <span style={muted}>
                {' '}
                · {phase.total - phase.fresh} already in RemNote, skipped · <b>{phase.fresh}</b> new
              </span>
            )}
          </div>
          {(phase.tree.folders.length > 0 || phase.tree.videos.length > 0) && (
            <div
              className="rounded p-2"
              style={{ background: 'var(--rn-clr-background-secondary)', maxHeight: 140, overflow: 'auto' }}
            >
              {phase.tree.videos.slice(0, SAMPLE_NAMES).map((v) => (
                <div key={v.path}>🎞️ {v.name}</div>
              ))}
              {phase.tree.videos.length > SAMPLE_NAMES && (
                <div style={muted}>… {phase.tree.videos.length - SAMPLE_NAMES} more</div>
              )}
              <FolderSummary folder={phase.tree} />
            </div>
          )}

          {phase.fresh > 0 && (
            <>
              {ctx?.parentId && (
                <div className="flex flex-col gap-1">
                  <label>
                    <input type="radio" checked={insideParent} onChange={() => setInsideParent(true)} /> Inside “
                    {ctx.parentName}”
                  </label>
                  <label>
                    <input type="radio" checked={!insideParent} onChange={() => setInsideParent(false)} /> As a new
                    top-level document
                  </label>
                </div>
              )}
              <label>
                <input type="checkbox" checked={makeIncremental} onChange={(e) => setMakeIncremental(e.target.checked)} />{' '}
                Make them Incremental Rems
              </label>
              {makeIncremental && (
                <div className="flex flex-col gap-1" style={{ paddingLeft: 20 }}>
                  <label>
                    Priority{' '}
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={priority}
                      onChange={(e) => setPriority(Number(e.target.value))}
                      style={{ width: 60 }}
                    />
                  </label>
                  <label>
                    <input type="radio" checked={!spread} onChange={() => setSpread(false)} /> All due today
                  </label>
                  <label>
                    <input type="radio" checked={spread} onChange={() => setSpread(true)} /> The first today, then one
                    more every{' '}
                    <input
                      type="number"
                      min={1}
                      value={spreadDays}
                      onChange={(e) => setSpreadDays(Number(e.target.value))}
                      style={{ width: 48 }}
                    />{' '}
                    day{spreadDays === 1 ? '' : 's'}, in file order
                  </label>
                </div>
              )}
            </>
          )}
        </>
      )}

      {phase.kind === 'importing' && (
        <div>
          {phase.progress.stage === 'checking'
            ? 'Checking what is already in RemNote…'
            : phase.progress.stage === 'creating'
              ? `Creating the Rems: ${phase.progress.done} / ${phase.progress.total}…`
              : `Making them Incremental: ${phase.progress.done} / ${phase.progress.total}…`}
        </div>
      )}

      {phase.kind === 'done' && (
        <div>
          ✓ {phase.created} video{phase.created === 1 ? '' : 's'} imported
          {phase.skipped > 0 && <span style={muted}> · {phase.skipped} already there</span>}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs" style={muted}>
          {phase.kind === 'importing' ? 'Keep this open until it finishes' : 'Enter to go on · Esc to close'}
        </span>
        <div className="flex gap-2">
          {phase.kind !== 'importing' && phase.kind !== 'done' && (
            <button onClick={close} className="py-1.5 px-3 text-sm rounded" style={{ cursor: 'pointer' }}>
              Cancel
            </button>
          )}
          {phase.kind === 'ready' && phase.fresh > 0 && (
            <button onClick={start} className="py-1.5 px-4 text-sm font-medium rounded" style={primary}>
              Import {phase.fresh}
            </button>
          )}
          {phase.kind === 'done' && (
            <button onClick={openDocument} className="py-1.5 px-4 text-sm font-medium rounded" style={primary}>
              Open the document
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

renderWidget(LocalVideoImportPopup);
