/**
 * The Mastery Drill cooling rule, pure so it can be tested without the SDK.
 * Settings and storage live in mastery_drill_status.ts.
 */

/**
 * An entry in the synced `finalDrillIds` list. The bare-string form is the
 * legacy shape, written before the list carried its knowledge base: it belongs
 * to the primary KB and has no age, so it is always considered ready.
 */
export type FinalDrillEntry =
  | string
  | {
      cardId: string;
      kbId?: string;
      addedAt?: number;
      /**
       * Set only for a Hard rating: the interval that rating gave the card
       * (its next due date minus the rating). Stored rather than a release
       * time so a change to the Hard settings applies to cards already waiting.
       */
      intervalMs?: number;
    };

/**
 * How long a drill card waits after the rating that put it there.
 *
 * Again is a lapse: the drill is a relearning step, so the card comes back after
 * the Minimum Delay while the failure is fresh. Hard is a pass the scheduler
 * already rewarded, maybe with a year. Drilling it three hours later only tests
 * the review you just did; the useful check is whether it holds once it has left
 * working memory. So a Hard card waits a share of its new interval, between the
 * Minimum Delay and the Hard maximum — the Priority Queue cooling rule, in days
 * instead of minutes.
 */
export interface DrillCooling {
  minDelayMs: number;
  /** 0..1 */
  hardShare: number;
  hardMaxMs: number;
}

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

export function toCooling(minDelayMinutes: unknown, hardPercent: unknown, hardMaxDays: unknown): DrillCooling {
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  return {
    minDelayMs: num(minDelayMinutes) * MINUTE_MS,
    hardShare: Math.min(1, num(hardPercent) / 100),
    hardMaxMs: num(hardMaxDays) * DAY_MS,
  };
}

/** The wait for this entry. Legacy entries (no date) and Again ratings get the Minimum Delay. */
export function drillCoolingMs(item: FinalDrillEntry, c: DrillCooling): number {
  if (typeof item === 'string' || !item.intervalMs) return c.minDelayMs;
  return Math.max(c.minDelayMs, Math.min(c.hardShare * item.intervalMs, c.hardMaxMs));
}

/** When the entry may be drilled; 0 for one with no date, which is always ready. */
export function drillReadyAt(item: FinalDrillEntry, c: DrillCooling): number {
  const addedAt = typeof item === 'string' ? undefined : item.addedAt;
  return addedAt ? addedAt + drillCoolingMs(item, c) : 0;
}

export const isDrillEntryCooling = (item: FinalDrillEntry, c: DrillCooling, now: number) =>
  drillReadyAt(item, c) > now;

/** Whether a card just rated Again (or Hard) may come straight back into the same drill session. */
export function returnsAtOnce(isHard: boolean, c: DrillCooling): boolean {
  return c.minDelayMs <= 0 && (!isHard || c.hardShare <= 0);
}

/** A wait as "40 min", "5 h" or "3 days". */
export function formatDrillWait(ms: number): string {
  if (ms < 90 * MINUTE_MS) return `${Math.max(1, Math.ceil(ms / MINUTE_MS))} min`;
  if (ms < 36 * 60 * MINUTE_MS) return `${Math.round(ms / (60 * MINUTE_MS))} h`;
  const days = Math.round(ms / DAY_MS);
  return `${days} day${days === 1 ? '' : 's'}`;
}
