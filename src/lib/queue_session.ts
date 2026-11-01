import {
  AppEvents,
  QueueInteractionScore,
  ReactRNPlugin,
  RNPlugin,
} from '@remnote/plugin-sdk';
import { safeRemTextToString } from './pdfUtils';
import { autoFocusQueueDashboardId, fsrsWeightsId, flashcardResponseTimeLimitId } from './consts';
import { isMobileDevice } from './mobileUtils';
import { openQueueDashboard } from './queue_dashboard';
import type { PracticedQueueSession } from '../widgets/practiced_queues';
import { PRACTICED_QUEUES_HISTORY_KEY, rollOverOldSessions } from './queue_aggregates';
import { computeFSRSState, parseWeightsString } from './fsrs';
import { getIESetting } from './settings';
import { isNativeDrillActive, isNativeDrillQueue } from './mastery_drill_native';

const ACTIVE_SESSION_KEY = 'activeQueueSession';

// Delay between queue entry and spawning the right sidebar. Just enough to
// let RemNote finish building the queue view first; set to 0 to open the
// sidebar immediately, at the cost of racing that construction.
const SIDEBAR_SPAWN_DELAY_MS = 400;

// Editor-only IncRem sessions auto-close after this much idle time so a row
// is recorded for the burst of activity. Cleared/rescheduled on every
// engagement and rep tick. See startIncRemEngagement / recordIncRemRep.
const EDITOR_SESSION_IDLE_MS = 60 * 60 * 1000;
const EDITOR_REVIEW_SCOPE = 'Editor Review';

let currentSession: PracticedQueueSession | null = null;
const cardStartTimes = new Map<string, number>();
let responseTimeLimitSec: number | undefined;
/** The last flashcard QueueLoadCard named, for a QueueEnter that arrives after it. */
let lastCardLoad: { cardId: string; at: number } | null = null;
const FIRST_CARD_CARRY_MS = 5000;

// Open IncRem engagement timer. Replaces the old currentIncRemStart variable
// and is now driven by explicit start/end calls from the IncRem rendering
// surfaces (queue widget, editor timer) rather than inferred from QueueLoadCard.
let incRemEngagementStart: number | null = null;
let incRemEngagementRemId: string | null = null;

// Track the last closed engagement to prevent unmount/remount races (e.g. extracts) from double-counting
let lastIncRemEndTs: number | null = null;
let lastIncRemEndRemId: string | null = null;

// Set by markIncRemTransition() right before a queue→editor handoff. Tells the
// next startIncRemEngagement(remId) to skip the count++ so a single IncRem
// reviewed across queue + editor counts as one rep with combined time.
let incRemTransitionFlag: string | null = null;

let editorIncRemIdleTimer: ReturnType<typeof setTimeout> | null = null;

// Single-flight guard: rollover walks synced storage and rewrites two keys.
// Concurrent runs would race on the read/write cycle and could double-bucket
// the same sessions. Skip if one is already in-flight; the next save (or the
// next register pass) will pick up anything missed.
let isRollingOver = false;
async function maybeRollOver(plugin: RNPlugin) {
  if (isRollingOver) return;
  isRollingOver = true;
  try {
    const result = await rollOverOldSessions(plugin);
    if (result.rolled > 0 || result.removedNulls > 0) {
      console.log(
        `[QueueSession] Rolled over ${result.rolled} old sessions; pruned ${result.removedNulls} null entries.`
      );
    }
  } catch (err) {
    console.error('[QueueSession] Rollover failed:', err);
  } finally {
    isRollingOver = false;
  }
}

async function syncLiveSession(plugin: RNPlugin) {
  await plugin.storage.setSession(ACTIVE_SESSION_KEY, currentSession);
}

function clearEditorIdleSave() {
  if (editorIncRemIdleTimer) {
    clearTimeout(editorIncRemIdleTimer);
    editorIncRemIdleTimer = null;
  }
}

function scheduleEditorIdleSave(plugin: RNPlugin) {
  if (!currentSession || currentSession.scopeName !== EDITOR_REVIEW_SCOPE) return;
  clearEditorIdleSave();
  editorIncRemIdleTimer = setTimeout(() => {
    if (currentSession?.scopeName === EDITOR_REVIEW_SCOPE) {
      saveCurrentSession(plugin, 'Editor Review Idle Timeout').catch((err) =>
        console.error('Failed to auto-save editor IncRem session:', err)
      );
    }
  }, EDITOR_SESSION_IDLE_MS);
}

