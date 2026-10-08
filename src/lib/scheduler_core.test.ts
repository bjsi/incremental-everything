/**
 * Fixture tests for the IncRem scheduling maths. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncrementalRep } from './incremental_rem/types';
import {
  computeCurveInterval,
  computeMultiplierInterval,
  computeNextInterval,
  getCurrentInterval,
  overrideForChoice,
  parseSchedulerOverride,
  previewMultiplierIntervals,
  resolveInitialInterval,
  resolveInheritedScheduler,
  resolveScheduler,
  schedulerTypeGroup,
  serializeSchedulerOverride,
} from './scheduler_core';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const entry = (day: number, over: Partial<IncrementalRep> = {}): IncrementalRep => ({
  date: T0 + day * DAY,
  scheduled: T0 + day * DAY,
  ...over,
});

describe('multiplier interval', () => {
  it('multiplies the current interval and rounds up', () => {
    assert.equal(computeMultiplierInterval(50, 1.5), 75);
    assert.equal(computeMultiplierInterval(75, 1.5), 113);
  });
  it('grows from a one-day start much like the old factor^N', () => {
    assert.deepEqual(previewMultiplierIntervals(1, 1.5, 6), [2, 3, 5, 8, 12, 18]);
  });
  it('always leaves a 0-day interval', () => {
    assert.equal(computeMultiplierInterval(0, 1.5), 2);
    assert.equal(computeMultiplierInterval(0, 1.05), 2);
  });
  it('moves at least a day when the factor is above 1', () => {
    assert.equal(computeMultiplierInterval(3, 1.1), 4);
  });
  it('keeps the interval constant at factor 1', () => {
    assert.equal(computeMultiplierInterval(50, 1), 50);
    assert.equal(computeMultiplierInterval(0, 1), 1);
  });
});

describe('initial interval', () => {
  it('uses the type value when set, including 0', () => {
    assert.equal(resolveInitialInterval('30', 1), 30);
    assert.equal(resolveInitialInterval(' 0 ', 5), 0);
  });
  it('falls back to the general setting when empty or unusable', () => {
    assert.equal(resolveInitialInterval('', 3), 3);
    assert.equal(resolveInitialInterval(undefined, 3), 3);
    assert.equal(resolveInitialInterval('soon', 3), 3);
    assert.equal(resolveInitialInterval('-2', 3), 3);
    assert.equal(resolveInitialInterval('1.5', 3), 3);
  });
});

describe('curve interval', () => {
  it('matches the documented progression', () => {
    assert.deepEqual(
      [1, 2, 3, 5, 10, 20].map((n) => computeCurveInterval(n, 5, 30)),
      [5, 10, 14, 18, 23, 26]
    );
  });
});

describe('current interval', () => {
  it('reads the interval chosen at creation', () => {
    const history = [entry(0, { eventType: 'madeIncremental', interval: 50 })];
    assert.equal(getCurrentInterval(history), 50);
  });
  it('follows an editor reschedule and a manual date edit', () => {
    const history = [
      entry(0, { eventType: 'madeIncremental', interval: 1 }),
      entry(1, { interval: 2 }),
      entry(2, { eventType: 'rescheduledInEditor', interval: 40 }),
    ];
    assert.equal(getCurrentInterval(history), 40);
    history.push(entry(3, { eventType: 'manualDateReset', interval: 9 }));
    assert.equal(getCurrentInterval(history), 9);
  });
  it('skips markers and swipe gestures', () => {
    const history = [
      entry(0, { eventType: 'madeIncremental', interval: 50 }),
      entry(50, { interval: 75 }),
      entry(125, { interval: 1, keepsInterval: true }),
      entry(125, { eventType: 'priorityChange', priority: 10 }),
      entry(125, { eventType: 'externalRep' }),
    ];
    assert.equal(getCurrentInterval(history), 75);
  });
  it('does not look past the last madeIncremental marker', () => {
    const history = [
      entry(0, { interval: 90 }),
      entry(1, { eventType: 'dismissed' }),
      entry(2, { eventType: 'madeIncremental' }),
    ];
    assert.equal(getCurrentInterval(history), null);
  });
  it('recovers the interval from the next-rep stamp', () => {
    const history = [entry(0, { nextRepMs: T0 + 12 * DAY })];
    assert.equal(getCurrentInterval(history), 12);
  });
});

describe('next interval', () => {
  const base = { curveFirstInterval: 5, curveMaxInterval: 30 };
  it('carries a chosen interval forward on the multiplier scheduler', () => {
    assert.equal(
      computeNextInterval({
        ...base,
        scheduler: { kind: 'multiplier', factor: 1.5 },
        reviewNumber: 1,
        currentInterval: 50,
      }),
      75
    );
  });
  it('ignores it on the curve', () => {
    assert.equal(
      computeNextInterval({
        ...base,
        scheduler: { kind: 'curve', factor: 1.5 },
        reviewNumber: 1,
        currentInterval: 50,
      }),
      5
    );
  });
  it('falls back to factor^N when no interval was ever recorded', () => {
    assert.equal(
      computeNextInterval({
        ...base,
        scheduler: { kind: 'multiplier', factor: 1.5 },
        reviewNumber: 10,
        currentInterval: null,
      }),
      58
    );
  });
});

describe('scheduler resolution', () => {
  const settings = { defaultKind: 'curve' as const, defaultFactor: 1.5 };
  it('layers item over type over default', () => {
    const fromDefault = resolveInheritedScheduler({ ...settings, typeDefault: 'default' });
    assert.deepEqual(fromDefault, { kind: 'curve', factor: 1.5, source: 'default' });
    const fromType = resolveInheritedScheduler({ ...settings, typeDefault: 'multiplier' });
    assert.deepEqual(fromType, { kind: 'multiplier', factor: 1.5, source: 'type' });
    assert.deepEqual(resolveScheduler({ kind: 'multiplier', factor: 2 }, fromDefault), {
      kind: 'multiplier',
      factor: 2,
      source: 'item',
    });
    assert.deepEqual(resolveScheduler({ kind: 'curve' }, fromType), {
      kind: 'curve',
      factor: 1.5,
      source: 'item',
    });
  });
  it('stores an override only when the choice differs from the settings', () => {
    const curve = resolveInheritedScheduler({ ...settings, typeDefault: 'default' });
    const mult = resolveInheritedScheduler({ ...settings, typeDefault: 'multiplier' });
    assert.equal(overrideForChoice({ kind: 'curve', factor: 1.5 }, curve), null);
    assert.deepEqual(overrideForChoice({ kind: 'multiplier', factor: 1.5 }, curve), {
      kind: 'multiplier',
    });
    assert.deepEqual(overrideForChoice({ kind: 'multiplier', factor: 2 }, curve), {
      kind: 'multiplier',
      factor: 2,
    });
    assert.equal(overrideForChoice({ kind: 'multiplier', factor: 1.5 }, mult), null);
    assert.deepEqual(overrideForChoice({ kind: 'multiplier', factor: 1.2 }, mult), {
      kind: 'multiplier',
      factor: 1.2,
    });
    assert.deepEqual(overrideForChoice({ kind: 'curve', factor: 1.5 }, mult), { kind: 'curve' });
  });
  it('round-trips the slot text', () => {
    for (const text of ['curve', 'mult', 'mult:2.5']) {
      assert.equal(serializeSchedulerOverride(parseSchedulerOverride(text)!), text);
    }
    assert.equal(parseSchedulerOverride(''), null);
    assert.equal(parseSchedulerOverride(undefined), null);
    assert.deepEqual(parseSchedulerOverride('mult:99'), { kind: 'multiplier', factor: 10 });
  });
  it('groups action-item types', () => {
    assert.equal(schedulerTypeGroup('pdf'), 'documents');
    assert.equal(schedulerTypeGroup('youtube'), 'videos');
    assert.equal(schedulerTypeGroup('pdf-highlight'), 'highlights');
    assert.equal(schedulerTypeGroup('rem'), 'rems');
    assert.equal(schedulerTypeGroup(null), 'rems');
  });
});
