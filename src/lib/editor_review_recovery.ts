import { ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import { formatEditorTimer, readEditorTimer, editorTimerElapsedMs } from './editor_review_session';
import { getPendingReviewNote, setPendingReviewNote } from './history_notes';
import { enqueueReviewJob, newReviewJobId } from './incremental_rem/review_jobs';
import { getIncrementalRemFromRem } from './incremental_rem';
import { openIncRemForReview } from './incRemHelpers';
import {
  editorReviewTimerAccumulatedMsKey,
  editorReviewTimerDateOverrideKey,
  editorReviewTimerIntervalKey,
  editorReviewTimerOriginKey,
  editorReviewTimerPausedAtKey,
  editorReviewTimerPriorityBaseKey,
  editorReviewTimerPriorityKey,
  editorReviewTimerRemIdKey,
  editorReviewTimerRemNameKey,
  editorReviewTimerStartKey,
} from './consts';

/* Recovering an Editor Review Timer that RemNote lost.

   The timer lives in session storage, which is per window and in memory only: a
   crash, a reload or quitting RemNote mid-review takes the time on the clock and
   the note typed for it with it. So the index widget of every window copies its
   running review to the local store (on disk, shared by the windows of this
   device) every HEARTBEAT_MS, under its own window id, and drops the copy as soon
   as the review ends.

   A copy whose window has stopped refreshing it for STALE_MS is a review that
   window never finished. At startup each window looks for those and offers them
   in the recovery popup: resume the timer from where it stopped, save the
   repetition with the time recorded, or discard. Esc leaves them for later; the
   "Recover Interrupted Editor Review" command reopens the popup. */

export const EDITOR_REVIEW_RECOVERY_POPUP = 'editor_review_recovery';
const checkpointsKey = 'editor-review-checkpoints';
/** The popup's answer, carried out by the index (a popup dies before its writes land). */
export const editorReviewRecoveryRequestKey = 'editor-review-recovery-request';

const HEARTBEAT_MS = 15_000;
/** Four missed heartbeats: the window is gone (or frozen long enough to count as gone). */
const STALE_MS = 60_000;
/** After this the copy is no longer worth offering. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Another window offering the same copy at its own startup: only the first one asks. */
const OFFER_CLAIM_MS = 2 * 60_000;
/** Reviews shorter than this are not worth a prompt. */
const MIN_ELAPSED_MS = 60_000;

/** This window's id, published by its index in session storage (which is per window). */
const windowIdKey = 'editor-review-checkpoint-window-id';
// Every iframe loads its own copy of this module; only the index's id is used,
// so the timer bar and the index write the same copy.
const OWN_ID = Math.random().toString(36).slice(2, 10);

async function windowId(plugin: RNPlugin): Promise<string> {
  return (await plugin.storage.getSession<string>(windowIdKey)) || OWN_ID;
}

export interface EditorReviewCheckpoint {
  windowId: string;
  kbId?: string;
  remId: string;
  remName: string;
  /** Time on the clock at savedAt. */
  elapsedMs: number;
  paused: boolean;
  /** When the review started, as far as the timer knew (start minus accumulated time). */
  startedAt: number;
  savedAt: number;
  origin: string;
  interval?: number;
  priority?: number;
  priorityBase?: number;
  dateOverride?: number;
  queueList: string[];
  note?: string;
  offeredBy?: string;
  offeredAt?: number;
}

type CheckpointMap = Record<string, EditorReviewCheckpoint>;

export type EditorReviewRecoveryAction = 'resume' | 'save' | 'discard';

export interface EditorReviewRecoveryRequest {
  id: string;
  windowId: string;
  action: EditorReviewRecoveryAction;
}

const readMap = async (plugin: RNPlugin): Promise<CheckpointMap> =>
  ((await plugin.storage.getLocal<CheckpointMap>(checkpointsKey).catch(() => undefined)) as CheckpointMap) || {};

const writeMap = (plugin: RNPlugin, map: CheckpointMap) =>
  plugin.storage.setLocal(checkpointsKey, Object.keys(map).length ? map : undefined);

let kbIdCache: string | undefined;
async function currentKbId(plugin: RNPlugin): Promise<string | undefined> {
  if (!kbIdCache) kbIdCache = (await plugin.kb.getCurrentKnowledgeBaseData().catch(() => undefined))?._id;
  return kbIdCache;
}

/** Copies this window's running review to disk, or drops its copy when none runs. */
export async function checkpointEditorReview(plugin: RNPlugin): Promise<void> {
  const WINDOW_ID = await windowId(plugin);
  const timer = await readEditorTimer(plugin);
  const map = await readMap(plugin);
  if (!timer || !timer.startTime) {
    if (map[WINDOW_ID]) {
      delete map[WINDOW_ID];
      await writeMap(plugin, map);
    }
    return;
  }
  const now = Date.now();
  const elapsedMs = editorTimerElapsedMs(timer, now);
  const startedAt = timer.startTime - timer.accumulatedMs;
  // A plugin reload keeps the session (and so the running timer) but gives the
  // window a new id: the copy under the old id is this very review, not a lost one.
  for (const [id, c] of Object.entries(map)) {
    if (id !== WINDOW_ID && c.remId === timer.remId && Math.abs(c.startedAt - startedAt) < 2000) delete map[id];
  }
  map[WINDOW_ID] = {
    windowId: WINDOW_ID,
    kbId: await currentKbId(plugin),
    remId: timer.remId,
    remName: timer.remName,
    elapsedMs,
    paused: !!timer.pausedAt,
    startedAt,
    savedAt: now,
    origin: timer.origin,
    interval: timer.interval ?? undefined,
    priority: timer.priority ?? undefined,
    priorityBase: timer.priorityBase ?? undefined,
    dateOverride:
      (await plugin.storage.getSession<number>(editorReviewTimerDateOverrideKey)) ?? undefined,
    queueList: timer.queueList,
    note: await getPendingReviewNote(plugin, timer.remId),
  };
  await writeMap(plugin, map);
}

/** Reviews a window left unfinished in this knowledge base, newest first. */
export async function listInterruptedReviews(plugin: RNPlugin): Promise<EditorReviewCheckpoint[]> {
  const WINDOW_ID = await windowId(plugin);
  const map = await readMap(plugin);
  const kbId = await currentKbId(plugin);
  const now = Date.now();
  // Only copies no window refreshes any more are pruned: a running review is
  // rewritten every heartbeat.
  let pruned = false;
  for (const [id, c] of Object.entries(map)) {
    const stale = id !== WINDOW_ID && now - c.savedAt > STALE_MS;
    if (stale && (now - c.savedAt > KEEP_MS || c.elapsedMs < MIN_ELAPSED_MS)) {
      delete map[id];
      pruned = true;
    }
  }
  if (pruned) await writeMap(plugin, map);
  return Object.values(map)
    .filter((c) => c.windowId !== WINDOW_ID && now - c.savedAt > STALE_MS)
    .filter((c) => !c.kbId || !kbId || c.kbId === kbId)
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function openEditorReviewRecovery(plugin: RNPlugin): Promise<boolean> {
  const found = await listInterruptedReviews(plugin);
  if (found.length === 0) return false;
  await plugin.widget.openPopup(EDITOR_REVIEW_RECOVERY_POPUP);
  return true;
}

/** At startup: offer what another window left behind, once its copy has gone stale. */
async function offerAtStartup(plugin: RNPlugin) {
  const WINDOW_ID = await windowId(plugin);
  const map = await readMap(plugin);
  const now = Date.now();
  // A copy refreshed moments ago may be a window that just crashed, or one that
  // is still running: wait until it would have gone stale, then look again.
  const youngest = Object.values(map)
    .filter((c) => c.windowId !== WINDOW_ID)
    .reduce((t, c) => Math.max(t, c.savedAt), 0);
  const wait = youngest ? Math.max(0, youngest + STALE_MS + 1000 - now) : 0;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const found = await listInterruptedReviews(plugin);
  const fresh = Date.now();
  const toOffer = found.filter(
    (c) => !c.offeredBy || c.offeredBy === WINDOW_ID || fresh - (c.offeredAt ?? 0) > OFFER_CLAIM_MS
  );
  if (toOffer.length === 0) return;

  const latest = await readMap(plugin);
  for (const c of toOffer) {
    if (latest[c.windowId]) latest[c.windowId] = { ...latest[c.windowId], offeredBy: WINDOW_ID, offeredAt: fresh };
  }
  await writeMap(plugin, latest);
  await plugin.widget.openPopup(EDITOR_REVIEW_RECOVERY_POPUP);
}

async function takeCheckpoint(plugin: RNPlugin, windowId: string) {
  const map = await readMap(plugin);
  const c = map[windowId];
  if (c) {
    delete map[windowId];
    await writeMap(plugin, map);
  }
  return c;
}

async function resume(plugin: RNPlugin, c: EditorReviewCheckpoint) {
  const running = await plugin.storage.getSession<string>(editorReviewTimerRemIdKey);
  if (running) {
    await plugin.app.toast('End the review that is running first, then recover this one.');
    return false;
  }
  const rem = await plugin.rem.findOne(c.remId);
  if (!rem) {
    await plugin.app.toast(`The Rem "${c.remName}" no longer exists.`);
    return false;
  }
  // Running again from the time recorded: the recorded time becomes the
  // accumulated part and the clock restarts now, so nothing is added for the
  // time RemNote was down.
  const now = Date.now();
  if (c.note) await setPendingReviewNote(plugin, c.remId, c.note);
  await plugin.storage.setSession(editorReviewTimerStartKey, now);
  await plugin.storage.setSession(editorReviewTimerPausedAtKey, undefined);
  await plugin.storage.setSession(editorReviewTimerAccumulatedMsKey, c.elapsedMs);
  await plugin.storage.setSession(editorReviewTimerIntervalKey, c.interval ?? null);
  await plugin.storage.setSession(editorReviewTimerPriorityKey, c.priority);
  await plugin.storage.setSession(editorReviewTimerPriorityBaseKey, c.priorityBase ?? c.priority);
  await plugin.storage.setSession(editorReviewTimerRemNameKey, c.remName);
  await plugin.storage.setSession('editor-review-timer-from-queue', c.origin === 'queue');
  await plugin.storage.setSession(editorReviewTimerOriginKey, c.origin);
  await plugin.storage.setSession(editorReviewTimerDateOverrideKey, c.dateOverride);
  await plugin.storage.setSession('editor-review-timer-queue-list', c.queueList);
  // Last: the bar appears on this key, with everything above already in place.
  await plugin.storage.setSession(editorReviewTimerRemIdKey, c.remId);
  await checkpointEditorReview(plugin);
  await plugin.app.toast(`⏱️ Review of "${c.remName}" resumed at ${formatEditorTimer(c.elapsedMs)}`);
  await openIncRemForReview(plugin, rem);
  return true;
}

async function save(plugin: RNPlugin, c: EditorReviewCheckpoint) {
  const rem = await plugin.rem.findOne(c.remId);
  if (!rem) {
    await plugin.app.toast(`The Rem "${c.remName}" no longer exists.`);
    return false;
  }
  const fromQueue = c.origin === 'queue';
  if (fromQueue) {
    // The queue already wrote this repetition when it handed the Rem to the
    // timer; only its time and note are missing. Amend it only while it is
    // still the last one: a later review would get this one's time.
    const incRem = await getIncrementalRemFromRem(plugin, rem);
    const last = incRem?.history?.[incRem.history.length - 1];
    if (!last || last.date > c.savedAt) {
      await plugin.app.toast(
        `"${c.remName}" was reviewed again since; the ${formatEditorTimer(c.elapsedMs)} were not saved.`
      );
      return true;
    }
  }
  if (c.note) await setPendingReviewNote(plugin, c.remId, c.note);
  await enqueueReviewJob(plugin, {
    id: newReviewJobId(c.remId),
    remId: c.remId,
    kind: fromQueue ? 'amendLast' : 'new',
    intervalDays: c.interval || 0,
    overrideNextRepDate: fromQueue ? undefined : c.dateOverride,
    newPriority: c.priority,
    basePriority: c.priorityBase ?? c.priority,
    reviewTimeSeconds: Math.round(c.elapsedMs / 1000),
    // The queue counted a handed-off review already; the timer's own count
    // (its engagement tracking) died with the window.
    recordRep: !fromQueue,
    remName: c.remName,
    // The review happened then, not now.
    confirmedAt: c.savedAt,
  });
  await plugin.app.toast(`✓ ${c.remName}: Repetition saved (${formatEditorTimer(c.elapsedMs)})`);
  return true;
}

async function carryOut(plugin: RNPlugin, request: EditorReviewRecoveryRequest) {
  const map = await readMap(plugin);
  const c = map[request.windowId];
  if (!c) return;
  if (request.action === 'discard') {
    await takeCheckpoint(plugin, request.windowId);
    await plugin.app.toast(`Discarded the review of "${c.remName}"`);
    return;
  }
  const done = request.action === 'resume' ? await resume(plugin, c) : await save(plugin, c);
  if (done) await takeCheckpoint(plugin, request.windowId);
}

/** Index only: the heartbeat, the startup offer, and the popup's answers. */
export function registerEditorReviewRecovery(plugin: ReactRNPlugin): void {
  void (async () => {
    await plugin.storage.setSession(windowIdKey, OWN_ID);
    await plugin.storage.setSession(editorReviewRecoveryRequestKey, null);

    let lastId: string | undefined;
    plugin.track(async (rp) => {
      const request = await rp.storage.getSession<EditorReviewRecoveryRequest>(editorReviewRecoveryRequestKey);
      if (!request || request.id === lastId) return;
      lastId = request.id;
      await carryOut(plugin, request).catch((e) =>
        console.error('[editor_review_recovery] Recovery failed:', e)
      );
    });

    // At once too: after a plugin reload this claims the running review before
    // the startup check below could take its old copy for a lost one.
    await checkpointEditorReview(plugin).catch(() => {});
    setInterval(() => {
      checkpointEditorReview(plugin).catch((e) =>
        console.error('[editor_review_recovery] Checkpoint failed:', e)
      );
    }, HEARTBEAT_MS);

    await offerAtStartup(plugin).catch((e) =>
      console.error('[editor_review_recovery] Startup check failed:', e)
    );
  })();
}

export function postEditorReviewRecoveryRequest(
  plugin: RNPlugin,
  windowId: string,
  action: EditorReviewRecoveryAction
) {
  const request: EditorReviewRecoveryRequest = {
    id: Math.random().toString(36).slice(2, 10),
    windowId,
    action,
  };
  return plugin.storage.setSession(editorReviewRecoveryRequestKey, request);
}
