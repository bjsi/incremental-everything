/**
 * Which repetitions count as a test of a prediction, for the analytics views
 * (Memory Analytics, FSRS Calibration).
 *
 * Every gradeable rep moves the FSRS replay, but only some of them are a fair
 * test of the retrievability FSRS predicted:
 *
 *   - the first rep of a lifetime (a new card, or the first after a RESET) has
 *     no prior state, so nothing was predicted;
 *   - a rep on the same calendar day as the previous one — a learning or
 *     relearning step, a Mastery Drill pass, a second look in another queue — is
 *     a test minutes after the last answer. FSRS predicts close to 100% there,
 *     and real recall after an Again is lower (95% on the main KB in 2026), so
 *     these reps drag every comparison towards "worse than predicted" and say
 *     nothing about the long-term model the weights are fitted for.
 *
 * fsrs-optimizer evaluates on the same population: it drops `delta_t == 0` rows
 * (same day) and the first rep before computing log loss or RMSE(bins), so the
 * views' figures stay comparable with an optimizer run.
 *
 * Days are local calendar days, midnight to midnight — the rule Grid D (initial
 * stability) already used, and the one RemNote's revlog export applies.
 */

/** Local midnight of the day `ms` falls on. */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole local calendar days from one moment to another. Rounding absorbs DST shifts. */
export function dayDiff(fromMs: number, toMs: number): number {
  return Math.round((startOfLocalDay(toMs) - startOfLocalDay(fromMs)) / 86400000);
}

/**
 * Whether a gradeable rep tests a prediction, given the date of the previous
 * gradeable rep in its lifetime (null for the first one).
 */
export function isScoredRep(previousDate: number | null, date: number): boolean {
  return previousDate !== null && dayDiff(previousDate, date) >= 1;
}
