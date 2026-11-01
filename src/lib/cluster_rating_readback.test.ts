/**
 * Fixture tests for reading Card Cluster ratings back from history. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QueueInteractionScore } from '@remnote/plugin-sdk';
import { newRatingOf } from './cluster_rating_readback';

const good = (date: number) => ({ score: QueueInteractionScore.GOOD, date });
const again = (date: number) => ({ score: QueueInteractionScore.AGAIN, date });
const tooEarly = (date: number) => ({ score: QueueInteractionScore.TOO_EARLY, date });

describe('newRatingOf', () => {
  it('returns a rating made after the card came on screen', () => {
    assert.deepEqual(newRatingOf([again(10), good(100)], 50, 0), good(100));
  });

  it('ignores a rating from before the card came on screen', () => {
    assert.equal(newRatingOf([good(40)], 50, 0), null);
  });

  it('ignores a rating already accounted for', () => {
    assert.equal(newRatingOf([good(100)], 50, 100), null);
  });

  it('takes a second rating of the same card in one session', () => {
    assert.deepEqual(newRatingOf([again(100), good(200)], 150, 100), good(200));
  });

  it('looks past a Too Early tap to the last real answer', () => {
    assert.deepEqual(newRatingOf([good(100), tooEarly(120)], 50, 0), good(100));
    assert.equal(newRatingOf([tooEarly(120)], 50, 0), null);
  });

  it('handles a card with no history', () => {
    assert.equal(newRatingOf(undefined, 0, 0), null);
    assert.equal(newRatingOf([], 0, 0), null);
  });
});
