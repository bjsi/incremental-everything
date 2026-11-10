import { RNPlugin } from '@remnote/plugin-sdk';

/* Stall diagnostics: why do all the plugin's widgets sometimes stop responding for minutes?

   Two things can freeze every widget at once, and the console has to tell them apart:

   1. Our main thread is blocked. The plugin's iframes are same-site, so Chromium runs
      them in one renderer process on one main thread: a long synchronous task in any
      of them (the index or a widget) freezes them all, and new widgets cannot start.
   2. The plugin↔RemNote bridge is saturated. Every SDK call is a postMessage round
      trip that RemNote answers in turn; a flood of calls (e.g. one ancestor walk per
      badge) makes every widget wait for its first answer, so they render nothing.

   What this module does, in every frame that imports it (index + widgets):
   - Wraps RNPlugin.prototype._call, the one function every SDK call goes through,
     to count calls per method and keep the in-flight ones. It must be installed
     before the plugin object is constructed, because the SDK's namespaces bind
     `_call` in the constructor: so it runs on import, and the widgets import it
     through HoverTipLayer (or directly), the index at the top of index.tsx.
   - Watches the frame's own long main-thread tasks (PerformanceObserver 'longtask').
   - In a widget frame, reports its own slow calls and long tasks on one
     "[StallDiag] widget …" line, at most once a minute. Plugin iframes are sandboxed
     without allow-same-origin, so frames cannot read each other's counters: each
     one has to speak for itself.

   And in the index only (startStallMonitor):
   - A 500 ms timer whose lateness measures main-thread blocks (skipped while the
     window is hidden, when Chromium throttles timers anyway).
   - A cheap bridge probe (a session read) every 5 s. An answer slower than 3 s opens
     a stall episode: a start report, a progress line every 20 s, an end summary.
   - A ring of the index's recent console lines, so a report says which job was
     running (the jobs already log when they are picked up and complete).

   Everything is silent until something is slow. */

const SLOW_CALL_MS = 3000;
const WIDGET_REPORT_EVERY_MS = 60_000;
const LONG_TASK_REPORT_MS = 1000;
const RATE_WINDOW_S = 10;

const TICK_MS = 500;
const MAIN_BLOCK_MS = 2000;
const PROBE_EVERY_MS = 5000;
const BRIDGE_SLOW_MS = 3000;
const BRIDGE_OK_MS = 1000;
const STALL_QUIET_MS = 5000;
const PROGRESS_EVERY_MS = 20_000;
const LOG_RING_SIZE = 40;

type InFlightCall = { method: string; startedAt: number };
type Bucket = { sec: number; total: number; byMethod: Map<string, number> };
type SlowCall = { method: string; ms: number; endedAt: number };
type LongTask = { at: number; ms: number; who: string };
type LogLine = { at: number; level: string; text: string };

const frameName: string = (() => {
  try {
    return new URLSearchParams(window.location.search).get('widgetName') || 'unknown';
  } catch {
    return 'unknown';
  }
})();
const isIndexFrame = frameName === 'index';

let widgetInstanceId: number | undefined;
let nextCallId = 1;
const inFlight = new Map<number, InFlightCall>();
const buckets: Bucket[] = [];
const slowCalls: SlowCall[] = [];
const longTasks: LongTask[] = [];

const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const fmtTime = (at: number) => new Date(at).toLocaleTimeString();

function pushCapped<T>(list: T[], item: T, cap: number) {
  list.push(item);
  if (list.length > cap) list.splice(0, list.length - cap);
}

function topEntries(counts: Map<string, number>, n: number): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

// ---------------------------------------------------------------- bridge calls

function countCall(method: string, now: number) {
  const sec = Math.floor(now / 1000);
  let bucket = buckets[buckets.length - 1];
  if (!bucket || bucket.sec !== sec) {
    bucket = { sec, total: 0, byMethod: new Map() };
    buckets.push(bucket);
    while (buckets.length > 0 && buckets[0].sec <= sec - RATE_WINDOW_S) buckets.shift();
  }
  bucket.total++;
  bucket.byMethod.set(method, (bucket.byMethod.get(method) ?? 0) + 1);
}

function recentCallRate(now: number): { total: number; byMethod: Map<string, number> } {
  const oldest = Math.floor(now / 1000) - RATE_WINDOW_S;
  const byMethod = new Map<string, number>();
  let total = 0;
  for (const b of buckets) {
    if (b.sec <= oldest) continue;
    total += b.total;
    b.byMethod.forEach((v, k) => byMethod.set(k, (byMethod.get(k) ?? 0) + v));
  }
  return { total, byMethod };
}

