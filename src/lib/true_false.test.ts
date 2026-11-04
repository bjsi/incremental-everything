/**
 * Back-text handling for True/False cards. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  backTextWithVerdict,
  isBareVerdictBack,
  referencedRemIds,
  splitOnVerdictWords,
  verdictFromMarks,
  verdictFromWords,
} from './true_false';

// How the command reads a back: marks first, words only without one.
const verdictStatedByBack = (back: any[] | undefined, refText: Record<string, string> = {}) =>
  verdictFromMarks(back, refText) ?? verdictFromWords(back, refText);

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

describe('verdictStatedByBack', () => {
  it('reads the mark wherever it is in the back', () => {
    assert.equal(verdictStatedByBack(['✅']), 'true');
    assert.equal(verdictStatedByBack(['see art. 16 ❌']), 'false');
    assert.equal(verdictStatedByBack([bold('❌'), ' only the selected one']), 'false');
  });

  it('finds nothing without a mark', () => {
    assert.equal(verdictStatedByBack(undefined), null);
    assert.equal(verdictStatedByBack([]), null);
    assert.equal(verdictStatedByBack(['Paris']), null);
  });

  it('will not choose between two marks', () => {
    assert.equal(verdictStatedByBack(['✅ not ❌']), 'both');
    assert.equal(verdictStatedByBack([bold('✅'), ref('x')], { x: '❌' }), 'both');
  });

  it('takes a reference that is the mark, not one that mentions it', () => {
    assert.equal(verdictStatedByBack([ref('x')], { x: ' ✅\uFE0F ' }), 'true');
    assert.equal(verdictStatedByBack([ref('doc')], { doc: 'Why ❌ is wrong' }), null);
    assert.equal(verdictStatedByBack(['✅ see ', ref('doc')], { doc: 'Why ❌ is wrong' }), 'true');
    assert.equal(verdictStatedByBack([ref('unresolved')]), null);
  });
});

describe('other check marks', () => {
  const checks = ['✅', '✔', '✔\uFE0F', '☑', '☑\uFE0F', '✓'];

  it('all state true', () => {
    for (const mark of checks) {
      assert.equal(verdictStatedByBack([`${mark} see art. 16`]), 'true');
      assert.equal(verdictStatedByBack([ref('x')], { x: mark }), 'true');
      assert.equal(verdictStatedByBack([`${mark} not ❌`]), 'both');
    }
  });

  it('are kept when marking true, with no ✅ added', () => {
    for (const mark of checks) assert.equal(backTextWithVerdict([`${mark} see art. 16`], 'true'), null);
  });

  it('are swapped when marking false, variation selector included', () => {
    assert.deepEqual(backTextWithVerdict(['✔\uFE0F see art. 16'], 'false'), ['❌ see art. 16']);
    assert.deepEqual(backTextWithVerdict([ref('x'), ' note'], 'false', { x: '☑\uFE0F' }), ['❌', ' note']);
  });

  it('count as a bare back', () => {
    for (const mark of checks) assert.equal(isBareVerdictBack([mark]), true);
  });
});

describe('other cross marks', () => {
  it('✖ states false', () => {
    assert.equal(verdictStatedByBack(['✖\uFE0F see art. 16']), 'false');
    assert.equal(verdictStatedByBack(['✖']), 'false');
    assert.equal(verdictStatedByBack([ref('x')], { x: '✖️' }), 'false');
    assert.equal(verdictStatedByBack(['✖ not ✔']), 'both');
  });

  it('is kept when marking false and swapped when marking true', () => {
    assert.equal(backTextWithVerdict(['✖️ see art. 16'], 'false'), null);
    assert.deepEqual(backTextWithVerdict(['✖\uFE0F see art. 16'], 'true'), ['✅ see art. 16']);
    assert.equal(isBareVerdictBack(['✖\uFE0F']), true);
  });
});

describe('verdict words', () => {
  it('are recognized in any case, English or Portuguese', () => {
    assert.equal(verdictStatedByBack(['true']), 'true');
    assert.equal(verdictStatedByBack(['It is TRUE, see art. 16']), 'true');
    assert.equal(verdictStatedByBack(['Verdadeiro.']), 'true');
    assert.equal(verdictStatedByBack(['False']), 'false');
    assert.equal(verdictStatedByBack([bold('(falso)')]), 'false');
    assert.equal(verdictStatedByBack(['A assertiva é verdadeira']), 'true');
    assert.equal(verdictStatedByBack(['FALSA, ver art. 16']), 'false');
  });

  it('must be whole words', () => {
    for (const text of ['untrue', 'truest', 'falsos', 'falsas', 'verdadeiras', 'falsely', 'falsoé', 'éfalsa']) {
      assert.equal(verdictStatedByBack([text]), null, text);
    }
  });

  it('give way to a mark', () => {
    assert.equal(verdictStatedByBack(['✅ the false claim was corrected']), 'true');
    assert.equal(verdictStatedByBack(['❌ it is true only in part']), 'false');
  });

  it('will not choose between the two', () => {
    assert.equal(verdictStatedByBack(['true or false']), 'both');
    assert.equal(verdictStatedByBack(['verdadeiro', bold(' falso')]), 'both');
  });

  it('skip formulas and code, and references that only mention them', () => {
    assert.equal(verdictStatedByBack([{ i: 'x', text: 'true' }]), null);
    assert.equal(verdictStatedByBack([{ i: 'm', text: 'true', code: true }]), null);
    assert.equal(verdictStatedByBack([ref('x')], { x: ' False ' }), 'false');
    assert.equal(verdictStatedByBack([ref('x')], { x: 'False memory' }), null);
  });

  it('are not marks: the command can tell how a card was judged', () => {
    assert.equal(verdictFromMarks(['Falso']), null);
    assert.equal(verdictFromWords(['Falso']), 'false');
  });

  it('are picked out of the text', () => {
    assert.deepEqual(splitOnVerdictWords('É Falsa, not untrue, true'), [
      { text: 'É ', isWord: false },
      { text: 'Falsa', isWord: true },
      { text: ', not untrue, ', isWord: false },
      { text: 'true', isWord: true },
    ]);
    assert.deepEqual(splitOnVerdictWords('nothing'), [{ text: 'nothing', isWord: false }]);
  });

  it('do not count as a mark when marking: one is put in front', () => {
    assert.deepEqual(backTextWithVerdict(['Falso'], 'false'), ['❌ ', 'Falso']);
  });
});

describe('referencedRemIds', () => {
  it('lists reference elements only', () => {
    assert.deepEqual(referencedRemIds(['a', ref('x'), bold('b'), ref('y')]), ['x', 'y']);
    assert.deepEqual(referencedRemIds(undefined), []);
  });
});

describe('isBareVerdictBack', () => {
  it('accepts a back holding only the mark', () => {
    assert.equal(isBareVerdictBack(['✅']), true);
    assert.equal(isBareVerdictBack(['❌ ']), true);
    assert.equal(isBareVerdictBack(['✅\uFE0F']), true);
    assert.equal(isBareVerdictBack([bold('❌')]), true);
    assert.equal(isBareVerdictBack([ref('a')], { a: '✅' }), true);
    assert.equal(isBareVerdictBack([]), true);
  });

  it('rejects a back with anything else on it', () => {
    assert.equal(isBareVerdictBack(['✅ see art. 16']), false);
    assert.equal(isBareVerdictBack(['❌ ', bold('only one')]), false);
    assert.equal(isBareVerdictBack([ref('a')], { a: 'Article 16' }), false);
  });

  it('counts what it cannot read as content', () => {
    assert.equal(isBareVerdictBack([ref('a')]), false);
    assert.equal(isBareVerdictBack([{ i: 'i', url: 'x.png' }]), false);
  });
});
