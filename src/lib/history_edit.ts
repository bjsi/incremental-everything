import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import {
  powerupCode,
  repHistorySlotCode,
  dismissedPowerupCode,
  dismissedHistorySlotCode,
  pendingReviewJobQueueKey,
  editorReviewTimerRemIdKey,
} from './consts';
import { IncrementalRep, repCountsForStats } from './incremental_rem/types';
import { getIncrementalRemFromRem } from './incremental_rem';
import { updateIncrementalRemCache } from './incremental_rem/cache';
import { updateSRSDataForRem } from './scheduler';
import { sanitizeNote } from './history_notes';
import { tryParseJson } from './utils';
import { safeRemTextToString } from './pdfUtils';

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
  /** Machine context for the entry, such as the web page a Companion session read. */
  context?: IncrementalRep['context'];
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
      ...(input.context ? { context: input.context } : {}),
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
  /** Fields merged into the entry's machine context. */
  context?: IncrementalRep['context'];
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

  if (patch.context) updated.context = { ...updated.context, ...patch.context };

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

// ---------------------------------------------------------------------------
// Move a review's time to another rem
// ---------------------------------------------------------------------------
//
// "↪ Move to another Rem" in the Repetition History popup, for the session that
// came up as one IncRem in the queue but was spent reading another (a new
// version of a norm opened, and the section actually studied is elsewhere).
//
// A review carries two things, and the move separates them:
//   - its QUEUE FOOTPRINT (scheduler count and interval, same-day rule, early/
//     late, Priority Queue cooling) stays on the source: the entry keeps its
//     place, its eventType, interval and nextRepMs. Only `reviewTimeSeconds`
//     shrinks, and `context.movedTo` records where the time went.
//   - its STUDY TIME goes to the target as a new 'movedRep' entry, which counts
//     for statistics only (see types.ts). The target's schedule never sees it.
// So neither rem's schedule changes. A source review left with no time stops
// counting for stats (entryCountsForStats), so the rep is counted once.
//
// Two slot writes with no transaction: the target is written first and rolled
// back if the source write fails, so a failure never counts the time twice.

/** How long a queue → Companion hand-off may still be refined by the Companion. */
const COMPANION_HANDOFF_GRACE_MS = 24 * 60 * 60 * 1000;
/** Rem names stored on move links are capped like transfer names. */
const MOVED_NAME_MAX_CHARS = 60;

/** Context fields that describe what was read — copied onto the moved entry. */
const READING_CONTEXT_KEYS = [
  'page',
  'rangeStart',
  'rangeEnd',
  'pdfName',
  'bookmark',
  'readPoint',
  'readPointRemId',
  'videoTime',
  'videoStart',
  'videoEnd',
  'videoDuration',
  'videoRate',
  'webUrl',
] as const;

async function shortRemName(plugin: RNPlugin, rem: PluginRem): Promise<string> {
  const text = (await safeRemTextToString(plugin, rem.text)).trim() || 'Untitled';
  return text.length > MOVED_NAME_MAX_CHARS ? text.slice(0, MOVED_NAME_MAX_CHARS).trimEnd() + '…' : text;
}

/** A review still being written by the tracker, or a running Editor Review Timer, on these rems. */
async function busyWith(plugin: RNPlugin, remIds: string[]): Promise<string | null> {
  const jobs = (await plugin.storage.getSession<{ remId?: string }[]>(pendingReviewJobQueueKey)) || [];
  if (jobs.some((job) => job?.remId && remIds.includes(job.remId))) {
    return 'A review of one of these Rems is still being saved — try again in a moment.';
  }
  const timerRemId = await plugin.storage.getSession<string>(editorReviewTimerRemIdKey);
  if (timerRemId && remIds.includes(timerRemId)) {
    return 'The Editor Review Timer is running on one of these Rems — end that review first.';
  }
  return null;
}

/**
 * Why a review can't be moved, or null when it can. Shared by the popup (to
 * offer the button) and the move itself (which re-checks on a fresh read).
 */
export function moveRefusal(rep: IncrementalRep, now = Date.now()): string | null {
  if (!repCountsForStats(rep.eventType)) return 'Only reviews can be moved.';
  if (rep.eventType === 'movedRep') return 'This time was already moved here — move it back first.';
  if (!((rep.reviewTimeSeconds ?? 0) > 0)) return 'This record has no time left to move.';
  const handoff = rep.context?.companionHandoffAt;
  if (handoff && rep.context?.companionSeconds === undefined && now - handoff < COMPANION_HANDOFF_GRACE_MS) {
    return 'The Chrome Companion has not reported this reading yet — move it once it has.';
  }
  return null;
}

