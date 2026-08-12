import { ReactRNPlugin, RemId } from '@remnote/plugin-sdk';
import * as _ from 'remeda';
import {
  allIncrementalRemKey,
  currentScopeRemIdsKey,
  seenRemInSessionKey,
  noIncRemTimerKey,
  incRemDisabledDeviceKey,
} from './consts';
import { getIncrementalRemFromRem, IncrementalRem } from './incremental_rem';
import {
  CardsPerRem,
  DEFAULT_CARDS_PER_REM,
  getCardsPerRem,
  getSortingRandomness,
  getWeightSelectionK,
  applyPriorityWeightedLottery,
} from './sorting';

/**
 * Off-critical-path preparation of the next Incremental Rem to inject into the
 * queue.
 *
 * WHY THIS EXISTS
 * ---------------
 * RemNote awaits the GetNextCard callback with an internal deadline of roughly
 * one second. Past it, RemNote stops waiting and loads a flashcard of its own;
 * whatever the plugin returns afterwards is discarded silently.
 *
 * Instrumented sessions on a 5,525-IncRem KB showed injections landing at 623ms,
 * 863ms, 969ms and 993ms, and one dropped at 1088ms. The plugin was not slow at
 * anything it *computed* — sorting and filtering all 5,525 entries measured
 * 0–3ms every single call. The entire cost was SDK round-trips, and the largest
 * single phase was two trivial scalar reads that ranged from 13ms to 631ms
 * depending only on how busy the plugin bridge happened to be. That is queueing
 * delay, and no amount of shaving round-trips makes it predictable.
 *
 * So this module removes them instead. Everything GetNextCard needs — the
 * blocking gates, the interval setting, and a small buffer of already-verified
 * candidates — is held in plain module state, and the callback answers from
 * memory with zero awaits. The work that used to sit on the critical path now
 * runs in the gap while the user is reading the current item, where taking 400ms
 * costs nothing.
 *
 * WHY MODULE STATE IS SAFE HERE
 * -----------------------------
 * `registerCallbacks` and `registerIncrementalRemTracker` are both invoked from
 * `index.tsx`'s `onActivate`, so they share one JS realm with this module. A
 * module-level variable is a direct memory read from the callback — no bridge,
 * no serialization. (It is deliberately NOT session storage: reading that is the
 * very cost we are removing.)
 */

export type QueueMode = 'practice-all' | 'in-order' | 'normal';

export type PrefetchQueueInfo = {
  mode: QueueMode;
  subQueueId: string | undefined;
};

/**
 * How many verified candidates to keep ready. More than one because a candidate
 * can go stale between preparation and serving (the rem gets un-incrementalised,
 * deleted, or reviewed elsewhere), and because a dropped injection is pushed
 * back onto the buffer rather than discarded.
 */
const BUFFER_TARGET = 3;

/**
 * How many rounds of "take a window, verify it in parallel" the builder will run
 * before giving up. Bounds the work when a scope contains many stale entries.
 */
const MAX_VERIFY_ROUNDS = 4;

/**
 * Delay before the background rebuild starts after a GetNextCard call.
 *
 * The rebuild reads the full IncRem session cache — 7.99MB on the KB this was
 * measured against. That read used to happen *inside* GetNextCard, i.e. before
 * the queue widget mounted. Firing it immediately after the return would instead
 * put it in direct contention with that mount, which is already slow enough to
 * be visible (it was slow enough to make an earlier mount-based drop detector
 * report false positives). Waiting about a second hands the bridge to the widget
 * first and still finishes long before the user rates the item.
 */
const REFILL_DELAY_MS = 1200;

type PrefetchState = {
  /** `${mode}|${subQueueId}` the buffer was built for; null when never built. */
  buildKey: string | null;
  /** Verified candidates, best-first. */
  buffer: IncrementalRem[];
  /** Due-and-in-scope count, for the queue counter CSS. */
  dueCount: number;
  cardsPerRem: CardsPerRem;
  /** Mirror of noIncRemTimerKey: ms timestamp, or null when no timer is set. */
  timerEndsAt: number | null;
  /** Mirror of incRemDisabledDeviceKey. */
  deviceDisabled: boolean;
  /**
   * Rems already served this session. Authoritative in memory; written through
   * to session storage (which QueueExit reads for the Priority Shield history)
   * only once an injection is CONFIRMED to have been displayed.
   */
  seen: Set<RemId>;
  /**
   * Served but not yet confirmed on screen. Excluded from selection so it cannot
   * be served twice, but not yet burned into `seen` — if RemNote dropped it, it
   * goes back on the buffer intact.
   */
  pending: IncrementalRem | null;
  ready: boolean;
};

