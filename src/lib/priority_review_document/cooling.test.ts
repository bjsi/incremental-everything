/**
 * Fixture tests for the pure cooling engine. Run with `npm test`.
 * Uses node's built-in runner so no test framework is added to the bundle.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardIntervalDays,
  cardLastSeenAt,
  coolingWindowDays,
  DAY_MS,
  DEFAULT_COOLING_PARAMS,
  EMPTY_COOLING_OVERRIDES,
  evaluateCooling,
  excludeCooling,
  isCardDue,
  pruneCoolingOverrides,
  CoolingCandidate,
  SpoilerSeenEvent,
} from './cooling';

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const daysAgo = (d: number) => NOW - d * DAY_MS;

const seen = (over: Partial<SpoilerSeenEvent> = {}): SpoilerSeenEvent => ({
  relation: 'same-rem',
  sourceRemId: 'sib',
  cardId: 'sib-card',
  seenAt: daysAgo(1),
  stillDue: false,
  ...over,
});

const candidate = (over: Partial<CoolingCandidate> = {}): CoolingCandidate => ({
  remId: 'r1',
  dueCards: [{ cardId: 'c1', intervalDays: 100 }],
  seen: [seen()],
  ...over,
});

describe('coolingWindowDays', () => {
  it('follows the documented table with the default parameters', () => {
    assert.equal(coolingWindowDays(10), 1);
    assert.equal(coolingWindowDays(60), 3);
    assert.equal(coolingWindowDays(200), 10);
    assert.equal(coolingWindowDays(365), 15);
    assert.equal(coolingWindowDays(3000), 15);
  });
  it('never drops below the minimum, even for a new card', () => {
    assert.equal(coolingWindowDays(0), 1);
    assert.equal(coolingWindowDays(-5), 1);
  });
  it('honours custom parameters and keeps max >= min', () => {
    assert.equal(coolingWindowDays(100, { intervalFraction: 0.1, minDays: 2, maxDays: 30 }), 10);
    assert.equal(coolingWindowDays(100, { intervalFraction: 0.1, minDays: 20, maxDays: 5 }), 20);
  });
});

describe('card facts', () => {
  it('reads the last VIEWED repetition, ignoring reset and manual entries', () => {
    const card = {
      _id: 'c',
      repetitionHistory: [
        { date: daysAgo(10), score: 1 },
        { date: daysAgo(2), score: 3 }, // RESET
        { date: daysAgo(1), score: 4 }, // MANUAL_DATE
      ],
    };
    assert.equal(cardLastSeenAt(card), daysAgo(10));
  });
  it('counts TOO_EARLY as a viewing', () => {
    assert.equal(cardLastSeenAt({ _id: 'c', repetitionHistory: [{ date: daysAgo(3), score: 0.01 }] }), daysAgo(3));
  });
  it('falls back to lastRepetitionTime and then to null', () => {
    assert.equal(cardLastSeenAt({ _id: 'c', lastRepetitionTime: daysAgo(4) }), daysAgo(4));
    assert.equal(cardLastSeenAt({ _id: 'c' }), null);
  });
  it('derives the interval from next due minus last seen, 0 when unknown', () => {
    const card = { _id: 'c', nextRepetitionTime: daysAgo(-20), repetitionHistory: [{ date: daysAgo(80), score: 1 }] };
    assert.equal(Math.round(cardIntervalDays(card)), 100);
    assert.equal(cardIntervalDays({ _id: 'c', nextRepetitionTime: NOW }), 0);
    assert.equal(cardIntervalDays({ _id: 'c', nextRepetitionTime: daysAgo(5), repetitionHistory: [{ date: daysAgo(1), score: 1 }] }), 0);
  });
  it('treats an unscheduled card as never due', () => {
    assert.equal(isCardDue({ _id: 'c' }, NOW), false);
    assert.equal(isCardDue({ _id: 'c', nextRepetitionTime: null }, NOW), false);
    assert.equal(isCardDue({ _id: 'c', nextRepetitionTime: NOW }, NOW), true);
    assert.equal(isCardDue({ _id: 'c', nextRepetitionTime: NOW + 1 }, NOW), false);
  });
});

describe('evaluateCooling', () => {
  it('cools a rem whose sibling was graded inside the window', () => {
    const v = evaluateCooling(candidate(), NOW);
    assert.ok(v);
    assert.equal(v.windowDays, 5);
    assert.equal(v.until, daysAgo(1) + 5 * DAY_MS);
    assert.equal(v.reasons.length, 1);
    assert.equal(v.reasons[0].relation, 'same-rem');
  });
  it('returns null without due cards', () => {
    assert.equal(evaluateCooling(candidate({ dueCards: [] }), NOW), null);
  });
  it('ignores a sibling that is itself still due', () => {
    assert.equal(evaluateCooling(candidate({ seen: [seen({ stillDue: true })] }), NOW), null);
  });
  it('ignores an event whose window has run out', () => {
    assert.equal(evaluateCooling(candidate({ seen: [seen({ seenAt: daysAgo(6) })] }), NOW), null);
    assert.ok(evaluateCooling(candidate({ seen: [seen({ seenAt: daysAgo(4.9) })] }), NOW));
  });
  it('uses the LONGEST due interval to size the window', () => {
    const v = evaluateCooling(
      candidate({
        dueCards: [
          { cardId: 'a', intervalDays: 10 },
          { cardId: 'b', intervalDays: 400 },
        ],
        seen: [seen({ seenAt: daysAgo(12) })],
      }),
      NOW
    );
    assert.ok(v);
    assert.equal(v.windowDays, 15);
    assert.equal(v.intervalDays, 400);
  });
  it('a new card is buried for the minimum window', () => {
    const v = evaluateCooling(candidate({ dueCards: [{ cardId: 'n', intervalDays: 0 }], seen: [seen({ seenAt: NOW - 3600_000 })] }), NOW);
    assert.ok(v);
    assert.equal(v.windowDays, 1);
  });
  it('cools until the latest reason and lists reasons latest-first', () => {
    const v = evaluateCooling(
      candidate({
        seen: [
          seen({ seenAt: daysAgo(3), relation: 'descendant', sourceRemId: 'd' }),
          seen({ seenAt: daysAgo(1), relation: 'cloze-sibling', sourceRemId: 's' }),
        ],
      }),
      NOW
    );
    assert.ok(v);
    assert.equal(v.until, daysAgo(1) + 5 * DAY_MS);
    assert.deepEqual(v.reasons.map((r) => r.relation), ['cloze-sibling', 'descendant']);
  });
  it('clamps a future seenAt to now', () => {
    const v = evaluateCooling(candidate({ seen: [seen({ seenAt: NOW + DAY_MS })] }), NOW);
    assert.ok(v);
    assert.equal(v.until, NOW + 5 * DAY_MS);
  });

  describe('overrides', () => {
    it('release suppresses events up to the release, not after', () => {
      const overrides = { ...EMPTY_COOLING_OVERRIDES, released: { r1: daysAgo(0.5) } };
      assert.equal(evaluateCooling(candidate(), NOW, DEFAULT_COOLING_PARAMS, overrides), null);
      const later = candidate({ seen: [seen({ seenAt: daysAgo(0.25) })] });
      assert.ok(evaluateCooling(later, NOW, DEFAULT_COOLING_PARAMS, overrides));
    });
    it('never wins over everything', () => {
      const overrides = { ...EMPTY_COOLING_OVERRIDES, never: ['r1'] };
      assert.equal(evaluateCooling(candidate(), NOW, DEFAULT_COOLING_PARAMS, overrides), null);
    });
    it('an extension lengthens cooling and can hold it alone', () => {
      const ext = NOW + 20 * DAY_MS;
      const overrides = { ...EMPTY_COOLING_OVERRIDES, extended: { r1: ext } };
      const v = evaluateCooling(candidate(), NOW, DEFAULT_COOLING_PARAMS, overrides);
      assert.ok(v);
      assert.equal(v.until, ext);
      assert.equal(v.extendedUntil, ext);
      const alone = evaluateCooling(candidate({ seen: [] }), NOW, DEFAULT_COOLING_PARAMS, overrides);
      assert.ok(alone);
      assert.equal(alone.reasons.length, 0);
      assert.equal(alone.until, ext);
    });
    it('an extension shorter than the reasons does not shorten them', () => {
      const overrides = { ...EMPTY_COOLING_OVERRIDES, extended: { r1: NOW + DAY_MS } };
      const v = evaluateCooling(candidate(), NOW, DEFAULT_COOLING_PARAMS, overrides);
      assert.ok(v);
      assert.equal(v.until, daysAgo(1) + 5 * DAY_MS);
      assert.equal(v.extendedUntil, undefined);
    });
    it('an expired extension is ignored', () => {
      const overrides = { ...EMPTY_COOLING_OVERRIDES, extended: { r1: daysAgo(1) } };
      assert.equal(evaluateCooling(candidate({ seen: [] }), NOW, DEFAULT_COOLING_PARAMS, overrides), null);
    });
  });
});

describe('pruneCoolingOverrides', () => {
  it('drops dead releases and past extensions, keeps never', () => {
    const pruned = pruneCoolingOverrides(
      {
        released: { old: daysAgo(16), fresh: daysAgo(2) },
        extended: { past: daysAgo(1), future: NOW + DAY_MS },
        never: ['a', 'a', 'b'],
      },
      NOW
    );
    assert.deepEqual(Object.keys(pruned.released), ['fresh']);
    assert.deepEqual(Object.keys(pruned.extended), ['future']);
    assert.deepEqual(pruned.never, ['a', 'b']);
  });
  it('tolerates a half-missing record', () => {
    const pruned = pruneCoolingOverrides({ released: {}, extended: {}, never: undefined as any }, NOW);
    assert.deepEqual(pruned.never, []);
  });
});

describe('excludeCooling', () => {
  it('filters by remId and is a no-op for an empty set', () => {
    const items = [{ remId: 'a', priority: 1 }, { remId: 'b', priority: 2 }];
    assert.equal(excludeCooling(items, new Set()), items);
    assert.deepEqual(excludeCooling(items, new Set(['a'])), [{ remId: 'b', priority: 2 }]);
  });
});
