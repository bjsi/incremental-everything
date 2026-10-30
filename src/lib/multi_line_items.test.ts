/**
 * Tests for the items of a multi-line card. Run with `npm test`.
 * WEIGHTS and the card below are a real set card, whose values were checked against
 * RemNote's own Bullet Information (findings/MULTI_LINE_SUB_CARDS.md).
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RepetitionStatusInterface } from '@remnote/plugin-sdk';
import {
  describeMultiLineCard,
  endOfRemNoteDay,
  nextTestLabel,
  repItemMarks,
  summarizeMultiLineCard,
} from './multi_line_items';

const WEIGHTS = [
  3.973, 13.618, 43.322, 100, 7.011, 0.46, 2.096, 0.15, 2.5, 0.27, 1.081, 1.601, 0.068, 0.504, 1.387, 0.011, 3,
  0.546, 0.08, 0.066, 0.118,
];
const DAY = 24 * 60 * 60 * 1000;
const [A, B, C] = ['itemA', 'itemB', 'itemC'];
const names: Record<string, string> = { [A]: 'com dois', [B]: 'ou dão-se', [C]: 'constituída' };
const nameOf = (id: string) => names[id];

const rep = (date: number, score: number, scores?: Record<string, number>, full = true) =>
  ({
    date,
    score,
    ...(scores
      ? {
          isFullMultiLineRep: full,
          subCardScores: Object.entries(scores).map(([remId, s]) => ({ remId, score: s, responseTime: 1 })),
        }
      : {}),
  } as RepetitionStatusInterface);

const all = (score: number) => ({ [A]: score, [B]: score, [C]: score });

const REAL_CARD = [
  rep(1714375318988, 1.5, all(1.5)),
  rep(1715762302045, 1, all(1)),
  rep(1745404071522, 0, {}),
  rep(1745428382740, 0, {}),
  rep(1745438584423, 1, all(1)),
  rep(1747660153316, 1, all(1)),
  rep(1793358817393, 0.5, { [A]: 0.5, [B]: 0, [C]: 0.5 }),
];
const AFTER = 1793358817393 + 2 * 60 * 60 * 1000;

const summarize = (history: RepetitionStatusInterface[], over = {}) =>
  summarizeMultiLineCard({
    history,
    weights: WEIGHTS,
    retention: 0.9,
    nextRepetitionTime: 1793358817393 + 90 * 60 * 1000,
    now: AFTER,
    useModel: true,
    ...over,
  });

describe('a real set card after forgetting one item', () => {
  const summary = summarize(REAL_CARD)!;

  it('reproduces the stability RemNote shows for each item', () => {
    const stability = (id: string) => summary.items.find((item) => item.remId === id)!.stability!;
    assert.ok(Math.abs(stability(B) - 13.34087437) < 0.01);
    assert.ok(Math.abs(stability(A) - 56.61310193) < 0.3);
    assert.ok(Math.abs(stability(C) - 56.61310193) < 0.3);
  });

  it('marks all three as in trouble, and the forgotten item as setting the date', () => {
    assert.ok(summary.items.every((item) => item.troubled));
    assert.deepEqual(summary.driverIds, [B]);
  });

  it('tests only the forgotten item next, and lists it first', () => {
    assert.deepEqual(summary.nextTest, [B]);
    assert.equal(summary.items[0].remId, B);
    assert.deepEqual(summary.items[0].lastScores, [1, 0]);
  });

  it('explains it in plain words', () => {
    const { reason, next } = describeMultiLineCard(summary, nameOf, AFTER);
    assert.match(reason!, /^Back early because you forgot "ou dão-se" on /);
    assert.match(next, /^Next time it tests only "ou dão-se"\. The full card returns around /);
  });

  it('labels the other items with the full card', () => {
    assert.equal(nextTestLabel(summary.items[0], summary, AFTER), 'Next time');
    assert.match(nextTestLabel(summary.items[1], summary, AFTER), /^Full card, ~/);
  });
});

describe('summarizeMultiLineCard', () => {
  const T = Date.UTC(2026, 0, 10, 15);

  it('returns null for an ordinary card', () => {
    assert.equal(summarize([rep(T, 1), rep(T + 10 * DAY, 1)], { now: T + 11 * DAY }), null);
  });

  it('forgets everything before a Reset', () => {
    const summary = summarize([rep(T, 1, { old: 1 }), rep(T + DAY, 3), rep(T + 2 * DAY, 1, { [A]: 1 })], {
      now: T + 3 * DAY,
    })!;
    assert.deepEqual(summary.items.map((item) => item.remId), [A]);
  });

  it('tracks only the items scored since the last full rep', () => {
    const summary = summarize([rep(T, 1, { gone: 1, [A]: 1 }), rep(T + 9 * DAY, 1, { [A]: 1, [B]: 1 })], {
      now: T + 10 * DAY,
    })!;
    assert.deepEqual(summary.items.map((item) => item.remId).sort(), [A, B].sort());
  });

  it('counts a rep with no item scores for every item', () => {
    const history = [rep(T, 1, all(1)), rep(T + 30 * DAY, 0, {}, true)];
    history[1] = { ...history[1], isFullMultiLineRep: false } as RepetitionStatusInterface;
    const summary = summarize(history, { now: T + 31 * DAY })!;
    assert.ok(summary.items.every((item) => item.lastScores.join() === '1,0' && item.troubled));
  });

  it('clears an item after two good answers in a row', () => {
    const history = [
      rep(T, 1, all(1)),
      rep(T + 30 * DAY, 1, { [A]: 0, [B]: 1, [C]: 1 }),
      rep(T + 30 * DAY + 3 * 60 * 60 * 1000, 1, { [A]: 1 }, false),
      rep(T + 45 * DAY, 1, { [A]: 1 }, false),
    ];
    const summary = summarize(history, { now: T + 46 * DAY })!;
    assert.ok(summary.items.every((item) => !item.troubled));
    assert.equal(summary.nextTest, 'full');
    assert.deepEqual(summary.driverIds, []);
    const { reason } = describeMultiLineCard(summary, nameOf, T + 46 * DAY);
    assert.equal(reason, 'On its normal schedule.');
  });

  it('tests the full card when the main card is due, even with an item in trouble', () => {
    const history = [rep(T, 1, all(1)), rep(T + 30 * DAY, 1, { [A]: 0, [B]: 1, [C]: 1 })];
    const summary = summarize(history, { now: T + 5000 * DAY })!;
    assert.equal(summary.mainDue, true);
    assert.equal(summary.nextTest, 'full');
    assert.equal(describeMultiLineCard(summary, nameOf, T + 5000 * DAY).next, 'Due for the full card.');
  });

  it('tests the full card when every item would be selected', () => {
    const history = [rep(T, 1, all(1)), rep(T + 30 * DAY, 0.5, all(0.5))];
    assert.equal(summarize(history, { now: T + 31 * DAY })!.nextTest, 'full');
  });

  it('partial reps leave the main card alone', () => {
    const base = [rep(T, 1, all(1)), rep(T + 30 * DAY, 1, { [A]: 0, [B]: 1, [C]: 1 })];
    const withPartial = [...base, rep(T + 31 * DAY, 0, { [A]: 0 }, false)];
    const now = T + 32 * DAY;
    assert.equal(summarize(withPartial, { now })!.mainDate, summarize(base, { now })!.mainDate);
  });

  it('without a model, reports what the scores alone decide', () => {
    const summary = summarize(REAL_CARD, { useModel: false })!;
    assert.ok(summary.items.every((item) => item.stability === null && item.nextDate === null));
    assert.deepEqual(summary.nextTest, [B]);
    assert.equal(summary.mainDate, null);
    assert.equal(nextTestLabel(summary.items[1], summary, AFTER), 'Full card');
    const { reason, next } = describeMultiLineCard(summary, nameOf, AFTER);
    assert.equal(reason, null);
    assert.equal(next, 'Next time it tests only "ou dão-se". The full card returns when the main card is due.');
  });
});

describe('repItemMarks', () => {
  const summary = summarize(REAL_CARD)!;

  it('marks a full rep per item', () => {
    const marks = repItemMarks(REAL_CARD[6], summary)!;
    assert.equal(marks.partial, false);
    assert.equal(marks.tested, 3);
    assert.equal(marks.marks.find((m) => m.remId === B)!.score, 0);
  });

  it('counts a Forgot all for every item', () => {
    const marks = repItemMarks(REAL_CARD[2], summary)!;
    assert.ok(marks.marks.every((m) => m.score === 0));
  });

  it('marks a partial rep with how many items it tested', () => {
    const marks = repItemMarks(rep(AFTER, 1, { [B]: 1 }, false), summary)!;
    assert.equal(marks.partial, true);
    assert.equal(marks.tested, 1);
    assert.equal(marks.marks.find((m) => m.remId === A)!.score, null);
  });

  it('shows nothing for a rep that scored no item', () => {
    assert.equal(repItemMarks(rep(AFTER, 2), summary), null);
  });
});

describe('endOfRemNoteDay', () => {
  it('ends the day at the default 4am start', () => {
    const noon = new Date(2026, 5, 10, 12).getTime();
    const end = new Date(endOfRemNoteDay(noon));
    assert.equal(end.getDate(), 11);
    assert.equal(end.getHours(), 3);
    const beforeDayStart = new Date(2026, 5, 10, 2).getTime();
    assert.equal(new Date(endOfRemNoteDay(beforeDayStart)).getDate(), 10);
  });
});
