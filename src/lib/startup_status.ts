import { RNPlugin } from '@remnote/plugin-sdk';
import { startupTasksStatusKey } from './consts';

/**
 * Whether the work RemNote kicks off at activation has finished.
 *
 * Every one of these runs in the background and reports only to the console,
 * spread over a minute or more on a large knowledge base — so "is the plugin
 * ready yet?" used to mean scrolling the console for six different lines. The
 * index widget records each task here as it settles, and the hub's ▶ button
 * starts pulsing once none is left running.
 *
 * Kept free of heavy imports on purpose: the hub panel reads it for the whole
 * session, and the orchestration hands it promises rather than having it import
 * the caches itself.
 */

export type StartupTaskId =
  | 'cardCache'
  | 'pretagging'
  | 'incRemCache'
  | 'coolingScan'
  | 'hiddenSlotCheck'
  | 'priorityBands'
  | 'priorityQueueRefresh';

/** `skipped` = does not apply here (Light Mode, flashcard prioritisation or auto-refresh off). */
export type StartupTaskState = 'running' | 'done' | 'skipped' | 'failed';

export interface StartupTasksStatus {
  startedAt: number;
  /** Set once no task is running, whatever the outcome. */
  completedAt: number | null;
  tasks: Record<StartupTaskId, StartupTaskState>;
}

export const STARTUP_TASK_ORDER: StartupTaskId[] = [
  'cardCache',
  'incRemCache',
  'pretagging',
  'coolingScan',
  'hiddenSlotCheck',
  'priorityBands',
  'priorityQueueRefresh',
];

export const STARTUP_TASK_LABELS: Record<StartupTaskId, string> = {
  cardCache: 'Card priority cache',
  incRemCache: 'IncRem cache',
  pretagging: 'Deferred pre-tagging',
  coolingScan: 'Cooling scan',
  hiddenSlotCheck: 'CardPriority hidden-slot check',
  priorityBands: 'Priority bands',
  priorityQueueRefresh: 'Priority Queue refresh',
};

/** Finished, and nothing failed. */
export function startupTasksSucceeded(status: StartupTasksStatus | null | undefined): boolean {
  return (
    !!status?.completedAt &&
    STARTUP_TASK_ORDER.every((id) => status.tasks[id] === 'done' || status.tasks[id] === 'skipped')
  );
}

/** One line for a tooltip. */
export function describeStartupTasks(status: StartupTasksStatus | null | undefined): string {
  if (!status) return 'Startup status not available yet.';
  const labelled = (state: StartupTaskState) =>
    STARTUP_TASK_ORDER.filter((id) => status.tasks[id] === state).map((id) => STARTUP_TASK_LABELS[id]);

  const running = labelled('running');
  if (running.length > 0) return `⏳ Still starting up: ${running.join(', ')}.`;

  const failed = labelled('failed');
  if (failed.length > 0) return `⚠️ Startup finished with problems: ${failed.join(', ')} — see the console.`;

  const seconds = Math.round(((status.completedAt ?? Date.now()) - status.startedAt) / 1000);
  return `✅ Startup finished in ${seconds}s — the plugin is fully ready.`;
}

/**
 * The index widget's record of the startup tasks. One writer, one realm: the
 * whole snapshot is written on every change, so concurrent settles cannot lose
 * each other's updates the way read-modify-write on the session key would.
 */
export class StartupTaskBoard {
  private readonly status: StartupTasksStatus;

  constructor(private readonly plugin: RNPlugin) {
    this.status = {
      startedAt: Date.now(),
      completedAt: null,
      tasks: Object.fromEntries(STARTUP_TASK_ORDER.map((id) => [id, 'running'])) as Record<
        StartupTaskId,
        StartupTaskState
      >,
    };
    void this.publish();
  }

  get(id: StartupTaskId): StartupTaskState {
    return this.status.tasks[id];
  }

  /** A task settles once; later calls are ignored. */
  settle(id: StartupTaskId, state: Exclude<StartupTaskState, 'running'>): void {
    if (this.status.tasks[id] !== 'running') return;
    this.status.tasks[id] = state;

    if (STARTUP_TASK_ORDER.every((t) => this.status.tasks[t] !== 'running')) {
      this.status.completedAt = Date.now();
      console.log(`[Startup] ${describeStartupTasks(this.status)}`);
    }
    void this.publish();
  }

  /**
   * Settles `id` from a promise: `false` or a rejection is a failure, anything
   * else is done. Resolves once settled, and never rejects.
   */
  track(id: StartupTaskId, work: Promise<unknown>): Promise<void> {
    return work.then(
      (result) => this.settle(id, result === false ? 'failed' : 'done'),
      () => this.settle(id, 'failed')
    );
  }

  private async publish(): Promise<void> {
    try {
      await this.plugin.storage.setSession(startupTasksStatusKey, {
        ...this.status,
        tasks: { ...this.status.tasks },
      });
    } catch (e) {
      console.warn('[Startup] could not publish the startup status', e);
    }
  }
}

/** Resolves `true` when the session flag turns truthy, `false` at the deadline. */
export function waitForSessionFlag(
  plugin: RNPlugin,
  key: string,
  opts: { timeoutMs: number; pollMs?: number }
): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 2000;
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        if (await plugin.storage.getSession<boolean>(key)) return resolve(true);
      } catch {
        /* keep polling */
      }
      if (Date.now() < deadline) setTimeout(tick, pollMs);
      else resolve(false);
    };
    void tick();
  });
}
