import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import {
  deleteEmptyEcdRems,
  EmptyEcdBackup,
  EmptyEcdCandidate,
  EmptyEcdDeleteResult,
  EmptyEcdScanResult,
  EmptyEcdScope,
  saveDeletionBackup,
  scanEmptyEcdRems,
  SKIP_REASON_LABELS,
  SkipReason,
} from '../lib/empty_ecd_scan';
import { IE_DOCS_BASE_URL } from '../lib/settings';

const DOCS_PATH = 'Utilities-Cleaning-Up/#delete-empty-extra-card-detail-rems';

/**
 * Opens the docs section for this feature. `window.open` is blocked in some
 * embedded contexts, so fall back to a synthesised anchor click — same helper
 * shape as the Image Scan popup.
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

const formatElapsed = (ms: number): string => {
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m ${Math.round(seconds - mins * 60)}s`;
};

/**
 * Rough wall clock for the delete phase.
 *
 * ~74ms per write is the figure measured in lib/image_scan.ts on this same
 * bridge, and RemNote serializes writes, so the estimate is simply the count
 * times that. It exists because the difference between "this takes a moment" and
 * "this takes twenty minutes" decides whether the user starts the run now.
 */
const estimateDeleteTime = (count: number): string => formatElapsed(count * 74);

type Phase = 'confirm' | 'scanning' | 'review' | 'deleting' | 'done' | 'error';

/**
 * Find-and-delete for the blank Rems an Anki import leaves behind under the
 * Extra Card Detail powerup.
 *
 * Deliberately TWO stages, unlike the Image Scan popup it otherwise resembles:
 * the scan runs first and writes nothing, and the user confirms against real
 * counts from their own knowledge base before a single Rem is removed. Tagging
 * is reversible by re-running a scan; deleting is not, so the numbers have to
 * come before the decision rather than after it.
 */
