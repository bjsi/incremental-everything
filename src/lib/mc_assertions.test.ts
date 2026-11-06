/**
 * Assertion detection for the multiple-choice answer sheet. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertionLabels, richTextPlain, romanValue } from './mc_assertions';

describe('romanValue', () => {
  it('reads canonical numerals', () => {
    assert.equal(romanValue('I'), 1);
    assert.equal(romanValue('IV'), 4);
    assert.equal(romanValue('IX'), 9);
    assert.equal(romanValue('X'), 10);
  });
  it('rejects non-canonical ones', () => {
    assert.equal(romanValue('IIII'), 0);
    assert.equal(romanValue('VX'), 0);
    assert.equal(romanValue('IIX'), 0);
  });
});

describe('assertionLabels', () => {
  it('finds statements separated by blank lines', () => {
    const text =
      '9) According to the book, analyze the sentences below: \n\n' +
      'I. In a 3D body, the streamlines move down. \n\n' +
      'II. On the parallel middle body there is no curvature. \n\n' +
      'III. At the stern the flow moves upward.';
    assert.deepEqual(assertionLabels(text), ['I', 'II', 'III']);
  });

  it('accepts a bullet before the numeral and a closing parenthesis', () => {
    const text = 'Judge:\n• I. First.\n• II) Second.\n- III. Third.\n– IV. Fourth.';
    assert.deepEqual(assertionLabels(text), ['I', 'II', 'III', 'IV']);
  });

  it('needs at least two statements', () => {
    assert.deepEqual(assertionLabels('Question?\nI. Only one.'), []);
    assert.deepEqual(assertionLabels('No statements at all.'), []);
  });

  it('only counts up from I', () => {
    assert.deepEqual(assertionLabels('Q\nII. a\nIII. b'), []);
    // A repeated or skipped numeral is ignored; the run continues after it.
    assert.deepEqual(assertionLabels('Q\nI. a\nI. again\nIII. skip\nII. b'), ['I', 'II']);
  });

  it('ignores numerals inside prose and without a space after the mark', () => {
    assert.deepEqual(assertionLabels('See chapter I. and II. for details\nI.no space\nII.x'), []);
    assert.deepEqual(assertionLabels('Q\nI. a\nClause II. inline\nII. b'), ['I', 'II']);
  });
});

describe('richTextPlain', () => {
  it('joins strings and formatted text, dropping other elements', () => {
    const rt = ['Q:\n', { i: 'm', text: 'I.', b: true }, ' first\n', { i: 'q', _id: 'x' }, 'II. second'];
    assert.equal(richTextPlain(rt), 'Q:\nI. first\nII. second');
    assert.deepEqual(assertionLabels(richTextPlain(rt)), ['I', 'II']);
  });
  it('handles a missing value', () => {
    assert.equal(richTextPlain(undefined), '');
  });
});