export interface MoveTarget {
  ok: boolean;
  /** Name for display, set even when the target is refused. */
  name?: string;
  kind?: HistoryStoreKind;
  /** The target's due date, for an active IncRem. */
  nextRepDate?: number;
  error?: string;
}

/** Whether `targetRemId` can receive time moved from `sourceRemId`. */
export async function checkMoveTarget(
  plugin: RNPlugin,
  sourceRemId: string,
  targetRemId: string
): Promise<MoveTarget> {
  const rem = await plugin.rem.findOne(targetRemId);
  if (!rem) return { ok: false, error: 'Rem not found.' };
  const name = await shortRemName(plugin, rem);
  if (targetRemId === sourceRemId) return { ok: false, name, error: 'That is the Rem the record is on.' };
  if (await rem.hasPowerup(powerupCode)) {
    const inc = await getIncrementalRemFromRem(plugin, rem);
    return { ok: true, name, kind: 'incremental', nextRepDate: inc?.nextRepDate };
  }
  if (await rem.hasPowerup(dismissedPowerupCode)) return { ok: true, name, kind: 'dismissed' };
  return {
    ok: false,
    name,
    error: 'Not an Incremental Rem. Make it Incremental first if its time should be counted.',
  };
}

export interface MoveResult extends HistoryWriteResult {
  movedSeconds?: number;
  targetName?: string;
}

/**
 * Move `seconds` of a review's time from `sourceRemId` to `targetRemId` (see the
 * section comment). `seconds` defaults to all of it.
 */
export async function moveHistoryEntryTime(
  plugin: RNPlugin,
  sourceRemId: string,
  target: IncrementalRep,
  targetRemId: string,
  seconds?: number,
  hintIndex?: number
): Promise<MoveResult> {
  if (sourceRemId === targetRemId) return { ok: false, error: 'That is the Rem the record is on.' };

  const busy = await busyWith(plugin, [sourceRemId, targetRemId]);
  if (busy) return { ok: false, error: busy };

  const source = await resolveHistoryStore(plugin, sourceRemId);
  if (!source) return { ok: false, error: 'No history found on the source Rem.' };
  const destination = await resolveHistoryStore(plugin, targetRemId);
  if (!destination) {
    return { ok: false, error: 'The target is not an Incremental Rem. Make it Incremental first.' };
  }

  const index = locateEntry(source.history, target, hintIndex);
  if (index === -1) {
    return { ok: false, error: 'That entry is no longer in the history — reopen the popup and try again.' };
  }
  const original = source.history[index];
  const refusal = moveRefusal(original);
  if (refusal) return { ok: false, error: refusal };

  const available = original.reviewTimeSeconds ?? 0;
  const amount = Math.round(seconds ?? available);
  if (!(amount > 0)) return { ok: false, error: 'Enter how much of the time to move.' };
  if (amount > available) {
    return { ok: false, error: `Only ${Math.round(available / 60)} min are left on this record.` };
  }

  const [sourceName, targetName] = await Promise.all([
    shortRemName(plugin, source.rem),
    shortRemName(plugin, destination.rem),
  ]);
  const at = Date.now();

  // ── The target's new entry: when and what was read, never the schedule ──
  const readingContext: NonNullable<IncrementalRep['context']> = {};
  for (const key of READING_CONTEXT_KEYS) {
    const value = original.context?.[key];
    if (value !== undefined) (readingContext as Record<string, unknown>)[key] = value;
  }
  const moved: IncrementalRep = {
    date: original.date,
    // Required by the schema; equal to the date so no early/late is implied.
    scheduled: original.date,
    reviewTimeSeconds: amount,
    eventType: 'movedRep',
    ...(original.notes ? { notes: original.notes } : {}),
    context: { ...readingContext, movedFromId: sourceRemId, movedFromName: sourceName, movedAt: at },
  };

  // ── The source entry: same place, same scheduling fields, less time ──
  const remaining = available - amount;
  const shell: IncrementalRep = {
    ...original,
    context: {
      ...original.context,
      movedTo: [
        ...(original.context?.movedTo ?? []),
        { remId: targetRemId, name: targetName, seconds: amount, at },
      ],
    },
  };
  if (remaining > 0) shell.reviewTimeSeconds = remaining;
  else delete shell.reviewTimeSeconds;

  const targetBefore = destination.history;
  const targetStamp = latestNextRepStamp(targetBefore);
  await persist(
    plugin,
    destination,
    preserveNextRepStamp(sortChronologically([...targetBefore, moved]), targetStamp)
  );

  try {
    const next = [...source.history];
    next[index] = shell;
    await persist(plugin, source, next);
  } catch (e) {
    console.error('[history_edit] move: source write failed, rolling the target back', e);
    try {
      await persist(plugin, destination, targetBefore);
    } catch (rollbackError) {
      console.error('[history_edit] move: rollback failed', rollbackError);
      return {
        ok: false,
        error: `Moving failed half-way: "${targetName}" now has the time, and "${sourceName}" still has it too. Delete the moved record on "${targetName}".`,
      };
    }
    return { ok: false, error: 'Could not update the source record; nothing was moved.' };
  }

  return { ok: true, movedSeconds: amount, targetName };
}

