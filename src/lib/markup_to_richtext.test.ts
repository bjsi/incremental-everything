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

  it('reads ***text*** as bold italic', () => {
    assert.deepEqual(convert('o primeiro sobrepasso – ***overshoot***.'), [
      'o primeiro sobrepasso – ',
      { i: 'm', text: 'overshoot', b: true, l: true },
      '.',
    ]);
  });

  it('keeps an italic nested at the end of a bold run', () => {
    assert.deepEqual(convert('obtidas pelo **primeiro *overshoot*** sejam'), [
      'obtidas pelo ',
      { i: 'm', text: 'primeiro ', b: true },
      { i: 'm', text: 'overshoot', b: true, l: true },
      ' sejam',
    ]);
  });

  it('keeps an italic nested at the start or middle of a bold run', () => {
    assert.deepEqual(convert('**de *sway* e** e **(*overshoot*)**'), [
      { i: 'm', text: 'de ', b: true },
      { i: 'm', text: 'sway', b: true, l: true },
      { i: 'm', text: ' e', b: true },
      ' e ',
      { i: 'm', text: '(', b: true },
      { i: 'm', text: 'overshoot', b: true, l: true },
      { i: 'm', text: ')', b: true },
    ]);
    assert.deepEqual(convert('***sway* e yaw**'), [
      { i: 'm', text: 'sway', b: true, l: true },
      { i: 'm', text: ' e yaw', b: true },
    ]);
  });

  it('keeps a bold run nested inside an italic one', () => {
    assert.deepEqual(convert('*see **this***, then'), [
      { i: 'm', text: 'see ', l: true },
      { i: 'm', text: 'this', l: true, b: true },
      ', then',
    ]);
  });

  it('handles bold and italic side by side', () => {
    assert.deepEqual(convert('*a* and **b** and ***c***'), [
      { i: 'm', text: 'a', l: true },
      ' and ',
      { i: 'm', text: 'b', b: true },
      ' and ',
      { i: 'm', text: 'c', b: true, l: true },
    ]);
  });

  it('turns TeX-style dashes into en and em dashes', () => {
    assert.deepEqual(convert('VIAS INTERIORES -- Corpos hídricos'), [
      'VIAS INTERIORES \u2013 Corpos hídricos',
    ]);
    assert.deepEqual(convert('1988--1989, e ---- acima --- abaixo'), [
      '1988\u20131989, e ---- acima \u2014 abaixo',
    ]);
  });

  it('converts dashes inside emphasis but never inside a formula', () => {
    assert.deepEqual(convert('**VIAS INTERIORES --** Corpos, \\(a--b\\)'), [
      { i: 'm', text: 'VIAS INTERIORES \u2013', b: true },
      ' Corpos, ',
      { i: 'x', text: 'a--b' },
    ]);
  });

  it('converts a dash in an already formatted run', () => {
    assert.deepEqual(convertRichText([{ i: 'm', text: 'AG -- Agência', b: true }] as any), [
      { i: 'm', b: true, text: 'AG \u2013 Agência' },
    ]);
    assert.equal(convertRichText([{ i: 'm', text: 'AG \u2013 Agência', b: true }] as any), null);
  });

  it('returns null when there is nothing to convert', () => {
    assert.equal(convert('plain text, $5 and $10'), null);
  });
});
