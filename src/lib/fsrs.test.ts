/**
 * Fixture tests pinning the replay to ts-fsrs. Run with `npm test`.
 * The expected values come from RemNote's own copy of the library, run without
 * fuzz on these same histories (see findings/MULTI_LINE_SUB_CARDS.md).
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RepetitionStatusInterface } from '@remnote/plugin-sdk';
import { computeFSRSState, computeFSRSStatesPerReview } from './fsrs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 0, 10, 12);

const OPTIMIZED = [
    3.973, 13.618, 43.322, 100, 7.011, 0.46, 2.096, 0.15, 2.5, 0.27, 1.081, 1.601, 0.068, 0.504, 1.387,
    0.011, 3, 0.546, 0.08, 0.066, 0.118,
];
const FSRS_DEFAULT = [
    0.212, 1.293, 2.306, 8.295, 6.413, 0.833, 3.019, 0.001, 1.872, 0.166, 0.796, 1.483, 0.061, 0.262, 1.648,
    0.601, 1.872, 0.542, 0.091, 0.065, 0.154,
];

const FORGOT = 0;
const PARTIAL = 0.5;
const GOOD = 1;

const history = (reps: [number, number][]) =>
    reps.map(([offset, score]) => ({ date: START + offset, score } as RepetitionStatusInterface));

const CASES: {
    name: string;
    reps: [number, number][];
    optimized: { s: number; d: number };
    fsrsDefault: { s: number; d: number };
}[] = [
    {
        name: 'a lapse, then Good later the same UTC day, keeps the post-lapse stability',
        reps: [[0, GOOD], [30 * DAY, GOOD], [120 * DAY, FORGOT], [120 * DAY + 3 * HOUR, GOOD]],
        optimized: { s: 17.38658425, d: 6.52393365 },
        fsrsDefault: { s: 3.00280924, d: 7.38069874 },
    },
    {
        name: 'a lapse, then Good the next UTC day, takes the recall formula while relearning',
        reps: [[0, GOOD], [30 * DAY, GOOD], [120 * DAY, FORGOT], [121 * DAY, GOOD]],
        optimized: { s: 21.40823234, d: 6.52393365 },
        fsrsDefault: { s: 5.02841561, d: 7.38069874 },
    },
    {
        name: 'Forgot the same UTC day takes the short-term formula, and Hard then holds',
        reps: [[0, GOOD], [100 * DAY, GOOD], [100 * DAY + 2 * HOUR, FORGOT], [100 * DAY + 4 * HOUR, PARTIAL]],
        optimized: { s: 58.53482684, d: 7.12513192 },
        fsrsDefault: { s: 14.03768541, d: 8.25437854 },
    },
    {
        name: 'one hour across UTC midnight counts as a whole day',
        reps: [[0, GOOD], [11.5 * HOUR, GOOD], [12.5 * HOUR, GOOD]],
        optimized: { s: 47.87963223, d: 5.09500249 },
        fsrsDefault: { s: 7.31902431, d: 2.10828659 },
    },
];

// Relative, because ts-fsrs rounds its intermediate values to 8 decimals, which
// leaves differences of about 1 part in 10 million.
const assertClose = (actual: number, expected: number, label: string) =>
    assert.ok(Math.abs(actual - expected) / expected < 1e-6, `${label}: got ${actual}, expected ${expected}`);

describe('FSRS replay matches ts-fsrs', () => {
    for (const { name, reps, optimized, fsrsDefault } of CASES) {
        it(name, () => {
            for (const [weights, expected] of [
                [OPTIMIZED, optimized],
                [FSRS_DEFAULT, fsrsDefault],
            ] as const) {
                const state = computeFSRSState(history(reps), [...weights])!;
                assertClose(state.s, expected.s, 'state S');
                assertClose(state.d, expected.d, 'state D');

                const steps = computeFSRSStatesPerReview(history(reps), [...weights]);
                assertClose(steps[steps.length - 1].s, expected.s, 'last step S');
                assertClose(steps[steps.length - 1].d, expected.d, 'last step D');
            }
        });
    }
});
