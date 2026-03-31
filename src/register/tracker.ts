import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { loadIncrementalRemCache } from '../lib/incremental_rem/cache';
import { incrementalQueueActiveKey, currentIncRemKey, powerupCode, pendingPrioritySaveKey, pendingCardPriorityRemovalKey, pendingPriorityDeltaQueueKey } from '../lib/consts';
import { withQueueMutex } from '../lib/mutex';

// Module-level flag to suppress IncRem cache reloads during batch writes.
// IMPORTANT: This is intentionally a plain JS variable, NOT session storage.
// plugin.track() only adds getSession/getSynced calls as reactive dependencies.
// A module-level variable is invisible to the reactive system — setting it true→false
// does NOT re-trigger plugin.track(), eliminating spurious IncRem cache reloads
// after every card priority save (which was the bug when using plugin_operation_active
// session storage for this check).
// Note: plugin_operation_active session storage is kept separately for events.ts
// GlobalRemChanged suppression (cross-iframe communication).
let incRemBatchActive = false;

export function registerIncrementalRemTracker(plugin: ReactRNPlugin) {
  plugin.track(async (rp) => {
    // Use module-level variable (non-reactive) — does NOT create a reactive dependency.
    // This watcher will only re-run when actual rem data changes, not when the flag changes.
    if (incRemBatchActive) return;

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

  // Background inheritance cascade watcher — with 5s debounce.
  // All cascade triggers write to 'pendingInheritanceCascade'. This watcher:
  //   1. Clears the key immediately (prevents re-triggering on the next track() tick).
  //   2. Adds the remId to a Set (all rems accumulate — deduplication is free via Set).
  //   3. Resets a 5s debounce timer. After 5s of quiet, cascades run for ALL collected rems.
  //   4. If a cascade is already running, the remId is queued for a follow-up pass.
  const CASCADE_DEBOUNCE_MS = 5000;
  let cascadeRunning = false;
  let cascadeDebounceTimer: NodeJS.Timeout | null = null;
  let pendingCascadeRemIds = new Set<string>();

  const runCascade = async (remId: string) => {
    cascadeRunning = true;
    incRemBatchActive = true;
    await plugin.storage.setSession('plugin_operation_active', true);
    console.log('[Tracker] Background inheritance cascade started for remId:', remId);
    try {
      const { recalculateTreeInheritance } = await import('../lib/card_priority');
      const { flushCacheUpdatesNow } = await import('../lib/card_priority/cache');
      const rem = await plugin.rem.findOne(remId);
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
      incRemBatchActive = false;
      await plugin.storage.setSession('plugin_operation_active', false);
      // If more remIds were queued while running, drain them now (no extra debounce wait).
      if (pendingCascadeRemIds.size > 0) {
        const queued = [...pendingCascadeRemIds];
        pendingCascadeRemIds.clear();
        console.log('[Tracker] Cascade queue: draining', queued.length, 'queued remId(s)');
        for (const next of queued) {
          await runCascade(next);
        }
      }
    }
  };

  plugin.track(async (rp) => {
    const pendingRemId = await rp.storage.getSession<string>('pendingInheritanceCascade');
    if (!pendingRemId) return;

    // Clear immediately to prevent re-trigger on the next track() tick
    await plugin.storage.setSession('pendingInheritanceCascade', null);

    if (cascadeRunning) {
      // Cascade already in progress — add to the queue for a follow-up pass
      pendingCascadeRemIds.add(pendingRemId);
      console.log('[Tracker] Cascade queued (cascade running) for remId:', pendingRemId);
      return;
    }

    // Debounce: accumulate remIds, reset the 5s timer.
    // Arm suppression flags immediately so GlobalRemChanged is suppressed for the
    // entire debounce window, not just while runCascade is executing.
    pendingCascadeRemIds.add(pendingRemId);
    const wasAlreadyArmed = cascadeDebounceTimer !== null;
    if (cascadeDebounceTimer) clearTimeout(cascadeDebounceTimer);
    if (!wasAlreadyArmed) {
      incRemBatchActive = true;
      await plugin.storage.setSession('plugin_operation_active', true);
      console.log('[Tracker] Cascade suppression flags armed (debounce window started)');
    }
    cascadeDebounceTimer = setTimeout(async () => {
      cascadeDebounceTimer = null;
      const remIds = [...pendingCascadeRemIds];
      pendingCascadeRemIds.clear();
      console.log(`[Tracker] Cascade debounce fired — running ${remIds.length} cascade(s)`);
      if (remIds.length === 0) {
        // Nothing to run — clear flags defensively.
        incRemBatchActive = false;
        await plugin.storage.setSession('plugin_operation_active', false);
        return;
      }
      for (const remId of remIds) {
        await runCascade(remId);
      }
      // runCascade's finally block clears flags after the last cascade completes.
    }, CASCADE_DEBOUNCE_MS);
    console.log(`[Tracker] Cascade debounce reset (${CASCADE_DEBOUNCE_MS}ms), pending: ${pendingCascadeRemIds.size} rem(s)`);
  });

  // Pending priority save watcher
  // priority_light.tsx writes a job here before closing, so that DB writes survive popup teardown.
  // This watcher runs in the persistent index widget, sets plugin_operation_active to suppress
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
    // Suppress GlobalRemChanged (cross-iframe) and IncRem cache reload (module-level).
    // incRemBatchActive is non-reactive: clearing it in finally does NOT re-trigger plugin.track().
    incRemBatchActive = true;
    await plugin.storage.setSession('plugin_operation_active', true);

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
          // Set pendingInheritanceCascade BEFORE clearing incRemBatchActive/plugin_operation_active,
          // so the cascade watcher can immediately re-set both flags when it fires.
          await plugin.storage.setSession('pendingInheritanceCascade', job.remId);
        }
      }

      console.log('[Tracker] pendingPrioritySave complete for remId:', job.remId);
    } catch (err) {
      console.error('[Tracker] pendingPrioritySave failed:', err);
    } finally {
      prioritySaveRunning = false;
      incRemBatchActive = false; // non-reactive clear — does NOT re-trigger plugin.track()
      await plugin.storage.setSession('plugin_operation_active', false);
    }
  });
  // Pending card-priority removal watcher.
  // priority.tsx writes the remId here before closing the popup (fire-and-forget).
  // This watcher performs the actual removePowerup + cache refresh in the
  // persistent index widget, safely wrapped in plugin_operation_active suppression.
  let cardPriorityRemovalRunning = false;
  plugin.track(async (rp) => {
    const remId = await rp.storage.getSession<string>(pendingCardPriorityRemovalKey);
    if (!remId || cardPriorityRemovalRunning) return;

    cardPriorityRemovalRunning = true;
    // Clear immediately so we don't re-trigger.
    await plugin.storage.setSession(pendingCardPriorityRemovalKey, null);
    incRemBatchActive = true;
    await plugin.storage.setSession('plugin_operation_active', true);

    console.log('[Tracker] pendingCardPriorityRemoval picked up for remId:', remId);
    try {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        console.warn('[Tracker] pendingCardPriorityRemoval: rem not found', remId);
        return;
      }
      await rem.removePowerup('cardPriority');
      // Patch the card-priority cache to evict the removed entry.
      const { updateCardPriorityCache } = await import('../lib/card_priority/cache');
      await updateCardPriorityCache(plugin as any, remId);
      // Signal card-priority display widgets to refresh.
      const { cardPriorityCacheRefreshKey } = await import('../lib/consts');
      await plugin.storage.setSession(cardPriorityCacheRefreshKey, Date.now());
      console.log('[Tracker] pendingCardPriorityRemoval complete for remId:', remId);
    } catch (err) {
      console.error('[Tracker] pendingCardPriorityRemoval failed:', err);
    } finally {
      cardPriorityRemovalRunning = false;
      incRemBatchActive = false;
      await plugin.storage.setSession('plugin_operation_active', false);
    }
  });
  // -----------------------------------------------------------------------
  // Delta-queue watcher for Quick Increase/Decrease Priority commands.
  //
  // Why a queue and not the single pendingPrioritySaveKey slot?
  // Each keypress fires handleQuickPriorityChange, which used to write an
  // *absolute* priority value to a single session-storage slot.  With rapid
  // presses the slot was overwritten before the tracker could read it,
  // so only the last keypress "won".
  //
  // Now each keypress atomically APPENDS a tiny {remId, incDelta, cardDelta}
  // entry to an array.  This watcher:
  //   1. Snapshots the entire queue and clears it in one atomic read+write
  //      using a shared mutex lock to prevent overwriting rapid keystrokes.
  //   2. Groups entries by remId and sums their deltas.
  //   3. Reads the *current live DB value* once per rem.
  //   4. Applies the net delta and performs a single DB write per rem.
  //
  // 3 rapid "decrease" presses → 3 entries with delta −10 each → net −30.
  // -----------------------------------------------------------------------
  let deltaQueueRunning = false;
  plugin.track(async (rp) => {
    // Reactive read JUST to wake up the tracker when the queue length changes
    const reactiveQueue = await rp.storage.getSession<Array<any>>(pendingPriorityDeltaQueueKey);
    if (!reactiveQueue || reactiveQueue.length === 0 || deltaQueueRunning) return;

    deltaQueueRunning = true;

    try {
      let snapshot: any[] = [];

      // Safely snapshot and clear inside the shared lock
      await withQueueMutex(async () => {
        // Non-reactive read inside the lock to get the absolute latest state
        snapshot = await plugin.storage.getSession<any[]>(pendingPriorityDeltaQueueKey) || [];
        if (snapshot.length > 0) {
          await plugin.storage.setSession(pendingPriorityDeltaQueueKey, null);
        }
      });

      // If another execution already cleared it, bail out
      if (snapshot.length === 0) {
        return;
      }

      incRemBatchActive = true;
      await plugin.storage.setSession('plugin_operation_active', true);

      console.log(`[Tracker] deltaQueue: draining ${snapshot.length} entry/entries`);

      // Group by remId and sum deltas.
      const byRem = new Map<string, {
        incDelta: number; cardDelta: number;
        hasIncPowerup: boolean; hasCards: boolean; hasCardPriorityPowerup: boolean;
      }>();
      for (const entry of snapshot) {
        const existing = byRem.get(entry.remId);
        if (existing) {
          existing.incDelta += entry.incDelta;
          existing.cardDelta += entry.cardDelta;
        } else {
          byRem.set(entry.remId, {
            incDelta: entry.incDelta,
            cardDelta: entry.cardDelta,
            hasIncPowerup: entry.hasIncPowerup,
            hasCards: entry.hasCards,
            hasCardPriorityPowerup: entry.hasCardPriorityPowerup,
          });
        }
      }

      const { setCardPriority } = await import('../lib/card_priority');
      const { getIncrementalRemFromRem } = await import('../lib/incremental_rem');
      const { updateIncrementalRemCache } = await import('../lib/incremental_rem/cache');
      const { updateCardPriorityCache, flushCacheUpdatesNow } = await import('../lib/card_priority/cache');
      const { shouldUseLightMode } = await import('../lib/mobileUtils');
      const isLight = await shouldUseLightMode(plugin as any);

      for (const [remId, agg] of byRem) {
        const rem = await plugin.rem.findOne(remId);
        if (!rem) { console.warn('[Tracker] deltaQueue: rem not found', remId); continue; }

        let didWrite = false;
        const messages: string[] = [];

        // --- IncRem priority ---
        if (agg.hasIncPowerup && agg.incDelta !== 0) {
          const incRemInfo = await getIncrementalRemFromRem(plugin as any, rem);
          if (incRemInfo) {
            const oldP = incRemInfo.priority;
            const newP = Math.max(0, Math.min(100, oldP + agg.incDelta));
            if (oldP !== newP) {
              await rem.setPowerupProperty(powerupCode, 'priority', [newP.toString()]);
              const updated = await getIncrementalRemFromRem(plugin as any, rem);
              if (updated) await updateIncrementalRemCache(plugin as any, updated);
              messages.push(`IncRem ${oldP} → ${newP}`);
              didWrite = true;
            }
          }
        }

        // --- Card priority ---
        if ((agg.hasCards || agg.hasCardPriorityPowerup) && agg.cardDelta !== 0) {
          const { getCardPriority } = await import('../lib/card_priority');
          const cardInfo = await getCardPriority(plugin as any, rem);
          const oldP = cardInfo?.priority ?? 50;
          const newP = Math.max(0, Math.min(100, oldP + agg.cardDelta));
          if (oldP !== newP) {
            if (!agg.hasCardPriorityPowerup) await rem.addPowerup('cardPriority');
            await setCardPriority(plugin as any, rem, newP, 'manual', true);
            updateCardPriorityCache(plugin as any, rem._id, true, {
              remId: rem._id, priority: newP, source: 'manual',
            } as any);
            await flushCacheUpdatesNow(plugin as any);
            messages.push(`Card ${oldP} → ${newP}`);
            didWrite = true;
          }
        }

        if (didWrite) {
          // Signal card-priority display widgets to refresh.
          const { cardPriorityCacheRefreshKey } = await import('../lib/consts');
          await plugin.storage.setSession(cardPriorityCacheRefreshKey, Date.now());

          // Trigger inheritance cascade (full mode only).
          if (!isLight) {
            await plugin.storage.setSession('pendingInheritanceCascade', remId);
          }

          // Global-context survivor so the queue event-guard lets this through.
          try {
            const manualRems = await plugin.storage.getSession<string[]>('manual_priority_pending_rems') || [];
            if (!manualRems.includes(remId)) {
              manualRems.push(remId);
              await plugin.storage.setSession('manual_priority_pending_rems', manualRems);
            }
          } catch (_) { }

          console.log(`[Tracker] deltaQueue applied for ${remId}: ${messages.join(', ')}`);
        }
      }
    } catch (err) {
      console.error('[Tracker] deltaQueue failed:', err);
    } finally {
      deltaQueueRunning = false;
      incRemBatchActive = false;
      await plugin.storage.setSession('plugin_operation_active', false);
    }
  });
}
