import { PluginRem, ReactRNPlugin, RemId } from '@remnote/plugin-sdk';
import * as _ from 'remeda';
import {
  allIncrementalRemKey,
  allIncrementalRemSlimKey,
  currentScopeRemIdsKey,
  currentIncRemKey,
  seenRemInSessionKey,
  noIncRemTimerKey,
  incRemDisabledDeviceKey,
  deferSpoilerIncRemsId,
} from './consts';
import { getIESetting } from './settings';
import { getIncrementalRemFromRem, IncrementalRem, SlimIncRem } from './incremental_rem';
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

/**
 * Per-turn tracing for queue injection: the selection decision, the outcome of
 * each call, and every buffer rebuild. Roughly five console lines per queue
 * item, which drowns out everything else during a study session, so it ships
 * off.
 *
 * Flip to `true` to get a full session trace back — the diagnostic that found
 * the dropped-injection bug in the first place. Deliberately a flag rather than
 * deleted code: this subsystem has a failure mode (RemNote silently discarding
 * a late answer) that produces no symptom whatsoever, so the next investigation
 * should not have to start by rebuilding the instrumentation.
 *
 * Genuine problems are NOT gated on this. The dropped-injection warning and the
 * slow-call warning always print, and every console.error stays unconditional.
 */
export const VERBOSE_QUEUE_INJECTION = false;

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
 * The rebuild reads the slim IncRem cache and verifies a few candidates, so it
 * is far from free even after that projection landed. It used to happen *inside*
 * GetNextCard, i.e. before the queue widget mounted. Firing it immediately after
 * the return would instead put it in direct contention with that mount, which is
 * already slow enough to be visible (slow enough, in fact, to make an earlier
 * mount-based drop detector report false positives). Waiting about a second
 * hands the bridge to the widget first and still finishes long before the user
 * rates the item.
 */
const REFILL_DELAY_MS = 1200;

type PrefetchState = {
  /** `${mode}|${subQueueId}` the buffer was built for; null when never built. */
  buildKey: string | null;
  /** Verified candidates, best-first. */
  buffer: SlimIncRem[];
  /**
   * Verified candidates held back by spoiler protection: the rem is a genuine
   * IncRem, but it also owns a flashcard that RemNote would schedule right now,
   * and showing the extract first would give the answer away.
   *
   * Deliberately a second buffer rather than a filter — see `cleanExhausted`.
   */
  deferredBuffer: SlimIncRem[];
  /**
   * True when the last build walked the entire eligible list and everything that
   * survived verification was a spoiler.
   *
   * This is what makes the deferral safe. Without it, "buffer is empty" would be
   * ambiguous — it is also what an exhausted MAX_VERIFY_ROUNDS looks like — and
   * falling through to the deferred list on that would weaken the protection to
   * nothing on a busy build. With it, a deferred IncRem is served only when
   * there is genuinely no unspoiled one left to serve instead.
   */
  cleanExhausted: boolean;
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
  pending: SlimIncRem | null;
  ready: boolean;
};

/**
 * Clears the SESSION-scoped fields, carrying the rest forward.
 *
 * `cardsPerRem` and the two gate mirrors describe the KB and the device, not the
 * queue session, so resetting them to defaults on every queue enter/exit was
 * wrong: until the first background build completed, `readCardsPerRem` handed
 * out DEFAULT_CARDS_PER_REM instead of the user's setting, and the first calls
 * of a session computed their injection interval from it. A session with
 * cardsPerRem 2 opened with `(0+1) % 7` instead of `(0+1) % 3`.
 *
 * These three are seeded at activation (see registerPrefetchTrackers) and
 * refreshed on every build, so carrying them across a reset is strictly more
 * accurate than re-defaulting.
 */
