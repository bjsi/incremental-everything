import {
  BuiltInPowerupCodes,
  PluginRem,
  RichTextElementRemInterface,
  RNPlugin,
  ReactRNPlugin,
} from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import {
  powerupCode,
  nextRepDateSlotCode,
  prioritySlotCode,
  repHistorySlotCode,
  originalIncrementalDateSlotCode,
  initialIntervalId,
  defaultPriorityId,
  currentIncRemKey,
  incremReviewStartTimeKey,
  pendingQueueDashboardRefocusKey,
  dismissedPowerupCode,
} from '../consts';
import { readRawPdfState, writeRawPdfState } from '../pdf_state';
import { getNextSpacingDateForRem, updateSRSDataForRem } from '../scheduler';
import { IncrementalRem, IncrementalRep, UNREADABLE_PRIORITY_FALLBACK } from './types';
import { tryParseJson, getDailyDocReferenceForDate, sleep } from '../utils';
import { getInitialPriority } from '../priority_inheritance';
import { stampNoteAndContext } from '../history_notes';
import { updateIncrementalRemCache } from './cache';
import { mergeHistoryFromDismissed } from '../dismissed';
import { registerRemsAsPdfKnown, registerRemsAsHtmlKnown, isHtmlSource } from '../pdfUtils';
import { syncPriorityBand } from '../priority_bands';
import { getIESetting } from '../settings';
import { PriorityChangeEvent, PRIORITY_HISTORY_COALESCE_MS } from '../priority_history';

type ReviewOverrideOptions = {
  /**
   * If provided, force the next repetition to this timestamp (ms).
   */
  overrideNextRepDate?: number;
  /**
   * If provided, override the interval stored in history (in days).
   * Use together with overrideNextRepDate to keep metadata consistent.
   */
  overrideIntervalDays?: number;
};

export interface SetIncRemPriorityOptions {
  /**
   * Which gesture changed the priority — see lib/priority_history.ts. Recorded
   * on the 'priorityChange' history entry this write appends.
   */
  event?: PriorityChangeEvent;
  /**
   * Suppress the 'priorityChange' history entry.
   *
   * Pass `recordHistory: false` from any caller that writes its OWN history
   * entry carrying this priority — the reschedule popup, the editor review and
   * its timer, the Priority & Interval batch save. Two reasons, and the second
   * is the dangerous one:
   *
   *   1. Duplication. Their entry already says "rescheduled to 5d at priority
   *      45"; a bare 'priorityChange' beside it says the same thing twice.
   *   2. Clobbering. Those callers snapshot `incRem.history` BEFORE calling
   *      here and later write `[...snapshot, theirEntry]` back. An entry
   *      appended here in between is inside the write they are about to
   *      overwrite, so it would vanish — silently, and only sometimes.
   *
   * Defaults to TRUE, so a call site added later is recorded unless it opts
   * out. That is the direction that fails safely: a duplicate row is visible
   * and fixable, a missing one is not.
   */
  recordHistory?: boolean;
}

/**
 * THE write path for an Incremental Rem's priority. Use this instead of calling
 * `rem.setPowerupProperty(powerupCode, prioritySlotCode, …)` directly.
 *
 * Why it exists: the priority slot is not the only thing that has to move when a
 * priority changes — the table-cell badge is drawn from a `PriorityBand0–9`
 * powerup tag that mirrors the effective priority (see lib/priority_bands.ts),
 * and `effectivePriorityForBadge` reads the INCREMENTAL slot in preference to the
 * card-priority one for any rem carrying the IncRem powerup. Card priority got
 * this for free because every writer already went through `setCardPriority`,
 * which syncs the band internally. Incremental priority had no such chokepoint,
 * so each of eleven call sites was expected to remember `syncPriorityBand` — and
 * eight of them did not, leaving stale badges after batch priority changes, the
 * Priority & Interval batch save, reschedules, editor reviews and the list views.
 * Routing every writer through here makes that impossible to forget again.
 *
 * `syncPriorityBand` writes nothing when the band is already correct (and returns
 * early for the large majority of rems, which aren't band-eligible), so this is
 * cheap on the common path and cannot loop. A band-sync failure is logged and
 * swallowed: the badge is a derived mirror, and losing it must never cost the
 * caller the priority write that just succeeded.
 *
 * Static import of priority_bands, matching card_priority/index.ts: a dynamic
 * import() emits a chunk the RemNote index sandbox evaluates as a classic script,
 * which dies on `import.meta` (see the note atop register/tracker.ts).
 * priority_bands imports only consts + card_priority/types, so there is no cycle.
 *
 * Since the priority history landed, it is also where a priority-only change is
 * RECORDED — a 'priorityChange' entry in the rem's own History slot. The same
 * argument applies: the Alt+P popup, Quick Priority and the inline list editors
 * each used to change a priority and leave no trace of it whatsoever, and one
 * chokepoint is the only way that stays true for the next writer. See
 * {@link SetIncRemPriorityOptions.recordHistory} for the callers that opt out
 * because they write a richer entry of their own.
 */
