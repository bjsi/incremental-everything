/**
 * Pure scheduling maths for Incremental Rems — no SDK, no settings reads — so it
 * can be unit-tested and shared by the scheduler, the popups and the tracker.
 *
 * Two schedulers exist:
 *   - 'multiplier': next interval = the interval the item is on × its factor.
 *     Remembers an interval the user chose (Reschedule, the creation popup, a
 *     manual date edit), which is the whole point of it.
 *   - 'curve': the saturating curve. Depends only on the review count, so a
 *     Reschedule on a curve item stays a one-off postponement.
 *
 * Which one a rem uses is resolved in three layers, most specific first:
 * the rem's own Scheduler slot → the per-type setting → the Default Scheduler.
 */
import type { ActionItemType, IncrementalRep } from './incremental_rem/types';

export type SchedulerKind = 'multiplier' | 'curve';

/** What the per-rem Scheduler slot holds once parsed. `factor` absent = use the setting. */
export interface SchedulerOverride {
  kind: SchedulerKind;
  factor?: number;
}

/** A fully resolved scheduler: what Next will actually use. */
export interface SchedulerChoice {
  kind: SchedulerKind;
  /** Always present so a switch to 'multiplier' has a value to start from. */
  factor: number;
}

export type SchedulerSource = 'item' | 'type' | 'default';

export interface ResolvedScheduler extends SchedulerChoice {
  /** Which layer decided `kind`. */
  source: SchedulerSource;
}

export const MIN_FACTOR = 1;
export const MAX_FACTOR = 10;

/** Clamp to the allowed range and to two decimals; null for anything unusable. */
export function normalizeFactor(value: unknown): number | null {
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(n)) return null;
  const clamped = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, n));
  return Math.round(clamped * 100) / 100;
}

/** Slot text → override. Anything unrecognised reads as "no override". */
export function parseSchedulerOverride(raw: unknown): SchedulerOverride | null {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (text === 'curve') return { kind: 'curve' };
  if (text === 'mult') return { kind: 'multiplier' };
  if (text.startsWith('mult:')) {
    const factor = normalizeFactor(text.slice('mult:'.length));
    return factor === null ? { kind: 'multiplier' } : { kind: 'multiplier', factor };
  }
  return null;
}

export function serializeSchedulerOverride(override: SchedulerOverride): string {
  if (override.kind === 'curve') return 'curve';
  return override.factor === undefined ? 'mult' : `mult:${override.factor}`;
}

export type SchedulerTypeGroup = 'documents' | 'videos' | 'highlights' | 'rems';

/** Which per-type setting governs a rem of this action-item type. */
export function schedulerTypeGroup(type: ActionItemType | null | undefined): SchedulerTypeGroup {
  switch (type) {
    case 'pdf':
    case 'html':
      return 'documents';
    case 'youtube':
    case 'video':
      return 'videos';
    case 'pdf-highlight':
    case 'html-highlight':
    case 'youtube-highlight':
      return 'highlights';
    default:
      return 'rems';
  }
}

/**
 * The scheduler a rem gets from the settings alone — per-type setting first,
 * then the Default Scheduler. This is what "no override" means for that rem.
 */
export function resolveInheritedScheduler(args: {
  typeDefault: SchedulerKind | 'default' | null | undefined;
  defaultKind: SchedulerKind;
  defaultFactor: number;
}): ResolvedScheduler {
  const factor = normalizeFactor(args.defaultFactor) ?? 1.5;
  if (args.typeDefault === 'multiplier' || args.typeDefault === 'curve') {
    return { kind: args.typeDefault, factor, source: 'type' };
  }
  return { kind: args.defaultKind, factor, source: 'default' };
}

export function resolveScheduler(
  override: SchedulerOverride | null,
  inherited: ResolvedScheduler
): ResolvedScheduler {
  if (!override) return inherited;
  return {
    kind: override.kind,
    factor: override.factor ?? inherited.factor,
    source: 'item',
  };
}

/**
 * The override to store so a rem ends up on `choice` — or null when the settings
 * already give exactly that, in which case the slot is cleared and the rem keeps
 * following the settings (including later changes to them).
 */
export function overrideForChoice(
  choice: SchedulerChoice,
  inherited: ResolvedScheduler
): SchedulerOverride | null {
  if (choice.kind === 'curve') {
    return inherited.kind === 'curve' ? null : { kind: 'curve' };
  }
  const factor = normalizeFactor(choice.factor) ?? inherited.factor;
  const ownFactor = factor !== inherited.factor;
  if (inherited.kind === 'multiplier' && !ownFactor) return null;
  return ownFactor ? { kind: 'multiplier', factor } : { kind: 'multiplier' };
}

/**
 * The Initial Interval for a new rem: its type's own value when one is set,
 * otherwise the general setting. The per-type value is free text so that it can
 * be left empty; anything that is not a whole number of days ≥ 0 counts as empty.
 */
export function resolveInitialInterval(typeValue: unknown, general: number): number {
  const text = typeof typeValue === 'string' ? typeValue.trim() : '';
  if (/^\d+$/.test(text)) return parseInt(text, 10);
  return Number.isFinite(general) && general >= 0 ? general : 0;
}

