/**
 * The Mastery Drill's full-window panels: the clear confirmations, Clear Low
 * Priority and the card editor. The popup drill shows them in place of its queue;
 * the regular-queue drill's bar opens the first two in widgets/mastery_drill_panel.tsx
 * (the regular queue edits cards natively).
 *
 * Keyboard: ←/→ (or Tab) move the selection ring between the buttons, Enter runs
 * the selected one, Esc goes back. Keys are read on the container, never on the
 * buttons, so the ring and Enter always agree.
 */

import { RemHierarchyEditorTree, RemRichTextEditor, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { readDrillPriorities } from '../lib/mastery_drill_actions';
import { FinalDrillEntry } from '../lib/mastery_drill_cooling';
import { EditLaterNote } from './MasteryDrillHeader';

const ring = (on: boolean): React.CSSProperties =>
  on ? { outline: '2px solid var(--rn-clr-border-accent, #3B82F6)', outlineOffset: '2px' } : {};

const secondaryButton: React.CSSProperties = {
  border: '1px solid var(--rn-clr-border-primary)',
  color: 'var(--rn-clr-content-primary)',
  backgroundColor: 'var(--rn-clr-background-secondary)',
};

/** Focuses the container once RemNote has settled focus after the panel appeared. */
function useInitialFocus(ref: React.RefObject<HTMLElement>) {
  React.useEffect(() => {
    let cancelled = false;
    const tryFocus = (attemptsLeft: number) => {
      if (cancelled) return;
      ref.current?.focus();
      if (document.activeElement !== ref.current && attemptsLeft > 0) setTimeout(() => tryFocus(attemptsLeft - 1), 50);
    };
    tryFocus(8);
    return () => {
      cancelled = true;
    };
  }, [ref]);
}

/**
 * Arrow/Enter/Esc over a row of buttons. `actions[i]` runs for button i; `selected`
 * starts on `initial`. Returns the key handler for the container.
 */
function useButtonRowKeys(actions: Array<(() => void) | null>, initial: number, onEscape: () => void) {
  const [selected, setSelected] = React.useState(initial);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT') {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab') {
      e.preventDefault();
      const step = e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
      setSelected((i) => (i + step + actions.length) % actions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      actions[selected]?.();
    }
  };
  return { selected, setSelected, onKeyDown };
}

