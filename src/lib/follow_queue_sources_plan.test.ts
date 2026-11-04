/**
 * Which sources a card opens, and how the panes are laid out. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { followedSourcesLayout, planFollowedSources, sameSources } from './follow_queue_sources_plan';

const pin = (hostRemId: string, highlightRemId: string | null = null) => ({ hostRemId, highlightRemId });

describe('planFollowedSources', () => {
  it('keeps the first pin of each source, in card order', () => {
    assert.deepEqual(planFollowedSources([pin('A', 'a1'), pin('B', 'b1'), pin('A', 'a2'), pin('B', 'b2')]), [
      pin('A', 'a1'),
      pin('B', 'b1'),
    ]);
  });

  it('takes the first highlight when the first pin is to the document itself', () => {
    assert.deepEqual(planFollowedSources([pin('A'), pin('A', 'a1'), pin('A', 'a2')]), [pin('A', 'a1')]);
  });

  it('stops at four sources', () => {
    const plan = planFollowedSources(['A', 'B', 'C', 'D', 'E'].map((host) => pin(host)));
    assert.deepEqual(plan.map((source) => source.hostRemId), ['A', 'B', 'C', 'D']);
  });

  it('still adds a later highlight to a source within the limit', () => {
    const pins = [pin('A'), pin('B'), pin('C'), pin('D'), pin('E'), pin('A', 'a1')];
    assert.equal(planFollowedSources(pins)[0].highlightRemId, 'a1');
  });

  it('does not change the pins it was given', () => {
    const first = pin('A');
    planFollowedSources([first, pin('A', 'a1')]);
    assert.equal(first.highlightRemId, null);
  });
});

describe('followedSourcesLayout', () => {
  const half = { splitPercentage: 50 };

  it('fills the window with one source', () => {
    assert.equal(followedSourcesLayout(['A']), 'A');
  });

  it('sets two side by side', () => {
    assert.deepEqual(followedSourcesLayout(['A', 'B']), { direction: 'row', first: 'A', second: 'B', ...half });
  });

  it('gives the first of three the left half', () => {
    assert.deepEqual(followedSourcesLayout(['A', 'B', 'C']), {
      direction: 'row',
      first: 'A',
      second: { direction: 'column', first: 'B', second: 'C', ...half },
      ...half,
    });
  });

  it('makes a grid of four', () => {
    assert.deepEqual(followedSourcesLayout(['A', 'B', 'C', 'D']), {
      direction: 'row',
      first: { direction: 'column', first: 'A', second: 'B', ...half },
      second: { direction: 'column', first: 'C', second: 'D', ...half },
      ...half,
    });
  });
});

describe('sameSources', () => {
  it('ignores the order of the panes', () => {
    assert.equal(sameSources(['B', 'A'], ['A', 'B']), true);
  });

  it('notices a pane too many or too few', () => {
    assert.equal(sameSources(['A', 'B', 'C'], ['A', 'B']), false);
    assert.equal(sameSources(['A'], ['A', 'B']), false);
  });

  it('treats a source open twice as one', () => {
    assert.equal(sameSources(['A', 'A'], ['A']), true);
  });
});
