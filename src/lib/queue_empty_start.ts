import { ReactRNPlugin } from '@remnote/plugin-sdk';
import {
  PrefetchQueueInfo,
  hasPrefetchedCandidate,
  waitForPrimedPrefetch,
} from './queue_prefetch';

/**
 * Empty-queue rescue: shows due IncRems in a queue that has no due flashcards.
 *
 * RemNote picks a queue's first card in a "critical" preload, and its plugin
 * card provider skips plugins in that mode (app.asar, PluginCardProvider
 * .preloadInner: `if (this.pendingPluginCard || mode === "critical") return`).
 * With no flashcards that first pop comes back empty, so the queue opens on
 * "You've finished practicing for now". GetNextCard is first asked only in the
 * "full" preload that follows, and RemNote holds its answer as
 * `pendingPluginCard` for the NEXT pop — which never comes on the end screen.
 *
 * `queue.removeCurrentCardFromQueue` is that next pop. On the end screen there
 * is no current card to remove, so it only pops: it shows the pending IncRem
 * when RemNote holds one, and its trailing preload asks GetNextCard again when
 * it does not (the first answer is usually null, because the prefetch is still
 * being built while QueueEnter resolves the scope). An empty pop runs RemNote's
 * "queue cleared" handler, so the confetti may play once more before the IncRem
 * appears.
 */

/** How long to keep trying after the first GetNextCard of an empty queue. */
const RESCUE_WINDOW_MS = 20_000;
/** Lets the bridge reply land as RemNote's pendingPluginCard before popping. */
const SETTLE_MS = 300;
/** How long to wait for the GetNextCard call a pop's trailing preload makes. */
const NEXT_CALL_TIMEOUT_MS = 2_000;
/** Two pops suffice (an empty one, then the IncRem); the third is slack. */
const MAX_POPS = 3;

const LOG = '[EmptyQueueRescue]';

export type GetNextCardProbe = {
  /** Increments on every GetNextCard call. */
  seq: () => number;
  /** True when the last GetNextCard answer was an IncRem, i.e. RemNote holds it. */
  answeredWithIncRem: () => boolean;
};

// Keyed by queue (mode + sub-queue) rather than reset per session: QueueEnter
// can run after the first GetNextCard of the queue it belongs to, and must not
// cancel the rescue that call started.
const running = new Set<string>();
/** Queues where a rescue found a card on screen: nothing left to rescue there. */
const settled = new Set<string>();

/** Called on queue enter and exit, alongside the prefetch reset. */
export function resetEmptyQueueRescue() {
  settled.clear();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(50);
}

/** 'gone' = the user left this queue; 'busy' = something is on screen. */
async function readQueueScreen(
  plugin: ReactRNPlugin,
  info: PrefetchQueueInfo
): Promise<'empty' | 'busy' | 'gone'> {
  const url = await plugin.window.getURL();
  if (!url.includes('/flashcards')) return 'gone';
  if (info.subQueueId && !url.includes(info.subQueueId)) return 'gone';
  const [screenType, remaining] = await Promise.all([
    plugin.queue.getCurrentQueueScreenType(),
    plugin.queue.getNumRemainingCards(),
  ]);
  // A checkpoint screen (buried cards, extra new cards…) has a type of its own;
  // only the end screen has no current item at all.
  return screenType === undefined && !remaining ? 'empty' : 'busy';
}

/**
 * Called (never awaited) from GetNextCard when RemNote reports no flashcards
 * left. Runs at most one rescue at a time; calls made by its own pops just
 * update the probe the running one is watching.
 */
export function rescueEmptyQueueStart(
  plugin: ReactRNPlugin,
  info: PrefetchQueueInfo,
  probe: GetNextCardProbe
) {
  const key = `${info.mode}|${info.subQueueId ?? ''}`;
  if (running.has(key) || settled.has(key)) return;
  running.add(key);
  void (async () => {
    const deadline = Date.now() + RESCUE_WINDOW_MS;
    let pops = 0;
    try {
      await sleep(SETTLE_MS);
      while (Date.now() < deadline) {
        if (!probe.answeredWithIncRem()) {
          // Nothing pending in RemNote yet. Pop only if the scoped buffer has
          // something for its trailing GetNextCard to hand over.
          const ready = await waitForPrimedPrefetch(plugin, info, deadline - Date.now());
          if (!ready || !hasPrefetchedCandidate(info)) return;
        }
        const screen = await readQueueScreen(plugin, info);
        if (screen !== 'empty') {
          if (screen === 'busy') settled.add(key);
          return;
        }
        if (pops >= MAX_POPS) {
          console.warn(`${LOG} still on the end screen after ${pops} pops; giving up.`);
          return;
        }
        pops++;
        const seqBefore = probe.seq();
        console.log(
          `${LOG} queue opened on the end screen with due IncRems; popping ` +
            `(${probe.answeredWithIncRem() ? 'RemNote holds an IncRem' : 'asking GetNextCard again'}).`
        );
        await plugin.queue.removeCurrentCardFromQueue(false);
        await waitUntil(() => probe.seq() > seqBefore, NEXT_CALL_TIMEOUT_MS);
        await sleep(SETTLE_MS);
      }
    } catch (e) {
      console.warn(`${LOG} failed:`, e);
    } finally {
      running.delete(key);
    }
  })();
}
