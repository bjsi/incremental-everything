import { ReactRNPlugin, RNPlugin, PluginRem, RichTextInterface } from '@remnote/plugin-sdk';
import {
  powerupCode,
  dismissedPowerupCode,
  dismissedHistorySlotCode,
  preservedHistoryPowerupCode,
  prioritySlotCode,
  nextRepDateSlotCode,
  repHistorySlotCode,
  schedulerSlotCode,
  originalIncrementalDateSlotCode,
  pendingIncRemTransferTailKey,
} from '../consts';
import { IncrementalRem, IncrementalRep, repCountsForStats } from './types';
import { getIncrementalRemFromRem, registerInKnownHostIndexes } from './index';
import { mergeHistoryFromDismissed } from '../dismissed';
import { readRawPdfState, writeRawPdfState, rekeyPdfStateForNewHost } from '../pdf_state';
import { syncPriorityBand } from '../priority_bands';
import { safeRemTextToString } from '../pdfUtils';
import { getDailyDocReferenceForDate, tryParseJson } from '../utils';
import { SuppressionLease } from '../operation_suppression';
import { getSchedulerSettings, readSchedulerOverride, getInheritedScheduler } from '../scheduler_choice';
import { describeScheduler, resolveScheduler, ResolvedScheduler } from '../scheduler_core';

/**
 * Moving a Rem's Incremental identity onto another Rem.
 *
 * The motivating case: a highlight is extracted under an outline header, the
 * extract becomes the IncRem, and only after a review or two does it become clear
 * that the HEADER is what should be scheduled — the extract is just one of its
 * children. Redoing that by hand means losing the priority, the interval
 * progression and every recorded review, so the whole point here is that nothing
 * is recreated: the same history object, the same next-rep date, the same
 * original-incremental date are moved across, and only a marker is appended
 * saying where they came from.
 *
 * What "Incremental data" means, concretely — everything the Incremental powerup
 * carries plus the derived state keyed by the Rem's id:
 *
 *   • Priority slot, next-rep Daily Doc reference, originalIncDate reference
 *   • The whole `repHist` history array
 *   • The hidden `pdfState` blob (page, page range, page history, active PDF,
 *     and rem-type READ POINTS — which are keyed by the IncRem's own id and so
 *     have to be re-keyed on the way over, see rekeyPdfStateForNewHost)
 *   • Membership of the session IncRem cache and the known-host indexes
 *   • The priority band tag (derived from the priority, so it is re-synced on
 *     both Rems rather than copied)
 *
 * Card-priority inheritance is NOT copied: it is derived from the nearest IncRem
 * ancestor, and the transfer changes exactly that, so the tail job runs a
 * cascade on the destination instead.
 *
 * TWO PHASES. The command commits only the two Rems — destination written, source
 * stripped, back to back — and hands everything derived from them (the IncRem
 * session cache, the band tags, the known-host indexes, the cascade) to a tracker
 * job, runIncRemTransferTail. That follow-up used to sit BETWEEN the two commits,
 * and on a large knowledge base it was slow: two read-modify-writes of the ~8MB
 * session cache, each re-firing every visible priority badge (each of which reads
 * that same cache), plus a reference lookup and child walk for the band sync.
 * Measured on real runs, the source was stripped 44–55 s after the destination's
 * last write; one run never got there at all, and left the full history on both
 * Rems with nothing to say so.
 *
 * Such a half-done transfer can still exist (a run that predates this split, or
 * one killed between the two commits), so the plan recognises it — the parent's
 * last 'transferred' marker names this very Rem — and offers to finish it instead
 * of refusing because the parent is already Incremental.
 */

/** A destination that cannot receive a transfer, and why — surfaced to the user verbatim. */
export type IncRemTransferRefusal = {
  ok: false;
  reason:
    | 'not-incremental'
    | 'no-parent'
    | 'destination-incremental'
    | 'destination-tombstone'
    | 'diverged-transfer';
  message: string;
};