export async function setIncRemPriority(
  plugin: RNPlugin,
  rem: PluginRem,
  priority: number,
  options?: SetIncRemPriorityOptions
): Promise<void> {
  const recordHistory = options?.recordHistory !== false;

  // The state being replaced, read BEFORE the write so the entry can show the
  // transition rather than just the destination.
  //
  // Two direct slot reads rather than a getIncrementalRemFromRem: this runs on
  // every priority write, a batch tool doing hundreds in a row included, and
  // that helper resolves the Next Rep Date's Daily Doc reference — an extra rem
  // lookup per call for a number this entry does not need (the nextRepMs stamp
  // already in the history is the same one). Both are `.catch`ed: a rem whose
  // slots do not resolve still gets its priority written, it just gets a
  // history entry with no "from" value.
  const before = recordHistory
    ? await Promise.all([
        rem.getPowerupProperty(powerupCode, prioritySlotCode).catch(() => null),
        rem.getPowerupProperty(powerupCode, repHistorySlotCode).catch(() => null),
      ])
    : null;

  await rem.setPowerupProperty(powerupCode, prioritySlotCode, [priority.toString()]);

  if (before) {
    const parsed = parseInt(String(before[0] ?? '').trim(), 10);
    const previousPriority = Number.isNaN(parsed) ? undefined : parsed;
    if (previousPriority !== priority) {
      const history = tryParseJson(before[1]);
      await appendIncRemPriorityChange(
        rem,
        Array.isArray(history) ? history : [],
        previousPriority,
        priority,
        options?.event ?? 'other'
      );
    }
  }

  try {
    await syncPriorityBand(plugin, rem);
  } catch (err) {
    console.error('[IncRem] band sync failed', err);
  }
}

/**
 * Appends a 'priorityChange' marker to an Incremental Rem's history.
 *
 * Writes the History slot DIRECTLY rather than going through
 * `updateSRSDataForRem`: that helper also rewrites the Next Rep Date slot and
 * raises the `plugin_updating_srs_data` guard, neither of which belongs to a
 * change that touches only the priority. What it does borrow from that helper
 * is the nextRepMs invariant — the LAST entry must carry the most recent
 * next-rep stamp, because `getIncrementalRemFromRem` falls back to it when the
 * Daily Doc reference does not round-trip. Appending an unstamped entry would
 * quietly strip that fallback, so the stamp is carried forward, and it doubles
 * as this entry's `scheduled` value.
 *
 * Coalesces on the same terms as the card-priority history: a second change
 * from the SAME gesture within PRIORITY_HISTORY_COALESCE_MS replaces the first
 * rather than appending, so holding Ctrl+Opt+↓ leaves one row showing the
 * priority it settled on — with `previousPriority` still pointing at where the
 * burst started, which is the number the user actually wants to see.
 *
 * Does NOT touch the session cache. Callers that need it refreshed already
 * re-read the rem and call updateIncrementalRemCache (that is how they pick up
 * the new priority); the ones that patch the cache in place instead — the batch
 * tools — leave its `history` a beat behind, which nothing reads for scheduling
 * or selection, and the history popups read the rem directly.
 *
 * Never throws: the priority write has already succeeded by the time this runs.
 */