export function MasteryDrillConfirm({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  useInitialFocus(ref);
  const keys = useButtonRowKeys([onCancel, () => void onConfirm()], 1, onCancel);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={keys.onKeyDown}
      className="h-full w-full flex flex-col items-center justify-center p-4 text-center"
      style={{ outline: 'none', backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)' }}
    >
      <h3 className="text-lg font-bold mb-2">{title}</h3>
      <p className="mb-6 text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
        {message}
      </p>
      <div className="flex gap-4">
        <button
          onClick={onCancel}
          onMouseEnter={() => keys.setSelected(0)}
          className="px-4 py-2 rounded transition-colors"
          style={{ ...secondaryButton, ...ring(keys.selected === 0) }}
        >
          Cancel
        </button>
        <button
          onClick={() => void onConfirm()}
          onMouseEnter={() => keys.setSelected(1)}
          className="px-4 py-2 rounded text-white transition-colors"
          style={{ backgroundColor: '#ea5e5e', ...ring(keys.selected === 1) }}
        >
          {confirmLabel}
        </button>
      </div>
      <p className="mt-4 text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
        ←/→ choose · Enter confirm · Esc back
      </p>
    </div>
  );
}

/** Histogram of the drill's card priorities, and removal of everything above a threshold. ↑/↓ move it by 5. */
export function MasteryDrillLowPriority({
  items,
  onRemove,
  onBack,
}: {
  items: FinalDrillEntry[];
  onRemove: (cardIds: string[]) => Promise<void>;
  onBack: () => void;
}) {
  const plugin = usePlugin();
  const ref = React.useRef<HTMLDivElement>(null);
  useInitialFocus(ref);
  const [data, setData] = React.useState<{ cardId: string; priority: number }[] | null>(null);
  const [threshold, setThreshold] = React.useState(70);

  React.useEffect(() => {
    let cancelled = false;
    void readDrillPriorities(plugin, items, () => cancelled).then((results) => {
      if (!cancelled) setData(results);
    });
    return () => {
      cancelled = true;
    };
    // Read once when the panel opens; a sync while it is up should not reshuffle the bars.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin]);

  const toRemove = data?.filter(({ priority }) => priority > threshold) ?? [];
  const remove = async () => {
    if (toRemove.length === 0) return;
    await onRemove(toRemove.map(({ cardId }) => cardId));
  };
  const keys = useButtonRowKeys([() => void remove(), onBack], 0, onBack);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (e.target as HTMLElement).tagName !== 'INPUT') {
      e.preventDefault();
      setThreshold((t) => Math.min(100, Math.max(0, t + (e.key === 'ArrowUp' ? 5 : -5))));
      return;
    }
    keys.onKeyDown(e);
  };

  const getBucket = (p: number) => Math.min(Math.floor(Math.max(p - 1, 0) / 5), 19);
  const buckets = Array.from({ length: 20 }, (_, i) => ({
    label: i === 0 ? '0-5' : `${i * 5 + 1}-${(i + 1) * 5}`,
    minPriority: i === 0 ? 0 : i * 5 + 1,
    maxPriority: (i + 1) * 5,
    count: 0,
  }));
  data?.forEach(({ priority }) => {
    buckets[getBucket(priority)].count++;
  });
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const n = toRemove.length;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="h-full w-full flex flex-col"
      style={{ outline: 'none', backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)' }}
    >
      <div
        className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0"
        style={{ borderColor: 'var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}
      >
        <span className="font-semibold">Clear Low Priority Cards</span>
        <button
          onClick={onBack}
          className="text-sm px-2 py-1 rounded transition-colors"
          style={{ color: 'var(--rn-clr-content-secondary)', border: '1px solid var(--rn-clr-border-primary)' }}
        >
          ← Back
        </button>
      </div>

      {data === null ? (
        <div className="flex-grow flex items-center justify-center text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          Loading priorities…
        </div>
      ) : (
        <>
          <div className="overflow-y-auto px-4 py-2" style={{ maxHeight: '65vh' }}>
            {buckets.map((bucket, i) => {
              const isAbove = bucket.minPriority > threshold;
              const isSplit = !isAbove && bucket.maxPriority > threshold;
              const barColor = isAbove ? '#ef4444' : isSplit ? '#f97316' : 'var(--rn-clr-blue)';
              const barWidth = bucket.count > 0 ? Math.max((bucket.count / maxCount) * 100, 2) : 0;
              return (
                <div key={i} className="flex items-center gap-2 py-0.5" style={{ opacity: bucket.count === 0 ? 0.3 : 1 }}>
                  <span
                    className="text-xs w-14 text-right flex-shrink-0 font-mono"
                    style={{
                      color: isAbove ? '#ef4444' : isSplit ? '#f97316' : 'var(--rn-clr-content-secondary)',
                      fontWeight: isAbove || isSplit ? 600 : undefined,
                    }}
                  >
                    {bucket.label}
                  </span>
                  <div className="flex-grow rounded overflow-hidden" style={{ height: 14, backgroundColor: 'var(--rn-clr-background-secondary)' }}>
                    <div style={{ width: `${barWidth}%`, height: '100%', backgroundColor: barColor, transition: 'width 0.15s' }} />
                  </div>
                  <span className="text-xs w-5 text-right flex-shrink-0" style={{ color: isAbove ? '#ef4444' : 'var(--rn-clr-content-tertiary)' }}>
                    {bucket.count}
                  </span>
                </div>
              );
            })}
          </div>

          <div
            className="flex-shrink-0 px-4 py-2 border-t flex flex-col gap-2"
            style={{ borderColor: 'var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                Remove cards with priority above:
              </span>
              <input
                type="number"
                min={0}
                max={100}
                value={threshold}
                onChange={(e) => setThreshold(Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                className="w-14 text-xs p-1 rounded text-center"
                style={{ border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)' }}
              />
              <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                ↑/↓ ±5 · ←/→ choose · Enter · Esc back
              </span>
              <span className="text-xs ml-auto" style={{ color: n > 0 ? '#ef4444' : 'var(--rn-clr-content-tertiary)' }}>
                {n === 0 ? 'No cards to remove' : `${n} card${n !== 1 ? 's' : ''} will be removed`}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void remove()}
                onMouseEnter={() => keys.setSelected(0)}
                disabled={n === 0}
                className="flex-1 py-1.5 rounded text-sm font-medium transition-colors"
                style={{
                  backgroundColor: n > 0 ? '#ef4444' : 'var(--rn-clr-background-primary)',
                  color: n > 0 ? 'white' : 'var(--rn-clr-content-tertiary)',
                  border: n === 0 ? '1px solid var(--rn-clr-border-primary)' : undefined,
                  cursor: n === 0 ? 'not-allowed' : 'pointer',
                  ...ring(keys.selected === 0),
                }}
              >
                {n > 0 ? `Remove ${n} card${n !== 1 ? 's' : ''}` : 'No cards to remove'}
              </button>
              <button
                onClick={onBack}
                onMouseEnter={() => keys.setSelected(1)}
                className="flex-1 py-1.5 rounded text-sm font-medium transition-colors"
                style={{
                  border: '1px solid var(--rn-clr-border-primary)',
                  color: 'var(--rn-clr-content-secondary)',
                  backgroundColor: 'var(--rn-clr-background-primary)',
                  ...ring(keys.selected === 1),
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A drill card's Rem in RemNote's editors, with Edit Later and Go to Rem. Esc goes
 * back when focus is on the panel itself; inside an editor, Esc is the editor's.
 */
export function MasteryDrillCardEditor({
  remId,
  onEditLater,
  onGoToRem,
  onDone,
  doneLabel = 'Done / Back to Drill',
}: {
  remId: string;
  onEditLater: (message: string) => Promise<void>;
  onGoToRem: () => void;
  onDone: () => void;
  doneLabel?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  useInitialFocus(ref);
  const [noteOpen, setNoteOpen] = React.useState(false);
  const [note, setNote] = React.useState('');
  const openNote = () => {
    setNote('');
    setNoteOpen(true);
  };
  const keys = useButtonRowKeys([openNote, onGoToRem, onDone], 2, onDone);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.target === ref.current) keys.onKeyDown(e);
      }}
      className="h-full w-full flex flex-col"
      style={{ outline: 'none', backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)' }}
    >
      <div
        className="w-full flex justify-between items-center p-2 border-b flex-shrink-0"
        style={{ borderColor: 'var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)' }}
      >
        <div className="flex flex-col">
          <span className="font-semibold text-lg px-2">Editing Card</span>
          <span className="text-xs px-2 font-mono" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            ID: {remId}
          </span>
        </div>
        <div className="flex gap-2" style={{ paddingRight: '60px' }}>
          <button
            onClick={openNote}
            onMouseEnter={() => keys.setSelected(0)}
            className="px-3 py-1.5 rounded bg-orange-500 text-white hover:bg-orange-600 font-medium transition-colors shadow-md"
            style={ring(keys.selected === 0)}
            title="Mark for Edit Later and remove from drill"
          >
            Edit Later
          </button>
          <button
            onClick={onGoToRem}
            onMouseEnter={() => keys.setSelected(1)}
            className="px-3 py-1.5 rounded font-medium transition-colors"
            style={{
              color: 'var(--rn-clr-content-primary)',
              border: '1px solid var(--rn-clr-border-primary)',
              backgroundColor: 'var(--rn-clr-background-primary)',
              ...ring(keys.selected === 1),
            }}
          >
            Go to Rem
          </button>
          <button
            onClick={onDone}
            onMouseEnter={() => keys.setSelected(2)}
            className="px-3 py-1.5 rounded bg-blue-500 text-white hover:bg-blue-600 font-medium transition-colors shadow-sm"
            style={ring(keys.selected === 2)}
          >
            {doneLabel}
          </button>
        </div>
      </div>

      {noteOpen && (
        <EditLaterNote
          value={note}
          onChange={setNote}
          onConfirm={async () => {
            await onEditLater(note);
            setNoteOpen(false);
          }}
          onCancel={() => {
            setNoteOpen(false);
            ref.current?.focus();
          }}
        />
      )}

      <div className="flex-grow w-full overflow-hidden flex flex-col p-4 overflow-y-auto gap-6">
        <div className="flex-shrink-0">
          <div className="text-sm font-bold mb-2 px-2 uppercase tracking-wide" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            Rem Content
          </div>
          <div className="border rounded-md p-2" style={{ borderColor: 'var(--rn-clr-border-primary)' }}>
            <RemRichTextEditor remId={remId} width="100%" />
          </div>
        </div>

        <div className="flex-grow flex flex-col min-h-[200px]">
          <div className="text-sm font-bold mb-2 px-2 uppercase tracking-wide" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            Hierarchy / Details
          </div>
          <div className="flex-grow border rounded-md p-2" style={{ borderColor: 'var(--rn-clr-border-primary)' }}>
            <RemHierarchyEditorTree remId={remId} width="100%" height="auto" />
          </div>
        </div>
      </div>
    </div>
  );
}
