/**
 * Cooling — spoiler protection across sessions for the Priority Queue.
 *
 * RemNote's own bury rule keeps a card out of the queue while ANOTHER card of
 * the same Rem was seen in the last hour (see `bury_protection` in the app
 * bundle). Anki buries siblings until the next day. Neither is enough for a
 * mature card: a descriptor whose answer was read as context yesterday, or an
 * Alt+Z cloze whose sibling cloze was graded three days ago, is still a free
 * recall — and FSRS will reward it with years of unearned stability.
 *
 * A Rem is COOLING when it still owes the queue a card and a card that gives
 * that answer away was graded recently and has since moved on. While cooling
 * it is left out of the Priority Queue document and is ineligible to set the
 * Priority Shield. Cooling ends on its own: the window is measured from the
 * moment the spoiling card was seen, and scales with the cooled card's own
 * interval — a mature card is both more damaged by a free recall and cheaper
 * to delay, so it waits longer.
 *
 * This module is PURE. It knows nothing about RemNote: the gatherer
 * (`cooling_gather.ts`) reads cards and the tree and hands it plain facts, so
 * the rules can be tested from fixtures alone. Nothing here is stored: the
 * cooling set is a function of card data and is recomputed on every refresh,
 * which is what makes it impossible for it to go stale or be lost when synced
 * storage is wiped. Only the user's overrides (release now, extend, never cool)
 * persist — see `cooling_store.ts`.
 */

export const DAY_MS = 86_400_000;

/**
 * How the spoiling card relates to the cooled Rem. Each is a distinct way one
 * review can put another card's answer on screen.
 */
export type CoolingRelation =
  /** Another card of the same Rem: the other direction, another cloze in the same text. */
  | 'same-rem'
  /** Another Alt+Z cloze under the same parent extract: each quotes the whole sentence. */
  | 'cloze-sibling'
  /** The parent extract itself was read as an IncRem, or its own card was graded. */
  | 'parent-extract'
  /** One of this Rem's own Alt+Z cloze children was graded. */
  | 'own-cloze-child'
  /** A child or grandchild card was graded, and its context line displayed this Rem's answer. */
  | 'descendant';

export const COOLING_RELATION_LABELS: Record<CoolingRelation, string> = {
  'same-rem': 'another card of this Rem was reviewed',
  'cloze-sibling': 'a sibling Alt+Z cloze was reviewed',
  'parent-extract': 'the parent extract was read',
  'own-cloze-child': 'one of its Alt+Z clozes was reviewed',
  descendant: 'a descendant card showed its answer as context',
};

export interface CoolingParams {
  /** Fraction of the cooled card's interval that becomes cooling time. */
  intervalFraction: number;
  /** Floor of the window in days — a new card's sibling still buries it for this long. */
  minDays: number;
  /** Ceiling of the window in days. */
  maxDays: number;
}

export const DEFAULT_COOLING_PARAMS: CoolingParams = {
  intervalFraction: 0.05,
  minDays: 1,
  maxDays: 15,
};

/** A due card of the candidate: what would be spoiled. */
export interface DueCardFact {
  cardId: string;
  /** Last scheduled interval in days; 0 for a never-practised card. */
  intervalDays: number;
}

/** A card (or an IncRem read) that could have shown the candidate's answer. */
export interface SpoilerSeenEvent {
  relation: CoolingRelation;
  /** The Rem that owns the spoiling card (or the extract that was read). */
  sourceRemId: string;
  sourceLabel?: string;
  /** Absent for an IncRem read. */
  cardId?: string;
  /** When it was last shown. */
  seenAt: number;
  /**
   * True when the spoiling card is itself still due. A pair that is both due
   * is not a cooling case: RemNote's hour-long bury already separates them
   * within a session, and holding the candidate would only stall the pair.
   */
  stillDue: boolean;
}

export interface CoolingCandidate {
  remId: string;
  label?: string;
  priority?: number;
  dueCards: DueCardFact[];
  seen: SpoilerSeenEvent[];
}

