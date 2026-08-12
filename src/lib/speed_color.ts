/**
 * Red → green colour coding of review speed, shared by every surface of the
 * Practiced Queues dashboard: the live session card, the History Log and the
 * Sessions Summary table.
 *
 * The gradient is always driven by cards-per-minute, never by the number that
 * happens to be printed. That is what makes the Summary's cpm ⇄ s/card toggle
 * a pure relabelling: the same pace keeps the same colour in either unit.
 *
 * Two ways to place the two ends of the gradient:
 *
 * - `fixed` — the two cpm limits from settings (1.5 / 4 by default, the values
 *   the dashboard used before they were configurable).
 * - `calibrated` — derived from the user's own flashcard history: the average
 *   seconds-per-card over a chosen window, ± a margin in seconds. Judges a
 *   session against the user's usual pace instead of an absolute standard.
 *
 * Calibration walks every card's repetition history, so it is far too heavy to
 * run per render. It runs at most once per staleness window and is cached in
 * *device-local* storage — it is derived data each device can rebuild, and the
 * window is a personal, per-device reading preference.
 */
import type { CSSProperties } from 'react';
import { RNPlugin, QueueInteractionScore } from '@remnote/plugin-sdk';
import {
  SpeedCalibrationPeriod,
  flashcardResponseTimeLimitId,
  speedCalibrationCacheKey,
  speedCalibrationMarginSecondsId,
  speedCalibrationPeriodId,
  speedColorGreenCpmId,
  speedColorModeId,
  speedColorRedCpmId,
} from './consts';
import { getIESetting, getIESettings, IE_SETTINGS_DEFAULTS } from './settings';

/** The two ends of the gradient, plus where they came from. */
export interface SpeedThresholds {
  /** At or below this pace the reading is fully red. */
  redCpm: number;
  /** At or above this pace the reading is fully green. */
  greenCpm: number;
  source: 'fixed' | 'calibrated';
  /** Calibrated only: the measured average, for the dashboard's caption. */
  avgSeconds?: number;
  sampleCount?: number;
  computedAt?: number;
  period?: SpeedCalibrationPeriod;
}

export interface SpeedCalibration {
  kbId: string;
  period: SpeedCalibrationPeriod;
  /** Average seconds per real flashcard repetition in the window. */
  avgSeconds: number;
  sampleCount: number;
  computedAt: number;
}

export const FIXED_FALLBACK: SpeedThresholds = {
  redCpm: IE_SETTINGS_DEFAULTS[speedColorRedCpmId],
  greenCpm: IE_SETTINGS_DEFAULTS[speedColorGreenCpmId],
  source: 'fixed',
};

/**
 * A card cannot honestly average less than this. Guards the reciprocal below:
 * an average of 4s with a 5s margin would otherwise put "green" at a negative
 * or infinite pace.
 */
const MIN_SECONDS_PER_CARD = 1;

/** How long a calibration stays good before the dashboard recomputes it. */
const CALIBRATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The gradient itself
// ---------------------------------------------------------------------------

/**
 * Hue in the 0 (red) → 120 (green) range for a pace, given the thresholds.
 * Degenerate thresholds (green not above red, non-finite) fall back to the
 * defaults rather than producing a discontinuous or NaN hue.
 */
export function speedHue(cpm: number, t: SpeedThresholds = FIXED_FALLBACK): number {
  let { redCpm, greenCpm } = t;
  if (!Number.isFinite(redCpm) || !Number.isFinite(greenCpm) || greenCpm <= redCpm) {
    redCpm = FIXED_FALLBACK.redCpm;
    greenCpm = FIXED_FALLBACK.greenCpm;
  }
  if (cpm <= redCpm) return 0;
  if (cpm >= greenCpm) return 120;
  return Math.floor(((cpm - redCpm) / (greenCpm - redCpm)) * 120);
}

/**
 * Inline style for a speed reading. An unknown pace (0) is left uncoloured, so
 * an empty period inherits the surrounding text colour rather than shouting red.
 */
export function speedColorStyle(
  cpm: number,
  t: SpeedThresholds = FIXED_FALLBACK
): CSSProperties {
  return cpm > 0 ? { color: `hsl(${speedHue(cpm, t)}, 90%, 35%)` } : {};
}

/** Convenience for captions: the s/card reading of a cpm threshold. */
export const cpmToSecondsPerCard = (cpm: number): number => (cpm > 0 ? 60 / cpm : 0);

/**
 * Turns a measured average into the two ends of the gradient: `avg + margin`
 * seconds per card is fully red, `avg - margin` fully green.
 */