async function ensureSessionForIncRem(plugin: RNPlugin) {
  if (currentSession) return;
  try {
    const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
    currentSession = {
      id: Math.random().toString(36).substring(7),
      startTime: Date.now(),
      kbId: kbData._id,
      scopeName: EDITOR_REVIEW_SCOPE,
      totalTime: 0,
      flashcardsCount: 0,
      flashcardsTime: 0,
      incRemsCount: 0,
      incRemsTime: 0,
      againCount: 0,
      currentCardFirstRep: undefined,
    };
    await syncLiveSession(plugin);
  } catch (err) {
    console.error('Failed to lazily create Editor Review session:', err);
  }
}

async function maybeAdoptScopeFromRem(plugin: RNPlugin, remId: string) {
  if (!currentSession) return;
  const generic =
    !currentSession.scopeName ||
    currentSession.scopeName === 'Untitled' ||
    currentSession.scopeName === 'Ad-hoc Queue' ||
    currentSession.scopeName === 'Ad-hoc Session' ||
    currentSession.scopeName === EDITOR_REVIEW_SCOPE;
  if (!generic) return;
  const rem = await plugin.rem.findOne(remId);
  if (rem?.text) {
    const text = await safeRemTextToString(plugin, rem.text);
    if (text && text !== 'Untitled') currentSession.scopeName = text;
  }
}

// ─── Widget→main IncRem signaling ──────────────────────────────────────────────
// Widgets run in sandboxed iframes, so they cannot mutate this module's
// `currentSession` directly — their import of this file gets a separate
// in-iframe copy. To bridge that, the public helpers (start/end engagement,
// record rep, mark transition) push events to a session-storage log, and
// registerQueueSessionTracking (which runs in the main process) polls and
// drains that log into the real `currentSession`.
//
// Pattern mirrors the existing card_info_bar → cluster-sibling poll.

const INC_REM_EVENT_LOG_KEY = 'ieIncRemEventLog';

type IncRemEvent =
  | { type: 'start'; remId: string; ts: number }
  | { type: 'end'; ts: number }
  | { type: 'rep'; remId: string; durationMs: number; ts: number }
  | { type: 'transition'; remId: string; ts: number }
  | { type: 'force_save'; ts: number };

async function pushIncRemEvent(plugin: RNPlugin, event: IncRemEvent) {
  const log = ((await plugin.storage.getSession<IncRemEvent[]>(INC_REM_EVENT_LOG_KEY)) || []).slice();
  log.push(event);
  await plugin.storage.setSession(INC_REM_EVENT_LOG_KEY, log);
}

export function markIncRemTransition(plugin: RNPlugin, remId: string) {
  // Fire-and-forget: handleReviewInEditorRem callers don't await this
  // historically, and the next polled drain will pick it up anyway.
  pushIncRemEvent(plugin, { type: 'transition', remId, ts: Date.now() }).catch((err) =>
    console.error('Failed to push IncRem transition event:', err)
  );
}

export async function startIncRemEngagement(plugin: RNPlugin, remId: string) {
  await pushIncRemEvent(plugin, { type: 'start', remId, ts: Date.now() });
}

export async function endIncRemEngagement(plugin: RNPlugin) {
  await pushIncRemEvent(plugin, { type: 'end', ts: Date.now() });
}

export async function forceSaveSession(plugin: RNPlugin) {
  await pushIncRemEvent(plugin, { type: 'force_save', ts: Date.now() });
}

export async function recordIncRemRep(plugin: RNPlugin, remId: string, durationMs: number) {
  await pushIncRemEvent(plugin, { type: 'rep', remId, durationMs, ts: Date.now() });
}

// ─── Main-process apply functions (only called by the poll) ────────────────────