export interface CoolingReason {
  relation: CoolingRelation;
  sourceRemId: string;
  sourceLabel?: string;
  cardId?: string;
  seenAt: number;
  /** seenAt + window. */
  until: number;
}

export interface CoolingVerdict {
  remId: string;
  label?: string;
  priority?: number;
  /** When cooling ends — the latest of every reason, or the user's extension. */
  until: number;
  windowDays: number;
  /** The interval the window was derived from: the longest among the due cards. */
  intervalDays: number;
  /** Empty only when the Rem is cooling purely by extension. */
  reasons: CoolingReason[];
  /** Set when a user extension is what decides `until`. */
  extendedUntil?: number;
}

/**
 * What the user has said about specific Rems. The only cooling state that is
 * ever persisted; everything else is recomputed.
 */
export interface CoolingOverrides {
  /**
   * remId → timestamp of a "release now". Events seen at or before that
   * instant no longer cool the Rem; a sibling graded afterwards cools it again.
   */
  released: Record<string, number>;
  /** remId → keep cooling until at least this timestamp. */
  extended: Record<string, number>;
  /** Rems that must never cool. */
  never: string[];
}

export const EMPTY_COOLING_OVERRIDES: CoolingOverrides = {
  released: {},
  extended: {},
  never: [],
};

/**
 * Days of cooling for a card of the given interval:
 *   clamp( ceil( interval × fraction ), min, max )
 * With the defaults: 10d → 1d, 60d → 3d, 200d → 10d, a year or more → 15d.
 */
export function coolingWindowDays(
  intervalDays: number,
  params: CoolingParams = DEFAULT_COOLING_PARAMS
): number {
  const min = Math.max(0, params.minDays);
  const max = Math.max(min, params.maxDays);
  const fraction = Math.max(0, params.intervalFraction);
  const raw = Math.ceil(Math.max(0, intervalDays) * fraction);
  return Math.min(max, Math.max(min, raw));
}

// --- card facts ------------------------------------------------------------

/** The subset of the SDK Card this module reads. Plain data, so fixtures are trivial. */
export interface CardLike {
  _id: string;
  nextRepetitionTime?: number | null;
  lastRepetitionTime?: number | null;
  repetitionHistory?: { date: number; score: number }[] | null;
}

/**
 * Scores at which the card was actually on screen. Values are RemNote's
 * QueueInteractionScore: AGAIN 0, TOO_EARLY 0.01, HARD 0.5, GOOD 1, EASY 1.5,
 * VIEWED_AS_LEECH 2. RESET (3), MANUAL_DATE (4) and MANUAL_EASE (5) are
 * bookkeeping — the card was not shown — and are excluded. TOO_EARLY counts:
 * the question was displayed even though it was skipped.
 */
const VIEWED_SCORES = new Set([0, 0.01, 0.5, 1, 1.5, 2]);

/** When the card was last shown, or null if never. */
export function cardLastSeenAt(card: CardLike): number | null {
  let last: number | null = null;
  for (const rep of card.repetitionHistory ?? []) {
    if (!rep || typeof rep.date !== 'number') continue;
    if (!VIEWED_SCORES.has(rep.score)) continue;
    if (last === null || rep.date > last) last = rep.date;
  }
  if (last === null && typeof card.lastRepetitionTime === 'number') {
    last = card.lastRepetitionTime;
  }
  return last;
}

/**
 * The card's last scheduled interval in days: next due minus last seen. A card
 * never shown, or one whose due date is not ahead of its last review, reads as
 * 0 — which the window formula turns into the minimum cooling.
 */
export function cardIntervalDays(card: CardLike): number {
  const next = card.nextRepetitionTime;
  const last = cardLastSeenAt(card);
  if (typeof next !== 'number' || last === null || next <= last) return 0;
  return (next - last) / DAY_MS;
}