export interface IncRemTransferPlan {
  ok: true;
  /**
   * 'transfer' is the full move. 'finish' completes an earlier run that wrote the
   * destination and stopped before stripping the source: everything is already on
   * the parent, so only the strip and the tail job remain.
   */
  mode: 'transfer' | 'finish';
  source: PluginRem;
  destination: PluginRem;
  sourceName: string;
  destinationName: string;
  /** The source's history exactly as it will be moved (marker not yet appended). */
  history: IncrementalRep[];
  /** Entries in `history` that count as real reviews — what the user recognises as "reps". */
  repCount: number;
  totalReviewSeconds: number;
  /**
   * The source's priority, or null when it could not be read from either the slot
   * or the history. Null is never written: a fabricated priority stamped into a
   * slot is indistinguishable from a real one afterwards.
   */
  priority: number | null;
  nextRepDate: number;
  /** Reviews already parked on the destination's Dismissed powerup, which the transfer revives. */
  destinationDismissedReps: number;
  /** Whether the source carries reading state (PDF pages / read points) to move. */
  hasReadingState: boolean;
  /**
   * Set when the destination will schedule with a different scheduler than the
   * source does now — a scheduler that comes from the Rem's TYPE (video, PDF, plain
   * Rem…) stays with the type rather than moving with the data. Labels as the
   * Repetition History popup shows them, e.g. "Multiplier ×1.5 (type setting)".
   */
  schedulerChange: { from: string; to: string } | null;
}

export type IncRemTransferOutcome = IncRemTransferPlan | IncRemTransferRefusal;

/**
 * How much of the source Rem's text is kept on the 'transferred' marker.
 *
 * This name is written into history PERMANENTLY and re-rendered on every visit to
 * the Repetition History popup, so it is capped at both ends of its life: an
 * extract's text is often a whole paragraph of highlighted prose, which would
 * bloat the history slot (a synced key with a hard size limit — see
 * lib/history_shards.ts) to say something a fragment already says. The popup caps
 * again on display for entries written before this existed.
 */
export const TRANSFERRED_NAME_MAX_CHARS = 60;

/** Text of a Rem, trimmed to `max` characters with an ellipsis. */
async function shortName(
  plugin: RNPlugin,
  rem: PluginRem,
  max = TRANSFERRED_NAME_MAX_CHARS
): Promise<string> {
  const raw = (await safeRemTextToString(plugin, rem.text)) || '(untitled Rem)';
  return raw.length > max ? raw.slice(0, max).trimEnd() + '…' : raw;
}

/**
 * Read-only: decide whether `source` can hand its Incremental data to its parent,
 * and gather everything a confirmation dialog needs to describe the move. Mutates
 * nothing, so the caller can show the dialog before committing.
 */
export async function planTransferIncRemToParent(
  plugin: RNPlugin,
  source: PluginRem
): Promise<IncRemTransferOutcome> {
  if (!(await source.hasPowerup(powerupCode))) {
    return {
      ok: false,
      reason: 'not-incremental',
      message: 'This Rem is not an Incremental Rem — there is nothing to transfer.',
    };
  }

  const destination = source.parent ? await plugin.rem.findOne(source.parent) : null;
  if (!destination) {
    return {
      ok: false,
      reason: 'no-parent',
      message: 'This Rem has no parent Rem to transfer to (it is a top-level Rem).',
    };
  }

  if (await destination.hasPowerup(powerupCode)) {
    // Either a half-done transfer from this very Rem, which is finished, or a
    // parent with an Incremental life of its own, which is refused.
    const finish = await planFinishTransfer(plugin, source, destination);
    if (finish) return finish;
    return {
      ok: false,
      reason: 'destination-incremental',
      message: `The parent is already an Incremental Rem — dismiss it first (Alt+Shift+X), then transfer. Its history is kept and revived by the transfer.`,
    };
  }

  // A tombstone's content was deliberately removed by 'Preserve history & remove';
  // reviving it as the live IncRem would schedule an empty Rem.
  if (await destination.hasPowerup(preservedHistoryPowerupCode)) {
    return {
      ok: false,
      reason: 'destination-tombstone',
      message: 'The parent is a preserved-history tombstone — it holds no content to review.',
    };
  }

  const incRem = await getIncrementalRemFromRem(plugin, source);
  const history = incRem?.history || [];

  let destinationDismissedReps = 0;
  if (await destination.hasPowerup(dismissedPowerupCode)) {
    const raw = tryParseJson(
      await destination.getPowerupProperty(dismissedPowerupCode, dismissedHistorySlotCode)
    );
    destinationDismissedReps = Array.isArray(raw) ? raw.length : 0;
  }

  const [sourceName, destinationName, pdfStateRaw, schedulerChange] = await Promise.all([
    shortName(plugin, source),
    shortName(plugin, destination),
    readRawPdfState(source, powerupCode),
    describeSchedulerChange(plugin, source, destination),
  ]);

  return {
    ok: true,
    mode: 'transfer',
    source,
    destination,
    sourceName,
    destinationName,
    history,
    repCount: history.filter((h) => repCountsForStats(h.eventType)).length,
    totalReviewSeconds: history.reduce((sum, h) => sum + (h.reviewTimeSeconds || 0), 0),
    // 'fallback' means nothing was readable — see UNREADABLE_PRIORITY_FALLBACK.
    priority: incRem && incRem.prioritySource !== 'fallback' ? incRem.priority : null,
    nextRepDate: incRem?.nextRepDate ?? Date.now(),
    destinationDismissedReps,
    hasReadingState: !!pdfStateRaw,
    schedulerChange,
  };
}