async function applyIncRemEngagementStart(
  plugin: RNPlugin,
  remId: string,
  startTs: number
) {
  await ensureSessionForIncRem(plugin);
  if (!currentSession) return;

  // Already engaged with this rem (e.g., widget re-render): keep timer.
  if (incRemEngagementRemId === remId && incRemEngagementStart !== null) {
    return;
  }

  // Engaged with a different rem: close that engagement first (time only).
  if (incRemEngagementStart !== null) {
    const duration = Math.max(0, startTs - incRemEngagementStart);
    currentSession.incRemsTime += duration;
    currentSession.totalTime += duration;
    incRemEngagementStart = null;
    incRemEngagementRemId = null;
  }

  const isTransition = incRemTransitionFlag === remId;
  incRemTransitionFlag = null;

  const isResumption = 
    lastIncRemEndRemId === remId && 
    lastIncRemEndTs !== null && 
    (startTs - lastIncRemEndTs) < 2000;

  if (!isTransition && !isResumption) {
    currentSession.incRemsCount++;
    await maybeAdoptScopeFromRem(plugin, remId);
  }

  incRemEngagementStart = startTs;
  incRemEngagementRemId = remId;

  scheduleEditorIdleSave(plugin);
  await syncLiveSession(plugin);
}

async function applyIncRemEngagementEnd(plugin: RNPlugin, endTs: number) {
  if (!currentSession || incRemEngagementStart === null) return;
  const duration = Math.max(0, endTs - incRemEngagementStart);
  currentSession.incRemsTime += duration;
  currentSession.totalTime += duration;

  lastIncRemEndTs = endTs;
  lastIncRemEndRemId = incRemEngagementRemId;

  incRemEngagementStart = null;
  incRemEngagementRemId = null;

  scheduleEditorIdleSave(plugin);
  await syncLiveSession(plugin);
}

async function applyIncRemRep(
  plugin: RNPlugin,
  remId: string,
  durationMs: number
) {
  await ensureSessionForIncRem(plugin);
  if (!currentSession) return;

  currentSession.incRemsCount++;
  if (durationMs > 0) {
    currentSession.incRemsTime += durationMs;
    currentSession.totalTime += durationMs;
  }
  await maybeAdoptScopeFromRem(plugin, remId);

  scheduleEditorIdleSave(plugin);
  await syncLiveSession(plugin);
}

export async function saveCurrentSession(plugin: RNPlugin, _reason: string) {
  if (!currentSession) return;

  currentSession.endTime = Date.now();

  if (incRemEngagementStart !== null) {
    currentSession.incRemsTime += Date.now() - incRemEngagementStart;
  }
  currentSession.totalTime = currentSession.flashcardsTime + currentSession.incRemsTime;

  if (currentSession.flashcardsCount > 0 || currentSession.incRemsCount > 0) {
    const history =
      ((await plugin.storage.getSynced(PRACTICED_QUEUES_HISTORY_KEY)) as PracticedQueueSession[]) || [];
    const validHistory = history.filter((s): s is PracticedQueueSession => !!s);
    await plugin.storage.setSynced(PRACTICED_QUEUES_HISTORY_KEY, [currentSession, ...validHistory]);
    // Fire-and-forget: keeps the raw window bounded by rolling older sessions
    // into daily aggregates. Single-flight guard inside.
    maybeRollOver(plugin);
  }

  currentSession = null;
  cardStartTimes.clear();
  incRemEngagementStart = null;
  incRemEngagementRemId = null;
  lastIncRemEndTs = null;
  lastIncRemEndRemId = null;
  incRemTransitionFlag = null;
  clearEditorIdleSave();
  await plugin.storage.setSession(ACTIVE_SESSION_KEY, null);
  await plugin.storage.setSession('finalDrillHeartbeat', 0);
}

export function hasActiveSession(): boolean {
  return currentSession !== null;
}

/**
 * Populate the `currentCard*` lifetime stats on the given session from a card's
 * repetitionHistory. Used by both QueueLoadCard and the cluster-sibling poll.
 */
async function loadCardStats(
  plugin: RNPlugin,
  session: PracticedQueueSession,
  cardId: string
) {
  const card = await plugin.card.findOne(cardId);
  // The queue may have moved on during the read.
  if (session.currentCardId !== cardId) return;
  if (card?.repetitionHistory && card.repetitionHistory.length > 0) {
    const dates = card.repetitionHistory.map((h) => h.date);
    session.currentCardFirstRep = Math.min(...dates);

    const lastRepTime =
      card.lastRepetitionTime || (dates.length > 0 ? Math.max(...dates) : undefined);
    session.currentCardInterval =
      card.nextRepetitionTime && lastRepTime
        ? card.nextRepetitionTime - lastRepTime
        : undefined;

    let totalCardTime = 0;
    let totalCardReps = 0;
    for (const rep of card.repetitionHistory) {
      if (rep.score !== QueueInteractionScore.TOO_EARLY) {
        totalCardReps++;
        if (rep.responseTime) totalCardTime += rep.responseTime;
      }
    }
    session.currentCardTotalTime = totalCardTime;
    session.currentCardRepCount = totalCardReps;
  } else {
    session.currentCardFirstRep = undefined;
    session.currentCardTotalTime = 0;
    session.currentCardRepCount = 0;
    session.currentCardInterval = undefined;
  }
}