function describeInFlight(now: number): string {
  if (inFlight.size === 0) return 'none in flight';
  const byMethod = new Map<string, number>();
  let oldest: InFlightCall | undefined;
  inFlight.forEach((call) => {
    byMethod.set(call.method, (byMethod.get(call.method) ?? 0) + 1);
    if (!oldest || call.startedAt < oldest.startedAt) oldest = call;
  });
  return (
    `${inFlight.size} in flight (oldest ${fmtS(now - oldest!.startedAt)} ${oldest!.method}; ` +
    `${topEntries(byMethod, 4)})`
  );
}

function describeCallRate(now: number): string {
  const rate = recentCallRate(now);
  if (rate.total === 0) return `no calls sent in the last ${RATE_WINDOW_S}s`;
  return `${rate.total} sent in the last ${RATE_WINDOW_S}s (${topEntries(rate.byMethod, 4)})`;
}

let installed = false;

function installBridgeTracking() {
  if (installed) return;
  installed = true;
  const proto = (RNPlugin as any)?.prototype;
  const original = proto?._call;
  if (typeof original !== 'function') {
    console.warn('[StallDiag] The SDK has no RNPlugin._call to time; bridge tracking is off in', frameName);
    return;
  }
  proto._call = function (this: any, methodName: string, args: unknown, namespace?: string | string[]) {
    const method =
      typeof namespace === 'string'
        ? `${namespace}.${methodName}`
        : Array.isArray(namespace)
          ? [...namespace, methodName].join('.')
          : methodName;
    const startedAt = Date.now();
    const id = nextCallId++;
    inFlight.set(id, { method, startedAt });
    countCall(method, startedAt);
    if (widgetInstanceId === undefined && this?.widgetInstanceId != null) widgetInstanceId = this.widgetInstanceId;

    const result: Promise<unknown> = original.call(this, methodName, args, namespace);
    const settle = () => {
      inFlight.delete(id);
      const ms = Date.now() - startedAt;
      if (ms >= SLOW_CALL_MS) noteSlowCall(method, ms);
    };
    result.then(settle, settle);
    return result;
  };
}

// ---------------------------------------------------------------- long tasks

function widgetNameFromSrc(src: string | undefined): string | undefined {
  if (!src) return undefined;
  try {
    return new URL(src, window.location.href).searchParams.get('widgetName') ?? undefined;
  } catch {
    return undefined;
  }
}

function installLongTaskObserver() {
  try {
    if (typeof PerformanceObserver === 'undefined') return;
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const own = entry.name === 'self';
        // A widget only speaks for itself; the index also records what it is told
        // about other frames, whatever attribution Chromium gives them.
        if (!own && !isIndexFrame) continue;
        const attribution = (entry as any).attribution?.[0];
        const other = widgetNameFromSrc(attribution?.containerSrc) ?? attribution?.containerName;
        const who = own ? frameName : `${entry.name}${other ? ` ${other}` : ''}`;
        const ms = Math.round(entry.duration);
        pushCapped(longTasks, { at: Math.round(performance.timeOrigin + entry.startTime), ms, who }, 100);
        if (own && !isIndexFrame && ms >= LONG_TASK_REPORT_MS) maybeReportWidget('long task');
      }
    });
    observer.observe({ type: 'longtask', buffered: false } as PerformanceObserverInit);
  } catch {
    // Not available: the index's timer still measures blocks.
  }
}

function describeLongTasks(since: number, minMs = 200): string {
  const tasks = longTasks.filter((t) => t.at >= since && t.ms >= minMs);
  if (tasks.length === 0) return 'none';
  const total = tasks.reduce((s, t) => s + t.ms, 0);
  const longest = [...tasks]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6)
    .map((t) => `${fmtS(t.ms)} ${t.who} at ${fmtTime(t.at)}`)
    .join('; ');
  return `${tasks.length} over ${minMs}ms, ${fmtS(total)} in all — longest: ${longest}`;
}

// ---------------------------------------------------------------- widget self-reports

let lastWidgetReportAt = 0;

function noteSlowCall(method: string, ms: number) {
  pushCapped(slowCalls, { method, ms, endedAt: Date.now() }, 200);
  if (!isIndexFrame) maybeReportWidget('slow call');
  else monitor?.noteIndexSlowCall();
}

