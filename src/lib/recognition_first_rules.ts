import { cardIntervalDays } from './priority_review_document/cooling';

/**
 * The decisions behind Recognition First (recognition_first.ts), free of plugin calls.
 *
 * In RemNote's terms: `forward` is front → back (name → description) and `backward` is
 * back → front (description → name, the "recognition" card that should come first).
 */

export interface DirectionCard {
  type: unknown;
  repetitionHistory?: Array<{ date?: number; score?: number }>;
  nextRepetitionTime?: number;
}

/** AGAIN, HARD, GOOD, EASY, VIEWED_AS_LEECH. A skip (TOO_EARLY) and the bookkeeping scores are no review. */
const REVIEW_SCORES = new Set([0, 0.5, 1, 1.5, 2]);
const PASSING_SCORES = new Set([1, 1.5]);

export const isPassingScore = (score: unknown): boolean => PASSING_SCORES.has(score as number);

export function hasBeenReviewed(card: DirectionCard): boolean {
  return (card.repetitionHistory ?? []).some((rep) => REVIEW_SCORES.has(rep?.score as number));
}

/** The back → front card was rated Good or Easy, with the last interval at least `minDays` long. */
export function recognitionPassed(backward: DirectionCard, minDays: number): boolean {
  if (!(backward.repetitionHistory ?? []).some((rep) => isPassingScore(rep?.score))) return false;
  if (minDays <= 0) return true;
  return cardIntervalDays(backward as Parameters<typeof cardIntervalDays>[0]) >= minDays;
}

/** Should this Rem's front → back card wait? `cards` are the Rem's cards while it practises both ways. */
export function shouldHoldForward(cards: DirectionCard[], minDays: number): boolean {
  const forward = cards.find((card) => card.type === 'forward');
  const backward = cards.find((card) => card.type === 'backward');
  if (!forward || !backward) return false;
  return !hasBeenReviewed(forward) && !recognitionPassed(backward, minDays);
}
