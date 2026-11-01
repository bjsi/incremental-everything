/**
 * Duplicate-source index updates and decisions. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DuplicateGroup,
  indexAfterScan,
  mergedIndex,
  remsToKeep,
  unscannedRemIds,
  withoutEntries,
  withRemUnderKeys,
} from './rules';

describe('withRemUnderKeys', () => {
  it('adds a Rem under each key', () => {
    assert.deepEqual(withRemUnderKeys({ a: ['1'] }, ['a', 'b'], '2'), { a: ['1', '2'], b: ['2'] });
  });
  it('returns the same object when already present, so no write follows', () => {
    const index = { a: ['1'] };
    assert.equal(withRemUnderKeys(index, ['a'], '1'), index);
  });
});

describe('withoutEntries', () => {
  it('removes the Rem and drops a key left empty', () => {
    assert.deepEqual(
      withoutEntries({ a: ['1', '2'], b: ['1'] }, [
        { key: 'a', remId: '1' },
        { key: 'b', remId: '1' },
      ]),
      { a: ['2'] }
    );
  });
  it('returns the same object when there is nothing to remove', () => {
    const index = { a: ['1'] };
    assert.equal(withoutEntries(index, [{ key: 'a', remId: '9' }]), index);
    assert.equal(withoutEntries(index, [{ key: 'z', remId: '1' }]), index);
  });
});

describe('mergedIndex', () => {
  it('unions without duplicating', () => {
    assert.deepEqual(mergedIndex({ a: ['1'] }, { a: ['1', '2'], b: ['3'] }), { a: ['1', '2'], b: ['3'] });
  });
  it('returns the same object when nothing is new', () => {
    const index = { a: ['1', '2'] };
    assert.equal(mergedIndex(index, { a: ['2'] }), index);
  });
});

describe('indexAfterScan', () => {
  const scanned = { kept: ['1'] };
  const scannedIds = new Set(['1', '2']);
  it('forgets a source a scanned Rem no longer has', () => {
    assert.deepEqual(indexAfterScan({ gone: ['2'], kept: ['1'] }, scanned, scannedIds, new Set()), { kept: ['1'] });
  });
  it('keeps a Rem added during the scan', () => {
    assert.deepEqual(indexAfterScan({ fresh: ['3'] }, scanned, scannedIds, new Set(['3'])), {
      fresh: ['3'],
      kept: ['1'],
    });
  });
  it('drops a Rem outside the scan that nothing vouches for', () => {
    assert.deepEqual(indexAfterScan({ stale: ['4'] }, scanned, scannedIds, new Set()), { kept: ['1'] });
  });
});

describe('unscannedRemIds', () => {
  it('lists each Rem the scan did not reach once', () => {
    assert.deepEqual(unscannedRemIds({ a: ['1', '3'], b: ['3'] }, new Set(['1'])), ['3']);
  });
});

describe('remsToKeep', () => {
  const rems = [{ _id: 'dup' }, { _id: 'new' }];
  const groups: DuplicateGroup[] = [{ remId: 'dup', name: '', url: '', matches: [] }];
  it('proceed keeps everything', () => {
    assert.deepEqual(remsToKeep(rems, groups, { kind: 'proceed' }), rems);
  });
  it('skip keeps only the Rems without a duplicate', () => {
    assert.deepEqual(remsToKeep(rems, groups, { kind: 'skip' }), [{ _id: 'new' }]);
  });
  it('cancel and open keep nothing', () => {
    assert.deepEqual(remsToKeep(rems, groups, { kind: 'cancel' }), []);
    assert.deepEqual(remsToKeep(rems, groups, { kind: 'open', remId: 'x' }), []);
  });
});
