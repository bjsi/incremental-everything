/**
 * Tests for the unified Priority Shield. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeUnifiedShield, topMissedPriority } from './unified_shield';

type Item = { priority: number; due: boolean };
const items = (spec: [number, boolean][]): Item[] => spec.map(([priority, due]) => ({ priority, due }));
const isDue = (x: Item) => x.due;

describe('computeUnifiedShield', () => {
  it('takes the lower of the two sides as the absolute and keeps both', () => {
    const r = computeUnifiedShield({
      incRems: items([[9, true], [50, false]]),
      isIncRemDue: isDue,
      cards: items([[2, false], [5, false], [30, true], [80, false]]),
      isCardDue: isDue,
      incRemAbsolute: 9,
      cardAbsolute: 30,
    });
    assert.equal(r.absolute, 9);
    assert.equal(r.incRemAbsolute, 9);
    assert.equal(r.cardAbsolute, 30);
    assert.equal(r.universeSize, 6);
    assert.equal(r.cardCount, 4);
    // Ranked above priority 9: the two cards at 2 and 5 → 2 / 6.
    assert.equal(r.percentile, 33.3);
  });

  it('counts processed elements at the same priority, from either side', () => {
    const r = computeUnifiedShield({
      incRems: items([[10, true], [10, false]]),
      isIncRemDue: isDue,
      cards: items([[10, false], [10, true], [40, false]]),
      isCardDue: isDue,
      incRemAbsolute: 10,
      cardAbsolute: 10,
    });
    assert.equal(r.absolute, 10);
    // Two processed at priority 10 (one IncRem, one card) → 2 / 5.
    assert.equal(r.percentile, 40);
  });

  it('is full when neither side has a missed element', () => {
    const r = computeUnifiedShield({
      incRems: items([[1, false]]),
      isIncRemDue: isDue,
      cards: items([[3, false]]),
      isCardDue: isDue,
      incRemAbsolute: null,
      cardAbsolute: null,
      computeWeighted: true,
    });
    assert.equal(r.absolute, null);
    assert.equal(r.percentile, 100);
    assert.equal(r.weightedShield, 100);
  });

  it('works with an empty side', () => {
    const r = computeUnifiedShield({
      incRems: items([]),
      isIncRemDue: isDue,
      cards: items([[4, false], [7, true]]),
      isCardDue: isDue,
      incRemAbsolute: null,
      cardAbsolute: 7,
    });
    assert.equal(r.absolute, 7);
    assert.equal(r.percentile, 50);
    assert.equal(r.cardCount, 2);
  });

  it('weights the joint universe', () => {
    const r = computeUnifiedShield({
      incRems: items([[1, true]]),
      isIncRemDue: isDue,
      cards: items([[90, false]]),
      isCardDue: isDue,
      incRemAbsolute: 1,
      cardAbsolute: null,
      computeWeighted: true,
    });
    // The due element is the top-ranked one, so most of the weight is unprocessed.
    assert.ok(r.weightedShield! < 50);
  });
});

describe('topMissedPriority', () => {
  it('returns the lowest priority that may set the shield', () => {
    const list = items([[20, true], [3, false], [8, true], [5, true]]);
    assert.equal(topMissedPriority(list, (x) => x.due && x.priority !== 5), 8);
    assert.equal(topMissedPriority(list, () => false), null);
  });
});