function maybeReportWidget(trigger: string) {
  const now = Date.now();
  if (now - lastWidgetReportAt < WIDGET_REPORT_EVERY_MS) return;
  const since = lastWidgetReportAt || now - WIDGET_REPORT_EVERY_MS;
  lastWidgetReportAt = now;

  const recentSlow = slowCalls.filter((c) => c.endedAt >= since);
  const slowest = recentSlow.reduce<SlowCall | undefined>((a, c) => (!a || c.ms > a.ms ? c : a), undefined);
  const slowPart =
    recentSlow.length > 0
      ? `${recentSlow.length} RemNote calls took over ${fmtS(SLOW_CALL_MS)} (slowest ${fmtS(slowest!.ms)} ${slowest!.method})`
      : 'no slow RemNote calls';
  console.warn(
    `[StallDiag] widget "${frameName}"${widgetInstanceId !== undefined ? ` #${widgetInstanceId}` : ''} (${trigger}) — ` +
      `${slowPart}; ${describeInFlight(now)}; ${describeCallRate(now)}; ` +
      `own long tasks: ${describeLongTasks(since)}`
  );
}

// ---------------------------------------------------------------- index monitor

const logRing: LogLine[] = [];

function summarizeArg(arg: unknown): string {
  if (typeof arg === 'string') return arg.length > 160 ? `${arg.slice(0, 160)}…` : arg;
  if (typeof arg === 'number' || typeof arg === 'boolean' || arg == null) return String(arg);
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (Array.isArray(arg)) return `[array(${arg.length})]`;
  return '{…}';
}

function installConsoleRing() {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        const text = args.map(summarizeArg).join(' ');
        if (!text.startsWith('[StallDiag]')) pushCapped(logRing, { at: Date.now(), level, text }, LOG_RING_SIZE);
      } catch {
        // never let the ring break logging
      }
      original(...args);
    };
  }
}

function describeRecentLogs(now: number, count = 12): string {
  const lines = logRing.slice(-count);
  if (lines.length === 0) return '  (no plugin log lines yet)';
  return lines
    .map((l) => `  -${fmtS(now - l.at)} ${l.level === 'log' ? '' : `[${l.level}] `}${l.text}`)
    .join('\n');
}

type Episode = {
  startedAt: number;
  lastBadAt: number;
  lastProgressAt: number;
  maxProbeMs: number;
  mainBlocks: number[];
  callsAtStart: number;
};

class StallMonitor {
  private lastTickAt = Date.now();
  private wasVisible = document.visibilityState === 'visible';
  private probeStartedAt: number | null = null;
  private lastProbeMs = 0;
  private lastProbeAt = 0;
  private episode: Episode | null = null;

  constructor(private readonly plugin: RNPlugin) {}

  start() {
    console.log(
      `[StallDiag] watching for stalls since ${new Date().toLocaleString()} — ` +
        `main thread blocks over ${fmtS(MAIN_BLOCK_MS)}, RemNote bridge answers slower than ${fmtS(BRIDGE_SLOW_MS)}.`
    );
    setInterval(() => this.tick(), TICK_MS);
  }

  noteIndexSlowCall() {
    if (this.episode) this.episode.lastBadAt = Date.now();
  }

  private tick() {
    const now = Date.now();
    const late = now - this.lastTickAt - TICK_MS;
    this.lastTickAt = now;
    const visible = document.visibilityState === 'visible';
    const wasVisible = this.wasVisible;
    this.wasVisible = visible;

    if (visible && wasVisible && late > MAIN_BLOCK_MS) this.reportMainBlock(late, now);

    const probeAge = this.probeStartedAt !== null ? now - this.probeStartedAt : 0;
    if (probeAge > BRIDGE_SLOW_MS) {
      this.markBad(now, this.probeStartedAt!, `the bridge probe has waited ${fmtS(probeAge)} for RemNote`);
    }

    if (this.probeStartedAt === null && now - this.lastProbeAt >= PROBE_EVERY_MS) void this.probe();

    const ep = this.episode;
    if (!ep) return;
    if (
      this.probeStartedAt === null &&
      this.lastProbeMs < BRIDGE_OK_MS &&
      this.lastProbeAt > ep.lastBadAt &&
      now - ep.lastBadAt >= STALL_QUIET_MS
    ) {
      this.endEpisode(now);
    } else if (now - ep.lastProgressAt >= PROGRESS_EVERY_MS) {
      ep.lastProgressAt = now;
      console.warn(
        `[StallDiag] … still stalled after ${fmtS(now - ep.startedAt)}: ` +
          `${probeAge > 0 ? `probe waiting ${fmtS(probeAge)}` : `last probe ${fmtS(this.lastProbeMs)}`}; ` +
          `index ${describeInFlight(now)}; ${describeCallRate(now)}; ` +
          `main-thread blocks so far: ${ep.mainBlocks.length}.\n` +
          `Recent plugin log:\n${describeRecentLogs(now, 6)}`
      );
    }
  }