const emptyState = (): PrefetchState => ({
  buildKey: null,
  buffer: [],
  dueCount: 0,
  cardsPerRem: DEFAULT_CARDS_PER_REM,
  timerEndsAt: null,
  deviceDisabled: false,
  seen: new Set<RemId>(),
  pending: null,
  ready: false,
});

let state: PrefetchState = emptyState();
let buildInFlight = false;
/** Set when a build is requested while one is already running; see buildQueuePrefetch. */
let rebuildRequested: PrefetchQueueInfo | null = null;
/**
 * Bumped by every reset. A build that started before a reset captures the old
 * value and throws its results away rather than writing them into the new
 * session's state — otherwise a build kicked off just before queue entry could
 * land afterwards and publish a buffer computed against the previous scope.
 */
let generation = 0;
let refillTimer: ReturnType<typeof setTimeout> | null = null;

const makeBuildKey = (info: PrefetchQueueInfo) => `${info.mode}|${info.subQueueId ?? ''}`;

/**
 * Drops all prefetched state. Called on queue enter and queue exit — the seen
 * set, the scope and the candidate buffer are all per-session.
 */
export function resetQueuePrefetch() {
  if (refillTimer) {
    clearTimeout(refillTimer);
    refillTimer = null;
  }
  rebuildRequested = null;
  generation++;
  state = emptyState();
}

// ---------------------------------------------------------------------------
// Synchronous accessors — these are what GetNextCard actually calls
// ---------------------------------------------------------------------------

/** Blocking-gate snapshot. Zero cost: plain memory reads. */
export function readGates(): { blocked: boolean; reason: 'timer-active' | 'device-disabled' | null } {
  if (state.deviceDisabled) return { blocked: true, reason: 'device-disabled' };
  if (state.timerEndsAt !== null && state.timerEndsAt > Date.now()) {
    return { blocked: true, reason: 'timer-active' };
  }
  return { blocked: false, reason: null };
}

export function readCardsPerRem(): CardsPerRem {
  return state.cardsPerRem;
}

export function readDueCount(): number {
  return state.dueCount;
}

export function isPrefetchReadyFor(info: PrefetchQueueInfo): boolean {
  return state.ready && state.buildKey === makeBuildKey(info);
}

/**
 * Pops the next verified candidate, or null when the buffer is empty or was
 * built for a different queue (mode or sub-queue changed).
 *
 * The candidate becomes `pending` rather than `seen`: see confirmServed /
 * rollbackServed. Purely synchronous — no awaits anywhere on this path.
 */
export function takePrefetchedCandidate(info: PrefetchQueueInfo): IncrementalRem | null {
  if (!isPrefetchReadyFor(info)) return null;
  const next = state.buffer.shift();
  if (!next) return null;
  state.pending = next;
  // Keep the queue counter honest between rebuilds; the next build recomputes it.
  if (state.dueCount > 0) state.dueCount--;
  return next;
}

/**
 * The pending item was confirmed on screen. Burn it: it must not be offered
 * again this session.
 *
 * The session-storage write is fire-and-forget on purpose. It is read by
 * QueueExit (Priority Shield history) and by the weighted-shield precompute,
 * neither of which runs anywhere near this moment, so nothing needs to await it.
 */
export function confirmServed(plugin: ReactRNPlugin) {
  const served = state.pending;
  if (!served) return;
  state.pending = null;
  state.seen.add(served.remId);
  void plugin.storage
    .setSession(seenRemInSessionKey, Array.from(state.seen))
    .catch((e) => console.error('[prefetch] seen write-through failed:', e));
}

/**
 * Commits any still-unconfirmed item at queue exit.
 *
 * Confirmation normally arrives on the FOLLOWING GetNextCard call, which never
 * comes for the last item of a session. Without this, an IncRem reviewed as the
 * final item would be missing from the seen list that QueueExit reads to save
 * the Priority Shield history. Awaited, unlike the in-session write-through,
 * because QueueExit reads that key moments later.
 *
 * If that last injection was in fact dropped, this marks a rem seen that was
 * never displayed — harmless, since the session is over and the list has no
 * remaining gatekeeping role.
 */
