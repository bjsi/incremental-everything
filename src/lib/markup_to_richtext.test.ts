/**
 * Markup -> rich text conversion. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertRichText } from './markup_to_richtext';

const convert = (text: string) => convertRichText([text] as any);

describe('convertRichText', () => {
  it('turns bold and italic markers into formatted runs', () => {
    assert.deepEqual(convert('A **stability bias** in *human memory*.'), [
      'A ',
      { i: 'm', text: 'stability bias', b: true },
      ' in ',
      { i: 'm', text: 'human memory', l: true },
      '.',
    ]);
  });

  it('keeps a formula inside a bold run instead of leaving literal markers', () => {
    assert.deepEqual(convert('and **state variables $x_i$** here'), [
      'and ',
      { i: 'm', text: 'state variables ', b: true },
      { i: 'x', text: 'x_i' },
      ' here',
    ]);
  });

  it('keeps a formula inside an italic run', () => {
    assert.deepEqual(convert('*the angle $\\theta$ of attack* matters'), [
      { i: 'm', text: 'the angle ', l: true },
      { i: 'x', text: '\\theta' },
      { i: 'm', text: ' of attack', l: true },
      ' matters',
    ]);
  });

  it('never reads asterisks inside formulas as emphasis', () => {
    assert.deepEqual(convert('$a^*$ and $b^*$'), [{ i: 'x', text: 'a^*' }, ' and ', { i: 'x', text: 'b^*' }]);
  });

  it('keeps display formulas and paragraph breaks around emphasis', () => {
    assert.deepEqual(convert('Para.\n\n$$a = b \\tag{1}$$\n\n**Bold** start'), [
      'Para.\n\n',
      { i: 'x', text: 'a = b \\tag{1}', block: true },
      '\n\n',
      { i: 'm', text: 'Bold', b: true },
      ' start',
    ]);
  });

  it('returns null when there is nothing to convert', () => {
    assert.equal(convert('plain text, $5 and $10'), null);
  });
});
