/** Find Rem's search seeds (reference_search_seeds.ts). Run with `npm test`. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SEEDS, searchSeeds } from './reference_search_seeds';

describe('searchSeeds', () => {
  it('adds the adjacent pairs, so a reference indexed at the end of its Rem is reached', () => {
    // "[sea margin] becomes useless" is indexed as "… becomes useless … sea margin".
    assert.deepEqual(searchSeeds('sea margin becomes'), [
      'sea margin becomes',
      'sea margin',
      'margin becomes',
      'becomes',
      'margin',
      'sea',
    ]);
  });
  it('a two-word query is its own pair', () => {
    assert.deepEqual(searchSeeds('sea margin'), ['sea margin', 'margin', 'sea']);
  });
  it('skips pairs RemNote cannot run as a phrase', () => {
    assert.ok(!searchSeeds('a de navio grande').includes('a de'));
  });
  it('asks for both figure spellings', () => {
    const seeds = searchSeeds('fig. 6.4 squat');
    assert.ok(seeds.includes('figure 6.4 squat'));
    assert.ok(seeds.includes('fig. 6.4'));
    assert.ok(seeds.includes('figure 6.4'));
  });
  it('stays within the budget on a long query, keeping the longest pairs', () => {
    const seeds = searchSeeds('the minimum under keel clearance in the approach channel');
    assert.equal(seeds.length, MAX_SEEDS);
    assert.equal(seeds[0], 'the minimum under keel clearance in the approach channel');
    assert.ok(seeds.includes('keel clearance'));
    assert.ok(seeds.includes('approach channel'));
    assert.ok(!seeds.includes('in the'));
  });
});