export async function flushPendingServed(plugin: ReactRNPlugin): Promise<void> {
  if (!state.pending) return;
  state.seen.add(state.pending.remId);
  state.pending = null;
  try {
    await plugin.storage.setSession(seenRemInSessionKey, Array.from(state.seen));
  } catch (e) {
    console.error('[prefetch] final seen flush failed:', e);
  }
}

/**
 * The pending item never reached the screen — RemNote consumed a flashcard
 * instead. Put it back at the head of the buffer so the next injection
 * opportunity retries it.
 *
 * Before this existed, a dropped injection still wrote the rem into the seen
 * list, permanently removing a due IncRem from the session that the user never
 * laid eyes on. That was visible in the logs as `filtered` counting down 8 → 7 →
 * 6 while `seenRemIds` climbed, and it is what turned an occasional timeout into
 * "incremental rems have stopped appearing".
 */
export function rollbackServed(): IncrementalRem | null {
  const served = state.pending;
  if (!served) return null;
  state.pending = null;
  state.buffer.unshift(served);
  state.dueCount++;
  return served;
}

// ---------------------------------------------------------------------------
// Background preparation — everything below runs off the critical path
// ---------------------------------------------------------------------------

/**
 * Refreshes the blocking-gate mirrors.
 *
 * `incRemDisabledDeviceKey` lives in LOCAL storage, which `plugin.track` does
 * not treat as a reactive dependency (only getSession/getSynced are), so it
 * cannot be kept live by subscription — it is refreshed here on every rebuild
 * instead, leaving it at most one queue item stale. Toggling the device switch
 * mid-queue therefore takes effect from the following item, which is well within
 * what that control implies.
 */
async function refreshGates(plugin: ReactRNPlugin) {
  const [timerEnd, deviceDisabled] = await Promise.all([
    plugin.storage.getSynced<number>(noIncRemTimerKey),
    plugin.storage.getLocal<boolean>(incRemDisabledDeviceKey),
  ]);

  state.deviceDisabled = !!deviceDisabled;

  if (timerEnd && timerEnd > Date.now()) {
    state.timerEndsAt = timerEnd;
  } else {
    state.timerEndsAt = null;
    if (timerEnd) {
      // Expired — clear it, as the old inline gate check did. Fire-and-forget:
      // the in-memory mirror is already correct, so nothing waits on this.
      void plugin.storage
        .setSynced(noIncRemTimerKey, null)
        .catch((e) => console.error('[prefetch] timer clear failed:', e));
    }
  }
}

/**
 * Confirms a candidate is still a genuine Incremental Rem.
 *
 * This is the expensive part — roughly eleven serial SDK round-trips per
 * candidate (hasPowerup, two Daily-Doc resolutions of three calls each, the
 * history slot, and the priority slot plus its rich-text conversion), measured
 * at 114–231ms. It used to run inside GetNextCard, between the decision and the
 * return. Here it runs while the user is reading.
 */
async function verifyCandidate(plugin: ReactRNPlugin, candidate: IncrementalRem): Promise<boolean> {
  try {
    const rem = await plugin.rem.findOne(candidate.remId);
    return !!(await getIncrementalRemFromRem(plugin, rem));
  } catch (e) {
    console.error('[prefetch] verify failed for', candidate.remId, e);
    return false;
  }
}

/**
 * Rebuilds the candidate buffer from scratch: read caches, sort, filter, run the
 * priority-weighted lottery, then verify the top candidates in parallel.
 *
 * The selection semantics are deliberately identical to the old inline
 * implementation — same sort key, same mode-dependent filters, same lottery,
 * same exclusion of already-seen rems — so this is a change of WHEN the work
 * happens, not WHAT it decides.
 */
