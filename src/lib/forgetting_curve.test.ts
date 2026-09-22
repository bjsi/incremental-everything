/**
 * Fixture tests for the forgetting-curve series builder. Run with `npm test`.
 * Uses node's built-in runner so no test framework is added to the bundle.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QueueInteractionScore, RepetitionStatusInterface } from '@remnote/plugin-sdk';
import {
    CURVE_GRADES,
    buildForgettingCurveSeries,
    describeCurveMismatch,
    formatCurveDays,
} from './forgetting_curve';
import {
    DEFAULT_REQUESTED_RETENTION,
    FSRS_DEFAULT_WEIGHTS,
    computeFSRSState,
    forgettingCurve,
    intervalFactorForRetention,
} from './fsrs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

const rep = (daysAgo: number, score: QueueInteractionScore): RepetitionStatusInterface =>
    ({ date: NOW - daysAgo * DAY, score } as RepetitionStatusInterface);

/** A six-review card: learned, then four growing review intervals. */
const HISTORY: RepetitionStatusInterface[] = [
    rep(400, QueueInteractionScore.GOOD),
    rep(399, QueueInteractionScore.GOOD),
    rep(393, QueueInteractionScore.GOOD),
    rep(376, QueueInteractionScore.GOOD),
    rep(330, QueueInteractionScore.GOOD),
    rep(200, QueueInteractionScore.GOOD),
];

const build = (history: RepetitionStatusInterface[], over = {}) =>
    buildForgettingCurveSeries(history, { now: NOW, ...over });

describe('buildForgettingCurveSeries', () => {
    it('returns null when there is nothing to replay', () => {
        assert.equal(build([]), null);
        assert.equal(buildForgettingCurveSeries(null, { now: NOW }), null);
        assert.equal(build([rep(1, QueueInteractionScore.RESET)]), null);
    });

    it('marks one rep per gradeable review, in order', () => {
        const s = build(HISTORY)!;
        assert.equal(s.reps.length, 6);
        assert.deepEqual(s.reps.map((r) => r.index), [1, 2, 3, 4, 5, 6]);
        for (let i = 1; i < s.reps.length; i++) {
            assert.ok(s.reps[i].t > s.reps[i - 1].t, 'reps are chronological');
        }
    });

    it('snaps retrievability to 100% at every review', () => {
        const s = build(HISTORY)!;
        for (const r of s.reps) {
            const row = s.rows.find((x) => x.t === r.t && x.r === 100);
            assert.ok(row, `review ${r.index} has a 100% row`);
        }
    });

    it('decays monotonically inside each segment', () => {
        const s = build(HISTORY)!;
        const past = s.rows.filter((r) => typeof r.r === 'number' && r.x <= s.nowX);
        let previous = Infinity;
        for (const row of past) {
            const r = row.r as number;
            // A new segment resets to 100; within one, R only falls.
            if (r === 100) { previous = 100; continue; }
            assert.ok(r <= previous + 1e-9, `R must not rise inside a segment (${r} > ${previous})`);
            previous = r;
        }
    });

    it('agrees with computeFSRSState on the present moment', () => {
        const s = build(HISTORY)!;
        const direct = computeFSRSState(HISTORY, null, DEFAULT_REQUESTED_RETENTION)!;
        assert.ok(Math.abs(s.nowR - direct.r * 100) < 1e-9);
        assert.equal(s.state.s, direct.s);
    });

    it('puts the optimum interval exactly where R crosses the target', () => {
        const target = 0.85;
        const s = build(HISTORY, { targetRetention: target })!;
        const w = FSRS_DEFAULT_WEIGHTS;
        const decay = -w[20];
        const factor = Math.pow(0.9, 1 / decay) - 1;
        for (const r of s.reps) {
            const rAtOptimum = forgettingCurve(r.optimumDays, r.s, decay, factor);
            assert.ok(
                Math.abs(rAtOptimum - target) < 1e-6,
                `R at the optimum interval should be the target (got ${rAtOptimum})`,
            );
        }
    });

    it('reports stability increase per review', () => {
        const s = build(HISTORY)!;
        assert.equal(s.reps[0].sInc, null, 'the first review has nothing to grow from');
        for (const r of s.reps.slice(1)) {
            assert.ok(r.sInc !== null);
            assert.ok(Math.abs(r.sInc! - r.s / r.sBefore!) < 1e-9);
        }
    });

    it('breaks the line at a Reset', () => {
        const history = [
            rep(400, QueueInteractionScore.GOOD),
            rep(390, QueueInteractionScore.GOOD),
            rep(300, QueueInteractionScore.RESET),
            rep(200, QueueInteractionScore.GOOD),
            rep(100, QueueInteractionScore.GOOD),
        ];
        const s = build(history)!;
        assert.equal(s.reps.length, 4, 'the Reset is not itself a review');
        const breaks = s.rows.filter((r) => r.r === null);
        assert.equal(breaks.length, 1, 'exactly one deliberate gap');
        assert.equal(breaks[0].t, NOW - 300 * DAY);
    });

    it('forecasts all four grades, ordered as FSRS orders them', () => {
        const s = build(HISTORY)!;
        assert.deepEqual(s.branches.map((b) => b.grade), CURVE_GRADES);
        const by = Object.fromEntries(s.branches.map((b) => [b.grade, b]));
        assert.ok(by.again.stability < by.hard.stability, 'a lapse costs stability');
        assert.ok(by.hard.stability < by.good.stability);
        assert.ok(by.good.stability < by.easy.stability);
        // Every branch leaves the review at full retrievability.
        const junction = s.rows.find((r) => r.t === NOW && r.good === 100)!;
        for (const g of CURVE_GRADES) assert.equal(junction[g], 100);
    });

    it('stops the forecast where Easy crosses the target retention', () => {
        for (const target of [0.9, 0.8]) {
            const s = build(HISTORY, { targetRetention: target })!;
            const last = s.rows[s.rows.length - 1];
            assert.ok(
                Math.abs((last.easy as number) - target * 100) < 0.5,
                `Easy should land on the target at the right edge (got ${last.easy} for ${target})`,
            );
            // And nothing is cut short: every other branch is already past it.
            for (const g of ['again', 'hard', 'good'] as const) {
                assert.ok((last[g] as number) <= target * 100 + 1e-6);
            }
        }
    });

    it('omits the branches when the forecast is switched off', () => {
        const s = build(HISTORY, { forecast: false })!;
        assert.equal(s.branches.length, 0);
        assert.ok(s.rows.every((r) => r.good == null));
    });

    it('samples evenly in the plotted coordinate on a log scale', () => {
        const s = build(HISTORY, { scale: 'log' })!;
        // The first segment is one day long and sits 400 days before the last;
        // on a log axis it must still get a comparable share of the samples.
        const firstSegment = s.rows.filter((r) => r.t >= s.reps[0].t && r.t <= s.reps[1].t);
        const lastSegment = s.rows.filter((r) => r.t >= s.reps[5].t && r.t <= s.nowT);
        assert.ok(firstSegment.length > 20, `first segment under-sampled (${firstSegment.length})`);
        assert.ok(lastSegment.length > 20, `last segment under-sampled (${lastSegment.length})`);
    });

    it('keeps rows sorted by x and inside the declared domain', () => {
        for (const scale of ['log', 'linear'] as const) {
            const s = build(HISTORY, { scale })!;
            for (let i = 1; i < s.rows.length; i++) {
                assert.ok(s.rows[i].x >= s.rows[i - 1].x, `${scale}: rows are sorted`);
            }
            for (const row of s.rows) {
                assert.ok(row.x >= s.xDomain[0] - 1e-9 && row.x <= s.xDomain[1] + 1e-9, `${scale}: row inside domain`);
            }
            assert.ok(s.ticks.length > 0, `${scale}: has ticks`);
        }
    });

    it('never clips the target retention line off the y axis', () => {
        const s = build(HISTORY, { targetRetention: 0.97 })!;
        assert.ok(s.yDomain[0] <= s.targetPercent);
        assert.equal(s.yDomain[1], 100);
    });
});