/** Saturating curve: `first` after review 1, approaching `max`; halfway at review 5. */
export function computeCurveInterval(reviewNumber: number, first: number, max: number): number {
  const k = 4;
  const n = Math.max(reviewNumber, 1);
  return Math.ceil(first + (max - first) * ((n - 1) / (n - 1 + k)));
}

/**
 * Multiplier scheduler: `base` × `factor`, rounded up to whole days.
 * A base under a day counts as one day, and a factor above 1 always moves the
 * interval by at least a day — otherwise 1 × 1.5 would be the only step a small
 * interval ever took, and a 0-day Initial Interval would never leave 0.
 */
export function computeMultiplierInterval(base: number, factor: number): number {
  const b = Math.max(1, base);
  const next = Math.ceil(b * factor - 1e-9);
  if (factor > 1 && next <= b) return Math.ceil(b) + 1;
  return Math.max(1, next);
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * The interval the item is currently on: the one set by the most recent entry
 * that scheduled it, looking back no further than the last 'madeIncremental'
 * marker (inclusive — the creation popup's interval is a chosen interval too).
 *
 * Unlike the review COUNT, this deliberately includes editor reschedules and
 * manual date edits: they do not confirm a review, but they do say which
 * interval the user wants this item on. Entries flagged `keepsInterval` (the
 * queue's swipe gestures) are the opposite case and are skipped.
 *
 * Returns null when nothing in the current session recorded one (history written
 * before `interval` was stamped), so the caller can fall back.
 */
export function getCurrentInterval(history: IncrementalRep[]): number | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    const type = entry.eventType;
    const setsSchedule =
      type === undefined ||
      type === 'rep' ||
      type === 'rescheduledInQueue' ||
      type === 'rescheduledInEditor' ||
      type === 'executeRepetition' ||
      type === 'externalRep' ||
      type === 'manualDateReset' ||
      type === 'madeIncremental';

    if (setsSchedule && !entry.keepsInterval) {
      if (typeof entry.interval === 'number' && entry.interval >= 0) {
        return entry.interval;
      }
      // An 'externalRep' logged without rescheduling carries no interval and did
      // not move the schedule — keep looking. Any other entry did set a date, so
      // recover the interval from its stamp when it has one.
      if (type !== 'externalRep' && typeof entry.nextRepMs === 'number') {
        return Math.max(0, Math.round((entry.nextRepMs - entry.date) / MS_PER_DAY));
      }
    }
    if (type === 'madeIncremental') break;
  }
  return null;
}

/**
 * The next interval, in days.
 *
 * @param reviewNumber 1 for the first review of the current session, 2 for the second…
 * @param currentInterval From {@link getCurrentInterval}. Null falls back to the
 *   count-based `factor ^ reviewNumber` the multiplier scheduler replaced, so an
 *   item with a long history but no recorded intervals does not collapse to a
 *   couple of days.
 */
export function computeNextInterval(args: {
  scheduler: SchedulerChoice;
  reviewNumber: number;
  currentInterval: number | null;
  curveFirstInterval: number;
  curveMaxInterval: number;
}): number {
  const { scheduler, reviewNumber, currentInterval } = args;
  if (scheduler.kind === 'curve') {
    return computeCurveInterval(reviewNumber, args.curveFirstInterval, args.curveMaxInterval);
  }
  if (currentInterval === null) {
    return Math.max(1, Math.ceil(scheduler.factor ** Math.max(reviewNumber, 1)));
  }
  return computeMultiplierInterval(currentInterval, scheduler.factor);
}

/** The intervals that follow `interval` on the multiplier scheduler, for popup previews. */
export function previewMultiplierIntervals(interval: number, factor: number, steps = 3): number[] {
  const out: number[] = [];
  let current = interval;
  for (let i = 0; i < steps; i++) {
    current = computeMultiplierInterval(current, factor);
    out.push(current);
  }
  return out;
}

/**
 * How a resolved scheduler is named in the UI — the Next button's chip and the
 * Repetition History popup — so the two cannot drift apart.
 */
export function describeScheduler(scheduler: ResolvedScheduler): {
  /** Compact form for the Next button: "×1.5" or "curve". */
  chip: string;
  /** Full name: "Multiplier ×1.5" or "Saturating Curve". */
  name: string;
  /** Where the choice comes from: "set for this Rem", "type setting", "default". */
  source: string;
  /** One sentence on what Next does with it. */
  explanation: string;
} {
  const source =
    scheduler.source === 'item'
      ? 'set for this Rem'
      : scheduler.source === 'type'
      ? 'type setting'
      : 'default';
  if (scheduler.kind === 'curve') {
    return {
      chip: 'curve',
      name: 'Saturating Curve',
      source,
      explanation: 'The next interval depends only on the number of reviews.',
    };
  }
  return {
    chip: `×${scheduler.factor}`,
    name: `Multiplier ×${scheduler.factor}`,
    source,
    explanation:
      scheduler.factor === 1
        ? 'The interval stays the same after each review.'
        : `The next interval is the current one × ${scheduler.factor}.`,
  };
}
