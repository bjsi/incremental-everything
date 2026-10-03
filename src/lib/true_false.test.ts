/**
 * Back-text handling for True/False cards. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backTextWithVerdict, referencedRemIds } from './true_false';

const ref = (id: string) => ({ i: 'q', _id: id });
const bold = (text: string) => ({ i: 'm', text, b: true });

describe('backTextWithVerdict', () => {
  it('fills an empty back', () => {
    assert.deepEqual(backTextWithVerdict(undefined, 'true'), ['✅']);
    assert.deepEqual(backTextWithVerdict([], 'false'), ['❌']);
  });

  it('leaves a back that already states the verdict', () => {
    assert.equal(backTextWithVerdict(['✅ see art. 16'], 'true'), null);
    assert.equal(backTextWithVerdict([bold('❌')], 'false'), null);
    assert.equal(backTextWithVerdict([ref('a')], 'true', { a: '✅' }), null);
  });

  it('puts the mark in front of existing content', () => {
    const back = ['see ', ref('law'), bold(' art. 16')];
    assert.deepEqual(backTextWithVerdict(back, 'true', { law: 'Lesta' }), ['✅ ', ...back]);
  });

  it('swaps the opposite mark and keeps the rest', () => {
    assert.deepEqual(backTextWithVerdict(['❌ because ', ref('law')], 'true', { law: 'Lesta' }), [
      '✅ because ',
      ref('law'),
    ]);
    assert.deepEqual(backTextWithVerdict([bold('✅ wrong')], 'false'), [bold('❌ wrong')]);
  });

  it('swaps a reference that is the opposite mark, not one that mentions it', () => {
    assert.deepEqual(backTextWithVerdict([ref('x'), ' note'], 'true', { x: '❌ ' }), ['✅', ' note']);
    const back = [ref('doc')];
    assert.deepEqual(backTextWithVerdict(back, 'true', { doc: 'Why ❌ is wrong' }), back);
  });
});

describe('referencedRemIds', () => {
  it('lists reference elements only', () => {
    assert.deepEqual(referencedRemIds(['a', ref('x'), bold('b'), ref('y')]), ['x', 'y']);
    assert.deepEqual(referencedRemIds(undefined), []);
  });
});