  private async probe() {
    const startedAt = Date.now();
    this.probeStartedAt = startedAt;
    try {
      await this.plugin.storage.getSession('incremental_everything_stall_probe');
    } catch {
      // an error still answers the round trip
    }
    const now = Date.now();
    this.lastProbeMs = now - startedAt;
    this.lastProbeAt = now;
    this.probeStartedAt = null;
    if (this.episode) this.episode.maxProbeMs = Math.max(this.episode.maxProbeMs, this.lastProbeMs);
    if (this.lastProbeMs > BRIDGE_SLOW_MS) this.markBad(now, startedAt, `a bridge probe took ${fmtS(this.lastProbeMs)}`);
  }

  private markBad(now: number, since: number, reason: string) {
    if (this.episode) {
      this.episode.lastBadAt = now;
      return;
    }
    this.episode = {
      startedAt: since,
      lastBadAt: now,
      lastProgressAt: now,
      maxProbeMs: 0,
      mainBlocks: [],
      callsAtStart: nextCallId,
    };
    console.warn(
      `[StallDiag] ⚠️ STALL started around ${fmtTime(this.episode.startedAt)} — ${reason}.\n` +
        this.snapshot(now, since - 5000) +
        `\nWidgets report their own slow calls on "[StallDiag] widget …" lines.`
    );
  }

  private reportMainBlock(ms: number, now: number) {
    if (this.episode) {
      this.episode.mainBlocks.push(ms);
      this.episode.lastBadAt = now;
    }
    console.warn(
      `[StallDiag] main thread blocked for ${fmtS(ms)} (ended ${fmtTime(now)}) — every widget of the plugin was frozen meanwhile.\n` +
        `Long tasks: ${describeLongTasks(now - ms - 2000)}\n` +
        `Recent plugin log:\n${describeRecentLogs(now, 8)}`
    );
  }

  private endEpisode(now: number) {
    const ep = this.episode!;
    this.episode = null;
    const blocks = ep.mainBlocks;
    const blockPart =
      blocks.length > 0
        ? `main thread blocked ${blocks.length} time(s), longest ${fmtS(Math.max(...blocks))}, ${fmtS(blocks.reduce((a, b) => a + b, 0))} in all`
        : 'main thread never blocked over 2s (so the wait was on the bridge / RemNote side)';
    console.warn(
      `[StallDiag] ✅ stall ended at ${fmtTime(now)} after ${fmtS(now - ep.startedAt)} — ` +
        `longest bridge probe ${fmtS(ep.maxProbeMs)}; ${blockPart}; ` +
        `the index sent ${nextCallId - ep.callsAtStart} calls during it. ` +
        `Long tasks during it: ${describeLongTasks(ep.startedAt)}`
    );
  }

  snapshot(now = Date.now(), longTasksSince = now - 30_000): string {
    return (
      `  index calls: ${describeInFlight(now)}; ${describeCallRate(now)}\n` +
      `  last probe: ${this.lastProbeAt ? `${fmtS(this.lastProbeMs)} at ${fmtTime(this.lastProbeAt)}` : 'none yet'}\n` +
      `  long tasks: ${describeLongTasks(longTasksSince)}\n` +
      `  recent plugin log:\n${describeRecentLogs(now)}`
    );
  }
}

let monitor: StallMonitor | null = null;

/** Index only: start the main-thread timer and the bridge probe. */
export function startStallMonitor(plugin: RNPlugin) {
  if (monitor || !isIndexFrame) return;
  monitor = new StallMonitor(plugin);
  monitor.start();
  // For a manual look from DevTools (select the index iframe's context).
  (window as any).__ieStallDiag = { snapshot: () => monitor?.snapshot() };
}

// Runs on import, before the SDK constructs the plugin object.
installBridgeTracking();
installLongTaskObserver();
if (isIndexFrame) installConsoleRing();
