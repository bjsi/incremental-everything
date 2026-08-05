import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import {
  powerupCode,
  repHistorySlotCode,
  dismissedPowerupCode,
  dismissedHistorySlotCode,
} from './consts';
import { IncrementalRep } from './incremental_rem/types';
import { getIncrementalRemFromRem } from './incremental_rem';
import { updateIncrementalRemCache } from './incremental_rem/cache';
import { updateSRSDataForRem } from './scheduler';
import { sanitizeNote } from './history_notes';
import { tryParseJson } from './utils';

/**
 * After-the-fact editing of a rem's repetition history, backing the Repetition
 * History popup's "Add session" / row-level edit + delete actions.
 *
 * Everything here writes the SAME History slot the review flows write, on
 * whichever powerup currently holds it:
 *   - active Incremental Rem  → `powerupCode` / `repHistorySlotCode`
 *   - dismissed rem           → `dismissedPowerupCode` / `dismissedHistorySlotCode`
 *
 * Two invariants are maintained on every write, because the rest of the plugin
 * relies on them:
 *   1. The array stays sorted by `date` ascending. The scheduler walks it
 *      positionally (reps since the last 'madeIncremental' marker, lookback mode
 *      dropping "the last interaction"), so a chronologically out-of-order entry
 *      would silently corrupt interval computation.
 *   2. The LAST entry keeps a `nextRepMs` stamp whenever one is known. That
 *      stamp is the read-time fallback for the next-rep date when the Daily Doc
 *      reference doesn't round-trip (see getIncrementalRemFromRem); losing it
 *      makes the rem read as due-now.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export type HistoryStoreKind = 'incremental' | 'dismissed';

interface HistoryStore {
  kind: HistoryStoreKind;
  rem: PluginRem;
  history: IncrementalRep[];
}

export interface HistoryWriteResult {
  ok: boolean;
  /** Whether the next-rep date was also updated (add-session path only). */
  rescheduled?: boolean;
  /** User-facing failure reason; only set when ok === false. */
  error?: string;
}

/**
 * Locate the powerup slot that currently holds this rem's history, and read it.
 * Returns null for rems that are neither incremental nor dismissed — there is no
 * history to amend there.
 */
async function resolveHistoryStore(
  plugin: RNPlugin,
  remId: string
): Promise<HistoryStore | null> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return null;

  if (await rem.hasPowerup(powerupCode)) {
    const parsed = tryParseJson(await rem.getPowerupProperty(powerupCode, repHistorySlotCode));
    return { kind: 'incremental', rem, history: Array.isArray(parsed) ? parsed : [] };
  }

  if (await rem.hasPowerup(dismissedPowerupCode)) {
    const parsed = tryParseJson(
      await rem.getPowerupProperty(dismissedPowerupCode, dismissedHistorySlotCode)
    );
    return { kind: 'dismissed', rem, history: Array.isArray(parsed) ? parsed : [] };
  }

  return null;
}

/** Chronological order, stable for entries sharing a timestamp. */
function sortChronologically(history: IncrementalRep[]): IncrementalRep[] {
  return history
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => (a.entry.date || 0) - (b.entry.date || 0) || a.i - b.i)
    .map((x) => x.entry);
}

/** The most recent `nextRepMs` known anywhere in an array (scanning newest first). */
function latestNextRepStamp(history: IncrementalRep[]): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (typeof history[i].nextRepMs === 'number') return history[i].nextRepMs;
  }
  return undefined;
}

/**
 * Re-stamp the last entry with the last known next-rep timestamp when the
 * mutation moved or removed the entry that carried it. Invariant 2 above.
 */
function preserveNextRepStamp(
  history: IncrementalRep[],
  previousStamp: number | undefined
): IncrementalRep[] {
  if (history.length === 0 || previousStamp === undefined) return history;
  const last = history[history.length - 1];
  if (typeof last.nextRepMs === 'number') return history;
  return history.map((entry, i) =>
    i === history.length - 1 ? { ...entry, nextRepMs: previousStamp } : entry
  );
}

/** Write the amended history back to whichever slot holds it, then refresh the cache. */
async function persist(
  plugin: RNPlugin,
  store: HistoryStore,
  history: IncrementalRep[]
): Promise<void> {
  if (store.kind === 'incremental') {
    await store.rem.setPowerupProperty(powerupCode, repHistorySlotCode, [
      JSON.stringify(history),
    ]);
    await syncCache(plugin, store.rem);
  } else {
    await store.rem.setPowerupProperty(dismissedPowerupCode, dismissedHistorySlotCode, [
      JSON.stringify(history),
    ]);
  }
}