export function EmptyEcdPopup() {
  const plugin = usePlugin();

  const [scopeRemId, setScopeRemId] = useState<string | null>(null);
  const [scopeName, setScopeName] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('confirm');
  const [progress, setProgress] = useState('');
  const [scan, setScan] = useState<EmptyEcdScanResult | null>(null);
  const [deletion, setDeletion] = useState<EmptyEcdDeleteResult | null>(null);
  const [ranOnKb, setRanOnKb] = useState(false);
  const [backupNote, setBackupNote] = useState('');
  const [error, setError] = useState('');

  /** Which scope button the keyboard is on: 0 = this Rem, 1 = whole KB. */
  const [selected, setSelected] = useState<0 | 1>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const init = async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      const remId = (ctx?.contextData?.scopeRemId as string) ?? null;
      setScopeRemId(remId);
      setScopeName((ctx?.contextData?.scopeName as string) ?? '');
      // With no scope Rem the first option is disabled, so the keyboard starts
      // on the only one that can actually run.
      if (!remId) setSelected(1);
    };
    init();
  }, []);

  // Keys are read on the container, not on the buttons: with focus on a button,
  // Enter would fire the browser's native activation AND bubble up here, running
  // the action twice.
  useEffect(() => {
    containerRef.current?.focus();
  }, [phase]);

  const runScan = async (scope: EmptyEcdScope) => {
    setRanOnKb(scope.kind === 'kb');
    setPhase('scanning');
    setProgress('Starting…');
    try {
      setScan(await scanEmptyEcdRems(plugin, scope, (message) => setProgress(message)));
      setPhase('review');
    } catch (e) {
      console.error('[EmptyECD] scan failed:', e);
      setError((e as any)?.message ?? String(e));
      setPhase('error');
    }
  };

  /**
   * Writes the manifest to a file the user keeps, mirroring the card-priority
   * migration's backup. Returns false when the browser refused the download, in
   * which case the run stops — see runDelete.
   */
  const downloadBackup = (backup: EmptyEcdBackup, candidates: EmptyEcdCandidate[]): boolean => {
    try {
      const payload = {
        ...backup,
        // Parent text only in the file, not in local storage: it is what makes
        // the manifest readable months later, and size is no object here.
        rows: backup.rows.map((row, i) => ({ ...row, parentText: candidates[i]?.parentText ?? '' })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `empty-ecd-deleted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    } catch (err) {
      console.error('[EmptyECD] backup download failed', err);
      return false;
    }
  };

  const runDelete = async () => {
    if (!scan || scan.candidates.length === 0) return;

    // Backup FIRST, and abort if it cannot be written. The plugin already holds
    // destructive bulk operations to this standard (the card-priority migration
    // refuses to start without one), and this deletes thousands of Rems.
    setPhase('deleting');
    setProgress('Writing the backup manifest…');
    try {
      const backup = await saveDeletionBackup(plugin, scan.candidates, scopeLabel);
      const downloaded = downloadBackup(backup, scan.candidates);
      setBackupNote(
        downloaded
          ? `Backed up ${backup.rows.length} Rem ids to a JSON file and to this device.`
          : `Backed up ${backup.rows.length} Rem ids to this device (the file download was blocked).`
      );
    } catch (e) {
      console.error('[EmptyECD] backup failed:', e);
      setError(
        `Nothing was deleted: the backup could not be written (${(e as any)?.message ?? e}). ` +
          'This run records what it removes before removing it, and will not proceed without that.'
      );
      setPhase('error');
      return;
    }

    setProgress('Starting…');
    try {
      // The ids from the scan, not a fresh derivation: the user confirmed a
      // specific count, and that is exactly what gets removed.
      setDeletion(
        await deleteEmptyEcdRems(
          plugin,
          scan.candidates.map((c) => c.remId),
          (message) => setProgress(message)
        )
      );
      setPhase('done');
    } catch (e) {
      console.error('[EmptyECD] delete failed:', e);
      setError((e as any)?.message ?? String(e));
      setPhase('error');
    }
  };

  const close = () => plugin.widget.closePopup();

  const runSelected = () => {
    if (selected === 0 && scopeRemId) runScan({ kind: 'rem', remId: scopeRemId });
    else runScan({ kind: 'kb' });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Not while working: Esc is a reflex, and here it would abort a run that
      // may be minutes in.
      if (phase === 'scanning' || phase === 'deleting') return;
      e.preventDefault();
      close();
      return;
    }

    if (phase === 'confirm') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((prev) => (prev === 1 && scopeRemId ? 0 : 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        runSelected();
      }
      return;
    }

    // No Enter-to-delete on the review screen. Enter ran the scan on the
    // previous screen, and carrying that reflex into an irreversible delete is
    // exactly the mistake this two-stage flow exists to prevent — the destructive
    // button has to be clicked.
    if (phase === 'review' && e.key === 'Enter') {
      e.preventDefault();
      return;
    }

    if ((phase === 'done' || phase === 'error') && e.key === 'Enter') {
      e.preventDefault();
      close();
    }
  };

  const selectionRing = (isSelected: boolean): React.CSSProperties =>
    isSelected
      ? { outline: '2px solid var(--rn-clr-border-accent, #3B82F6)', outlineOffset: '2px' }
      : {};

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
  const dangerButton: React.CSSProperties = {
    background: '#dc2626',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
  };

  const scopeLabel = ranOnKb ? 'the whole knowledge base' : `"${scopeName || 'Untitled'}"`;

  const header = (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 18 }}>🧹</span>
        <span className="font-semibold text-base">Delete Empty Extra Card Detail Rems</span>
      </div>
      <button
        onClick={openDocs}
        // Never take focus: the container owns the keys.
        onMouseDown={(e) => e.preventDefault()}
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

  /** The skip tally, rendered only for reasons that actually occurred. */
  const skipList = (result: EmptyEcdScanResult) => {
    const rows = (Object.keys(SKIP_REASON_LABELS) as SkipReason[])
      .filter((reason) => result.skipped[reason] > 0)
      .map((reason) => (
        <div key={reason}>
          <span className="font-bold">{result.skipped[reason]}</span>{' '}
          {SKIP_REASON_LABELS[reason]}
        </div>
      ));
    if (rows.length === 0) return null;
    return (
      <div
        className="flex flex-col gap-1 text-xs p-3 rounded"
        style={{
          background: 'var(--rn-clr-background-elevation-10)',
          color: 'var(--rn-clr-content-secondary)',
        }}
      >
        <div className="font-semibold">Kept, because deleting them would lose something:</div>
        {rows}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{ outline: 'none' }}
    >
      {header}

      {phase === 'confirm' && (
        <>
          <div className="text-sm" style={{ color: 'var(--rn-clr-content-primary)' }}>
            Finds Rems tagged <span className="font-semibold">Extra Card Detail</span> that hold{' '}
            <span className="font-semibold">nothing at all</span> — the blank bullets an Anki import
            leaves behind for every HTML paragraph break, which show up as{' '}
            <span className="font-semibold">Unnamed</span> in the queue.
          </div>
          <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            Nothing is deleted yet. This scan only counts, and you confirm against the numbers
            before anything is removed.
          </div>

          <div className="flex flex-col gap-2">
            <button
              onClick={() => scopeRemId && runScan({ kind: 'rem', remId: scopeRemId })}
              onMouseEnter={() => scopeRemId && setSelected(0)}
              disabled={!scopeRemId}
              className="w-full py-2 px-3 text-sm font-medium rounded text-left"
              style={{
                ...(scopeRemId
                  ? primaryButton
                  : { ...secondaryButton, opacity: 0.5, cursor: 'not-allowed' }),
                ...selectionRing(selected === 0 && !!scopeRemId),
              }}
            >
              <div>Scan this Rem and its descendants</div>
              <div className="text-xs font-normal opacity-90 mt-0.5" style={{ fontStyle: 'italic' }}>
                {scopeRemId ? scopeName || 'Untitled' : 'No focused Rem or open document'}
              </div>
            </button>

            <button
              onClick={() => runScan({ kind: 'kb' })}
              onMouseEnter={() => setSelected(1)}
              className="w-full py-2 px-3 text-sm font-medium rounded text-left"
              style={{ ...secondaryButton, ...selectionRing(selected === 1) }}
            >
              <div>Scan the whole knowledge base</div>
              <div
                className="text-xs font-normal mt-0.5"
                style={{ color: 'var(--rn-clr-content-tertiary)' }}
              >
                Reads every Extra Card Detail Rem — seconds, not minutes
              </div>
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              <span className="font-mono">↑↓</span> choose ·{' '}
              <span className="font-mono">Enter</span> scan ·{' '}
              <span className="font-mono">Esc</span> cancel
            </div>
            <button onClick={close} className="px-3 py-1.5 text-sm rounded" style={secondaryButton}>
              Cancel
            </button>
          </div>
        </>
      )}

      {(phase === 'scanning' || phase === 'deleting') && (
        <div className="flex flex-col gap-2 py-4">
          <div className="text-sm font-medium">
            {phase === 'scanning' ? '🔍 Scanning ' : '🧹 Deleting in '}
            {scopeLabel}…
          </div>
          <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            {progress}
          </div>
          <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            {phase === 'scanning'
              ? 'Keep this popup open until it finishes — closing it stops the scan. Nothing is written either way.'
              : 'Keep this popup open until it finishes — closing it stops the deletion (Rems already deleted stay deleted, and re-running clears the rest).'}
          </div>
        </div>
      )}

      {phase === 'review' && scan && (
        <>
          {/* The funnel, not just the final number: a surprising result is far
              easier to diagnose when you can see which stage it narrowed at. */}
          <div className="text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            Walked <span className="font-bold">{scan.scanned.toLocaleString()}</span> Rem
            {scan.scanned === 1 ? '' : 's'} in {scopeLabel} →{' '}
            <span className="font-bold">{scan.blank.toLocaleString()}</span> hold nothing →{' '}
            <span className="font-bold">{scan.blankEcd.toLocaleString()}</span> of those carry
            Extra Card Detail.
          </div>

          {scan.candidates.length === 0 ? (
            <div className="text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              {scan.blankEcd === 0
                ? 'No empty Extra Card Detail Rems here — there is nothing to clean up.'
                : 'Every empty one holds something that deleting would lose, so nothing can be removed.'}
            </div>
          ) : (
            <div
              className="text-sm p-3 rounded"
              style={{
                background: 'var(--rn-clr-background-elevation-10)',
                color: 'var(--rn-clr-content-primary)',
              }}
            >
              🗑️ <span className="font-bold text-base">{scan.candidates.length}</span> Rem
              {scan.candidates.length === 1 ? ' is' : 's are'} plain Rems holding nothing at all —
              no text or image, and not a portal, Concept, Descriptor or slot. Nothing underneath
              them, nothing referencing them, no cards, sources or aliases, and no tag beyond Extra
              Card Detail.
            </div>
          )}

          {skipList(scan)}

          {scan.preview.length > 0 && (
            <div className="flex flex-col gap-1 text-xs">
              <div className="font-semibold" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                A sample of what will go, by the Rem it sits under:
              </div>
              {scan.preview.map((candidate) => (
                <div
                  key={candidate.remId}
                  style={{ color: 'var(--rn-clr-content-tertiary)' }}
                  className="truncate"
                >
                  • {candidate.parentText || '(no parent)'}
                </div>
              ))}
              {scan.candidates.length > scan.preview.length && (
                <div style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                  …and {scan.candidates.length - scan.preview.length} more
                </div>
              )}
            </div>
          )}

          <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            Scan took {formatElapsed(scan.elapsedMs)}.
            {scan.candidates.length > 0 &&
              ` Deleting will take roughly ${estimateDeleteTime(scan.candidates.length)}.`}
          </div>

          {scan.candidates.length > 0 && (
            <div
              className="text-xs p-2 rounded"
              style={{
                background: 'var(--rn-clr-background-elevation-10)',
                color: 'var(--rn-clr-content-secondary)',
              }}
            >
              💾 Before deleting anything, a <span className="font-semibold">JSON manifest</span> of
              every Rem id and the Rem it sits under is saved to this device and offered as a file
              download. If it cannot be written, nothing is deleted.
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => setPhase('confirm')}
              className="px-3 py-1.5 text-sm rounded"
              style={secondaryButton}
            >
              Back
            </button>
            <div className="flex gap-2">
              <button onClick={close} className="px-3 py-1.5 text-sm rounded" style={secondaryButton}>
                Cancel
              </button>
              {scan.candidates.length > 0 && (
                <button
                  onClick={runDelete}
                  className="px-4 py-1.5 text-sm font-medium rounded"
                  style={dangerButton}
                >
                  Delete {scan.candidates.length} Rem{scan.candidates.length === 1 ? '' : 's'}
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {phase === 'done' && deletion && (
        <>
          <div className="text-sm">
            Deleted <span className="font-bold">{deletion.deleted}</span> empty Extra Card Detail
            Rem{deletion.deleted === 1 ? '' : 's'} in {scopeLabel}.
          </div>

          {deletion.failed > 0 && (
            <div className="text-sm" style={{ color: '#ef4444' }}>
              ⚠ <span className="font-bold">{deletion.failed}</span> could not be deleted — see the
              console
            </div>
          )}

          <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            Took {formatElapsed(deletion.elapsedMs)}.{backupNote ? ` ${backupNote}` : ''} Every id
            was also written to the developer console before removal.
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setScan(null);
                setDeletion(null);
                setPhase('confirm');
              }}
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

renderWidget(EmptyEcdPopup);