async function appendIncRemPriorityChange(
  rem: PluginRem,
  history: IncrementalRep[],
  previousPriority: number | undefined,
  priority: number,
  event: PriorityChangeEvent
): Promise<void> {
  try {
    const last = history[history.length - 1];

    let lastStamp: number | undefined;
    for (let i = history.length - 1; i >= 0; i--) {
      if (typeof history[i]?.nextRepMs === 'number') {
        lastStamp = history[i].nextRepMs;
        break;
      }
    }

    const now = Date.now();

    // A priority chosen moments after the rem was made Incremental belongs IN
    // the creation marker, not beside it — the same rule the Priority & Interval
    // batch save applies when it folds a save into 'madeIncremental'. Without
    // this, the ordinary "make incremental → pick a priority" flow leaves a
    // default-priority marker followed by a phantom priority change.
    if (
      last?.eventType === 'madeIncremental' &&
      now - last.date <= PRIORITY_HISTORY_COALESCE_MS
    ) {
      const folded = [...history.slice(0, -1), { ...last, priority }];
      await rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(folded)]);
      return;
    }

    const coalesce =
      last?.eventType === 'priorityChange' &&
      last.priorityEvent === event &&
      now - last.date <= PRIORITY_HISTORY_COALESCE_MS;

    const entry: IncrementalRep = {
      date: now,
      scheduled: lastStamp ?? now,
      priority,
      // Keep the burst's ORIGINAL starting priority when collapsing into the
      // entry we are replacing.
      previousPriority: coalesce ? last.previousPriority ?? last.priority : previousPriority,
      eventType: 'priorityChange',
      priorityEvent: event,
      nextRepMs: lastStamp,
    };

    const newHistory = coalesce ? [...history.slice(0, -1), entry] : [...history, entry];

    await rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(newHistory)]);
  } catch (err) {
    console.error('[IncRem] failed to record a priority change in history', err);
  }
}

/**
 * Persists the results of reviewing an incremental rem.
 *
 * Steps performed:
 * 1. Reads the session start time to calculate how long the review took (rounded seconds).
 * 2. Runs the scheduler to obtain the next repetition date plus a provisional history entry.
 * 3. Annotates that history entry with the measured review time and any manual overrides.
 * 4. Writes the updated next repetition reference + history back to the rem powerup slots.
 *
 * The session start time is intentionally left untouched so that other features (e.g. pdfUtils)
 * can still inspect it after this helper runs. Queue advancement is also left to the caller so
 * that different UI buttons can reuse this logic.
 *
 * @param plugin RNPlugin instance used for storage, queue, and rem updates.
 * @param incRem Incremental rem being reviewed; if undefined the function logs and returns null.
 * @param overrideOptions Allows UI gestures (drag-to-today/tomorrow) to force either the interval
 *                        stored in history or the exact next repetition timestamp.
 * @returns Next-spacing payload + final history array, or null when the rem could not be processed.
 */
export async function updateReviewRemData(
  plugin: RNPlugin,
  incRem: IncrementalRem | undefined,
  overrideOptions?: ReviewOverrideOptions
) {
  if (!incRem) {
    console.log("❌ [reviewRem] No incRem provided!");
    return null;
  }

  // 1. Calculate review time
  const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
  const reviewTimeSeconds = startTime ? dayjs().diff(dayjs(startTime), 'second') : undefined;

  // DEBUG LOGS
  console.log(`🔍 [reviewRem] ID: ${incRem.remId}`);
  console.log(`🔍 [reviewRem] Start Time: ${startTime}`);
  console.log(`🔍 [reviewRem] Calculated Duration: ${reviewTimeSeconds}`);

  const inLookbackMode = !!(await plugin.queue.inLookbackMode());
  const nextSpacing = await getNextSpacingDateForRem(plugin, incRem.remId, inLookbackMode);
  if (!nextSpacing) {
    return null;
  }

  const newHistory = [...nextSpacing.newHistory];
  const lastEntry = newHistory[newHistory.length - 1];
  if (lastEntry && reviewTimeSeconds !== undefined) {
    lastEntry.reviewTimeSeconds = reviewTimeSeconds;
  }

  // Stamp any pending user note (parked by the review-note inputs) and a
  // machine context snapshot (page/range/bookmark) onto the entry this review
  // just created — same pattern as the reviewTimeSeconds annotation above.
  if (lastEntry) {
    const rem = await plugin.rem.findOne(incRem.remId);
    if (rem) {
      await stampNoteAndContext(plugin, rem, lastEntry);
    }
  }

  // Apply manual overrides when provided (used by drag-to-next/today UX)
  if (overrideOptions?.overrideIntervalDays !== undefined && lastEntry) {
    lastEntry.interval = overrideOptions.overrideIntervalDays;
  }
  const nextRepDateToUse =
    overrideOptions?.overrideNextRepDate !== undefined
      ? overrideOptions.overrideNextRepDate
      : nextSpacing.newNextRepDate;

  await updateSRSDataForRem(plugin, incRem.remId, nextRepDateToUse, newHistory);

  return { ...nextSpacing, newHistory };
}