const emptyState = (previous?: PrefetchState): PrefetchState => ({
  buildKey: null,
  buffer: [],
  deferredBuffer: [],
  cleanExhausted: false,
  dueCount: 0,
  cardsPerRem: previous?.cardsPerRem ?? DEFAULT_CARDS_PER_REM,
  timerEndsAt: previous?.timerEndsAt ?? null,
  deviceDisabled: previous?.deviceDisabled ?? false,
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
  state = emptyState(state);
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
export function takePrefetchedCandidate(
  info: PrefetchQueueInfo,
  options?: { allowDeferred?: boolean }
): SlimIncRem | null {
  if (!isPrefetchReadyFor(info)) return null;
  // A rem can be burned while it sits in a buffer (see noteIncRemDisplayed), and
  // the buffers are only rebuilt later. Skipping it here is the last guard
  // against showing the same IncRem twice in one session.
  const takeUnseen = (list: SlimIncRem[]) => {
    let c = list.shift();
    while (c && state.seen.has(c.remId)) c = list.shift();
    return c;
  };
  let next = takeUnseen(state.buffer);
  if (!next && (state.cleanExhausted || options?.allowDeferred)) {
    // Nothing unspoiled is left to show instead, so the protection has done all
    // it usefully can: serving the held-back IncRem now beats withholding it for
    // a card that this session is not going to reach anyway.
    next = takeUnseen(state.deferredBuffer);
    if (next && VERBOSE_QUEUE_INJECTION) {
      console.log(
        `🎭 Spoiler protection released ${next.remId} — ` +
          (state.cleanExhausted ? 'no unspoiled candidate remains' : 'no flashcards remain') +
          '.'
      );
    }
  }
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
  burn(plugin, served.remId);
}

function burn(plugin: ReactRNPlugin, remId: RemId) {
  state.seen.add(remId);
  void plugin.storage
    .setSession(seenRemInSessionKey, Array.from(state.seen))
    .catch((e) => console.error('[prefetch] seen write-through failed:', e));
}

/**
 * Late confirmation: the queue widget reported that `remId` is on screen.
 *
 * GetNextCard verification runs from RemNote's preload, which fires as soon as
 * an item is popped — before our widget has even mounted — and it can only read
 * queue counters. So a rem judged "dropped" there may in fact be on screen a
 * moment later. If it is sitting in a buffer (rolled back), it goes out of it
 * now and is burned, instead of being served a second time.
 *
 * `pending` is left alone: a rem that is pending AND displayed is the one the
 * user is reading while RemNote already holds it for the next slot, and a
 * returned item cannot be taken back.
 */
function noteIncRemDisplayed(plugin: ReactRNPlugin, remId: RemId) {
  if (state.seen.has(remId) || state.pending?.remId === remId) return;
  const inBuffer = (list: SlimIncRem[]) => list.some((c) => c.remId === remId);
  const wasBuffered = inBuffer(state.buffer) || inBuffer(state.deferredBuffer);
  if (!wasBuffered) return;
  state.buffer = state.buffer.filter((c) => c.remId !== remId);
  state.deferredBuffer = state.deferredBuffer.filter((c) => c.remId !== remId);
  if (state.dueCount > 0) state.dueCount--;
  burn(plugin, remId);
  console.log(
    `🩹 IncRem ${remId} was on screen after all — removed from the prefetch buffer so it is not served again.`
  );
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
export function rollbackServed(): SlimIncRem | null {
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

type Verdict =
  /** A genuine IncRem with nothing of its own due in the flashcard queue. */
  | 'ok'
  /** A genuine IncRem, but one of its own cards is due — hold it back. */
  | 'spoiler'
  /** No longer an IncRem (un-incrementalised, deleted), or the read threw. */
  | 'invalid';

/**
 * Resolves the `cloze-extract` tag Rem, or null when the KB has none yet.
 *
 * It is a plain named Rem, not a powerup — `register/commands.ts` creates it
 * lazily the first time "Extract as cloze" runs — so a user who has never used
 * Alt+Z simply has no such tag and the child check is skipped entirely. Resolved
 * once per build rather than per candidate: it is one round-trip on a path that
 * already issues dozens, and re-reading it each build means a tag created (or
 * recreated) mid-session is picked up by the next rebuild without any cache to
 * invalidate.
 */
async function resolveClozeExtractTagId(plugin: ReactRNPlugin): Promise<RemId | null> {
  try {
    const tag = await plugin.rem.findByName(['cloze-extract'], null);
    return tag?._id ?? null;
  } catch (e) {
    console.error('[prefetch] cloze-extract tag lookup failed:', e);
    return null;
  }
}

/**
 * True when a DIRECT child of `rem` carries the `cloze-extract` tag and owns a
 * card RemNote would schedule right now.
 *
 * Membership is read per child (`getTagRems`) rather than from the tag's
 * `taggedRem()` member list, for two independent reasons.
 *
 * CORRECTNESS first: `taggedRem()` under-reports. On a KB holding thousands of
 * Extra Card Detail Rems it enumerated THREE while `hasPowerup` returned true on
 * those same Rems — see the finding recorded in lib/empty_ecd_scan.ts. A gate
 * built on it would silently stop protecting most of the graph, and silence is
 * the one failure mode this subsystem cannot afford. The under-reporting is a
 * BUILT-IN POWERUP problem, though, and `cloze-extract` is neither built-in nor
 * a powerup — register/commands.ts creates it as a plain Rem and attaches it
 * with addTag() — which is precisely the case that same finding says
 * `getTagRems()` reports correctly. Confirmed on a real dual-extract parent: the
 * probe found both tagged children.
 *
 * COST second: the member list would be one call instead of many, but it returns
 * every cloze extract in the KB — thousands of Rems on a mature graph —
 * deserialized across the bridge on every rebuild, which is the kind of cost
 * this module exists to keep out of a study session. A candidate's children are
 * a handful of Rems and they are read concurrently, so the wall time is one
 * round-trip deep regardless of fan-out.
 *
 * Fails OPEN, like the own-cards gate: a read that throws reports "no spoiler"
 * and the IncRem is shown, rather than being silently withheld.
 */
async function hasDueClozeExtractChild(
  rem: PluginRem,
  clozeExtractTagId: RemId,
  now: number
): Promise<boolean> {
  try {
    const children = (await rem.getChildrenRem()) || [];
    if (children.length === 0) return false;
    const spoils = await Promise.all(
      children.map(async (child: PluginRem) => {
        const tags = await child.getTagRems();
        if (!tags?.some((t: PluginRem) => t._id === clozeExtractTagId)) return false;
        const cards = await child.getCards();
        // Same predicate as the own-cards gate, for the same reasons: a disabled
        // direction is absent from getCards() entirely, and a never-practiced
        // cloze carries a real nextRepetitionTime, so a freshly extracted cloze
        // counts as due — the case that matters most, since the extract would be
        // giving away an answer the user has never recalled.
        return cards.some((c) => (c.nextRepetitionTime ?? Infinity) <= now);
      })
    );
    return spoils.some(Boolean);
  } catch (e) {
    console.error('[prefetch] cloze-extract child check failed for', rem._id, e);
    return false;
  }
}

/**
 * Decides whether a candidate is still a genuine Incremental Rem, and — when
 * spoiler protection is on — whether showing it now would give away a flashcard
 * the queue still owes the user.
 *
 * This is the expensive part — roughly eleven serial SDK round-trips per
 * candidate (hasPowerup, two Daily-Doc resolutions of three calls each, the
 * history slot, and the priority slot plus its rich-text conversion), measured
 * at 114–231ms. It used to run inside GetNextCard, between the decision and the
 * return. Here it runs while the user is reading.
 *
 * Both spoiler reads — the rem's own cards, and the cloze-extract child walk —
 * are issued CONCURRENTLY with the IncRem verification rather than after it, so
 * protection costs no additional wall time, only more in-flight requests on a
 * path that already has eleven.
 *
 * SCOPE: the rem's own cards, PLUS the cards of its direct children tagged
 * `cloze-extract` — the clozes that "Extract as cloze" (Alt+Z) carves out of an
 * extract and files directly underneath it. Those children quote the parent's
 * sentence verbatim with one span blanked out, so the parent spoils them exactly
 * as it spoils its own cards; before this, an IncRem with no cards of its own
 * sailed through the gate and gave away every cloze extracted from it.
 *
 * Deeper descendants and untagged children remain out of scope. The tag is what
 * makes this affordable: it identifies the spoiling children without walking the
 * subtree, which would need getDescendants() per candidate — a different order
 * of cost that wants a cache of its own.
 */
async function verifyCandidate(
  plugin: ReactRNPlugin,
  candidate: SlimIncRem,
  checkSpoiler: boolean,
  clozeExtractTagId: RemId | null
): Promise<Verdict> {
  try {
    const rem = await plugin.rem.findOne(candidate.remId);
    if (!rem) return 'invalid';
    const now = Date.now();
    const [incRem, cards, clozeChildSpoils] = await Promise.all([
      getIncrementalRemFromRem(plugin, rem),
      checkSpoiler ? rem.getCards() : Promise.resolve([]),
      checkSpoiler && clozeExtractTagId
        ? hasDueClozeExtractChild(rem, clozeExtractTagId, now)
        : Promise.resolve(false),
    ]);
    if (!incRem) return 'invalid';
    if (!checkSpoiler) return 'ok';
    if (clozeChildSpoils) return 'spoiler';

    // Two things had to be true for this gate to be safe, and both were measured
    // on real rems (debug widget → "Probe Spoiler State") rather than assumed:
    //
    // 1. A DISABLED direction cannot strand its IncRem. Turning a two-way card
    //    down to forward-only removes the backward card from getCards()
    //    ENTIRELY — a rem that reported 3 cards reported 2 afterwards, and the
    //    dropped one kept its 7 reps and its 2029 due date. So the disabled card
    //    is never seen by the predicate at all; it cannot hold the rem back in
    //    session after session with no card ever appearing to release it. Note
    //    this is a stronger guarantee than the "disabled cards have a null
    //    nextRepetitionTime" convention documented in lib/card_priority — the
    //    card is absent, not null — but the `?? Infinity` below keeps the two in
    //    agreement either way, and divergence would mean the queue and the
    //    shields disagreed about what "due" means.
    //
    // 2. A NEW card DOES trigger protection. Never-practiced cards carry a real
    //    nextRepetitionTime (their creation instant), not null, so a fresh
    //    flashcard on the same rem counts as due and its extract is held back —
    //    which is the case that matters most, since nothing has been recalled
    //    yet for the extract to spoil.
    //
    // `?? Infinity` therefore covers only genuinely unscheduled cards, and it
    // fails OPEN: an unrecognised state shows the IncRem rather than hiding it.
    return cards.some((c) => (c.nextRepetitionTime ?? Infinity) <= now) ? 'spoiler' : 'ok';
  } catch (e) {
    console.error('[prefetch] verify failed for', candidate.remId, e);
    return 'invalid';
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

    const [slimRaw, scopeRaw, cardsPerRem, sortingRandomness, weightK, deferSpoilers] =
      await Promise.all([
        plugin.storage.getSession<SlimIncRem[]>(allIncrementalRemSlimKey),
        plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey),
        getCardsPerRem(plugin),
        getSortingRandomness(plugin),
        getWeightSelectionK(plugin),
        getIESetting(plugin, deferSpoilerIncRemsId),
      ]);

    state.cardsPerRem = cardsPerRem;

    // Selection reads the slim projection — remId/nextRepDate/priority only —
    // which is roughly a tenth of the full cache's 7.99MB. The full key is the
    // fallback for the window before the first cache load under this version has
    // written the slim one; `IncrementalRem` is structurally a `SlimIncRem`, so
    // no mapping is needed.
    let allIncRems: SlimIncRem[];
    if (slimRaw) {
      allIncRems = slimRaw;
    } else {
      allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
    }
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

    // Spoiler protection applies to the normal queue only. In practice-all and
    // in-order every card in scope is going to be shown regardless of its due
    // date, so "has a due card" is true of every dual-type rem at once and the
    // gate would demote all of them for the whole session — a filter with no
    // release condition. Those modes also aren't where the measurement matters:
    // the user is drilling, not being scored by the scheduler.
    const checkSpoiler = deferSpoilers && info.mode === 'normal';

    // Resolved here, once, so the per-candidate child check is a tag-id compare
    // rather than a lookup. Null when the KB has no cloze-extract tag yet, which
    // switches the child check off without costing anything per candidate.
    const clozeExtractTagId = checkSpoiler ? await resolveClozeExtractTagId(plugin) : null;

    // Verify from the front in windows, keeping order, until the buffer is full
    // or we run out of candidates. Parallel within a window because these are
    // independent reads and this is off the critical path anyway.
    const verified: SlimIncRem[] = [];
    const deferred: SlimIncRem[] = [];
    let cursor = 0;
    let cleanExhausted = false;
    for (let round = 0; round < MAX_VERIFY_ROUNDS && verified.length < BUFFER_TARGET; round++) {
      const window = filtered.slice(cursor, cursor + (BUFFER_TARGET - verified.length));
      if (window.length === 0) {
        // Walked the whole eligible list. Anything sitting in `deferred` is now
        // the best there is; takePrefetchedCandidate is allowed to fall through
        // to it.
        cleanExhausted = true;
        break;
      }
      cursor += window.length;
      const results = await Promise.all(
        window.map((c) => verifyCandidate(plugin, c, checkSpoiler, clozeExtractTagId))
      );
      window.forEach((candidate, i) => {
        if (results[i] === 'ok') verified.push(candidate);
        else if (results[i] === 'spoiler') deferred.push(candidate);
      });
    }

    if (builtForGeneration !== generation) {
      if (VERBOSE_QUEUE_INJECTION) {
        console.log('🧰 Prefetch build discarded — the queue session changed while it ran.');
      }
      return;
    }

    state.buffer = verified;
    state.deferredBuffer = deferred;
    state.cleanExhausted = cleanExhausted;
    // Deferred rems ARE still due — they are postponed within the session, not
    // excluded from it — so they stay in the counter.
    state.dueCount = filtered.length;
    state.buildKey = makeBuildKey(info);
    state.ready = true;

    if (VERBOSE_QUEUE_INJECTION) {
      console.log(
        `🧰 Prefetch built for [${state.buildKey}] in ${Date.now() - startedAt}ms: ` +
          `${verified.length} verified of ${filtered.length} eligible (${allIncRems.length} cached)` +
          (checkSpoiler
            ? `, ${deferred.length} held back as spoilers` +
              (deferred.length ? ` [${deferred.map((d) => d.remId).join(', ')}]` : '') +
              (cleanExhausted ? ' (no unspoiled candidate left)' : '')
            : '') +
          '.'
      );
    }
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

  // The queue widget writes this key when it mounts (only the widget writes it;
  // QueueExit clears it). The tracker fires on change only, so the same rem
  // shown twice in a row is not reported — which is fine: by then it is burned.
  plugin.track(async (rp) => {
    const remId = await rp.storage.getSession<RemId>(currentIncRemKey);
    if (remId) noteIncRemDisplayed(plugin, remId);
  });

  // Seed the non-session mirrors at activation so the very first GetNextCard of
  // the very first queue already reads real values rather than defaults.
  //
  // Deliberately NOT inside a plugin.track: getCardsPerRem calls
  // kb.getCurrentKnowledgeBaseData(), and subscribing the tracker to that would
  // re-run this on unrelated KB churn. A one-shot read at activation plus the
  // refresh inside every build keeps it current — the setting only changes by
  // deliberate user action, and a change mid-queue lands on the next rebuild.
  void (async () => {
    try {
      const [cardsPerRem, deviceDisabled] = await Promise.all([
        getCardsPerRem(plugin),
        plugin.storage.getLocal<boolean>(incRemDisabledDeviceKey),
      ]);
      state.cardsPerRem = cardsPerRem;
      state.deviceDisabled = !!deviceDisabled;
    } catch (e) {
      console.error('[prefetch] activation seed failed:', e);
    }
  })();
}