/** Identity of a history entry, for telling whether one is already on the parent. */
const historyEntryKey = (h: IncrementalRep) => `${h.date}|${h.eventType ?? ''}`;

/**
 * Recognises a transfer from `source` that wrote `destination` and never stripped
 * the source: the destination's most recent 'transferred' marker names the source.
 * Returns null when there is no such marker (the parent is Incremental for reasons
 * of its own), a 'finish' plan when every entry on the source is already on the
 * parent, and a refusal when the source has entries the parent lacks — a review
 * recorded on the child after the half-done run, which stripping would lose.
 */
async function planFinishTransfer(
  plugin: RNPlugin,
  source: PluginRem,
  destination: PluginRem
): Promise<IncRemTransferOutcome | null> {
  const [sourceIncRem, destinationIncRem] = await Promise.all([
    getIncrementalRemFromRem(plugin, source),
    getIncrementalRemFromRem(plugin, destination),
  ]);
  const destinationHistory = destinationIncRem?.history || [];
  const marker = [...destinationHistory]
    .reverse()
    .find((h) => h.eventType === 'transferred' && h.context?.transferredFromId === source._id);
  if (!marker) return null;

  const [sourceName, destinationName] = await Promise.all([
    shortName(plugin, source),
    shortName(plugin, destination),
  ]);

  const sourceHistory = sourceIncRem?.history || [];
  const onParent = new Set(destinationHistory.map(historyEntryKey));
  const missing = sourceHistory.filter((h) => !onParent.has(historyEntryKey(h))).length;
  if (missing > 0) {
    return {
      ok: false,
      reason: 'diverged-transfer',
      message:
        `"${destinationName}" already received a transfer from this Rem, but ${missing} history ` +
        `entr(ies) on this Rem are not on the parent. Not finishing automatically — that would lose them.`,
    };
  }

  return {
    ok: true,
    mode: 'finish',
    source,
    destination,
    sourceName,
    destinationName,
    history: sourceHistory,
    repCount: sourceHistory.filter((h) => repCountsForStats(h.eventType)).length,
    totalReviewSeconds: sourceHistory.reduce((sum, h) => sum + (h.reviewTimeSeconds || 0), 0),
    priority:
      destinationIncRem && destinationIncRem.prioritySource !== 'fallback'
        ? destinationIncRem.priority
        : null,
    nextRepDate: destinationIncRem?.nextRepDate ?? Date.now(),
    destinationDismissedReps: 0,
    hasReadingState: false,
    schedulerChange: null,
  };
}

/**
 * The scheduler the source uses now against the one the destination will use
 * once it holds the data. The source's own Scheduler slot moves across, so only
 * the inherited layer (type setting → default) can differ. Null when they agree,
 * or when either cannot be worked out — a dialog line is not worth failing for.
 */