// Request that the Practiced Queues dashboard be restored in the right sidebar
// after we advance past this IncRem (the sidebar may have been taken over for
// editing — ExtractViewer auto-opens notes for rem items, and RemNote auto-
// focuses its own Summary pane for PDF/HTML).
//
// IMPORTANT: we must NOT call plugin.window.openWidgetInRightSidebar here. This
// runs in a widget sandbox (e.g. the answer buttons) that is destroyed the
// instant `removeCurrentCardFromQueue` advances the queue, so any window call
// after that hangs (observed: a 40s stall) or never runs. Instead we drop a
// short-lived timestamp flag *before* advancing (a fast session write that
// completes while the sandbox is alive); a persistent QueueLoadCard listener in
// register/events.ts consumes it and performs the actual refocus once the next
// card has loaded. Plain flashcard ratings never touch the sidebar.
//
// Queue entry (lib/queue_session.ts) routes through here too, for a different
// reason: see the stall note on the QueueLoadCard listener in register/events.ts.
// `source` is carried on the flag so that listener can pick a staleness window
// per caller.
export async function requestQueueDashboardRefocus(plugin: RNPlugin, source: string) {
  try {
    await plugin.storage.setSession(pendingQueueDashboardRefocusKey, {
      at: Date.now(),
      source,
    });
  } catch (e) {
    console.warn(`[QDASH] failed to set refocus flag from "${source}":`, e);
  }
}