/**
 * Moves the Live Session to a card. The ids move with no await before them, so nothing can move
 * the panel in between and copy the current card over the previous one. Callers run this ahead
 * of other work: a rating's bookkeeping can hold the plugin bridge for seconds right after.
 */
async function moveLivePanelTo(plugin: RNPlugin, session: PracticedQueueSession, cardId: string) {
  if (session.currentCardId !== cardId) {
    session.prevCardFirstRep = session.currentCardFirstRep;
    session.prevCardTotalTime = session.currentCardTotalTime;
    session.prevCardRepCount = session.currentCardRepCount;
    session.prevCardId = session.currentCardId;
    session.currentCardId = cardId;
  }
  await loadCardStats(plugin, session, cardId);
  if (currentSession === session && session.currentCardId === cardId) await syncLiveSession(plugin);
}

export function registerQueueSessionTracking(plugin: ReactRNPlugin) {
  // One-shot startup migration / rollover: covers users who installed this
  // build but haven't reviewed yet. Fire-and-forget; widget reads will pick
  // up the new state via useSyncedStorageState reactivity.
  maybeRollOver(plugin);

  // Startup recovery: if the plugin restarted (page refresh, crash) while a
  // session was in progress, ACTIVE_SESSION_KEY holds the last synced snapshot
  // but currentSession is null. Rescue it into synced history so the work is
  // not silently lost.
  (async () => {
    try {
      const orphaned = await plugin.storage.getSession<PracticedQueueSession>(ACTIVE_SESSION_KEY);
      if (orphaned && (orphaned.flashcardsCount > 0 || orphaned.incRemsCount > 0)) {
        if (!orphaned.endTime) orphaned.endTime = Date.now();
        const history =
          ((await plugin.storage.getSynced(PRACTICED_QUEUES_HISTORY_KEY)) as PracticedQueueSession[]) || [];
        const deduped = history.filter((s): s is PracticedQueueSession => !!s && s.id !== orphaned.id);
        await plugin.storage.setSynced(PRACTICED_QUEUES_HISTORY_KEY, [orphaned, ...deduped]);
        await plugin.storage.setSession(ACTIVE_SESSION_KEY, null);
        console.log(
          `[QueueSession] Recovered orphaned session: id=${orphaned.id} scope="${orphaned.scopeName}" fc=${orphaned.flashcardsCount} ir=${orphaned.incRemsCount}`
        );
        maybeRollOver(plugin);
      }
    } catch (err) {
      console.error('[QueueSession] Orphaned session recovery failed:', err);
    }
  })();

  // Heartbeat monitor: auto-save Mastery Drill session if the popup is closed without QueueExit.
  // Popup drill only: the regular-queue drill writes no heartbeat, so a timestamp left behind
  // by an earlier popup would end each of its sessions 5 s after it starts.
  setInterval(async () => {
    if (currentSession && currentSession.scopeName === 'Mastery Drill' && !isNativeDrillActive()) {
      if (Date.now() - currentSession.startTime < 5000) return; // grace period
      const lastHeartbeat = await plugin.storage.getSession<number>('finalDrillHeartbeat');
      if (lastHeartbeat) {
        if (Date.now() - lastHeartbeat > 5000) {
          await saveCurrentSession(plugin, 'Heartbeat Stale');
        }
      }
    }
  }, 2500);

  // Cluster sibling-transition poll: inside a cluster, QueueLoadCard does NOT fire per
  // sibling — only card_info_bar.tsx sees each sibling via getWidgetContext().
  // The widget broadcasts `clusterVisibleCardId`; we poll for changes and advance the
  // per-card panel state (currentCardId/prevCardId + lifetime stats) so the UI tracks
  // the sibling actually on screen rather than being stuck on the cluster anchor.
  setInterval(async () => {
    const session = currentSession;
    if (!session) return;
    try {
      const cardBeforeRead = session.currentCardId;
      const vis = await plugin.storage.getSession<string>('clusterVisibleCardId');
      // The queue may have closed during the read: saveCurrentSession nulls the session.
      if (currentSession !== session) return;
      // A new card loaded during the read, so the value read is about the card before it.
      if (session.currentCardId !== cardBeforeRead) return;
      if (!vis || vis === session.currentCardId) return;

      await moveLivePanelTo(plugin, session, vis);
    } catch (error) {
      console.error('ERROR in cluster sibling-transition poll:', error);
    }
  }, 500);

  // Periodic IncRem engagement flush: while an engagement is open, roll its
  // elapsed time into incRemsTime/totalTime so the live dashboard reflects
  // reading time without waiting for engagement end. The end/save paths still
  // flush remaining elapsed correctly because they compute from the (just
  // advanced) incRemEngagementStart.
  setInterval(async () => {
    if (!currentSession || incRemEngagementStart === null) return;
    try {
      const now = Date.now();
      const elapsed = Math.max(0, now - incRemEngagementStart);
      if (elapsed === 0) return;
      currentSession.incRemsTime += elapsed;
      currentSession.totalTime += elapsed;
      incRemEngagementStart = now;
      await syncLiveSession(plugin);
    } catch (error) {
      console.error('ERROR in IncRem engagement live flush:', error);
    }
  }, 2000);

  // IncRem event-log drain: widgets push start/end/rep/transition events to
  // session storage (see pushIncRemEvent above). Poll, drain, apply in order.
  // Read-clear-process: a widget appending between read and write loses that
  // event, but the race window is sub-millisecond — acceptable.
  setInterval(async () => {
    try {
      const log = await plugin.storage.getSession<IncRemEvent[]>(INC_REM_EVENT_LOG_KEY);
      if (!log || log.length === 0) return;
      await plugin.storage.setSession(INC_REM_EVENT_LOG_KEY, []);
      for (const event of log) {
        if (event.type === 'start') {
          await applyIncRemEngagementStart(plugin, event.remId, event.ts);
        } else if (event.type === 'end') {
          await applyIncRemEngagementEnd(plugin, event.ts);
        } else if (event.type === 'rep') {
          await applyIncRemRep(plugin, event.remId, event.durationMs);
        } else if (event.type === 'transition') {
          incRemTransitionFlag = event.remId;
        } else if (event.type === 'force_save') {
          await saveCurrentSession(plugin, 'Explicit End Review');
        }
      }
    } catch (error) {
      console.error('ERROR in IncRem event-log drain poll:', error);
    }
  }, 250);

  plugin.event.addListener(AppEvents.QueueEnter, undefined, async (data: any) => {
    try {
      console.warn(`[QueueEnter DEBUG] fired at ${Date.now()}, subQueueId=${data?.subQueueId}, hasCurrentSession=${!!currentSession}`);
      if (currentSession) {
        console.warn(`[QueueEnter DEBUG] saving previous session (scope=${currentSession.scopeName}, fc=${currentSession.flashcardsCount}, ir=${currentSession.incRemsCount})`);
        await saveCurrentSession(plugin, 'QueueEnter Overwrite');
      }

      const kbData = await plugin.kb.getCurrentKnowledgeBaseData();

      let scopeName = 'Ad-hoc Queue';
      const rawQueueId: string | undefined = data?.subQueueId;
      // The regular-queue drill's document lives for one session: record it as "Mastery Drill",
      // like the popup drill, rather than under a document id that is about to be deleted.
      const isNativeDrill = isNativeDrillQueue(rawQueueId);
      const queueId = isNativeDrill ? undefined : rawQueueId;
      const isValidId = queueId && typeof queueId === 'string' && !queueId.startsWith('0.');

      if (isNativeDrill) {
        scopeName = 'Mastery Drill';
      } else if (isValidId) {
        const rem = await plugin.rem.findOne(queueId);
        if (rem) {
          const text = rem.text ? await safeRemTextToString(plugin, rem.text) : '';
          scopeName = text && text !== 'Untitled' ? text : 'Untitled';
        }
      } else {
        // Generated queueId could be "Practice All", "Mastery Drill", or "Embedded Queue"
        const isFinalDrillActive = await plugin.storage.getSession<boolean>('finalDrillActive');
        const lastHeartbeat = await plugin.storage.getSession<number>('finalDrillHeartbeat');
        const isFresh = lastHeartbeat && Date.now() - lastHeartbeat < 4000;
        scopeName = isFinalDrillActive || isFresh ? 'Mastery Drill' : 'Ad-hoc Session';
      }

      currentSession = {
        id: Math.random().toString(36).substring(7),
        startTime: Date.now(),
        kbId: kbData._id,
        queueId: isValidId ? queueId : undefined,
        scopeName,
        totalTime: 0,
        flashcardsCount: 0,
        flashcardsTime: 0,
        incRemsCount: 0,
        incRemsTime: 0,
        againCount: 0,
        currentCardFirstRep: undefined,
      };

      console.warn(`[QueueEnter DEBUG] new session created, scopeName=${scopeName}`);
      const session = currentSession;
      await syncLiveSession(plugin);
      cardStartTimes.clear();
      // QueueEnter can arrive after the queue's first card has loaded. That card belongs to this
      // session: without its start time its rating would not count.
      if (lastCardLoad && Date.now() - lastCardLoad.at < FIRST_CARD_CARRY_MS && currentSession === session) {
        cardStartTimes.set(lastCardLoad.cardId, lastCardLoad.at);
        await moveLivePanelTo(plugin, session, lastCardLoad.cardId);
      }
      incRemEngagementStart = null;
      incRemEngagementRemId = null;
      lastIncRemEndTs = null;
      lastIncRemEndRemId = null;
      incRemTransitionFlag = null;
      clearEditorIdleSave();

      // Auto-focus the Practiced Queues dashboard in the right sidebar so the
      // user always has a live session view while reviewing. Opt-in via setting.
      // Skip when triggered from the Mastery Drill: opening the right sidebar
      // resizes the popup which re-mounts the embedded Queue, fires QueueEnter
      // again, and creates a resize loop.
      const autoFocus = await getIESetting(plugin, autoFocusQueueDashboardId);
      const isMobile = await isMobileDevice(plugin);
      const isMasteryDrill = scopeName === 'Mastery Drill';
      if (autoFocus && !isMobile && !isMasteryDrill) {
        // The open has to happen here: we are the only thing that spawns the
        // right sidebar in the queue, so there is nothing else to trigger it.
        // (Deferring it entirely to QueueLoadCard does not work — the first card
        // loads before this handler finishes, so the only card load that matters
        // has already fired by the time we could set a flag.)
        //
        // What we can do is keep it off the queue-construction path, where it
        // races RemNote's own tab-forcing and can wedge the plugin API channel.
        // A local timer is enough to get out of the way, and unlike an event it
        // cannot be missed. openQueueDashboard never blocks us and never throws;
        // it owns the retry and the wedge watchdog. See lib/queue_dashboard.
        setTimeout(() => openQueueDashboard(plugin, 'QueueEnter'), SIDEBAR_SPAWN_DELAY_MS);
      }
    } catch (error) {
      console.error('ERROR in QueueSession QueueEnter listener:', error);
    }
  });

  plugin.event.addListener(AppEvents.QueueExit, undefined, async () => {
    if (currentSession) {
      await saveCurrentSession(plugin, 'QueueExit Event');
    }
  });

  plugin.event.addListener('force_save_session', undefined, async () => {
    if (currentSession) {
      await saveCurrentSession(plugin, 'force_save_session Event');
    }
  });

  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, async (data: any) => {
    try {
      const now = Date.now();

      // Staleness defense: clear the on-screen card broadcast at the start of each new card load,
      // so its readers (the sibling poll above, lib/queue_visible_card) can't act on the previous
      // card if the widget fails to mount. Inside a cluster, QueueLoadCard does not fire per
      // sibling, so the widget's writes for later siblings are only overwritten, not cleared.
      // lib/cluster_rating_readback keeps its own list, so this cannot lose a rating.
      // Sent before the panel moves, so a later read by the poll cannot return the previous card.
      const broadcastCleared = plugin.storage.setSession('clusterVisibleCardId', undefined);

      if (data?.cardId) lastCardLoad = { cardId: data.cardId, at: now };

      // The panel first: see moveLivePanelTo.
      const movePanelNow = !!data?.cardId && !!currentSession;
      if (movePanelNow) {
        cardStartTimes.set(data.cardId, now);
        await moveLivePanelTo(plugin, currentSession!, data.cardId);
      }

      // Defensive: when a flashcard loads (data.cardId is set; IncRems load
      // without a cardId), close any open IncRem engagement synchronously so
      // the periodic flush does not keep adding reading time to incRemsTime
      // while a flashcard is on screen. The IncRem widget's unmount cleanup
      // also calls endIncRemEngagement, but that routes through the 250 ms
      // event-log drain and may lag behind QueueLoadCard.
      if (data?.cardId && incRemEngagementStart !== null && currentSession) {
        await applyIncRemEngagementEnd(plugin, now);
      }

      await broadcastCleared;

      // Lazy session init (mobile fix: QueueEnter sometimes doesn't fire on iOS)
      if (!currentSession) {
        try {
          const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
          const isFinalDrillActive = await plugin.storage.getSession<boolean>('finalDrillActive');
          const isMobile = await isMobileDevice(plugin);
          currentSession = {
            id: Math.random().toString(36).substring(7),
            startTime: now,
            kbId: kbData._id,
            scopeName: isFinalDrillActive || isNativeDrillActive() ? 'Mastery Drill' : (isMobile ? 'Restored Mobile Session' : 'Ad-hoc Session'),
            totalTime: 0,
            flashcardsCount: 0,
            flashcardsTime: 0,
            incRemsCount: 0,
            incRemsTime: 0,
            againCount: 0,
            currentCardFirstRep: undefined,
          };
          await syncLiveSession(plugin);
          cardStartTimes.clear();
          incRemEngagementStart = null;
          incRemEngagementRemId = null;
          lastIncRemEndTs = null;
          lastIncRemEndRemId = null;
          incRemTransitionFlag = null;
        } catch (err) {
          console.error('ERROR: Failed to lazily initialize practice session', err);
        }
      }

      // IncRem engagement (count + time) is now tracked explicitly by the
      // IncRem rendering surfaces (queue.tsx and editor_review_timer.tsx) via
      // startIncRemEngagement / endIncRemEngagement, plus by editor_review.tsx's
      // manual-minutes confirm via recordIncRemRep. This event no longer
      // infers IncRem activity from QueueItemType.Plugin.

      if (data?.cardId) {
        // Track current and previous card for Mastery Drill edit features
        const lastCurrentId = await plugin.storage.getSession<string>('finalDrillCurrentCardId');
        if (lastCurrentId && lastCurrentId !== data.cardId) {
          await plugin.storage.setSession('finalDrillPreviousCardId', lastCurrentId);
        }
        await plugin.storage.setSession('finalDrillCurrentCardId', data.cardId);

        // Only when the session was created above; otherwise the panel moved first.
        if (!movePanelNow) {
          cardStartTimes.set(data.cardId, now);
          if (currentSession) await moveLivePanelTo(plugin, currentSession, data.cardId);
        }

        // Verify Mastery Drill scope: if we labeled this session as Mastery Drill but the
        // card isn't in the drill list, it's an embedded/ad-hoc queue collision.
        // Not for the regular-queue drill: it is identified by its document, and it loads the
        // drill Rems' other cards (which it then skips), so a non-drill card proves nothing.
        if (currentSession && currentSession.scopeName === 'Mastery Drill' && !isNativeDrillActive()) {
          type FinalDrillItem = string | { cardId: string; kbId?: string };
          const finalDrillItems =
            ((await plugin.storage.getSynced('finalDrillIds')) as FinalDrillItem[]) || [];
          const isOurCard =
            finalDrillItems.length > 0 &&
            finalDrillItems.some((item) =>
              (typeof item === 'string' ? item : item.cardId) === data.cardId
            );
          if (!isOurCard) {
            currentSession.scopeName = 'Ad-hoc Session';
          }
        }
      }
    } catch (error) {
      console.error('ERROR in QueueSession QueueLoadCard listener:', error);
    }
  });

  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, async (message: any) => {
    try {
      const { cardId, score } = message as { cardId: string; score: QueueInteractionScore };

      // cardId is always the card rated: Card Cluster ratings never reach this event
      // (findings/QUEUE_AND_PRACTICE.md), and clusterVisibleCardId may already name the next card.

      if (currentSession && cardId) {
        // When cardStartTimes was already consumed there is nothing to add: RemNote can fire
        // QueueCompleteCard repeatedly for a stuck card, and the duplicate is silently ignored.
        const startTime = cardStartTimes.get(cardId);
        if (startTime) {
          await addRatingToSession(plugin, cardId, score, Date.now() - startTime);
          // Shown before the schedule read below, which can wait behind the rating's other work.
          await syncLiveSession(plugin);
        }
      } else if (incRemEngagementStart !== null && currentSession) {
        // No cardId — IncRem rep completion. Close any open engagement so
        // its accumulated time is captured even if the widget cleanup hasn't
        // fired yet (the rendering surfaces also call endIncRemEngagement).
        await endIncRemEngagement(plugin);
      }

      if (cardId && score !== QueueInteractionScore.TOO_EARLY) {
        await updatePrevCardSchedule(plugin, cardId);
      }

      if (currentSession) {
        await syncLiveSession(plugin);
      }
    } catch (error) {
      console.error('ERROR in QueueSession QueueCompleteCard listener:', error);
    }
  });
}

