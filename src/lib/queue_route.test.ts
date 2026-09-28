/**
 * Route classification for queue-level cooling. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queueRouteKind } from './queue_route';

describe('queueRouteKind', () => {
  it('spaced-repetition queues', () => {
    assert.equal(queueRouteKind('/flashcards'), 'spaced');
    assert.equal(queueRouteKind('/flashcards/'), 'spaced');
    assert.equal(queueRouteKind('/flashcards/abc123'), 'spaced');
  });
  it('Learn New, both routes', () => {
    assert.equal(queueRouteKind('/need_to_learn/exam1/doc1/shuffled'), 'learn-new');
    assert.equal(queueRouteKind('/need_to_learn/exam1/doc1'), 'learn-new');
    assert.equal(queueRouteKind('/flashcards/doc1/need_to_learn'), 'learn-new');
  });
  it('Practice All, In Order and no-SRS modes are left alone', () => {
    for (const mode of ['all', 'ordered', 'all_no_srs', 'ordered_no_srs']) {
      assert.equal(queueRouteKind(`/flashcards/doc1/${mode}`), 'other');
    }
  });
  it('anything else is other', () => {
    assert.equal(queueRouteKind('/need_to_learn_selector/folder1'), 'other');
    assert.equal(queueRouteKind('/flashcards_home'), 'other');
    assert.equal(queueRouteKind('/filtered_queue/kb1'), 'other');
    assert.equal(queueRouteKind('/document/abc'), 'other');
    assert.equal(queueRouteKind(undefined), 'other');
  });
});
