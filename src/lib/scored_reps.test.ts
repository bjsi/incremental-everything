/**
 * Which reps the analytics views score. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QueueInteractionScore as Q } from '@remnote/plugin-sdk';
import { dayDiff, isScoredRep } from './scored_reps';
import { computeCardStats } from './card_analytics';
import { computeFSRSCalibrationBreakdown } from './fsrs_calibration';

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
/** Local noon, so a few minutes either way never crosses midnight. */
const T0 = new Date(2025, 0, 6, 12, 0, 0).getTime();
const at = (days: number, minutes = 0) => T0 + days * DAY + minutes * MIN;

/**
 * Learned, one later-day pass, a lapse with a same-day relearning step, then a
 * next-day pass. Scored: day 5, day 30 (the Again), day 31. Not scored: day 0
 * (first of its life) and day 30 + 10 min (same day as the Again).
 */
const HISTORY = [
  { date: at(0), score: Q.GOOD },
  { date: at(5), score: Q.GOOD },
  { date: at(30), score: Q.AGAIN },
  { date: at(30, 10), score: Q.GOOD },
  { date: at(31), score: Q.GOOD },
];

describe('scored reps', () => {
  it('counts local calendar days, not 24-hour spans', () => {
    const lateEvening = new Date(2025, 0, 6, 23, 50).getTime();
    const justAfterMidnight = new Date(2025, 0, 7, 0, 10).getTime();
    assert.equal(dayDiff(lateEvening, justAfterMidnight), 1);
    assert.equal(dayDiff(at(0), at(0, 300)), 0);
  });

  it('scores neither the first rep of a lifetime nor a same-day step', () => {
    assert.equal(isScoredRep(null, at(0)), false);
    assert.equal(isScoredRep(at(30), at(30, 10)), false);
    assert.equal(isScoredRep(at(30, 10), at(31)), true);
  });
});

describe('Memory Analytics retention and Avg pR', () => {
  const stats = computeCardStats(
    { repetitionHistory: HISTORY, nextRepetitionTime: at(60) },
    null,
    at(40),
    180_000,
    false,
    0,
    Infinity,
    false,
  );

  it('takes retention over exactly the reps Avg pR averages', () => {
    assert.equal(stats.scoredReps, 3);
    assert.equal(stats.predRCount, 3);
    assert.equal(stats.scoredAgains, 1);
  });

  it('keeps every rep in throughput and lapses', () => {
    assert.equal(stats.gradeableReps, 5);
    assert.equal(stats.lapses, 1);
  });

  it('restarts at a RESET without scoring the first rep after it', () => {
    const withReset = [...HISTORY, { date: at(35), score: Q.RESET }, { date: at(36), score: Q.GOOD }];
    const s = computeCardStats(
      { repetitionHistory: withReset, nextRepetitionTime: at(60) },
      null,
      at(40),
      180_000,
      false,
      0,
      Infinity,
      false,
    );
    assert.equal(s.scoredReps, 3);
  });
});

describe('FSRS Calibration', () => {
  const plugin = { card: { getAll: async () => [{ _id: 'c1', repetitionHistory: HISTORY }] } };
  const period = { id: 'all', startMs: 0, endMs: Infinity, customStart: '', customEnd: '' };

  it('keeps the same-day relearning step out of the previous-grade grid', async () => {
    const b = await computeFSRSCalibrationBreakdown(plugin as any, null, false, period);
    // Reps with two earlier ones: day 30 (after Good) and day 31 (after the same-day
    // step). The step itself would have been a third, under the Again row.
    assert.equal(b.gridBOverall.reps, 2);
    const againRow = b.gridBRowTotals[0];
    assert.equal(againRow.reps, 0);
  });
});