async function addRatingToSession(
  plugin: RNPlugin,
  cardId: string,
  score: QueueInteractionScore | undefined,
  rawTimeSpent: number
) {
  // The cached limit is used at once and refreshed behind it, so a rating counts with no bridge
  // call in the way. Only the first rating has to wait for the read.
  const refresh = getIESetting(plugin, flashcardResponseTimeLimitId).then((value) => {
    responseTimeLimitSec = value;
  });
  if (responseTimeLimitSec === undefined) await refresh;
  else refresh.catch((e) => console.warn('[QueueSession] Could not refresh the response time limit:', e));
  // The session may have closed during the read.
  if (!currentSession) return;
  const timeSpent = Math.min(rawTimeSpent, (responseTimeLimitSec as number) * 1000);

  currentSession.totalTime += timeSpent;
  currentSession.flashcardsTime += timeSpent;
  currentSession.flashcardsCount++;
  if (score === QueueInteractionScore.AGAIN) {
    currentSession.againCount = (currentSession.againCount || 0) + 1;
  }

  if (score !== QueueInteractionScore.TOO_EARLY) {
    if (currentSession.currentCardId === cardId) {
      currentSession.currentCardTotalTime =
        (currentSession.currentCardTotalTime || 0) + timeSpent;
      currentSession.currentCardRepCount =
        (currentSession.currentCardRepCount || 0) + 1;
    }
    if (currentSession.prevCardId === cardId) {
      currentSession.prevCardTotalTime =
        (currentSession.prevCardTotalTime || 0) + timeSpent;
      currentSession.prevCardRepCount =
        (currentSession.prevCardRepCount || 0) + 1;
    }
  }

  cardStartTimes.delete(cardId);
}

