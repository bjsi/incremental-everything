import { renderWidget, usePlugin, RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { z } from 'zod';
import dayjs from 'dayjs';
import {
  powerupCode,
  prioritySlotCode,
  nextRepDateSlotCode,
  repHistorySlotCode,
  originalIncrementalDateSlotCode,
  allIncrementalRemKey,
} from '../lib/consts';
import { IncrementalRep, IncrementalRem } from '../lib/incremental_rem/types';
import { getDailyDocReferenceForDate, sleep } from '../lib/utils';

/**
 * Import Incremental Rems with History
 *
 * Accepts a JSON payload (produced e.g. by scripts/convert_study_log.py) that
 * describes a set of "books", each optionally incremental itself and each with
 * a set of chapter rems, every one carrying a full pre-computed
 * IncrementalRep[] history. Creates the rem hierarchy
 * (root document → book documents → chapter rems), applies the Incremental
 * powerup and writes the four powerup slots exactly like initIncrementalRem
 * does. 'Created' (originalIncDate) points to the import day, and a
 * 'madeIncremental' marker is appended AFTER the imported reps so the
 * scheduler restarts interval counting from the import (with the classic
 * exponential scheduler, counting hundreds of imported reps would explode
 * the next interval).
 *
 * The import is resume-safe: rems that already exist (matched by text under
 * the same parent) and already carry the Incremental powerup are skipped, so
 * re-running the import after an interruption continues where it left off.
 */

// ---------------------------------------------------------------------------
// Payload schema (version 1)
// ---------------------------------------------------------------------------

const ImportChapterSchema = z.object({
  chapter: z.string(),
  title: z.string().min(1),
  history: z.array(IncrementalRep).min(1),
});

const ImportBookSchema = z.object({
  item: z.string(),
  title: z.string().min(1),
  /** History of logs without a chapter — applied to the book rem itself. */
  history: z.array(IncrementalRep).min(1).nullable().optional(),
  chapters: z.array(ImportChapterSchema),
});

const ImportPayloadSchema = z.object({
  version: z.literal(1),
  defaultPriority: z.number().min(0).max(100).default(90),
  nextRepDays: z.number().min(0).default(10),
  books: z.array(ImportBookSchema).min(1),
});

type ImportPayload = z.infer<typeof ImportPayloadSchema>;

const HISTORY_SIZE_WARN_BYTES = 50_000;

interface PayloadSummary {
  books: number;
  incRems: number;
  logEntries: number;
  oversized: { name: string; kb: number; entries: number }[];
}

function summarizePayload(payload: ImportPayload): PayloadSummary {
  let incRems = 0;
  let logEntries = 0;
  const oversized: PayloadSummary['oversized'] = [];
  for (const book of payload.books) {
    const histories: { name: string; history: IncrementalRep[] }[] = [];
    if (book.history) histories.push({ name: book.title, history: book.history });
    for (const ch of book.chapters) {
      histories.push({ name: `${book.title} / ${ch.title}`, history: ch.history });
    }
    for (const { name, history } of histories) {
      incRems++;
      logEntries += history.filter((h) => h.eventType === 'rep' || !h.eventType).length;
      const bytes = new Blob([JSON.stringify(history)]).size;
      if (bytes > HISTORY_SIZE_WARN_BYTES) {
        oversized.push({ name, kb: Math.round(bytes / 1024), entries: history.length });
      }
    }
  }
  oversized.sort((a, b) => b.kb - a.kb);
  return { books: payload.books.length, incRems, logEntries, oversized };
}

// ---------------------------------------------------------------------------
// Import engine
// ---------------------------------------------------------------------------

interface ImportProgress {
  done: number;
  total: number;
  current: string;
}

interface ImportResult {
  createdBooks: number;
  createdChapters: number;
  madeIncremental: number;
  skippedAlreadyIncremental: number;
  failed: { name: string; error: string }[];
}

async function remTextToString(plugin: RNPlugin, rem: PluginRem): Promise<string> {
  try {
    return ((await plugin.richText.toString(rem.text || [])) || '').trim();
  } catch {
    return '';
  }
}

/** Map of child text → rem, used to make the import resume-safe. */
async function childrenByText(plugin: RNPlugin, parent: PluginRem): Promise<Map<string, PluginRem>> {
  const map = new Map<string, PluginRem>();
  const children = (await parent.getChildrenRem()) || [];
  for (const child of children) {
    const text = await remTextToString(plugin, child);
    if (text && !map.has(text)) map.set(text, child);
  }
  return map;
}

async function runImport(
  plugin: RNPlugin,
  payload: ImportPayload,
  rootName: string,
  setProgress: (p: ImportProgress) => void
): Promise<ImportResult> {
  const result: ImportResult = {
    createdBooks: 0,
    createdChapters: 0,
    madeIncremental: 0,
    skippedAlreadyIncremental: 0,
    failed: [],
  };

  const total = payload.books.reduce(
    (n, b) => n + (b.history ? 1 : 0) + b.chapters.length,
    0
  );
  let done = 0;

  // Suppress GlobalRemChanged handling in events.ts for the whole batch.
  await plugin.storage.setSession('plugin_operation_active', true);

  const importedIncRems: IncrementalRem[] = [];

  try {
    // One shared next-rep daily-doc reference for every imported rem.
    // NOTE: daily-doc lookups are intentionally serialized throughout this
    // import — concurrent getDailyDoc calls for the same missing doc can race
    // (see the comment in initIncrementalRem).
    const nextRepDate = new Date(Date.now() + payload.nextRepDays * 24 * 60 * 60 * 1000);
    const nextRepRef = await getDailyDocReferenceForDate(plugin, nextRepDate);
    if (!nextRepRef) {
      throw new Error('Could not create the daily document for the next repetition date');
    }
    const nextRepMs = nextRepDate.getTime();
    const nextRepStartOfDayMs = dayjs(nextRepDate).startOf('day').valueOf();

    // 'Created' points to the import day (one shared daily-doc reference).
    const createdRef = await getDailyDocReferenceForDate(plugin, new Date());
    const createdAtMs = dayjs().startOf('day').valueOf();

    const applyIncremental = async (rem: PluginRem, history: IncrementalRep[]) => {
      if (await rem.hasPowerup(powerupCode)) {
        result.skippedAlreadyIncremental++;
        return;
      }
      // Append the 'madeIncremental' marker AFTER the imported reps: the
      // scheduler counts reps since the LAST marker, so interval counting
      // restarts fresh at the import. The marker carries nextRepMs — the
      // reliable read-time fallback for the next-rep date (mirrors
      // initIncrementalRem).
      const stamped: IncrementalRep[] = history.concat({
        date: Date.now(),
        scheduled: Date.now(),
        eventType: 'madeIncremental',
        priority: payload.defaultPriority,
        nextRepMs,
      });

      await rem.addPowerup(powerupCode);
      await Promise.all([
        rem.setPowerupProperty(powerupCode, prioritySlotCode, [
          String(payload.defaultPriority),
        ]),
        rem.setPowerupProperty(powerupCode, nextRepDateSlotCode, nextRepRef),
        rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(stamped)]),
        ...(createdRef
          ? [rem.setPowerupProperty(powerupCode, originalIncrementalDateSlotCode, createdRef)]
          : []),
      ]);

      const parsed = IncrementalRem.safeParse({
        remId: rem._id,
        nextRepDate: nextRepStartOfDayMs,
        priority: payload.defaultPriority,
        history: stamped,
        createdAt: createdAtMs,
      });
      if (parsed.success) importedIncRems.push(parsed.data);
      result.madeIncremental++;
    };

    // Root document (reused when it already exists — enables resume).
    let root = await plugin.rem.findByName([rootName], null);
    if (!root) {
      root = await plugin.rem.createRem();
      if (!root) throw new Error('Failed to create the root document');
      await root.setText([rootName]);
      await root.setIsDocument(true);
    }

    const existingBooks = await childrenByText(plugin, root);

    for (const book of payload.books) {
      try {
        let bookRem = existingBooks.get(book.title);
        let existingChapters: Map<string, PluginRem> | undefined;
        if (!bookRem) {
          const created = await plugin.rem.createRem();
          if (!created) throw new Error('createRem returned undefined');
          bookRem = created;
          await bookRem.setText([book.title]);
          await bookRem.setParent(root);
          await bookRem.setIsDocument(true);
          result.createdBooks++;
        } else {
          existingChapters = await childrenByText(plugin, bookRem);
        }

        if (book.history) {
          setProgress({ done, total, current: book.title });
          await applyIncremental(bookRem, book.history);
          done++;
        }

        for (const chapter of book.chapters) {
          setProgress({ done, total, current: `${book.title} / ${chapter.title}` });
          try {
            let chapterRem = existingChapters?.get(chapter.title);
            if (!chapterRem) {
              const created = await plugin.rem.createRem();
              if (!created) throw new Error('createRem returned undefined');
              chapterRem = created;
              await chapterRem.setText([chapter.title]);
              await chapterRem.setParent(bookRem);
              result.createdChapters++;
            }
            await applyIncremental(chapterRem, chapter.history);
          } catch (e) {
            result.failed.push({
              name: `${book.title} / ${chapter.title}`,
              error: String(e),
            });
          }
          done++;
          // Brief pause every 20 rems so the SDK bridge isn't saturated.
          if (done % 20 === 0) await sleep(50);
        }
      } catch (e) {
        result.failed.push({ name: book.title, error: String(e) });
        done += (book.history ? 1 : 0) + book.chapters.length;
      }
    }

    setProgress({ done: total, total, current: 'Updating incremental rem cache…' });

    // Single bulk cache write instead of 1000+ per-rem updates
    // (updateIncrementalRemCache re-serializes the whole collection each call).
    const allRems: IncrementalRem[] =
      (await plugin.storage.getSession(allIncrementalRemKey)) || [];
    const importedIds = new Set(importedIncRems.map((r) => r.remId));
    await plugin.storage.setSession(
      allIncrementalRemKey,
      allRems.filter((r) => !importedIds.has(r.remId)).concat(importedIncRems)
    );
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

type Phase = 'input' | 'ready' | 'importing' | 'done';

export function ImportIncremHistory() {
  const plugin = usePlugin();
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState('');
  const [rootName, setRootName] = useState('Log de Atividades');
  const [fileName, setFileName] = useState('');
  const [payload, setPayload] = useState<ImportPayload | null>(null);
  const [summary, setSummary] = useState<PayloadSummary | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const parseJson = (raw: string, sourceName: string) => {
    setError('');
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      setError(`Not valid JSON: ${e}`);
      return;
    }
    const parsed = ImportPayloadSchema.safeParse(data);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setError(
        `Invalid import payload: ${first?.path?.join('.') || '(root)'} — ${first?.message}`
      );
      return;
    }
    setPayload(parsed.data);
    setSummary(summarizePayload(parsed.data));
    setFileName(sourceName);
    setPhase('ready');
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    parseJson(await file.text(), file.name);
  };

  const handleImport = async () => {
    if (!payload) return;
    setPhase('importing');
    try {
      const res = await runImport(plugin, payload, rootName.trim() || 'Imported Study Log', setProgress);
      setResult(res);
      setPhase('done');
      await plugin.app.toast(
        `✅ Import finished: ${res.madeIncremental} Incremental Rems` +
          (res.failed.length ? ` (${res.failed.length} failed)` : '')
      );
    } catch (e) {
      setError(`Import failed: ${e}`);
      setPhase('ready');
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto" style={{ maxHeight: 750 }}>
      <div className="text-xl font-bold">Import Incremental Rems with History</div>

      {phase === 'input' && (
        <>
          <div className="text-sm opacity-80">
            Load a JSON file produced by <code>scripts/convert_study_log.py</code> (or any
            payload following the version-1 import format). Nothing is created until you
            confirm on the next step.
          </div>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <div className="text-xs opacity-60">…or paste the JSON below:</div>
          <textarea
            ref={textRef}
            className="border rounded p-2 text-xs font-mono"
            rows={6}
            placeholder='{"version": 1, "books": [...]}'
          />
          <button
            className="self-start px-3 py-1 rounded bg-blue-600 text-white"
            style={{ backgroundColor: '#2563eb', color: 'white', padding: '4px 12px', borderRadius: 6 }}
            onClick={() => parseJson(textRef.current?.value || '', 'pasted JSON')}
          >
            Parse pasted JSON
          </button>
        </>
      )}

      {phase === 'ready' && summary && payload && (
        <>
          <div className="text-sm">
            Loaded <b>{fileName}</b>:
            <ul className="list-disc ml-5 mt-1">
              <li>{summary.books} books</li>
              <li>{summary.incRems} Incremental Rems to create</li>
              <li>{summary.logEntries} history entries (reps)</li>
              <li>
                Priority {payload.defaultPriority} · next repetition in {payload.nextRepDays}{' '}
                days
              </li>
            </ul>
          </div>

          {summary.oversized.length > 0 && (
            <div className="text-xs border border-yellow-500 rounded p-2">
              ⚠ {summary.oversized.length} histories exceed 50 KB — after importing, verify
              these rems sync correctly:
              <ul className="list-disc ml-5 mt-1">
                {summary.oversized.slice(0, 8).map((o) => (
                  <li key={o.name}>
                    {o.kb} KB · {o.entries} entries · {o.name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="text-sm flex flex-col gap-1">
            Root document name (books are created under it):
            <input
              className="border rounded p-1"
              value={rootName}
              onChange={(e) => setRootName(e.target.value)}
            />
          </label>

          <div className="text-xs opacity-70">
            The import may take a few minutes. <b>Keep this popup open</b> until it
            finishes — if it is interrupted, run the command again with the same file:
            already-imported rems are skipped.
          </div>

          <div className="flex gap-2">
            <button
              className="px-3 py-1 rounded bg-blue-600 text-white"
              style={{ backgroundColor: '#2563eb', color: 'white', padding: '4px 12px', borderRadius: 6 }}
              onClick={handleImport}
            >
              Import
            </button>
            <button
              className="px-3 py-1 rounded border"
              onClick={() => {
                setPayload(null);
                setSummary(null);
                setPhase('input');
              }}
            >
              Back
            </button>
          </div>
        </>
      )}

      {phase === 'importing' && progress && (
        <div className="flex flex-col gap-2">
          <div className="text-sm">
            Importing… {progress.done} / {progress.total}
          </div>
          <div className="w-full bg-gray-300 rounded h-2">
            <div
              className="bg-blue-600 h-2 rounded"
              style={{ backgroundColor: '#2563eb', height: 8, borderRadius: 6 }}
              style={{ width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` }}
            />
          </div>
          <div className="text-xs opacity-70 truncate">{progress.current}</div>
          <div className="text-xs opacity-60">Do not close this popup.</div>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="flex flex-col gap-2 text-sm">
          <div className="font-semibold">✅ Import finished</div>
          <ul className="list-disc ml-5">
            <li>{result.createdBooks} book documents created</li>
            <li>{result.createdChapters} chapter rems created</li>
            <li>{result.madeIncremental} rems made Incremental (with history)</li>
            {result.skippedAlreadyIncremental > 0 && (
              <li>{result.skippedAlreadyIncremental} skipped (already Incremental)</li>
            )}
          </ul>
          {result.failed.length > 0 && (
            <div className="text-xs border border-red-500 rounded p-2">
              ❌ {result.failed.length} failed:
              <ul className="list-disc ml-5 mt-1">
                {result.failed.slice(0, 10).map((f) => (
                  <li key={f.name}>
                    {f.name}: {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button
            className="self-start px-3 py-1 rounded bg-blue-600 text-white"
            style={{ backgroundColor: '#2563eb', color: 'white', padding: '4px 12px', borderRadius: 6 }}
            onClick={() => plugin.widget.closePopup()}
          >
            Close
          </button>
        </div>
      )}

      {error && <div className="text-sm text-red-600">{error}</div>}
    </div>
  );
}

renderWidget(ImportIncremHistory);