async function describeSchedulerChange(
  plugin: RNPlugin,
  source: PluginRem,
  destination: PluginRem
): Promise<{ from: string; to: string } | null> {
  try {
    const settings = await getSchedulerSettings(plugin);
    const [override, sourceInherited, destinationInherited] = await Promise.all([
      readSchedulerOverride(source),
      getInheritedScheduler(plugin, source, settings),
      getInheritedScheduler(plugin, destination, settings),
    ]);
    const before = resolveScheduler(override, sourceInherited);
    const after = resolveScheduler(override, destinationInherited);
    if (before.kind === after.kind && before.factor === after.factor) return null;
    const label = (scheduler: ResolvedScheduler) => {
      const d = describeScheduler(scheduler);
      return `${d.name} (${d.source})`;
    };
    return { from: label(before), to: label(after) };
  } catch (err) {
    console.warn('[TransferIncRem] could not compare schedulers', err);
    return null;
  }
}

/**
 * Commits the plan: destination gains the Incremental powerup and every slot the
 * source held, source loses the powerup. Everything derived from the two Rems is
 * queued for the tracker afterwards (runIncRemTransferTail).
 *
 * Order matters and is deliberate:
 *   1. Everything is READ off the source first — removing the powerup takes its
 *      properties with it, so nothing may be read after the strip.
 *   2. The destination is written BEFORE the source is stripped, so an
 *      interrupted run leaves the data on two Rems — which the next run of the
 *      command recognises and finishes (planFinishTransfer) — rather than on none.
 *   3. The strip follows the destination writes IMMEDIATELY. Nothing slow may sit
 *      between the two: that gap is exactly where an interrupted run leaves its
 *      duplicate. It optionally shares a tick with a queue advance —
 *      removePowerup tears down the queue widget on the next microtask, so both
 *      IPC messages have to be sent together (same pattern as the Dismiss button
 *      in answer_buttons.tsx).
 *   4. The tail job is queued only AFTER the suppression lease is released: the
 *      tracker raises and clears the flag itself, and a release landing after it
 *      would un-suppress the tail's own writes.
 *
 * Suppression is a lease, not `true`: a run that stalls on the bridge or dies with
 * its iframe never reaches its `finally`, and a bare `true` would then leave
 * GlobalRemChanged dead for the rest of the session (see operation_suppression.ts).
 */
export async function executeTransferIncRemToParent(
  plugin: ReactRNPlugin,
  plan: IncRemTransferPlan,
  options?: {
    /** Advance the queue off the source card as it stops being an IncRem. */
    advanceQueue?: boolean;
  }
): Promise<void> {
  const { source, destination } = plan;
  // Per-step timings, so a run that stalls again shows which call it stalled on.
  const startedAt = Date.now();
  const mark = (step: string) =>
    console.log(`[TransferIncRem] ${step} (+${Date.now() - startedAt} ms)`);
  mark(`start (${plan.mode}) "${plan.sourceName}" → "${plan.destinationName}"`);

  // Suppress the GlobalRemChanged storm the slot writes below would otherwise set off.
  const lease = new SuppressionLease(plugin);
  await lease.start();

  try {
    if (plan.mode === 'transfer') {
      await writeDestination(plugin, plan, mark);
    }

    // ---- 5. Strip the source ---------------------------------------------
    if (options?.advanceQueue) {
      await Promise.allSettled([
        source.removePowerup(powerupCode),
        plugin.queue.removeCurrentCardFromQueue(true),
      ]);
    } else {
      await source.removePowerup(powerupCode);
    }
    mark('source stripped');
  } finally {
    await lease.release();
  }

  // ---- 6. Make the rest of the system agree (tracker job) ----------------
  await enqueueIncRemTransferTail(plugin, {
    sourceId: source._id,
    destinationId: destination._id,
    destinationName: plan.destinationName,
  });
  mark('follow-up queued');
}