/** Update prev-card interval/coverage now that scheduler has updated. */
async function updatePrevCardSchedule(plugin: RNPlugin, cardId: string) {
  if (!currentSession || (currentSession.currentCardId !== cardId && currentSession.prevCardId !== cardId)) {
    return;
  }
  const card = await plugin.card.findOne(cardId);
  if (!card || !currentSession) return;
  const dates = card.repetitionHistory?.map((h) => h.date) || [];
  const lastRepTime =
    card.lastRepetitionTime || (dates.length > 0 ? Math.max(...dates) : undefined);
  if (card.nextRepetitionTime && lastRepTime) {
    currentSession.prevCardInterval = card.nextRepetitionTime - lastRepTime;
    currentSession.prevCardNextRepTime = card.nextRepetitionTime;
  }
  if (card.repetitionHistory && card.repetitionHistory.length > 0) {
    const weightsRaw = await getIESetting(plugin, fsrsWeightsId);
    const weights = parseWeightsString(weightsRaw);
    const fsrs = computeFSRSState(card.repetitionHistory, weights);
    if (fsrs && currentSession) {
      currentSession.prevCardFsrsD = fsrs.d;
      currentSession.prevCardFsrsS = fsrs.s;
    }
  }
}

/**
 * A rating no QueueCompleteCard reported (Card Clusters): the same bookkeeping, with the time
 * taken from RemNote's own record since QueueLoadCard never times a sibling.
 */
export async function recordRatingWithoutEvent(
  plugin: RNPlugin,
  cardId: string,
  score: QueueInteractionScore,
  responseTime: number
) {
  try {
    if (!currentSession) return;
    await addRatingToSession(plugin, cardId, score, responseTime);
    await updatePrevCardSchedule(plugin, cardId);
    if (currentSession) await syncLiveSession(plugin);
  } catch (error) {
    console.error('ERROR recording a Card Cluster rating in the session:', error);
  }
}
