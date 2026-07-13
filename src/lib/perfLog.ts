// Lightweight perf instrumentation for the "Create IncRem → priority popup" path.
// All logs are prefixed with ⏱️ so they can be grepped/removed easily once the
// bottleneck is identified. Delete this file (and its imports) afterwards.

/**
 * Intra-widget phase timer. Uses performance.now() for sub-millisecond deltas.
 * Only valid within a single iframe/widget — do NOT compare marks across widgets
 * (use the Date.now()-based helpers below for cross-iframe gaps).
 */
export class PerfTimer {
  private start: number;
  private last: number;

  constructor(private label: string) {
    this.start = performance.now();
    this.last = this.start;
  }

  /** Log the time since the previous mark (and cumulative total). */
  mark(phase: string): void {
    const now = performance.now();
    // eslint-disable-next-line no-console
    console.log(
      `⏱️ [${this.label}] ${phase}: ${(now - this.last).toFixed(1)}ms  (Σ ${(now - this.start).toFixed(1)}ms)`
    );
    this.last = now;
  }

  /** Log the full elapsed time under a closing label. */
  total(phase: string): void {
    const now = performance.now();
    // eslint-disable-next-line no-console
    console.log(`⏱️ [${this.label}] ${phase} — TOTAL ${(now - this.start).toFixed(1)}ms`);
  }
}

// Session key used to stash a wall-clock timestamp when the priority popup is
// requested, so the priority widget (a different iframe) can measure how long it
// took from request → mount → data-resolved.
export const PRIORITY_POPUP_REQUESTED_AT_KEY = 'perf_priorityPopupRequestedAt';
