import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import {
  SchedulerCardsExport,
  SchedulerCardsManifest,
  clearSchedulerCards,
  getSchedulerManifest,
  saveSchedulerCards,
  schedulerTypeLabel,
} from '../lib/scheduler_cards';

/**
 * Import the list written by scripts/export_scheduler_cards.py: the cards RemNote
 * schedules with something other than the Global Default. See lib/scheduler_cards.ts.
 */

/** The Enter that ran a command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;

function SchedulerList({ schedulers }: { schedulers: { name: string; type: string; count: number }[] }) {
  return (
    <ul className="list-disc ml-5 text-sm">
      {schedulers.map((s) => (
        <li key={s.name}>
          {s.name} ({schedulerTypeLabel(s.type)}): {s.count.toLocaleString()} cards
        </li>
      ))}
    </ul>
  );
}

function ImportSchedulerCards() {
  const plugin = usePlugin();
  const containerRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(Date.now());
  const fileRef = useRef<HTMLInputElement>(null);
  const [kbId, setKbId] = useState<string | null>(null);
  const [current, setCurrent] = useState<SchedulerCardsManifest | null>(null);
  const [pending, setPending] = useState<SchedulerCardsExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    containerRef.current?.focus();
    (async () => {
      const id = (await plugin.kb.getCurrentKnowledgeBaseData())?._id ?? null;
      setKbId(id);
      if (id) setCurrent(await getSchedulerManifest(plugin as any, id));
    })().catch((e) => setError(String(e)));
  }, [plugin]);

  const close = () => plugin.widget.closePopup();

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPending(null);
    setSelected(0);
    containerRef.current?.focus();
    let parsed;
    try {
      parsed = SchedulerCardsExport.safeParse(JSON.parse(await file.text()));
    } catch {
      setError(`${file.name} is not a JSON file.`);
      return;
    }
    if (!parsed.success) {
      setError(`${file.name} was not written by scripts/export_scheduler_cards.py.`);
    } else if (parsed.data.kbId !== kbId) {
      setError(
        `${file.name} belongs to knowledge base ${parsed.data.kbId}, but this one is ${kbId}. ` +
          'Export it with --kb, or import it from the right knowledge base.',
      );
    } else {
      setPending(parsed.data);
    }
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      close();
    } catch (e: any) {
      // Shown here rather than in a toast, which can vanish behind another one.
      setError(`Import failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doImport = () =>
    run(async () => {
      const manifest = await saveSchedulerCards(plugin as any, kbId!, pending!);
      await plugin.app.toast(`✅ Stored ${manifest.cardCount.toLocaleString()} cards on other schedulers`);
    });

  const doClear = () =>
    run(async () => {
      await clearSchedulerCards(plugin as any, kbId!);
      await plugin.app.toast('Removed the other-scheduler cards list');
    });

  const buttons: { label: string; primary?: boolean; run: () => void }[] = busy
    ? []
    : [
        ...(pending ? [{ label: 'Import', primary: true, run: doImport }] : []),
        { label: pending ? 'Choose another file…' : 'Choose file…', primary: !pending, run: () => fileRef.current?.click() },
        ...(current ? [{ label: 'Remove list', run: doClear }] : []),
        { label: 'Cancel', run: close },
      ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current >= ENTER_GRACE_MS) buttons[selected]?.run();
    } else if (buttons.length > 0 && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) {
      e.preventDefault();
      setSelected((i) => (i + 1) % buttons.length);
    } else if (buttons.length > 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) {
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
      <div className="text-base font-semibold">Import Other-Scheduler Cards List</div>
      <div className="text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
        Labels the cards RemNote schedules with something other than the Global Default, and lets
        Card Analytics and FSRS Calibration leave them out. Create the file on a computer with{' '}
        <code>python3 scripts/export_scheduler_cards.py</code>.
      </div>

      {current && !pending && (
        <div className="text-sm">
          Current list, from {new Date(current.generatedAt).toLocaleDateString()}:
          <SchedulerList
            schedulers={current.schedulers.map((s) => ({ name: s.name, type: s.type, count: s.cardCount }))}
          />
        </div>
      )}
      {pending && (
        <div className="text-sm">
          Ready to import, from {new Date(pending.generatedAt).toLocaleDateString()}:
          <SchedulerList
            schedulers={pending.schedulers.map((s) => ({ name: s.name, type: s.type, count: s.cards.length }))}
          />
        </div>
      )}
      {error && (
        <div className="text-sm" style={{ color: '#ef4444' }}>
          {error}
        </div>
      )}
      {busy && <div className="text-sm">Working…</div>}

      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
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

renderWidget(ImportSchedulerCards);
