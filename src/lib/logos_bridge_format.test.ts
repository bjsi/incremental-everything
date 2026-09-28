/**
 * Tests for the Logos bridge's pure helpers. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLogosLink, segmentsToRichText } from './logos_bridge_format';

describe('segmentsToRichText', () => {
  it('keeps plain runs as strings and formatted runs as elements', () => {
    const rich = segmentsToRichText([
      { text: 'the ' },
      { text: 'GOD', i: true },
      { text: ' of ' },
      { text: 'Noah', b: true },
    ]);
    assert.deepEqual(rich, [
      'the ',
      { i: 'm', text: 'GOD', l: true },
      ' of ',
      { i: 'm', text: 'Noah', b: true },
    ]);
  });

  it('merges adjacent plain runs and drops empty ones', () => {
    assert.deepEqual(segmentsToRichText([{ text: 'a' }, { text: '' }, { text: 'b' }]), ['ab']);
  });

  it('maps every formatting flag', () => {
    assert.deepEqual(segmentsToRichText([{ text: 'x', b: true, i: true, u: true, sup: true, sub: true }]), [
      { i: 'm', text: 'x', b: true, l: true, u: true, sup: true, sub: true },
    ]);
  });
});

describe('isLogosLink', () => {
  it('accepts ref.ly and native links only', () => {
    assert.equal(isLogosLink('https://ref.ly/logosres/lw33?ref=Page.p+37&off=2078'), true);
    assert.equal(isLogosLink('logosres:lw33;ref=Page.p_37;off=2078'), true);
    assert.equal(isLogosLink('https://example.com'), false);
    assert.equal(isLogosLink(undefined), false);
  });
});