export async function handleNextRepetitionClick(
  plugin: RNPlugin,
  incRem: IncrementalRem | undefined
) {
  if (!incRem) return;

  try {
    await plugin.storage.setSession('plugin_operation_active', true);

    // 1. Capture the exact new data calculated by the review
    const reviewResult = await updateReviewRemData(plugin, incRem);

    if (reviewResult) {
      // 2. Manually patch the object using the new data
      const updatedIncRem: IncrementalRem = {
        ...incRem,
        nextRepDate: reviewResult.newNextRepDate,
        history: reviewResult.newHistory,
      };

      // 3. Update the cache with guaranteed fresh data
      await updateIncrementalRemCache(plugin as any, updatedIncRem);
    }

    // Keep the sleep to be safe
    await sleep(150);

    // Flag the refocus BEFORE advancing — removeCurrentCardFromQueue tears down
    // this widget sandbox, so the actual refocus is done by the persistent
    // QueueLoadCard listener in register/events.ts.
    await requestQueueDashboardRefocus(plugin, 'handleNextRepetitionClick');
    await plugin.queue.removeCurrentCardFromQueue();
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}

/**
 * Same as handleNextRepetitionClick but allows forcing the next repetition
 * to a specific day offset (e.g., Today or Tomorrow) for the drag gesture UX.
 */
export async function handleNextRepetitionManualOffset(
  plugin: RNPlugin,
  incRem: IncrementalRem | undefined,
  offsetDays: number
) {
  if (!incRem) {
    console.log('[handleNextRepetitionManualOffset] No incRem provided');
    return;
  }

  try {
    await plugin.storage.setSession('plugin_operation_active', true);

    const targetDay = dayjs().startOf('day').add(Math.max(offsetDays, 0), 'day').valueOf();

    const manualEntry: IncrementalRep = {
      date: Date.now(),
      scheduled: targetDay,
      interval: Math.max(offsetDays, 0),
    };
    // Same note/context stamping as the regular review funnel.
    const remForStamp = await plugin.rem.findOne(incRem.remId);
    if (remForStamp) {
      await stampNoteAndContext(plugin, remForStamp, manualEntry);
    }

    const newHistory = [...(incRem.history || []), manualEntry];

    await updateSRSDataForRem(plugin, incRem.remId, targetDay, newHistory);

    // MANUALLY CONSTRUCT THE UPDATED OBJECT
    const updatedIncRem: IncrementalRem = {
      ...incRem,
      nextRepDate: targetDay,
      history: newHistory,
    };

    await updateIncrementalRemCache(plugin as any, updatedIncRem);

    await requestQueueDashboardRefocus(plugin, 'handleNextRepetitionManualOffset');
    await plugin.queue.removeCurrentCardFromQueue();
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}

/**
 * Constructs an IncrementalRem object from a PluginRem by reading and parsing its powerup properties.
 *
 * This function acts as a factory/constructor that:
 * 1. Reads the raw powerup data (next rep date, priority, history) from the rem
 * 2. Parses and validates the data
 * 3. Returns a structured IncrementalRem object
 *
 * @param plugin - RemNote plugin instance
 * @param r - The PluginRem to convert into an IncrementalRem
 * @returns The constructed IncrementalRem object, or null if the rem is not incremental or data is invalid
 */
export const getIncrementalRemFromRem = async (
  plugin: RNPlugin,
  r: PluginRem | undefined
): Promise<IncrementalRem | null> => {
  if (!r) {
    return null;
  }

  // A rem is incremental iff it carries the Incremental powerup. Resolution failures
  // of the next-rep Daily Doc reference below must NOT make an incremental rem vanish
  // from the cache/list — that is exactly what made interval-0 (today-referenced)
  // rems disappear. We gate on the powerup and fall back to "due now" instead of
  // returning null; null is reserved for rems that genuinely aren't incremental.
  if (!(await r.hasPowerup(powerupCode))) {
    return null;
  }

  // Resolves a Daily Document reference stored in a DATE slot back to a timestamp,
  // or undefined when the slot is empty or the reference can't be resolved.
  const resolveDailyDocSlot = async (slotCode: string): Promise<number | undefined> => {
    const richText = (await r.getPowerupPropertyAsRichText(
      powerupCode,
      slotCode
    )) as RichTextElementRemInterface[];
    const refId = richText?.[0]?._id;
    if (!refId) {
      return undefined;
    }
    const refDoc = await plugin.rem.findOne(refId);
    if (!refDoc) {
      return undefined;
    }
    const yyyymmdd = await refDoc.getPowerupProperty<BuiltInPowerupCodes.DailyDocument>(
      BuiltInPowerupCodes.DailyDocument,
      'Date'
    );
    if (!yyyymmdd) {
      return undefined;
    }
    return dayjs(yyyymmdd, 'YYYY-MM-DD').valueOf();
  };

  const resolvedNextRepDate = await resolveDailyDocSlot(nextRepDateSlotCode);

  // Read the original incremental date slot (Daily Document reference)
  let createdAt = await resolveDailyDocSlot(originalIncrementalDateSlotCode);

  const history = tryParseJson(await r.getPowerupProperty(powerupCode, repHistorySlotCode));

  // Priority resolution. The slot is authoritative, but it is not always
  // readable: RemNote's storage/sync overhaul left some Rems with a Priority
  // property whose slot definition no longer resolves, so getPowerupProperty
  // returns nothing while the value is still sitting on the Rem.
  //
  // This used to fall straight through to a bare `let priority = 10`, which was
  // indistinguishable from a genuinely stored 10 — a Rem whose history proved a
  // priority of 17 displayed as P10 with nothing to say it was a guess. Worse,
  // that fabricated number was then stamped into the next history entry
  // (see scheduler.ts), turning a display glitch into permanent data.
  //
  // So: read the slot; failing that, recover the last priority the Rem itself
  // recorded in its history; and only if there is nothing to go on at all fall
  // back to a constant — flagged, never silent.
  const priorityRichText = await r.getPowerupPropertyAsRichText(powerupCode, prioritySlotCode);
  let priority: number | undefined;
  if (priorityRichText && priorityRichText.length > 0) {
    const priorityString = await plugin.richText.toString(priorityRichText);
    const parsedPriority = parseInt(priorityString, 10);
    if (!isNaN(parsedPriority)) {
      priority = parsedPriority;
    }
  }

  let prioritySource: IncrementalRem['prioritySource'] = 'slot';
  if (priority === undefined && Array.isArray(history)) {
    // Walk backwards to the most recent rep that recorded a priority.
    for (let i = history.length - 1; i >= 0; i--) {
      const recorded = history[i]?.priority;
      if (typeof recorded === 'number' && !isNaN(recorded)) {
        priority = recorded;
        prioritySource = 'history';
        break;
      }
    }
  }
  if (priority === undefined) {
    priority = UNREADABLE_PRIORITY_FALLBACK;
    prioritySource = 'fallback';
  }
  priority = Math.min(100, Math.max(0, priority));

  // Fallback: derive createdAt from the 'madeIncremental' history marker when the
  // originalIncDate slot is empty/unresolvable. This repairs rems whose Daily Doc
  // reference failed to write (e.g. the concurrent getDailyDoc race in
  // initIncrementalRem) or resolve, and legacy rems created before the slot existed.
  // The marker's `date` is exactly when the rem was first made incremental, and we
  // store it as start-of-day to match the Daily-Doc-derived value.
  if (createdAt === undefined && Array.isArray(history)) {
    const madeMarker = history.find((h: any) => h?.eventType === 'madeIncremental');
    const fallbackDate =
      typeof madeMarker?.date === 'number'
        ? madeMarker.date
        : typeof history[0]?.date === 'number'
        ? history[0].date
        : undefined;
    if (fallbackDate !== undefined) {
      createdAt = dayjs(fallbackDate).startOf('day').valueOf();
    }
  }

  // Next-rep date resolution order:
  //  1. The Daily Doc reference — authoritative, so a manual edit of the date chip
  //     always wins (it only updates this reference, not the history stamp below).
  //  2. The nextRepMs stamped on the most-recent history entry — a reliable fallback
  //     for daily-doc rems whose 'Date' property doesn't round-trip (e.g. an interval-0
  //     reference to today's doc, the bug this resolves).
  //  3. Due now — legacy rems with neither, so the rem still surfaces instead of vanishing.
  let nextRepDate = resolvedNextRepDate;
  if (nextRepDate === undefined && Array.isArray(history) && history.length > 0) {
    const lastNextRepMs = history[history.length - 1]?.nextRepMs;
    if (typeof lastNextRepMs === 'number') {
      nextRepDate = lastNextRepMs;
    }
  }
  if (nextRepDate === undefined) {
    nextRepDate = dayjs().startOf('day').valueOf();
  }

  const rawData = {
    remId: r._id,
    nextRepDate,
    priority: priority,
    prioritySource,
    history,
    createdAt,
  };

  const parsed = IncrementalRem.safeParse(rawData);
  if (parsed.success) {
    return parsed.data;
  } else {
    console.error(
      'Failed to parse incremental rem info for Rem with id: ' +
      r._id +
      'with error: ',
      parsed.error
    );
    return null;
  }
};

/**
 * Ensures the provided Rem is initialized as an Incremental Rem with defaults.
 *
 * @param plugin ReactRNPlugin used for settings/storage access.
 * @param rem PluginRem to initialize.
 * @returns Promise that resolves after the Rem is initialized or skipped if already incremental.
 */
/**
 * Registers a freshly-created IncRem in the known_pdf_rems_ / known_html_rems_
 * synced indexes (PART 2 of findAllRemsFor*). Used so the parent selector and
 * bookmark popup can discover this IncRem even before the session cache loads.
 *
 * Intentionally not on the critical path of initIncrementalRem — callers invoke
 * it fire-and-forget so opening a popup right after extraction isn't blocked by
 * getSources + per-source powerup probes.
 */
export async function registerInKnownHostIndexes(plugin: ReactRNPlugin, rem: PluginRem) {
  try {
    const sources = await rem.getSources();
    const allSources = [rem, ...sources];
    for (const candidate of allSources) {
      const isPdf = await candidate.hasPowerup(BuiltInPowerupCodes.UploadedFile);
      if (isPdf) {
        try {
          const url = await candidate.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL');
          if (typeof url === 'string' && url.toLowerCase().endsWith('.pdf')) {
            await registerRemsAsPdfKnown(plugin as any, candidate._id, [rem._id]);
          }
        } catch {
          // Skip candidates where URL can't be read
        }
        continue;
      }
      if (await isHtmlSource(candidate)) {
        try {
          await registerRemsAsHtmlKnown(plugin as any, candidate._id, [rem._id]);
        } catch {
          // Skip candidates that fail registration
        }
      }
    }
  } catch (e) {
    console.error('[initIncrementalRem] Error registering in known host indexes:', e);
  }
}

export async function initIncrementalRem(plugin: ReactRNPlugin, rem: PluginRem, options?: { skipFlagManagement?: boolean, explicitParentId?: string, skipInitialCascade?: boolean, deferCacheUpdate?: boolean }) {
  const isAlreadyIncremental = await rem.hasPowerup(powerupCode);

  if (!isAlreadyIncremental) {
    // Suppress GlobalRemChanged (skip if caller already holds the flag)
    if (!options?.skipFlagManagement) {
      await plugin.storage.setSession('plugin_operation_active', true);
    }

    let triggeredCascade = false;
    try {
      // Read any PDF reading state parked on the Dismissed powerup BEFORE the
      // merge below, which removes that powerup and would take the property with
      // it. It is written back after the Incremental powerup is attached — a
      // property cannot be set for a powerup the Rem does not yet carry.
      const carriedPdfState = await readRawPdfState(rem, dismissedPowerupCode);

      // Independent reads — run concurrently instead of serially. The dismissed-history
      // merge and the two settings lookups don't depend on one another.
      const [dismissedHistory, initialIntervalSetting, defaultPrioritySetting] = await Promise.all([
        // Check for dismissed history to import (merge from previous learning sessions)
        mergeHistoryFromDismissed(plugin, rem),
        getIESetting(plugin, initialIntervalId),
        getIESetting(plugin, defaultPriorityId),
      ]);
      const hasExistingHistory = dismissedHistory && dismissedHistory.length > 0;
      const initialInterval = initialIntervalSetting || 0;
      const defaultPriority = Math.min(100, Math.max(0, defaultPrioritySetting || 10));

      const nextRepDate = new Date(Date.now() + (initialInterval * 24 * 60 * 60 * 1000));

      // The inherited-priority walk runs in parallel with the next-rep daily-doc
      // lookup. The "today" reference, however, must NOT share a Promise.all with
      // the next-rep lookup: plugin.date.getDailyDoc auto-creates missing daily
      // docs, and firing two getDailyDoc calls concurrently can make one lose the
      // race and resolve to undefined (which silently skipped the originalIncDate
      // write, leaving createdAt unset). When the next-rep date is today
      // (initialInterval === 0) both references are identical, so we reuse dateRef
      // instead of doing a redundant — and racy — second lookup.
      // getInitialPriority gets explicitParentId to override stale SDK cache when
      // creating a new Rem and moving it.
      const [initialPriority, dateRef] = await Promise.all([
        getInitialPriority(plugin, rem, defaultPriority, options?.explicitParentId),
        getDailyDocReferenceForDate(plugin, nextRepDate),
      ]);
      if (!dateRef) {
        return;
      }
      const todayRef =
        initialInterval === 0 ? dateRef : await getDailyDocReferenceForDate(plugin, new Date());

      await rem.addPowerup(powerupCode);

      // Create 'madeIncremental' marker to indicate the start of a new learning session
      // This is used by the scheduler to count only reps since this marker
      const madeIncrementalMarker = {
        date: Date.now(),
        scheduled: Date.now(),
        eventType: 'madeIncremental' as const,
        priority: Number(initialPriority), // Record priority at time of creation
        // Interval used at creation (the Initial Interval setting, or whatever the
        // priority popup folds in over it). Display/diagnostic only — no scheduling
        // code reads `interval` off a history entry — but it keeps the Opt+X marker
        // as informative as the Opt+Shift+X one.
        interval: initialInterval,
        // Reliable fallback for the next-rep date when this rem's Daily Doc reference
        // can't be resolved on read (covers rems made incremental without a reschedule,
        // e.g. the plain "make incremental" command, especially with initialInterval 0).
        nextRepMs: nextRepDate.getTime(),
      };

      // Build history: dismissed history (if any) + madeIncremental marker
      const historyWithMarker = [
        ...(dismissedHistory || []),
        madeIncrementalMarker,
      ];

      // Slot writes target distinct slots and are independent once the powerup is
      // attached — batch them instead of awaiting one at a time.
      const slotWrites: Promise<unknown>[] = [
        rem.setPowerupProperty(powerupCode, nextRepDateSlotCode, dateRef),
        rem.setPowerupProperty(powerupCode, prioritySlotCode, [initialPriority.toString()]),
        rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(historyWithMarker)]),
      ];
      // Set originalIncrementalDate only if no dismissed history (truly new Incremental Rem)
      if (!hasExistingHistory && todayRef) {
        slotWrites.push(
          rem.setPowerupProperty(powerupCode, originalIncrementalDateSlotCode, todayRef)
        );
      }
      // Restore the reading state carried over from a previous dismissal, so a
      // Rem revived with Opt+X resumes at the page it was left on.
      if (carriedPdfState) {
        slotWrites.push(writeRawPdfState(rem, powerupCode, carriedPdfState));
      }

      await Promise.all(slotWrites);

      // Band sync for the initial priority. Deliberately NOT routed through
      // setIncRemPriority: the priority slot write above belongs in the parallel
      // batch, and pulling it out to serialise a helper call would undo that.
      // Kept awaited rather than fire-and-forget because the priority popup that
      // follows also syncs on save — a detached sync could resolve after that save
      // and reinstate the band for the pre-save priority. isBandEligible short-circuits
      // on a fresh extract (its only tag is the Incremental powerup), so the cost
      // to the optimised create path is a getTagRems + one isPowerup, not the ten
      // hasPowerup reads a full sync would cost.
      try {
        await syncPriorityBand(plugin, rem);
      } catch (err) {
        console.error('[IncRem] initial band sync failed', err);
      }

      if (!hasExistingHistory) {
        // Record creation event in incremental history (fire and forget)
        addCreationToIncrementalHistory(plugin, rem._id).catch(console.error);
      }

      // Build the cache entry directly from the values we just wrote rather than
      // reading them all back via getIncrementalRemFromRem (~6-8 extra serial SDK
      // round-trips on the critical path before the priority popup can open).
      // nextRepDate/createdAt are stored as the start-of-day timestamp to match
      // exactly what getIncrementalRemFromRem resolves from the Daily Doc references.
      const constructedIncRem = {
        remId: rem._id,
        nextRepDate: dayjs(nextRepDate).startOf('day').valueOf(),
        priority: initialPriority,
        history: historyWithMarker,
        createdAt: !hasExistingHistory ? dayjs().startOf('day').valueOf() : undefined,
      };
      const parsedIncRem = IncrementalRem.safeParse(constructedIncRem);
      if (!parsedIncRem.success) {
        console.error('[initIncrementalRem] Failed to construct IncRem cache entry:', parsedIncRem.error);
        return;
      }

      // The in-session IncRem cache write can cost ~750ms (serializing the whole
      // collection). When the caller defers its tail to the tracker (Create-IncRem →
      // priority popup flow), skip it here — the deferred tail re-adds this rem to the
      // cache in the persistent index widget, off the popup's critical path.
      if (!options?.deferCacheUpdate) {
        await updateIncrementalRemCache(plugin, parsedIncRem.data);
      }

      // Register in the known_pdf_rems_ / known_html_rems_ synced indexes so
      // the parent selector and bookmark popup can discover this IncRem
      // (PART 2 of findAllRemsFor*), even when the session cache
      // (allIncrementalRemKey) is not yet loaded (e.g., WebBrowser / Light Mode).
      //
      // This only matters for OTHER popups opened later, so it runs fire-and-forget:
      // keeping it off the critical path lets the caller (e.g. the priority popup)
      // open without waiting on getSources + per-source powerup probes.
      void registerInKnownHostIndexes(plugin, rem);

      // The targeted updateIncrementalRemCache call above already inserts the new
      // IncRem into the in-session cache, so no global reload trigger is needed.
      if (!options?.skipInitialCascade) {
        plugin.storage.setSession('pendingInheritanceCascade', rem._id).catch(console.error);
        triggeredCascade = true;
      }
    } finally {
      // Only clear the flag if no cascade was triggered.
      // If cascade IS pending, leave the flag up — the cascade tracker will clear it.
      // (Matches the correct pattern from batch_priority.tsx)
      if (!options?.skipFlagManagement && !triggeredCascade) {
        await plugin.storage.setSession('plugin_operation_active', false);
      }
    }
  }
}

/**
 * Gets the current Incremental Rem from session storage.
 *
 * @param plugin - RemNote plugin instance
 * @returns The current PluginRem, or undefined if not found or not set
 */
export const getCurrentIncrementalRem = async (plugin: RNPlugin) => {
  const remId = await plugin.storage.getSession<string>(currentIncRemKey);
  const rem = await plugin.rem.findOne(remId);
  return rem;
};

import { addToIncrementalHistory, addCreationToIncrementalHistory } from '../history_utils';

/**
 * Sets the current Incremental Rem in session storage.
 *
 * @param plugin - RemNote plugin instance
 * @param remId - The rem ID to set as current, or undefined to clear
 */
export const setCurrentIncrementalRem = async (plugin: RNPlugin, remId: string | undefined) => {
  if (remId) {
    // Fire and forget history update
    addToIncrementalHistory(plugin, remId).catch(console.error);
  }
  return await plugin.storage.setSession(currentIncRemKey, remId);
};

export * from './types';
export * from './cache';
export * from './action_items';