describe('describeCurveMismatch', () => {
    const state = computeFSRSState(HISTORY, null, DEFAULT_REQUESTED_RETENTION)!;
    const lastRep = NOW - 200 * DAY;

    it('stays quiet when the scheduler agrees', () => {
        const modelled = state.s * state.intervalFactor;
        assert.equal(describeCurveMismatch(state, lastRep, lastRep + modelled * DAY), null);
    });

    it('stays quiet inside the tolerance', () => {
        const modelled = state.s * state.intervalFactor;
        assert.equal(describeCurveMismatch(state, lastRep, lastRep + modelled * 1.5 * DAY), null);
    });

    it('speaks up when the interval is nowhere near', () => {
        const modelled = state.s * state.intervalFactor;
        const msg = describeCurveMismatch(state, lastRep, lastRep + modelled * 10 * DAY);
        assert.ok(msg && msg.includes('different scheduler'));
    });

    it('has nothing to say without both dates', () => {
        assert.equal(describeCurveMismatch(state, null, NOW), null);
        assert.equal(describeCurveMismatch(state, lastRep, null), null);
    });
});

describe('formatCurveDays', () => {
    it('picks a unit that reads', () => {
        assert.equal(formatCurveDays(10 / 1440), '10m');
        assert.equal(formatCurveDays(6 / 24), '6h');
        assert.equal(formatCurveDays(1), '1.0d');
        assert.equal(formatCurveDays(7), '7d');
        assert.equal(formatCurveDays(30), '4w');
        assert.equal(formatCurveDays(200), '7mo');
        assert.equal(formatCurveDays(400), '1.1y');
    });
});
