import { RNPlugin } from '@remnote/plugin-sdk';
import { practicedQueuesVisibleKey } from './consts';

/**
 * Opening the Practiced Queues dashboard in the right sidebar, safely.
 *
 * We are the only thing that opens the right sidebar in the queue — RemNote
 * does not spawn it on queue entry. But RemNote *does* force its own tab (AI
 * Tutor) when the sidebar spawns, and that race is the source of a nasty
 * intermittent failure: when our open loses, the host-side promise never
 * settles, which wedges RemNote's per-plugin message queue. Every subsequent
 * call from *any* of our iframes then stalls behind it — the QueueEnter
 * pre-calculation stops mid-flight and the queue widgets (card info bar,
 * toolbar priority) never finish activating — until the user clicks the tab by
 * hand, which resolves the stuck call and drains the backlog at once.
 *
 * Three rules follow, and each one is load-bearing:
 *
 * 1. Never await the open. We cannot cancel a stalled host call; awaiting only
 *    wedges the caller too.
 * 2. Never retry blindly. A re-issue on a wedged channel is another
 *    unresolvable host promise. The single retry below is gated on a canary
 *    read completing first, so it cannot fire while the channel is stuck.
 * 3. Timers still run in a wedged iframe even though API calls do not, which is
 *    what makes the canary a usable detector.
 */

/** How long to give the widget to mark itself mounted before re-forcing once. */
const ACK_MS = 1200;
/** Canary deadline. A session read that misses this means the channel is gone. */
const CANARY_MS = 2500;

/**
 * Returns `true` if the plugin API channel answered within `timeoutMs`.
 * Races a trivial session read against a local timer.
 */
async function channelAlive(plugin: RNPlugin, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    plugin.storage.getSession(practicedQueuesVisibleKey).then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
  ]);
}

/**
 * Fire-and-forget open of the dashboard tab, with a mount acknowledgement retry
 * and a wedge watchdog. Safe to call from an event handler: it never blocks the
 * caller and never throws. Filter the console with [QDASH] to trace it.
 */
export function openQueueDashboard(plugin: RNPlugin, source: string): void {
  const startedAt = Date.now();

  const issue = (attempt: number) => {
    plugin.window
      .openWidgetInRightSidebar('practiced_queues')
      .catch((e) =>
        console.warn(`[QDASH] open attempt ${attempt} rejected (source=${source}):`, e)
      );
  };

  issue(1);

  void (async () => {
    // Watchdog first: if the channel is wedged this is the only trace we get,
    // and we must not issue a second open on top of a stuck one.
    if (!(await channelAlive(plugin, CANARY_MS))) {
      console.error(
        `[QDASH] plugin API channel wedged ${Date.now() - startedAt}ms after ` +
          `openWidgetInRightSidebar (source=${source}). Queue widgets will not ` +
          `render until the Practiced Queues tab is clicked by hand.`
      );
      return;
    }

    // Channel is alive, so a retry is cheap and cannot pile up. Re-force once if
    // RemNote stole the tab (the widget never marked itself mounted).
    const elapsed = Date.now() - startedAt;
    if (elapsed < ACK_MS) {
      await new Promise((r) => setTimeout(r, ACK_MS - elapsed));
    }
    const visibleAt = await plugin.storage.getSession<number>(practicedQueuesVisibleKey);
    if (visibleAt && visibleAt >= startedAt) return;

    console.warn(`[QDASH] tab did not come up in ${ACK_MS}ms (source=${source}), re-forcing once`);
    issue(2);
  })();
}
