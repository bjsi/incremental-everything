/**
 * Tests for the Priority Queue's Card Cluster rules. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coolingClusterMembersToKeep, missingClusterSiblings } from './cluster_rules';

// Cluster P: I, II, III, IV, V. Cluster Q: a, b. Loose Rem: x.
const parentOf = new Map([
  ['I', 'P'], ['II', 'P'], ['III', 'P'], ['IV', 'P'], ['V', 'P'],
  ['a', 'Q'], ['b', 'Q'],
]);
const membersOf = new Map([
  ['P', ['I', 'II', 'III', 'IV', 'V']],
  ['Q', ['a', 'b']],
]);

describe('coolingClusterMembersToKeep', () => {
  it('keeps a cooling member while a sibling in the document is due and not cooling', () => {
    const keep = coolingClusterMembersToKeep(new Set(['III']), ['I', 'III'], parentOf, () => true);
    assert.deepEqual([...keep], ['III']);
  });

  it('drains a cluster whose due members are all cooling', () => {
    const keep = coolingClusterMembersToKeep(new Set(['I', 'III']), ['I', 'III'], parentOf, () => true);
    assert.equal(keep.size, 0);
  });

  it('does not count a sibling that is no longer due', () => {
    const keep = coolingClusterMembersToKeep(new Set(['III']), ['I', 'III'], parentOf, (id) => id !== 'I');
    assert.equal(keep.size, 0);
  });

  it('leaves loose Rems and other clusters to the normal drain', () => {
    const keep = coolingClusterMembersToKeep(new Set(['x', 'a']), ['x', 'a', 'I'], parentOf, () => true);
    assert.equal(keep.size, 0);
  });
});

describe('missingClusterSiblings', () => {
  it('adds every due sibling not in the document', () => {
    const due = new Set(['I', 'III', 'IV', 'V']);
    const out = missingClusterSiblings(['I'], parentOf, membersOf, (id) => due.has(id), new Set(['I']));
    assert.deepEqual(out, ['III', 'IV', 'V']);
  });

  it('skips blocked siblings and completes each cluster once', () => {
    const out = missingClusterSiblings(['I', 'III', 'a'], parentOf, membersOf, () => true, new Set(['I', 'III', 'a', 'IV']));
    assert.deepEqual(out, ['II', 'V', 'b']);
  });

  it('adds nothing for loose Rems', () => {
    assert.deepEqual(missingClusterSiblings(['x'], parentOf, membersOf, () => true, new Set(['x'])), []);
  });
});
