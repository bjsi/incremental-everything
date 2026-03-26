import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { loadIncrementalRemCache } from '../lib/incremental_rem/cache';
import { incrementalQueueActiveKey, currentIncRemKey, powerupCode, pendingPrioritySaveKey } from '../lib/consts';

export function registerIncrementalRemTracker(plugin: ReactRNPlugin) {
  plugin.track(async (rp) => {
    // Suppress caching operations while a batch tool is aggressively writing
    const isBatchActive = await rp.storage.getSession<boolean>('batch_priority_active');
    if (isBatchActive) return;

    console.log('[Tracker] IncRem cache load triggered by plugin.track()');
    await loadIncrementalRemCache(rp as any);
    console.log('[Tracker] IncRem cache load completed.');
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
            // NOTE: Do NOT call removeCurrentCardFromQueue here.
            // QueueComponent's hasIncrementalPowerup hook in queue.tsx now
            // handles queue advancement reactively. Calling it here too
            // causes a double popCard that skips the next flashcard.
            console.log('[Tracker] Powerup gone for', currentRemId, '— letting QueueComponent handle advancement');
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

  // Background inheritance cascade watcher
  // The batch_priority popup can't run long tasks because closing the popup kills them.
  // Instead, it writes 'pendingInheritanceCascade' to session storage, and THIS tracker
  // (running in the persistent index widget) picks it up and runs the cascade.
  let cascadeRunning = false;
  plugin.track(async (rp) => {
    const pendingRemId = await rp.storage.getSession<string>('pendingInheritanceCascade');
    if (!pendingRemId || cascadeRunning) return;

    cascadeRunning = true;
    // Clear the pending flag immediately so we don't re-trigger on the next track() tick
    await plugin.storage.setSession('pendingInheritanceCascade', null);
    // Suppress GlobalRemChanged listener for the duration of the cascade.
    // Without this, every setCardPriority write fires GlobalRemChanged → cache reload (thousands of times).
    await plugin.storage.setSession('batch_priority_active', true);

    console.log('[Tracker] Background inheritance cascade started for remId:', pendingRemId);
    try {
      const { recalculateTreeInheritance } = await import('../lib/card_priority');
      const { flushCacheUpdatesNow } = await import('../lib/card_priority/cache');
      const rem = await plugin.rem.findOne(pendingRemId);
      if (rem) {
        const t = performance.now();
        await recalculateTreeInheritance(plugin as any, rem);
        await flushCacheUpdatesNow(plugin as any);
        console.log(`[Tracker] Background inheritance cascade complete in ${Math.round(performance.now() - t)}ms`);
      }
    } catch (err) {
      console.error('[Tracker] Background inheritance cascade failed:', err);
    } finally {
      cascadeRunning = false;
      await plugin.storage.setSession('batch_priority_active', false);
    }
  });

  // Pending priority save watcher
  // priority_light.tsx writes a job here before closing, so that DB writes survive popup teardown.
  // This watcher runs in the persistent index widget, sets batch_priority_active to suppress
  // GlobalRemChanged during writes, then triggers the inheritance cascade if needed.
  let prioritySaveRunning = false;
  plugin.track(async (rp) => {
    const job = await rp.storage.getSession<{
      remId: string;
      incPriority: number | null;
      cardPriority: number | null;
      cardSource: string;
      needsAddPowerup: boolean;
      triggerCascade: boolean;
    }>(pendingPrioritySaveKey);

    if (!job || prioritySaveRunning) return;

    prioritySaveRunning = true;
    // Clear the job immediately so we don't re-trigger
    await plugin.storage.setSession(pendingPrioritySaveKey, null);
    // Suppress GlobalRemChanged for the duration of the writes
    await plugin.storage.setSession('batch_priority_active', true);

    console.log('[Tracker] pendingPrioritySave picked up for remId:', job.remId);
    try {
      const rem = await plugin.rem.findOne(job.remId);
      if (!rem) {
        console.warn('[Tracker] pendingPrioritySave: rem not found', job.remId);
        return;
      }

      // 1. IncRem priority write
      if (job.incPriority !== null) {
        await rem.setPowerupProperty(powerupCode, 'priority', [job.incPriority.toString()]);
        const { updateIncrementalRemCache } = await import('../lib/incremental_rem/cache');
        const { getIncrementalRemFromRem } = await import('../lib/incremental_rem');
        const updatedIncRem = await getIncrementalRemFromRem(plugin as any, rem);
        if (updatedIncRem) await updateIncrementalRemCache(plugin as any, updatedIncRem);
        console.log(`[Tracker] IncRem priority written: ${job.incPriority}`);
      }

      // 2. Card priority write (addPowerup first if this is a first-time assignment)
      if (job.cardPriority !== null) {
        if (job.needsAddPowerup) {
          await rem.addPowerup('cardPriority');
        }
        const { setCardPriority } = await import('../lib/card_priority');
        await setCardPriority(plugin as any, rem, job.cardPriority, job.cardSource as any, true);
        const { updateCardPriorityCache, flushCacheUpdatesNow } = await import('../lib/card_priority/cache');
        updateCardPriorityCache(plugin as any, rem._id, true, {
          remId: rem._id,
          priority: job.cardPriority,
          source: job.cardSource,
        } as any);
        await flushCacheUpdatesNow(plugin as any);
        console.log(`[Tracker] Card priority written: ${job.cardPriority}`);
      }

      // 3. Trigger inheritance cascade if requested (handled by existing cascade watcher)
      if (job.triggerCascade) {
        const { shouldUseLightMode } = await import('../lib/mobileUtils');
        const isLight = await shouldUseLightMode(plugin as any);
        if (!isLight) {
          // cascade watcher will pick this up after batch_priority_active is cleared
          await plugin.storage.setSession('pendingInheritanceCascade', job.remId);
        }
      }

      console.log('[Tracker] pendingPrioritySave complete for remId:', job.remId);
    } catch (err) {
      console.error('[Tracker] pendingPrioritySave failed:', err);
    } finally {
      prioritySaveRunning = false;
      await plugin.storage.setSession('batch_priority_active', false);
    }
  });
}