/** Steps 1–4 of a full transfer: read the source, revive the parent's own past, write the parent. */
async function writeDestination(
  plugin: ReactRNPlugin,
  plan: IncRemTransferPlan,
  mark: (step: string) => void
): Promise<void> {
  const { source, destination } = plan;

  // ---- 1. Read everything off the source -------------------------------
  // Re-read rather than trusting the plan: a confirmation dialog sat in between,
  // and a review could have landed in that time.
  const incRem = await getIncrementalRemFromRem(plugin, source);
  const [nextRepRef, originalIncRef, pdfStateRaw, historyRaw] = await Promise.all([
    source.getPowerupPropertyAsRichText(powerupCode, nextRepDateSlotCode),
    source.getPowerupPropertyAsRichText(powerupCode, originalIncrementalDateSlotCode),
    readRawPdfState(source, powerupCode),
    source.getPowerupProperty(powerupCode, repHistorySlotCode),
  ]);
  // The rem's own scheduler choice travels with the schedule it governs.
  const schedulerRaw = await source
    .getPowerupProperty(powerupCode, schedulerSlotCode)
    .catch(() => '');

  const storedHistory = tryParseJson(historyRaw);
  const sourceHistory: IncrementalRep[] = Array.isArray(storedHistory)
    ? storedHistory
    : incRem?.history || [];
  mark('source read');

  // ---- 2. Revive any history parked on the destination ------------------
  // The destination is about to become Incremental, so a previous life of its
  // own (dismissed history + the reading state parked alongside it) has to be
  // merged in, exactly as initIncrementalRem does — otherwise adding the
  // powerup here would strand it. mergeHistoryFromDismissed removes the
  // Dismissed powerup, so its reading state is read first.
  const destinationDismissedPdfState = await readRawPdfState(destination, dismissedPowerupCode);
  const destinationHistory = await mergeHistoryFromDismissed(plugin, destination);
  mark('dismissed history revived');

  // ---- 3. Compose the moved history ------------------------------------
  // 'fallback' means nothing was readable, and a fabricated priority written to a
  // slot is indistinguishable from a real one afterwards — so it is never written.
  const priority = incRem && incRem.prioritySource !== 'fallback' ? incRem.priority : null;

  const marker: IncrementalRep = {
    date: Date.now(),
    scheduled: Date.now(),
    eventType: 'transferred',
    nextRepMs: incRem?.nextRepDate,
    context: {
      transferredFromId: source._id,
      transferredFromName: plan.sourceName,
    },
  };
  if (priority !== null) {
    marker.priority = priority;
  }

  // Concatenated, NOT sorted by date. The scheduler counts reps positionally —
  // everything after the last 'madeIncremental' marker — so interleaving the
  // destination's own older markers with the source's would silently rewrite
  // the interval progression this whole command exists to preserve. The
  // destination's revived history goes first (it is the older life), the moved
  // history keeps its shape, and the marker closes the seam.
  const mergedHistory = [...destinationHistory, ...sourceHistory, marker];

  // ---- 4. Write the destination ----------------------------------------
  await destination.addPowerup(powerupCode);

  const slotWrites: Promise<unknown>[] = [
    destination.setPowerupProperty(powerupCode, repHistorySlotCode, [
      JSON.stringify(mergedHistory),
    ]),
  ];

  if (priority !== null) {
    slotWrites.push(
      destination.setPowerupProperty(powerupCode, prioritySlotCode, [priority.toString()])
    );
  }

  if (schedulerRaw) {
    slotWrites.push(
      destination.setPowerupProperty(powerupCode, schedulerSlotCode, [schedulerRaw])
    );
  }

  // The Daily Doc references are copied as rich text, so the destination points
  // at the very same daily documents — a manual edit of the date chip on either
  // Rem keeps working. Falling back to a freshly built reference covers a source
  // whose slot never resolved (the detached-slot case the priority read guards
  // against too).
  if (nextRepRef && nextRepRef.length > 0) {
    slotWrites.push(
      destination.setPowerupProperty(powerupCode, nextRepDateSlotCode, nextRepRef as RichTextInterface)
    );
  } else {
    const rebuilt = await getDailyDocReferenceForDate(
      plugin,
      new Date(incRem?.nextRepDate ?? plan.nextRepDate)
    );
    if (rebuilt) {
      slotWrites.push(destination.setPowerupProperty(powerupCode, nextRepDateSlotCode, rebuilt));
    }
  }

  if (originalIncRef && originalIncRef.length > 0) {
    slotWrites.push(
      destination.setPowerupProperty(
        powerupCode,
        originalIncrementalDateSlotCode,
        originalIncRef as RichTextInterface
      )
    );
  } else if (incRem?.createdAt) {
    const rebuilt = await getDailyDocReferenceForDate(plugin, new Date(incRem.createdAt));
    if (rebuilt) {
      slotWrites.push(
        destination.setPowerupProperty(powerupCode, originalIncrementalDateSlotCode, rebuilt)
      );
    }
  }

  // Reading state, with the source's self-keyed read points re-pointed at the
  // destination and anything the destination had parked while dismissed kept.
  const carriedPdfState = rekeyPdfStateForNewHost(
    pdfStateRaw,
    destinationDismissedPdfState,
    source._id,
    destination._id
  );
  if (carriedPdfState) {
    slotWrites.push(writeRawPdfState(destination, powerupCode, carriedPdfState));
  }

  await Promise.all(slotWrites);
  mark('destination written');
}

