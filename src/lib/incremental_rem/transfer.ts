import { ReactRNPlugin, RNPlugin, PluginRem, RichTextInterface } from '@remnote/plugin-sdk';
import {
  powerupCode,
  dismissedPowerupCode,
  dismissedHistorySlotCode,
  preservedHistoryPowerupCode,
  prioritySlotCode,
  nextRepDateSlotCode,
  repHistorySlotCode,
  originalIncrementalDateSlotCode,
} from '../consts';
import { IncrementalRep, repCountsForStats } from './types';
import { getIncrementalRemFromRem, registerInKnownHostIndexes } from './index';
import { updateIncrementalRemCache, removeIncrementalRemCache } from './cache';
import { mergeHistoryFromDismissed } from '../dismissed';
import { readRawPdfState, writeRawPdfState, rekeyPdfStateForNewHost } from '../pdf_state';
import { syncPriorityBand } from '../priority_bands';
import { safeRemTextToString } from '../pdfUtils';
import { getDailyDocReferenceForDate, tryParseJson } from '../utils';

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
 * ancestor, and the transfer changes exactly that, so execute() enqueues a
 * cascade on the destination instead.
 */

/** A destination that cannot receive a transfer, and why — surfaced to the user verbatim. */
export type IncRemTransferRefusal = {
  ok: false;
  reason: 'not-incremental' | 'no-parent' | 'destination-incremental' | 'destination-tombstone';
  message: string;
};

export interface IncRemTransferPlan {
  ok: true;
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

  const [sourceName, destinationName, pdfStateRaw] = await Promise.all([
    shortName(plugin, source),
    shortName(plugin, destination),
    readRawPdfState(source, powerupCode),
  ]);

  return {
    ok: true,
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
  };
}

/**
 * Commits the plan: destination gains the Incremental powerup and every slot the
 * source held, source loses the powerup.
 *
 * Order matters and is deliberate:
 *   1. Everything is READ off the source first — removing the powerup takes its
 *      properties with it, so nothing may be read after step 5.
 *   2. The destination is written and made consistent (bands, caches, cascade)
 *      BEFORE the source is stripped, so an interrupted run leaves the data on
 *      two Rems (recoverable) rather than on none.
 *   3. The source's powerup removal goes last, optionally in the same tick as a
 *      queue advance — removePowerup tears down the queue widget on the next
 *      microtask, so both IPC messages have to be sent together (same pattern as
 *      the Dismiss button in answer_buttons.tsx).
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

  // Suppress the GlobalRemChanged storm the slot writes below would otherwise set off.
  await plugin.storage.setSession('plugin_operation_active', true);

  try {
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

    const storedHistory = tryParseJson(historyRaw);
    const sourceHistory: IncrementalRep[] = Array.isArray(storedHistory)
      ? storedHistory
      : incRem?.history || [];

    // ---- 2. Revive any history parked on the destination ------------------
    // The destination is about to become Incremental, so a previous life of its
    // own (dismissed history + the reading state parked alongside it) has to be
    // merged in, exactly as initIncrementalRem does — otherwise adding the
    // powerup here would strand it. mergeHistoryFromDismissed removes the
    // Dismissed powerup, so its reading state is read first.
    const destinationDismissedPdfState = await readRawPdfState(destination, dismissedPowerupCode);
    const destinationHistory = await mergeHistoryFromDismissed(plugin, destination);

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

    // ---- 5. Make the rest of the system agree ----------------------------
    // Cache first: the destination must be a known IncRem before the source stops
    // being one, so the queue never sees a window with neither.
    const rebuiltIncRem = await getIncrementalRemFromRem(plugin, destination);
    if (rebuiltIncRem) {
      await updateIncrementalRemCache(plugin, rebuiltIncRem);
    }
    await removeIncrementalRemCache(plugin, source._id);

    try {
      await syncPriorityBand(plugin, destination);
    } catch (err) {
      console.error('[IncRemTransfer] band sync failed for destination', err);
    }

    void registerInKnownHostIndexes(plugin, destination);

    // ---- 6. Strip the source ---------------------------------------------
    if (options?.advanceQueue) {
      await Promise.allSettled([
        source.removePowerup(powerupCode),
        plugin.queue.removeCurrentCardFromQueue(true),
      ]);
    } else {
      await source.removePowerup(powerupCode);
    }

    // The source keeps a band tag matching a priority it no longer has. Re-syncing
    // resolves it to whatever it is now (a card priority, or nothing).
    try {
      await syncPriorityBand(plugin, source);
    } catch (err) {
      console.error('[IncRemTransfer] band sync failed for source', err);
    }

    // ---- 7. Re-derive card priorities under the new owner -----------------
    // Cards in this subtree inherited from the SOURCE; their nearest IncRem
    // ancestor is now the destination. Queued LAST, after the source has actually
    // lost the powerup — the cascade skips IncRem descendants (an IncRem owns its
    // own priority), so a cascade racing the removal would walk right past the very
    // subtree that needs re-deriving.
    //
    // The cascade watcher raises its own suppression flag when it starts, so the
    // flag this function holds is still cleared normally below: a cascade that never
    // runs (flashcard prioritisation off) must not leave GlobalRemChanged suppressed
    // for the rest of the session.
    await plugin.storage.setSession('pendingInheritanceCascade', destination._id);
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}
