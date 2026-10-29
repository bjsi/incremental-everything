/**
 * The percentile estimate shown between a popup save and the tracker's cache
 * write must agree with the real ranking it stands in for. Run with `npm test`.
 */
import '../sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    CardPriorityInfo,
    calculateCardRemPercentilesFromCards,
    estimateCardRemPercentile,
} from './types';

const info = (remId: string, priority: number, cardCount: number): CardPriorityInfo => ({
    remId,
    priority,
    source: 'manual',
    lastUpdated: 0,
    cardCount,
    dueCards: 0,
    cardsNextRep: Array(cardCount).fill(0),
});

const CACHE = [info('a', 10, 1), info('b', 30, 3), info('c', 50, 2), info('d', 70, 1), info('e', 90, 4)];

/** The real ranking, after the cache write the estimate waits for. */
const rankedAt = (remId: string, priority: number) =>
    calculateCardRemPercentilesFromCards(
        CACHE.map((i) => (i.remId === remId ? { ...i, priority } : i))
    )[remId];

describe('estimateCardRemPercentile', () => {
    it('matches the full ranking when the new priority ties nobody', () => {
        for (const [remId, priority] of [['c', 5], ['c', 40], ['c', 95], ['b', 60], ['e', 1]] as const) {
            assert.equal(estimateCardRemPercentile(CACHE, remId, priority), rankedAt(remId, priority));
        }
    });

    it('stays inside the tie band when the new priority ties another rem', () => {
        // c (2 cards) moved onto b's 30 (3 cards): ranks 2..6 of 11, either order.
        const estimate = estimateCardRemPercentile(CACHE, 'c', 30)!;
        assert.ok(estimate >= (2 / 11) * 100 && estimate <= (6 / 11) * 100, `got ${estimate}`);
    });

    it('places an inheritance-only rem like the real calculation does', () => {
        const withAnchor = [...CACHE, info('anchor', 0, 0)];
        const real = calculateCardRemPercentilesFromCards(
            withAnchor.map((i) => (i.remId === 'anchor' ? { ...i, priority: 60 } : i))
        ).anchor;
        assert.equal(estimateCardRemPercentile(withAnchor, 'anchor', 60), real);
    });

    it('returns undefined for an empty cache', () => {
        assert.equal(estimateCardRemPercentile([], 'a', 50), undefined);
    });
});