/** What the tracker needs to finish a transfer the command has committed. */
export interface IncRemTransferTailJob {
  sourceId: string;
  destinationId: string;
  /** For the log lines only. */
  destinationName: string;
}

/** Appends a tail job for the tracker (register/tracker.ts). */
export async function enqueueIncRemTransferTail(
  plugin: RNPlugin,
  job: IncRemTransferTailJob
): Promise<void> {
  const queue =
    (await plugin.storage.getSession<IncRemTransferTailJob[]>(pendingIncRemTransferTailKey)) || [];
  await plugin.storage.setSession(pendingIncRemTransferTailKey, [...queue, job]);
}

/**
 * The follow-up of a committed transfer, run by the tracker under suppression.
 * Cache changes go into `cache` for the caller to write once per drain — the
 * ~8MB session cache is the expensive part of all this, and it used to be read
 * and written twice per transfer. Returns the Rem whose subtree needs the
 * inheritance cascade.
 *
 * Every step is best-effort: by now both Rems are already correct, and these are
 * mirrors of them.
 */
export async function runIncRemTransferTail(
  plugin: ReactRNPlugin,
  job: IncRemTransferTailJob,
  cache: Map<string, IncrementalRem | null>
): Promise<{ cascadeRemId?: string }> {
  const startedAt = Date.now();
  const mark = (step: string) =>
    console.log(`[TransferIncRem] tail: ${step} (+${Date.now() - startedAt} ms)`);

  const [source, destination] = await Promise.all([
    plugin.rem.findOne(job.sourceId),
    plugin.rem.findOne(job.destinationId),
  ]);

  cache.set(job.sourceId, null);
  if (destination) {
    const rebuiltIncRem = await getIncrementalRemFromRem(plugin, destination);
    if (rebuiltIncRem) cache.set(destination._id, rebuiltIncRem);
  }
  mark('cache entries built');

  // The source keeps a band tag matching a priority it no longer has. Re-syncing
  // resolves it to whatever it is now (a card priority, or nothing).
  for (const [label, rem] of [
    ['destination', destination],
    ['source', source],
  ] as const) {
    if (!rem) continue;
    try {
      await syncPriorityBand(plugin, rem);
    } catch (err) {
      console.error(`[TransferIncRem] band sync failed for ${label}`, err);
    }
  }
  mark('bands synced');

  if (destination) {
    await registerInKnownHostIndexes(plugin, destination);
    mark('host indexes registered');
  }

  // ---- 7. Re-derive card priorities under the new owner -----------------
  // Cards in this subtree inherited from the SOURCE; their nearest IncRem
  // ancestor is now the destination. Only reached after the source has actually
  // lost the powerup — the cascade skips IncRem descendants (an IncRem owns its
  // own priority), so a cascade racing the removal would walk right past the very
  // subtree that needs re-deriving.
  return destination ? { cascadeRemId: destination._id } : {};
}