/**
 * Undo one move: delete the 'movedRep' entry on the target and give its seconds
 * back to the source review. Callable from either side — the source's link
 * (`movedTo[]`) or the target's entry (`movedFromId` + `movedAt`).
 */
export async function moveHistoryEntryTimeBack(
  plugin: RNPlugin,
  sourceRemId: string,
  targetRemId: string,
  at: number
): Promise<MoveResult> {
  const busy = await busyWith(plugin, [sourceRemId, targetRemId]);
  if (busy) return { ok: false, error: busy };

  const source = await resolveHistoryStore(plugin, sourceRemId);
  const shellIndex =
    source?.history.findIndex((rep) => rep.context?.movedTo?.some((m) => m.at === at && m.remId === targetRemId)) ??
    -1;
  if (!source || shellIndex === -1) {
    return {
      ok: false,
      error: 'The original record is no longer on the Rem it came from (deleted or transferred), so there is nothing to give the time back to.',
    };
  }
  const shell = source.history[shellIndex];
  const link = shell.context!.movedTo!.find((m) => m.at === at && m.remId === targetRemId)!;

  // The target side. When the target is gone, or is no longer Incremental or
  // dismissed, its history went with it: the time only needs restoring here.
  // When it is there but the entry is not, it went somewhere we can't see (a
  // transfer to its parent): restoring would count it twice.
  const targetRem = await plugin.rem.findOne(targetRemId);
  const destination = targetRem ? await resolveHistoryStore(plugin, targetRemId) : null;
  let destinationNext: IncrementalRep[] | null = null;
  let seconds = link.seconds;
  if (destination) {
    const movedIndex = destination.history.findIndex(
      (rep) =>
        rep.eventType === 'movedRep' && rep.context?.movedAt === at && rep.context?.movedFromId === sourceRemId
    );
    if (movedIndex === -1) {
      return {
        ok: false,
        error: 'The moved record is no longer on the target Rem (deleted or transferred) — moving it back would count it twice.',
      };
    }
    seconds = destination.history[movedIndex].reviewTimeSeconds ?? link.seconds;
    destinationNext = preserveNextRepStamp(
      destination.history.filter((_, i) => i !== movedIndex),
      latestNextRepStamp(destination.history)
    );
  }

  const remainingLinks = shell.context!.movedTo!.filter((m) => m !== link);
  const restored: IncrementalRep = {
    ...shell,
    reviewTimeSeconds: (shell.reviewTimeSeconds ?? 0) + seconds,
    context: { ...shell.context },
  };
  if (remainingLinks.length > 0) restored.context!.movedTo = remainingLinks;
  else delete restored.context!.movedTo;

  const sourceBefore = source.history;
  const sourceNext = [...sourceBefore];
  sourceNext[shellIndex] = restored;
  await persist(plugin, source, sourceNext);

  if (destination && destinationNext) {
    try {
      await persist(plugin, destination, destinationNext);
    } catch (e) {
      console.error('[history_edit] move back: target write failed, rolling the source back', e);
      try {
        await persist(plugin, source, sourceBefore);
      } catch (rollbackError) {
        console.error('[history_edit] move back: rollback failed', rollbackError);
      }
      return { ok: false, error: 'Could not remove the moved record from the target; nothing was moved back.' };
    }
  }

  return { ok: true, movedSeconds: seconds, targetName: link.name };
}
