/**
 * Tests for the unified (IncRems + cards) priority scale. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPriorityColorScale,
  buildUnifiedRanking,
  scalePercentile,
  scheduledCardCount,
  unifiedPercentileAt,
  unifiedRankingFor,
} from './unified_percentile';

describe('scheduledCardCount', () => {
  it('counts scheduled cards only, and falls back to cardCount', () => {
    assert.equal(scheduledCardCount({ priority: 5, cardCount: 3, cardsNextRep: [1, null, 2] }), 2);
    assert.equal(scheduledCardCount({ priority: 5, cardCount: 2 }), 2);
    assert.equal(scheduledCardCount({ priority: 5, cardCount: 0, cardsNextRep: [] }), 0);
  });
});

describe('unifiedPercentileAt', () => {
  // IncRems at 10, 20; a Rem at 10 with two cards (one unscheduled), a Rem at 30 with three.
  const ranking = buildUnifiedRanking(
    [{ priority: 10 }, { priority: 20 }],
    [
      { priority: 10, cardCount: 2, cardsNextRep: [1, null] },
      { priority: 30, cardCount: 3, cardsNextRep: [1, 2, 3] },
      { priority: 5, cardCount: 1, cardsNextRep: [null] }, // all unscheduled: out
    ]
  );

  it('ranks IncRems and cards in one universe, one element per card', () => {
    assert.equal(ranking.total, 6);
    // Priority 10: two elements (IncRem + card) at ranks 1–2 → midpoint 1.5 / 6.
    assert.equal(unifiedPercentileAt(ranking, 10), 25);
    // Priority 30: ranks 4–6 → 5 / 6.
    assert.equal(unifiedPercentileAt(ranking, 30), 83.3);
  });

  it('places a priority nobody holds between its neighbours', () => {
    // Two elements below 15 → rank 2.5 / 6.
    assert.equal(unifiedPercentileAt(ranking, 15), 41.7);
    assert.equal(unifiedPercentileAt(ranking, 99), 100);
    assert.equal(unifiedPercentileAt(ranking, 0), 8.3);
  });

  it('is null for an empty universe', () => {
    assert.equal(unifiedPercentileAt(buildUnifiedRanking([], []), 50), null);
  });

  it('reuses the ranking for the same cache arrays', () => {
    const inc = [{ priority: 1 }];
    const cards = [{ priority: 2, cardCount: 1 }];
    assert.equal(unifiedRankingFor(inc, cards), unifiedRankingFor(inc, cards));
    assert.notEqual(unifiedRankingFor(inc, cards), unifiedRankingFor([...inc], cards));
  });
});

describe('buildPriorityColorScale', () => {
  it('maps every priority 0–100, and is null for a tiny universe', () => {
    const big = buildUnifiedRanking(
      Array.from({ length: 30 }, (_, i) => ({ priority: i * 3 })),
      []
    );
    const scale = buildPriorityColorScale(big)!;
    assert.equal(scale.length, 101);
    assert.equal(scalePercentile(scale, 0), unifiedPercentileAt(big, 0));
    assert.equal(scalePercentile(scale, 250), scale[100]);
    assert.ok(scale.every((v, i) => i === 0 || v >= scale[i - 1]));
    assert.equal(buildPriorityColorScale(buildUnifiedRanking([{ priority: 1 }], [])), null);
  });
});