/**
 * The queue's due predicate: `?? Infinity` so a card with no schedule
 * (disabled, table row, markup removed) never reads as due.
 */
export function isCardDue(card: CardLike, now: number): boolean {
  return (card.nextRepetitionTime ?? Infinity) <= now;
}

// --- the verdict -----------------------------------------------------------

/**
 * Decides whether a candidate is cooling right now.
 *
 * The window belongs to the CANDIDATE: it is derived from the longest interval
 * among its due cards, the one a free recall would inflate the most. Each seen
 * event that is not itself still due, that happened after any release, and
 * whose window has not yet run out, becomes a reason; the Rem cools until the
 * latest of them. A user extension can only lengthen that.
 */
export function evaluateCooling(
  candidate: CoolingCandidate,
  now: number,
  params: CoolingParams = DEFAULT_COOLING_PARAMS,
  overrides: CoolingOverrides = EMPTY_COOLING_OVERRIDES
): CoolingVerdict | null {
  if (candidate.dueCards.length === 0) return null;
  if (overrides.never.includes(candidate.remId)) return null;

  const intervalDays = Math.max(0, ...candidate.dueCards.map((c) => c.intervalDays));
  const windowDays = coolingWindowDays(intervalDays, params);
  const windowMs = windowDays * DAY_MS;
  const releasedAt = overrides.released[candidate.remId] ?? -Infinity;

  const reasons: CoolingReason[] = [];
  for (const event of candidate.seen) {
    if (event.stillDue) continue;
    // A timestamp from the future is a clock skew, not a review from tomorrow.
    const seenAt = Math.min(event.seenAt, now);
    if (seenAt <= releasedAt) continue;
    const until = seenAt + windowMs;
    if (until <= now) continue;
    reasons.push({
      relation: event.relation,
      sourceRemId: event.sourceRemId,
      sourceLabel: event.sourceLabel,
      cardId: event.cardId,
      seenAt,
      until,
    });
  }
  reasons.sort((a, b) => b.until - a.until);

  const extendedUntil = overrides.extended[candidate.remId];
  const extensionApplies = typeof extendedUntil === 'number' && extendedUntil > now;

  if (reasons.length === 0 && !extensionApplies) return null;

  const reasonUntil = reasons.length ? reasons[0].until : -Infinity;
  const until = extensionApplies ? Math.max(reasonUntil, extendedUntil) : reasonUntil;

  return {
    remId: candidate.remId,
    label: candidate.label,
    priority: candidate.priority,
    until,
    windowDays,
    intervalDays,
    reasons,
    extendedUntil: extensionApplies && extendedUntil >= reasonUntil ? extendedUntil : undefined,
  };
}

/**
 * Drops overrides that can no longer change any verdict, so the synced record
 * stays a handful of entries: a release older than the longest possible window
 * only suppresses events that have expired anyway, and an extension in the
 * past extends nothing. "Never" entries are the user's standing decision and
 * are kept.
 */
export function pruneCoolingOverrides(
  overrides: CoolingOverrides,
  now: number,
  params: CoolingParams = DEFAULT_COOLING_PARAMS
): CoolingOverrides {
  const horizon = now - Math.max(params.minDays, params.maxDays) * DAY_MS;
  const released: Record<string, number> = {};
  for (const [remId, at] of Object.entries(overrides.released ?? {})) {
    if (typeof at === 'number' && at > horizon) released[remId] = at;
  }
  const extended: Record<string, number> = {};
  for (const [remId, until] of Object.entries(overrides.extended ?? {})) {
    if (typeof until === 'number' && until > now) extended[remId] = until;
  }
  return { released, extended, never: [...new Set(overrides.never ?? [])] };
}

/** Removes cooling Rems from any list keyed by remId — the shield's exclusion. */
export function excludeCooling<T extends { remId: string }>(
  items: T[],
  cooling: ReadonlySet<string>
): T[] {
  if (cooling.size === 0) return items;
  return items.filter((item) => !cooling.has(item.remId));
}