export async function buildQueuePrefetch(
  plugin: ReactRNPlugin,
  info: PrefetchQueueInfo
): Promise<void> {
  if (buildInFlight) {
    // Don't drop the request. Queue-entry priming in particular arrives while an
    // opportunistic build may still be running against a not-yet-resolved scope;
    // silently discarding it would leave the session on that stale buffer.
    rebuildRequested = info;
    return;
  }
  buildInFlight = true;
  const builtForGeneration = generation;
  const startedAt = Date.now();
  try {
    await refreshGates(plugin);

    const [allIncRemsRaw, scopeRaw, cardsPerRem, sortingRandomness, weightK] = await Promise.all([
      plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
      plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey),
      getCardsPerRem(plugin),
      getSortingRandomness(plugin),
      getWeightSelectionK(plugin),
    ]);

    state.cardsPerRem = cardsPerRem;

    const allIncRems = allIncRemsRaw || [];
    // Same fallback the inline version used: while QueueEnter is still resolving
    // a document scope, select from the full KB rather than blocking. The scope
    // lands within a few seconds and later rebuilds pick it up.
    const scope = scopeRaw;
    const scopeSet = scope ? new Set(scope) : null;

    const sorted = _.sortBy(allIncRems, (incRem) => {
      if (info.mode === 'in-order' && scope) {
        return scope.indexOf(incRem.remId);
      }
      return incRem.priority;
    });

    const now = Date.now();
    const excluded = state.pending ? new Set([...state.seen, state.pending.remId]) : state.seen;
    const filtered = sorted.filter((x) => {
      if (info.subQueueId && scopeSet && !scopeSet.has(x.remId)) return false;
      if (excluded.has(x.remId)) return false;
      switch (info.mode) {
        case 'practice-all':
        case 'in-order':
          return true;
        default:
          return now >= x.nextRepDate;
      }
    });

    // In 'in-order' mode `filtered` is in document order, not priority order, so
    // the lottery must not touch it — same carve-out as before.
    if (info.mode !== 'in-order') {
      applyPriorityWeightedLottery(filtered, sortingRandomness, weightK);
    }

    // Verify from the front in windows, keeping order, until the buffer is full
    // or we run out of candidates. Parallel within a window because these are
    // independent reads and this is off the critical path anyway.
    const verified: IncrementalRem[] = [];
    let cursor = 0;
    for (let round = 0; round < MAX_VERIFY_ROUNDS && verified.length < BUFFER_TARGET; round++) {
      const window = filtered.slice(cursor, cursor + (BUFFER_TARGET - verified.length));
      if (window.length === 0) break;
      cursor += window.length;
      const results = await Promise.all(window.map((c) => verifyCandidate(plugin, c)));
      window.forEach((candidate, i) => {
        if (results[i]) verified.push(candidate);
      });
    }

    if (builtForGeneration !== generation) {
      console.log('🧰 Prefetch build discarded — the queue session changed while it ran.');
      return;
    }

    state.buffer = verified;
    state.dueCount = filtered.length;
    state.buildKey = makeBuildKey(info);
    state.ready = true;

    console.log(
      `🧰 Prefetch built for [${state.buildKey}] in ${Date.now() - startedAt}ms: ` +
        `${verified.length} verified of ${filtered.length} eligible (${allIncRems.length} cached).`
    );
  } catch (e) {
    console.error('[prefetch] build failed:', e);
  } finally {
    buildInFlight = false;
    const queued = rebuildRequested;
    if (queued) {
      rebuildRequested = null;
      void buildQueuePrefetch(plugin, queued);
    }
  }
}

/**
 * Queues a rebuild after REFILL_DELAY_MS. Repeated calls collapse into one, so a
 * burst of queue activity does not stack rebuilds.
 */
export function scheduleQueuePrefetchRefill(plugin: ReactRNPlugin, info: PrefetchQueueInfo) {
  if (refillTimer) clearTimeout(refillTimer);
  refillTimer = setTimeout(() => {
    refillTimer = null;
    void buildQueuePrefetch(plugin, info);
  }, REFILL_DELAY_MS);
}

/**
 * Primes state at queue entry, before the first GetNextCard call arrives.
 *
 * Called at the end of the QueueEnter handler, by which point the document scope
 * and the session caches it depends on are resolved. The queue mode is not part
 * of the QueueEnter payload, so this primes for 'normal'; if the session turns
 * out to be practice-all or in-order, the first GetNextCard sees the build-key
 * mismatch and triggers a rebuild for the real mode.
 */
export async function primeQueuePrefetch(plugin: ReactRNPlugin, subQueueId: string | undefined) {
  resetQueuePrefetch();
  await buildQueuePrefetch(plugin, { mode: 'normal', subQueueId });
}

/**
 * Keeps the no-IncRem timer mirror live. Synced storage IS a reactive dependency
 * for plugin.track, so setting the timer from anywhere updates the gate at once
 * rather than waiting for the next rebuild.
 */
export function registerPrefetchTrackers(plugin: ReactRNPlugin) {
  plugin.track(async (rp) => {
    const timerEnd = await rp.storage.getSynced<number>(noIncRemTimerKey);
    state.timerEndsAt = timerEnd && timerEnd > Date.now() ? timerEnd : null;
  });
}