/** Keep the session IncRem cache in step so dashboards/queue see the amended history. */
async function syncCache(plugin: RNPlugin, rem: PluginRem): Promise<void> {
  try {
    const updated = await getIncrementalRemFromRem(plugin, rem);
    if (updated) await updateIncrementalRemCache(plugin, updated);
  } catch (e) {
    console.warn('[history_edit] cache refresh failed:', e);
  }
}

/**
 * Identity of a history entry, used to re-locate it in a freshly-read array
 * (the popup's copy may be a few seconds stale, and a concurrent review could
 * have appended to it). Deliberately value-based rather than positional.
 */
export function repSignature(rep: IncrementalRep): string {
  return JSON.stringify([
    rep.date ?? null,
    rep.eventType ?? 'rep',
    rep.reviewTimeSeconds ?? null,
    rep.scheduled ?? null,
    rep.interval ?? null,
  ]);
}

/** Index of `target` in `history`, preferring `hintIndex` when it still matches. */
function locateEntry(
  history: IncrementalRep[],
  target: IncrementalRep,
  hintIndex?: number
): number {
  const sig = repSignature(target);
  if (
    hintIndex !== undefined &&
    hintIndex >= 0 &&
    hintIndex < history.length &&
    repSignature(history[hintIndex]) === sig
  ) {
    return hintIndex;
  }
  return history.findIndex((entry) => repSignature(entry) === sig);
}

