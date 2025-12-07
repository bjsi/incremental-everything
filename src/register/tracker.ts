import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { loadIncrementalRemCache } from '../lib/incremental_rem/cache';
import { incrementalQueueActiveKey, currentIncRemKey, powerupCode } from '../lib/consts';

export function registerIncrementalRemTracker(plugin: ReactRNPlugin) {
  plugin.track(async (rp) => {
    await loadIncrementalRemCache(rp);
  });

  // Track queue state and current rem to detect when powerup is removed
  let intervalId: NodeJS.Timeout | null = null;
  let lastCheckedRemId: string | null = null;
  let pollCount = 0;
  const MAX_POLLS_PER_REM = 60; // 60 polls * 500ms = 30 seconds max per item

  plugin.track(async (rp) => {
    const isQueueActive = await rp.storage.getSession<boolean>(incrementalQueueActiveKey);
    const currentRemId = await rp.storage.getSession<string>(currentIncRemKey);

    // Clear existing interval if any
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }

    // Only start polling if queue is active and we have a current rem
    if (isQueueActive && currentRemId) {
      // Reset counters when rem changes
      if (currentRemId !== lastCheckedRemId) {
        lastCheckedRemId = currentRemId;
        pollCount = 0;
      }

      // Start polling for this rem
      intervalId = setInterval(async () => {
        try {
          pollCount++;

          // Stop polling after 30 seconds for the same rem
          if (pollCount > MAX_POLLS_PER_REM) {
            if (intervalId) {
              clearInterval(intervalId);
              intervalId = null;
            }
            return;
          }

          const rem = await plugin.rem.findOne(currentRemId);
          if (!rem) {
            // Rem was deleted while in the queue -> skip it and move on.
            await plugin.queue.removeCurrentCardFromQueue(true);
            if (intervalId) {
              clearInterval(intervalId);
              intervalId = null;
            }
            return;
          }

          const hasPowerup = await rem.hasPowerup(powerupCode);

          if (!hasPowerup) {
            await plugin.queue.removeCurrentCardFromQueue(true);
            if (intervalId) {
              clearInterval(intervalId);
              intervalId = null;
            }
          }
        } catch (error) {
          // Silently handle errors
        }
      }, 500);
    } else {
      // Queue not active, reset state
      lastCheckedRemId = null;
      pollCount = 0;
    }
  });
}
