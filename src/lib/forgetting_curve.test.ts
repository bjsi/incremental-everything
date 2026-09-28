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
    formatCurveDays,
    rebuildTicks,
    tickMinGap,
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

const DECAY = -FSRS_DEFAULT_WEIGHTS[20];
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;
/** Retrievability of a memory of `stability` after `elapsedDays`. */
const rAt = (elapsedDays: number, stability: number) =>
    forgettingCurve(elapsedDays, stability, DECAY, FACTOR);

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

    it('puts the new stability last among the rows sharing a repetition\'s x', () => {
        const s = build(HISTORY)!;
        for (const rep of s.reps) {
            const atRep = s.rows.filter(
                (r) => Math.abs(r.x - rep.x) < 1e-12 && typeof r.s === 'number',
            );
            assert.ok(atRep.length >= 1, `rep ${rep.index}: has a row`);

            // Anything reading "the stability here" must take the LAST of these.
            // The first is the closing sample of the segment this repetition
            // ends, which still carries the previous stability — reading it is
            // what made the tooltip report the previous repetition's value.
            const last = atRep[atRep.length - 1];
            assert.ok(
                Math.abs((last.s as number) - rep.s) < 1e-9,
                `rep ${rep.index}: last row at its x should be its own stability ` +
                    `(got ${last.s}, expected ${rep.s})`,
            );

            if (rep.index > 1 && rep.sBefore !== null) {
                assert.ok(atRep.length >= 2, `rep ${rep.index}: closes a segment too`);
                assert.ok(
                    Math.abs((atRep[0].s as number) - rep.sBefore) < 1e-9,
                    `rep ${rep.index}: first row at its x closes the previous segment`,
                );
            }
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

    it('opens the log view where Easy reaches the target retention', () => {
        // A log axis compresses its right-hand end, so the longest branch can be
        // followed to the target for almost no width.
        for (const target of [0.9, 0.8]) {
            const s = build(HISTORY, { scale: 'log', targetRetention: target })!;
            const easy = s.branches.find((b) => b.grade === 'easy')!;
            const elapsed = Math.pow(10, s.xDomain[1]) - s.nowDays;
            assert.ok(
                Math.abs(rAt(elapsed, easy.stability) - target) < 0.005,
                `Easy should be at the target on the opening edge (got ${rAt(elapsed, easy.stability)} for ${target})`,
            );
        }
    });

    it('opens the linear view while Good is still 6 points clear of the target', () => {
        // A linear axis pays for every extra day by squeezing the repetitions
        // that have happened, so it opens on the current stability instead.
        for (const target of [0.9, 0.8]) {
            const s = build(HISTORY, { scale: 'linear', targetRetention: target })!;
            const good = s.branches.find((b) => b.grade === 'good')!;
            const elapsed = s.xDomain[1] - s.nowDays;
            assert.ok(
                Math.abs(rAt(elapsed, good.stability) - (target + 0.06)) < 0.005,
                `Good should be 6pp above the target on the opening edge (got ${rAt(elapsed, good.stability)})`,
            );
        }
    });

    it('opens the log scale on a longer window than the linear one', () => {
        const log = build(HISTORY, { scale: 'log' })!;
        const linear = build(HISTORY, { scale: 'linear' })!;
        assert.ok(Math.pow(10, log.xDomain[1]) > linear.xDomain[1]);
        // Both still cover the card's whole history.
        for (const s of [log, linear]) {
            const viewEnd = s.scale === 'linear' ? s.xDomain[1] : Math.pow(10, s.xDomain[1]);
            assert.ok(viewEnd >= s.reps[s.reps.length - 1].days);
        }
    });

    it('keeps the forecast worth looking at after a lapse, without losing history', () => {
        // A lapse collapses stability to days while the history is still years,
        // so sizing the view by the forecast's own timescale ended it a few days
        // past `now` and left the branches in a fraction of a percent of the
        // width. The floor is a share of the card's age instead.
        const older = [840, 830, 800, 770, 700, 560, 420].map((d) => rep(d, QueueInteractionScore.GOOD));
        const lapsed = [...older, rep(1, QueueInteractionScore.AGAIN)];

        for (const scale of ['log', 'linear'] as const) {
            const s = build(lapsed, { scale })!;
            const viewEnd = scale === 'linear' ? s.xDomain[1] : Math.pow(10, s.xDomain[1]);
            assert.ok(
                viewEnd >= s.nowDays * 1.4 - 1e-6,
                `${scale}: view should reach 40% of the card's age past now (${viewEnd} vs ${s.nowDays})`,
            );
            // The whole history is still on screen — that is the point of
            // extending the right edge rather than trimming the left one.
            assert.ok(
                s.xDomain[0] <= s.reps[0].x + 1e-9,
                `${scale}: the first repetition is still inside the opening view`,
            );
        }
    });

    it('leaves a healthy card to the retention rule', () => {
        const older = [840, 830, 800, 770, 700, 560, 420].map((d) => rep(d, QueueInteractionScore.GOOD));
        const healthy = [...older, rep(1, QueueInteractionScore.GOOD)];

        for (const scale of ['log', 'linear'] as const) {
            const s = build(healthy, { scale })!;
            const viewEnd = scale === 'linear' ? s.xDomain[1] : Math.pow(10, s.xDomain[1]);
            assert.ok(
                viewEnd > s.nowDays * 1.4,
                `${scale}: the age floor should not bind on a card whose forecast is long`,
            );
        }
    });

    it('computes far past the opening view, so zooming out keeps finding curve', () => {
        for (const scale of ['log', 'linear'] as const) {
            const s = build(HISTORY, { scale })!;
            const easy = s.branches.find((b) => b.grade === 'easy')!;

            // The extent runs until Easy is as likely forgotten as recalled.
            assert.ok(
                Math.abs(rAt(s.axisMaxDays - s.nowDays, easy.stability) - 0.5) < 0.005,
                `${scale}: extent should reach 50% on Easy`,
            );
            // Which is well past where the chart opens.
            assert.ok(
                s.xFullDomain[1] > s.xDomain[1],
                `${scale}: there must be something to zoom out to`,
            );
            // And the rows really go there, rather than the axis claiming range
            // the data does not cover.
            const last = s.rows[s.rows.length - 1];
            assert.ok(Math.abs((last.easy as number) - 50) < 0.5, `${scale}: last row is the 50% point`);
        }
    });

    it('gives both scales the same extent, since only the opening view differs', () => {
        const log = build(HISTORY, { scale: 'log' })!;
        const linear = build(HISTORY, { scale: 'linear' })!;
        // Not exactly equal: `computeFSRSState` reads the wall clock rather than
        // the `now` this builder is given, so two calls a millisecond apart see
        // fractionally different retrievability — and the horizon multiplies
        // stability by about ninety, which magnifies that. Relative equality is
        // what the claim actually is.
        const drift = Math.abs(log.axisMaxDays - linear.axisMaxDays) / log.axisMaxDays;
        assert.ok(drift < 1e-3, `extents differ by ${(drift * 100).toFixed(4)}%`);
    });

    it('samples the forecast densely inside the opening view', () => {
        // The branches now span orders of magnitude more time than the window
        // they open in. Spacing them evenly across that would leave the visible
        // part with almost no points and draw it as a straight line — worst on
        // the linear scale, where the opening window is a sliver of the extent.
        for (const scale of ['log', 'linear'] as const) {
            const s = build(HISTORY, { scale })!;
            const inView = s.rows.filter(
                (r) => r.x > s.nowX && r.x <= s.xDomain[1] && typeof r.good === 'number',
            );
            assert.ok(inView.length >= 20, `${scale}: only ${inView.length} forecast samples on screen`);
        }
    });

    it('omits the branches when the forecast is switched off', () => {
        const s = build(HISTORY, { forecast: false })!;
        assert.equal(s.branches.length, 0);
        assert.ok(s.rows.every((r) => r.good == null));
        // Including on the stability panel, which grew its own branches later.
        assert.ok(s.rows.every((r) => r.goodSLog == null));
        assert.ok(s.rows.every((r) => r.noReview == null));
    });

    it('carries the card\'s own curve past now as the do-nothing baseline', () => {
        const s = build(HISTORY)!;
        const w = FSRS_DEFAULT_WEIGHTS;
        const decay = -w[20];
        const factor = Math.pow(0.9, 1 / decay) - 1;
        const lastRep = s.reps[s.reps.length - 1];

        const future = s.rows.filter((r) => typeof r.noReview === 'number');
        assert.ok(future.length > 10, `the baseline is drawn (${future.length} points)`);

        for (const row of future) {
            // Anchored on the last review, not on `now` — it is the same
            // segment continuing, so the two must agree exactly.
            const expected =
                forgettingCurve(row.days - lastRep.days, lastRep.s, decay, factor) * 100;
            assert.ok(
                Math.abs((row.noReview as number) - expected) < 1e-9,
                `baseline should continue the last segment (got ${row.noReview}, expected ${expected})`,
            );
            assert.ok(row.days >= s.nowDays - 1e-9, 'and only past now');
        }

        // It meets the history line where that one stops.
        const junction = future[0];
        assert.ok(Math.abs(junction.days - s.nowDays) < 1e-6);

        // At `now` every branch starts from a fresh review, so all four are
        // above the card's untouched curve.
        for (const g of CURVE_GRADES) {
            assert.ok((junction[g] as number) >= (junction.noReview as number));
        }
    });

    it('keeps the forecast worth looking at after a lapse, without losing history', () => {
        // A lapse collapses stability to days while the history is still years,
        // so sizing the view by the forecast's own timescale ended it a few days
        // past `now` and left the branches in a fraction of a percent of the
        // width. The floor is a share of the card's age instead.
        const older = [840, 830, 800, 770, 700, 560, 420].map((d) => rep(d, QueueInteractionScore.GOOD));
        const lapsed = [...older, rep(1, QueueInteractionScore.AGAIN)];

        for (const scale of ['log', 'linear'] as const) {
            const s = build(lapsed, { scale })!;
            const viewEnd = scale === 'linear' ? s.xDomain[1] : Math.pow(10, s.xDomain[1]);
            assert.ok(
                viewEnd >= s.nowDays * 1.4 - 1e-6,
                `${scale}: view should reach 40% of the card's age past now (${viewEnd} vs ${s.nowDays})`,
            );
            // The whole history is still on screen — that is the point of
            // extending the right edge rather than trimming the left one.
            assert.ok(
                s.xDomain[0] <= s.reps[0].x + 1e-9,
                `${scale}: the first repetition is still inside the opening view`,
            );
        }
    });

    it('leaves a healthy card to the retention rule', () => {
        const older = [840, 830, 800, 770, 700, 560, 420].map((d) => rep(d, QueueInteractionScore.GOOD));
        const healthy = [...older, rep(1, QueueInteractionScore.GOOD)];

        for (const scale of ['log', 'linear'] as const) {
            const s = build(healthy, { scale })!;
            const viewEnd = scale === 'linear' ? s.xDomain[1] : Math.pow(10, s.xDomain[1]);
            assert.ok(
                viewEnd > s.nowDays * 1.4,
                `${scale}: the age floor should not bind on a card whose forecast is long`,
            );
        }
    });

    it('computes far past the opening view, so zooming out keeps finding curve', () => {
        for (const scale of ['log', 'linear'] as const) {
            const s = build(HISTORY, { scale })!;
            const easy = s.branches.find((b) => b.grade === 'easy')!;

            // The extent runs until Easy is as likely forgotten as recalled.
            assert.ok(
                Math.abs(rAt(s.axisMaxDays - s.nowDays, easy.stability) - 0.5) < 0.005,
                `${scale}: extent should reach 50% on Easy`,
            );
            // Which is well past where the chart opens.
            assert.ok(
                s.xFullDomain[1] > s.xDomain[1],
                `${scale}: there must be something to zoom out to`,
            );
            // And the rows really go there, rather than the axis claiming range
            // the data does not cover.
            const last = s.rows[s.rows.length - 1];
            assert.ok(Math.abs((last.easy as number) - 50) < 0.5, `${scale}: last row is the 50% point`);
        }
    });

    it('gives both scales the same extent, since only the opening view differs', () => {
        const log = build(HISTORY, { scale: 'log' })!;
        const linear = build(HISTORY, { scale: 'linear' })!;
        // Not exactly equal: `computeFSRSState` reads the wall clock rather than
        // the `now` this builder is given, so two calls a millisecond apart see
        // fractionally different retrievability — and the horizon multiplies
        // stability by about ninety, which magnifies that. Relative equality is
        // what the claim actually is.
        const drift = Math.abs(log.axisMaxDays - linear.axisMaxDays) / log.axisMaxDays;
        assert.ok(drift < 1e-3, `extents differ by ${(drift * 100).toFixed(4)}%`);
    });

    it('samples the forecast densely inside the opening view', () => {
        // The branches now span orders of magnitude more time than the window
        // they open in. Spacing them evenly across that would leave the visible
        // part with almost no points and draw it as a straight line — worst on
        // the linear scale, where the opening window is a sliver of the extent.
        for (const scale of ['log', 'linear'] as const) {
            const s = build(HISTORY, { scale })!;
            const inView = s.rows.filter(
                (r) => r.x > s.nowX && r.x <= s.xDomain[1] && typeof r.good === 'number',
            );
            assert.ok(inView.length >= 20, `${scale}: only ${inView.length} forecast samples on screen`);
        }
    });

    it('omits the branches when the forecast is switched off', () => {
        const s = build(HISTORY, { forecast: false })!;
        assert.equal(s.branches.length, 0);
        assert.ok(s.rows.every((r) => r.good == null));
        // Including on the stability panel, which grew its own branches later.
        assert.ok(s.rows.every((r) => r.goodSLog == null));
    });

    it('ends a forecast-less view at now, with the history intact', () => {
        // What the history popup asks for: the card up to the present moment
        // and not a step further, since nothing is about to be answered there.
        for (const scale of ['log', 'linear'] as const) {
            const withForecast = build(HISTORY, { scale })!;
            const s = build(HISTORY, { scale, forecast: false })!;

            const end = scale === 'linear' ? s.xDomain[1] : Math.pow(10, s.xDomain[1]);
            assert.ok(
                Math.abs(end - s.nowDays) < 1e-6,
                `${scale}: view should stop at now (${end} vs ${s.nowDays})`,
            );
            // Nothing to zoom out to either — the data ends where the view does.
            assert.ok(Math.abs(s.xFullDomain[1] - s.xDomain[1]) < 1e-9, `${scale}: no hidden tail`);
            assert.ok(withForecast.xDomain[1] > s.xDomain[1], `${scale}: the queue view reaches further`);

            // Every repetition is still drawn.
            assert.equal(s.reps.length, withForecast.reps.length);
            assert.ok(s.rows.some((r) => typeof r.r === 'number'), `${scale}: the history curve is there`);
        }
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
            // Against the full extent, not the opening view: the forecast is
            // deliberately computed past what the chart shows at rest.
            for (const row of s.rows) {
                assert.ok(
                    row.x >= s.xFullDomain[0] - 1e-9 && row.x <= s.xFullDomain[1] + 1e-9,
                    `${scale}: row inside the extent`,
                );
            }
            assert.ok(s.ticks.length > 0, `${scale}: has ticks`);
        }
    });

    it('keeps axis ticks apart and always marks the right edge', () => {
        for (const scale of ['log', 'linear'] as const) {
            const s = build(HISTORY, { scale })!;
            const span = s.xDomain[1] - s.xDomain[0];

            assert.ok(s.ticks.length >= 2, `${scale}: more than one tick`);

            // The end of the axis is where the forecast stops; it must be legible.
            const last = s.ticks[s.ticks.length - 1];
            assert.ok(
                Math.abs(last.value - s.xDomain[1]) < 1e-9,
                `${scale}: the last tick sits on the right edge`,
            );

            for (let i = 1; i < s.ticks.length; i++) {
                const gap = s.ticks[i].value - s.ticks[i - 1].value;
                // An unlabelled half-chart: what the shared candidate list did
                // to the right-hand tail of a linear axis.
                assert.ok(gap <= span * 0.45, `${scale}: ticks ${i - 1}/${i} too far apart (${gap})`);
            }

            const labels = s.ticks.map((t) => t.label);
            assert.equal(new Set(labels).size, labels.length, `${scale}: no repeated tick labels`);
        }
    });

    it('spaces ticks by the width it is given, at every width', () => {
        for (const scale of ['log', 'linear'] as const) {
            const s = build(HISTORY, { scale })!;
            const span = s.xDomain[1] - s.xDomain[0];
            for (const width of [360, 560, 1200, 1850]) {
                const ticks = rebuildTicks(s, width);
                const minGap = span * tickMinGap(width);
                for (let i = 1; i < ticks.length; i++) {
                    const gap = ticks[i].value - ticks[i - 1].value;
                    assert.ok(
                        gap >= minGap * 0.999,
                        `${scale} @${width}px: "${ticks[i - 1].label}"/"${ticks[i].label}" overlap (${gap} < ${minGap})`,
                    );
                }
                assert.ok(
                    Math.abs(ticks[ticks.length - 1].value - s.xDomain[1]) < 1e-9,
                    `${scale} @${width}px: right edge marked`,
                );
                const labels = ticks.map((t) => t.label);
                assert.equal(new Set(labels).size, labels.length, `${scale} @${width}px: labels unique`);
            }
        }
    });

    it('labels the whole axis when zoomed right out', () => {
        // The extent reaches centuries, so the candidate ladder has to as well:
        // stopping at ten years left the entire tail of a log axis unlabelled.
        for (const scale of ['log', 'linear'] as const) {
            const s = build(HISTORY, { scale })!;
            const ticks = rebuildTicks(s, 1850, s.xFullDomain);
            const span = s.xFullDomain[1] - s.xFullDomain[0];
            assert.ok(ticks.length >= 4, `${scale}: ${ticks.length} ticks across the extent`);
            for (let i = 1; i < ticks.length; i++) {
                const gap = ticks[i].value - ticks[i - 1].value;
                assert.ok(
                    gap <= span * 0.45,
                    `${scale}: nothing between "${ticks[i - 1].label}" and "${ticks[i].label}"`,
                );
            }
        }
    });

    it('subdivides the crowded left of a linear axis when the width allows', () => {
        const s = build(HISTORY, { scale: 'linear' })!;
        // Every repetition of a mature card lands in the first fraction of a
        // linear axis. A wide chart should put readable marks in there; a narrow
        // one honestly cannot, and must not pretend otherwise.
        const narrow = rebuildTicks(s, 360).map((t) => t.label);
        const wide = rebuildTicks(s, 1850).map((t) => t.label);
        assert.ok(wide.length > narrow.length, `wide gains ticks (${wide.length} vs ${narrow.length})`);

        const firstCoarse = s.xDomain[1] * 0.2;
        const inLeftZone = (labels: string[], width: number) =>
            rebuildTicks(s, width).filter((t) => t.value > 0 && t.value <= firstCoarse).length;
        assert.ok(
            inLeftZone(wide, 1850) >= 2,
            'a wide linear axis carries several marks in the short-term zone',
        );
    });

    it('re-ticks a zoomed range without leaving it', () => {
        for (const scale of ['log', 'linear'] as const) {
            const s = build(HISTORY, { scale })!;
            const [lo, hi] = s.xDomain;
            // A window over the middle of the axis, as a drag-select would give.
            const window: [number, number] = [lo + (hi - lo) * 0.35, lo + (hi - lo) * 0.6];
            const ticks = rebuildTicks(s, 1200, window);

            assert.ok(ticks.length >= 2, `${scale}: a zoomed range still gets ticks`);
            for (const t of ticks) {
                assert.ok(
                    t.value >= window[0] - 1e-9 && t.value <= window[1] + 1e-9,
                    `${scale}: tick "${t.label}" at ${t.value} escaped ${window}`,
                );
            }

            const minGap = (window[1] - window[0]) * tickMinGap(1200);
            for (let i = 1; i < ticks.length; i++) {
                assert.ok(
                    ticks[i].value - ticks[i - 1].value >= minGap * 0.999,
                    `${scale}: zoomed ticks "${ticks[i - 1].label}"/"${ticks[i].label}" overlap`,
                );
            }

            assert.ok(
                Math.abs(ticks[ticks.length - 1].value - window[1]) < 1e-9,
                `${scale}: the zoomed right edge is marked`,
            );
            const labels = ticks.map((t) => t.label);
            assert.equal(new Set(labels).size, labels.length, `${scale}: zoomed labels unique`);
        }
    });

    it('survives a range handed to it from the other scale', () => {
        // Switching scale while zoomed used to feed the old scale's coordinates
        // to the new one for a single render. A linear x of ~800 (days) through
        // the log axis's 10^x is Infinity, and the tick loop's `i++` never
        // advances past that — it hung, and took the widget down with no error.
        const linear = build(HISTORY, { scale: 'linear' })!;
        const log = build(HISTORY, { scale: 'log' })!;

        for (const [series, foreign] of [
            [log, linear.xDomain],
            [linear, log.xDomain],
        ] as const) {
            const ticks = rebuildTicks(series, 1200, foreign as [number, number]);
            assert.ok(ticks.length > 0, `${series.scale}: still produces ticks`);
            assert.ok(ticks.length <= 64, `${series.scale}: bounded (${ticks.length})`);
            for (const t of ticks) {
                assert.ok(Number.isFinite(t.value), `${series.scale}: finite tick ${t.label}`);
            }
        }
    });

    it('falls back to the full range for a domain it cannot make sense of', () => {
        const s = build(HISTORY, { scale: 'log' })!;
        const full = rebuildTicks(s, 1200);
        for (const nonsense of [
            [NaN, 10],
            [0, Infinity],
            [5, 1],
            [Infinity, Infinity],
        ] as [number, number][]) {
            const ticks = rebuildTicks(s, 1200, nonsense);
            assert.deepEqual(
                ticks.map((t) => t.label),
                full.map((t) => t.label),
                `${JSON.stringify(nonsense)} should fall back to the whole axis`,
            );
        }
    });

    it('starts the log axis at half a day once the card is older than its learning steps', () => {
        // Learning steps at 0, 4m and 20m, then a rep at one day: the minutes
        // must not claim the left of the axis, and the one-day rep must not be
        // pinned to its edge.
        const start = 2000;
        const history = [
            rep(start, QueueInteractionScore.GOOD),
            rep(start - 4 / 1440, QueueInteractionScore.GOOD),
            rep(start - 20 / 1440, QueueInteractionScore.GOOD),
            rep(start - 1, QueueInteractionScore.GOOD),
            rep(start - 5, QueueInteractionScore.GOOD),
        ];
        const s = build(history, { scale: 'log' })!;
        assert.ok(Math.abs(s.xDomain[0] - Math.log10(0.5)) < 1e-9, `axis starts at ${Math.pow(10, s.xDomain[0])}d`);
        assert.ok(s.reps[3].x > s.xDomain[0] + 0.25, 'the one-day rep sits clear of the left edge');
        assert.ok(!s.ticks.some((t) => /m$|h$/.test(t.label)), `no sub-day ticks: ${s.ticks.map((t) => t.label)}`);

        // A card still inside its first day has nothing else to show.
        const young = build([rep(0.02, QueueInteractionScore.GOOD), rep(0.01, QueueInteractionScore.GOOD)], {
            scale: 'log',
        })!;
        assert.ok(Math.pow(10, young.xDomain[0]) < 0.1);
    });

    it('covers a short-lived card without flooding it with ticks', () => {
        // Three reps inside twenty minutes: the axis is minutes wide, and the
        // step has to shrink with it without producing a tick per minute.
        const history = [
            rep(0.02, QueueInteractionScore.AGAIN),
            rep(0.015, QueueInteractionScore.GOOD),
            rep(0.01, QueueInteractionScore.GOOD),
        ];
        for (const scale of ['log', 'linear'] as const) {
            const s = build(history, { scale })!;
            assert.ok(s.ticks.length >= 2 && s.ticks.length <= 12, `${scale}: ${s.ticks.length} ticks`);
        }
    });

    it('never clips the target retention line off the y axis', () => {
        const s = build(HISTORY, { targetRetention: 0.97 })!;
        assert.ok(s.yDomain[0] <= s.targetPercent);
        assert.equal(s.yDomain[1], 100);
    });
});

describe('formatCurveDays', () => {
    it('picks a unit that reads', () => {
        assert.equal(formatCurveDays(10 / 1440), '10m');
        assert.equal(formatCurveDays(6 / 24), '6h');
        assert.equal(formatCurveDays(1), '1.0d');
        assert.equal(formatCurveDays(7), '7d');
        assert.equal(formatCurveDays(21), '3w');
        // Months start at four weeks, so a one-month axis step is not "4w".
        assert.equal(formatCurveDays(365.25 / 12), '1mo');
        assert.equal(formatCurveDays(200), '7mo');
        assert.equal(formatCurveDays(400), '1.1y');
        // Years keep a decimal: this labels the right edge, wherever it lands.
        assert.equal(formatCurveDays(5337), '14.6y');
    });
});
