/**
 * The unified Priority Shield: IncRems and cards ranked together by absolute
 * priority, one element each (a Rem with three cards is three elements), the
 * way SuperMemo's priority protection counts topics and items in one queue.
 *
 * Dismissed Rems are not part of it: they need no further reading, and the
 * work they still cost is in their cards, which are already counted.
 *
 * The top missed element of the union is simply the higher-priority of the two
 * sides' own top missed elements, so the caller passes those in. Each side
 * keeps its own rules for choosing it: cards their overdue-before-today
 * predicate, cooling exclusion and live verification; IncRems due-now. Only
 * the percentile, the weighted value and the universe are computed here.
 *
 * Pure: no SDK imports, so it runs under the ts-node unit tests.
 */
import { calculateVolumeBasedPercentile, calculateWeightedShield } from './shield_math';

export interface UnifiedShieldEntry {
  /** min(incRemAbsolute, cardAbsolute); null when neither side has a missed element. */
  absolute: number | null;
  /** Share of the joint universe ranked above the top missed element (0–100). */
  percentile: number | null;
  /** IncRems + cards. */
  universeSize: number;
  /** The cards part of `universeSize`. */
  cardCount: number;
  /** The IncRem side's own top missed priority. */
  incRemAbsolute: number | null;
  /** The card side's own top missed priority. */
  cardAbsolute: number | null;
  weightedShield?: number | null;
}

export interface UnifiedShieldInput<I extends { priority: number }, C extends { priority: number }> {
  incRems: I[];
  /** Due and not yet reviewed in this session. */
  isIncRemDue: (item: I) => boolean;
  cards: C[];
  /** Due and not yet reviewed in this session. */
  isCardDue: (item: C) => boolean;
  incRemAbsolute: number | null;
  cardAbsolute: number | null;
  computeWeighted?: boolean;
}

type Joint = { priority: number; remId: string; due: boolean };

export function computeUnifiedShield<I extends { priority: number }, C extends { priority: number }>(
  input: UnifiedShieldInput<I, C>
): UnifiedShieldEntry {
  const { incRems, cards, incRemAbsolute, cardAbsolute } = input;

  const joint: Joint[] = new Array(incRems.length + cards.length);
  let n = 0;
  for (const r of incRems) joint[n++] = { priority: r.priority, remId: '', due: input.isIncRemDue(r) };
  for (const c of cards) joint[n++] = { priority: c.priority, remId: '', due: input.isCardDue(c) };

  const absolute =
    incRemAbsolute === null ? cardAbsolute
    : cardAbsolute === null ? incRemAbsolute
    : Math.min(incRemAbsolute, cardAbsolute);

  const entry: UnifiedShieldEntry = {
    absolute,
    percentile: absolute === null
      ? 100
      : calculateVolumeBasedPercentile(joint, absolute, (x) => x.due),
    universeSize: joint.length,
    cardCount: cards.length,
    incRemAbsolute,
    cardAbsolute,
  };

  if (input.computeWeighted) {
    entry.weightedShield = calculateWeightedShield(joint, (x) => x.due);
  }

  return entry;
}

/**
 * Top missed priority of one side for the LIVE queue bars: the lowest priority
 * among due, unseen elements that are allowed to set the shield. Null when none.
 */
export function topMissedPriority<T extends { priority: number }>(
  items: T[],
  canSetShield: (item: T) => boolean
): number | null {
  let best: number | null = null;
  for (const item of items) {
    if ((best === null || item.priority < best) && canSetShield(item)) best = item.priority;
  }
  return best;
}
