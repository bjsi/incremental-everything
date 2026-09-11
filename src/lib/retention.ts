// lib/retention.ts
//
// The retention scale, in one place.
//
// Retention is the share of graded answers that were not "Again". Three
// surfaces report it — the Practiced Queues Sessions Summary, the live/logged
// session cards, and the Flashcard Repetition History — and they must agree, so
// the thresholds live here rather than being restated at each call site.
//
// WHY THERE ARE TWO RENDERINGS OF THE SAME SCALE
//
// The Practiced Queues dashboard is a Tailwind widget and colours text with
// class names; the Flashcard Repetition History styles inline and needs a hex.
// Both are derived from the SAME band, so a threshold changes in one edit and
// the two cannot drift — which is the whole reason this module exists rather
// than each widget carrying its own ternary.
//
// WHY THREE BANDS AND NOT THE FOUR-STEP PROGRESS RAMP
//
// The ≥95 / ≥80 / ≥50 ramp in Colour-Coding-Reference is for progress bars,
// where more is unambiguously better. Retention is a judgement with a target in
// the middle: above ~90% you are reviewing more than you need to, below 80% the
// material is not sticking. Green means "on target", not "maximal".

/** At or above this, retention reads green. */
export const RETENTION_GOOD_MIN = 90;
/** Below this, retention reads red. Between the two it is amber. */
export const RETENTION_POOR_MAX = 80;

export type RetentionBand = 'good' | 'fair' | 'poor';

/**
 * Red-500 — the colour a lapse (an answer graded "Again") is called out in, and
 * the same red the "poor" band uses below. One constant, so a lapse count and a
 * failing retention cannot end up two different reds.
 */
export const LAPSE_COLOR = '#ef4444';

export function retentionBand(retentionPercent: number): RetentionBand {
  if (retentionPercent >= RETENTION_GOOD_MIN) return 'good';
  if (retentionPercent < RETENTION_POOR_MAX) return 'poor';
  return 'fair';
}

/** Tailwind text colour, for the class-name surfaces. */
export function retentionColorClass(retentionPercent: number): string {
  switch (retentionBand(retentionPercent)) {
    case 'good':
      return 'text-green-600';
    case 'poor':
      return 'text-red-500';
    default:
      return 'text-yellow-600';
  }
}

/**
 * The same three colours as hex, for the inline-styled surfaces. These are the
 * literal values of the Tailwind classes above (green-600, red-500,
 * yellow-600), so the two renderings are the same colour and not merely the
 * same idea.
 */
export function retentionColorHex(retentionPercent: number): string {
  switch (retentionBand(retentionPercent)) {
    case 'good':
      return '#16a34a';
    case 'poor':
      return LAPSE_COLOR;
    default:
      return '#ca8a04';
  }
}

/**
 * Retention as a percentage: `kept` of `answered`.
 *
 * `null` when nothing was answered — a session or a card with no graded answers
 * has no retention, and reporting it as 100% would flatter it. Call sites that
 * want a placeholder choose their own.
 */
export function retentionPercent(kept: number, answered: number): number | null {
  if (answered <= 0) return null;
  return (kept / answered) * 100;
}