export function thresholdsFromCalibration(
  cal: SpeedCalibration,
  marginSeconds: number
): SpeedThresholds {
  const avg = Math.max(MIN_SECONDS_PER_CARD, cal.avgSeconds);
  const margin = Math.max(0, marginSeconds);
  const slowSeconds = avg + margin;
  const fastSeconds = Math.max(MIN_SECONDS_PER_CARD, avg - margin);
  return {
    redCpm: 60 / slowSeconds,
    greenCpm: 60 / fastSeconds,
    source: 'calibrated',
    avgSeconds: cal.avgSeconds,
    sampleCount: cal.sampleCount,
    computedAt: cal.computedAt,
    period: cal.period,
  };
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/** Start of the calibration window, or 0 for "Ever". */
export function calibrationWindowStart(
  period: SpeedCalibrationPeriod,
  now: number = Date.now()
): number {
  const d = new Date(now);
  switch (period) {
    case 'week':
      d.setDate(d.getDate() - 7);
      return d.getTime();
    case 'month':
      d.setMonth(d.getMonth() - 1);
      return d.getTime();
    case 'year':
      d.setFullYear(d.getFullYear() - 1);
      return d.getTime();
    case 'ever':
    default:
      return 0;
  }
}

export const CALIBRATION_PERIOD_LABELS: Record<SpeedCalibrationPeriod, string> = {
  ever: 'all time',
  year: 'the last year',
  month: 'the last month',
  week: 'the last week',
};

function isRealCardScore(score: number | undefined): boolean {
  // Same filter the authoritative recompute uses: only AGAIN / HARD / GOOD /
  // EASY are real reviews. TOO_EARLY, VIEWED_AS_LEECH, RESET, MANUAL_DATE and
  // MANUAL_EASE carry no meaningful response time.
  return (
    score === QueueInteractionScore.AGAIN ||
    score === QueueInteractionScore.HARD ||
    score === QueueInteractionScore.GOOD ||
    score === QueueInteractionScore.EASY
  );
}

/**
 * Walks every card's repetition history and averages the response time of real
 * reviews inside the window. Heavy — O(cards) over the whole knowledge base.
 *
 * Response times are clipped by the Flashcard Response Time Limit, exactly as
 * the Practiced Queues statistics clip them: a card left on screen while the
 * user made coffee would otherwise drag the average up by minutes.
 */
export async function computeSpeedCalibration(
  plugin: RNPlugin,
  period: SpeedCalibrationPeriod
): Promise<SpeedCalibration> {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  const capMs = (await getIESetting(plugin, flashcardResponseTimeLimitId)) * 1000;
  const since = calibrationWindowStart(period);

  const allCards = (await plugin.card.getAll()) || [];
  let totalMs = 0;
  let count = 0;
  for (const card of allCards) {
    const history = card?.repetitionHistory || [];
    for (const rep of history) {
      if (!rep || typeof rep.date !== 'number' || rep.date < since) continue;
      if (!isRealCardScore(rep.score)) continue;
      totalMs += Math.min(Math.max(0, rep.responseTime || 0), capMs);
      count += 1;
    }
  }

  const cal: SpeedCalibration = {
    kbId,
    period,
    avgSeconds: count > 0 ? totalMs / count / 1000 : 0,
    sampleCount: count,
    computedAt: Date.now(),
  };
  await plugin.storage.setLocal(speedCalibrationCacheKey, cal);
  return cal;
}

export async function readSpeedCalibration(
  plugin: RNPlugin
): Promise<SpeedCalibration | null> {
  const raw = await plugin.storage.getLocal<SpeedCalibration>(speedCalibrationCacheKey);
  return raw && typeof raw.avgSeconds === 'number' ? raw : null;
}

/**
 * Whether a cached calibration can still be used: same knowledge base, same
 * window, measured recently, and based on at least one review.
 */
export function isCalibrationUsable(
  cal: SpeedCalibration | null,
  kbId: string | null,
  period: SpeedCalibrationPeriod,
  now: number = Date.now()
): boolean {
  if (!cal || cal.sampleCount <= 0) return false;
  if (kbId && cal.kbId !== kbId) return false;
  if (cal.period !== period) return false;
  return now - cal.computedAt < CALIBRATION_MAX_AGE_MS;
}

/** In-flight calibration, so two widgets never walk every card at once. */
let inFlight: Promise<SpeedCalibration> | null = null;

/**
 * Returns a usable calibration, recomputing only when the cache is missing,
 * from another knowledge base, for another window, or older than a week.
 * `force` recomputes regardless — what the dashboard's "Recalibrate" does.
 */
export async function ensureSpeedCalibration(
  plugin: RNPlugin,
  period: SpeedCalibrationPeriod,
  force = false
): Promise<SpeedCalibration | null> {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  if (!force) {
    const cached = await readSpeedCalibration(plugin);
    if (isCalibrationUsable(cached, kbId, period)) return cached;
  }
  if (!inFlight) {
    inFlight = computeSpeedCalibration(plugin, period).finally(() => {
      inFlight = null;
    });
  }
  try {
    return await inFlight;
  } catch (e) {
    console.error('[SpeedColor] calibration failed:', e);
    return null;
  }
}

/**
 * The thresholds to colour with right now, without triggering any computation.
 * In calibrated mode with no usable cache yet, falls back to the fixed limits
 * so the dashboard always has *some* sensible colouring while it measures.
 */
export async function resolveSpeedThresholds(plugin: RNPlugin): Promise<SpeedThresholds> {
  const s = await getIESettings(plugin, [
    speedColorModeId,
    speedColorRedCpmId,
    speedColorGreenCpmId,
    speedCalibrationPeriodId,
    speedCalibrationMarginSecondsId,
  ] as const);
  const fixed: SpeedThresholds = {
    redCpm: s[speedColorRedCpmId],
    greenCpm: s[speedColorGreenCpmId],
    source: 'fixed',
  };
  if (s[speedColorModeId] !== 'calibrated') return fixed;

  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  const cal = await readSpeedCalibration(plugin);
  if (!isCalibrationUsable(cal, kbId, s[speedCalibrationPeriodId])) return fixed;
  return thresholdsFromCalibration(cal!, s[speedCalibrationMarginSecondsId]);
}