/** Recompute the early/late fields of an entry against its recorded `scheduled` date. */
function withEarlyLate(entry: IncrementalRep, date: number): IncrementalRep {
  const scheduled = entry.scheduled;
  if (typeof scheduled !== 'number' || scheduled <= 0) return { ...entry, date };
  const daysDifference = (date - scheduled) / MS_PER_DAY;
  return {
    ...entry,
    date,
    wasEarly: daysDifference < 0,
    daysEarlyOrLate: Math.round(daysDifference * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Add an external session
// ---------------------------------------------------------------------------

export interface ExternalSessionInput {
  /** Wall-clock timestamp at which the session ENDED (matches how reps are dated). */
  date: number;
  /** Total time studied, in seconds. */
  reviewTimeSeconds: number;
  /** Optional user note stored on the entry. */
  note?: string;
  /**
   * When set, ALSO reschedule the rem to this date — mirroring Ctrl+Shift+J.
   * Honoured only for an active IncRem whose session is the newest entry; a
   * backdated session never touches the schedule.
   */
  nextRepDate?: number;
}

/**
 * Whether an external session dated `date` would be the newest entry in
 * `history` — the condition under which rescheduling is offered.
 */
export function isNewestEntry(history: IncrementalRep[], date: number): boolean {
  if (!history || history.length === 0) return true;
  const newest = history.reduce((max, entry) => Math.max(max, entry.date || 0), 0);
  return date >= newest;
}

/**
 * Record a study session that happened outside RemNote (past date, end time and
 * total time), as an 'externalRep' entry in the rem's history.
 *
 * The entry is inserted chronologically. When it lands at the end and
 * `nextRepDate` is supplied, the rem is rescheduled too; otherwise only the
 * History slot is written and the schedule is left exactly as it was.
 */
export async function addExternalSessionRep(
  plugin: RNPlugin,
  remId: string,
  input: ExternalSessionInput
): Promise<HistoryWriteResult> {
  const store = await resolveHistoryStore(plugin, remId);
  if (!store) {
    return { ok: false, error: 'This Rem is neither Incremental nor dismissed — nothing to record against.' };
  }

  const incRem =
    store.kind === 'incremental' ? await getIncrementalRemFromRem(plugin, store.rem) : null;

  // What was scheduled at the time of the session: the next-rep stamp left by
  // the most recent entry that predates it, falling back to the rem's current
  // due date. This makes the early/late column meaningful for backdated records.
  const priorStamp = sortChronologically(store.history)
    .filter((entry) => (entry.date || 0) <= input.date)
    .reduce<number | undefined>(
      (found, entry) => (typeof entry.nextRepMs === 'number' ? entry.nextRepMs : found),
      undefined
    );
  const scheduled = priorStamp ?? incRem?.nextRepDate ?? input.date;

  const entry: IncrementalRep = withEarlyLate(
    {
      date: input.date,
      scheduled,
      reviewTimeSeconds: input.reviewTimeSeconds > 0 ? input.reviewTimeSeconds : undefined,
      eventType: 'externalRep',
      ...(incRem ? { priority: incRem.priority } : {}),
    },
    input.date
  );

  const note = sanitizeNote(input.note);
  if (note) entry.notes = note;

  const previousStamp = latestNextRepStamp(store.history);
  const merged = sortChronologically([...store.history, entry]);
  const isLast = merged[merged.length - 1] === entry;

  const shouldReschedule =
    store.kind === 'incremental' && isLast && typeof input.nextRepDate === 'number';

  if (shouldReschedule) {
    const nextRepDate = input.nextRepDate!;
    entry.interval = Math.round(((nextRepDate - input.date) / MS_PER_DAY) * 10) / 10;
    // updateSRSDataForRem stamps nextRepMs on the last entry (our new one) and
    // writes the Daily Doc reference, so the rem's due date moves with it.
    await updateSRSDataForRem(plugin, remId, nextRepDate, merged);
    await syncCache(plugin, store.rem);
    return { ok: true, rescheduled: true };
  }

  await persist(plugin, store, preserveNextRepStamp(merged, previousStamp));
  return { ok: true, rescheduled: false };
}

// ---------------------------------------------------------------------------
// Edit / delete an existing entry
// ---------------------------------------------------------------------------

export interface HistoryEntryPatch {
  /** New end timestamp for the entry. */
  date?: number;
  /** New total time in seconds; 0 clears it. */
  reviewTimeSeconds?: number;
  /** New note text; empty string clears it. */
  notes?: string;
}

/**
 * Amend one history entry's date / total time / note in place. Early-late status
 * is recomputed from the entry's own `scheduled` date, and the array is re-sorted
 * when the new date reorders it. The schedule is never touched.
 */
export async function updateHistoryEntry(
  plugin: RNPlugin,
  remId: string,
  target: IncrementalRep,
  patch: HistoryEntryPatch,
  hintIndex?: number
): Promise<HistoryWriteResult> {
  const store = await resolveHistoryStore(plugin, remId);
  if (!store) return { ok: false, error: 'No history found for this Rem.' };

  const index = locateEntry(store.history, target, hintIndex);
  if (index === -1) {
    return { ok: false, error: 'That entry is no longer in the history — reopen the popup and try again.' };
  }

  const original = store.history[index];
  let updated: IncrementalRep = { ...original };

  if (patch.date !== undefined && patch.date !== original.date) {
    updated = withEarlyLate(updated, patch.date);
  }
  if (patch.reviewTimeSeconds !== undefined) {
    if (patch.reviewTimeSeconds > 0) {
      updated.reviewTimeSeconds = patch.reviewTimeSeconds;
    } else {
      delete updated.reviewTimeSeconds;
    }
  }
  if (patch.notes !== undefined) {
    const note = sanitizeNote(patch.notes);
    if (note) {
      updated.notes = note;
    } else {
      delete updated.notes;
    }
  }

  const previousStamp = latestNextRepStamp(store.history);
  const next = [...store.history];
  next[index] = updated;

  await persist(plugin, store, preserveNextRepStamp(sortChronologically(next), previousStamp));
  return { ok: true };
}

/**
 * Remove one history entry. Used for accidental or duplicate records; the popup
 * confirms first, and warns when the entry is a lifecycle marker.
 */
export async function deleteHistoryEntry(
  plugin: RNPlugin,
  remId: string,
  target: IncrementalRep,
  hintIndex?: number
): Promise<HistoryWriteResult> {
  const store = await resolveHistoryStore(plugin, remId);
  if (!store) return { ok: false, error: 'No history found for this Rem.' };

  const index = locateEntry(store.history, target, hintIndex);
  if (index === -1) {
    return { ok: false, error: 'That entry is no longer in the history — reopen the popup and try again.' };
  }

  const previousStamp = latestNextRepStamp(store.history);
  const next = store.history.filter((_, i) => i !== index);

  await persist(plugin, store, preserveNextRepStamp(next, previousStamp));
  return { ok: true };
}
