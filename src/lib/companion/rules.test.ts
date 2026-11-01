/**
 * Chrome companion decisions. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION_SHARD_COUNT, indexInReadingOrder, isInReadingOrder, sanitizeExtractRichText, shardOfPage } from './rules';

describe('shardOfPage', () => {
  it('stays within the fixed number of keys, and is stable', () => {
    for (const page of ['a', 'supermemo.guru/wiki/Pleasure_of_learning', 'youtube.com/watch?v=abc', '']) {
      const shard = shardOfPage(page);
      assert.ok(Number.isInteger(shard) && shard >= 0 && shard < COMPANION_SHARD_COUNT);
      assert.equal(shardOfPage(page), shard);
    }
  });
  it('spreads pages across the keys', () => {
    const used = new Set(Array.from({ length: 500 }, (_, i) => shardOfPage(`example.com/page/${i}`)));
    assert.ok(used.size > COMPANION_SHARD_COUNT / 2);
  });
});

describe('indexInReadingOrder', () => {
  const order = { intro: 110, a: 120, b: 150 };
  const children = ['a', 'b'];
  it('places before the first later sibling, and at the end otherwise', () => {
    assert.equal(indexInReadingOrder(children, 110, order), 0);
    assert.equal(indexInReadingOrder(children, 130, order), 1);
    assert.equal(indexInReadingOrder(children, 999, order), 2);
  });
  it('steps over a Rem added by hand, which has no position', () => {
    assert.equal(indexInReadingOrder(['a', 'mine', 'b'], 130, order), 2);
  });
  it('appends to an empty parent', () => {
    assert.equal(indexInReadingOrder([], 5, {}), 0);
  });
});

describe('isInReadingOrder', () => {
  it('ignores Rems without a position', () => {
    assert.equal(isInReadingOrder(['a', 'mine', 'b'], { a: 1, b: 2 }), true);
    assert.equal(isInReadingOrder(['b', 'a'], { a: 1, b: 2 }), false);
  });
});

describe('sanitizeExtractRichText', () => {
  const url = 'https://example.org/a.png';
  it('keeps text, formats, links, images and LaTeX', () => {
    const items = [
      'plain',
      { i: 'm', text: 'bold', b: true },
      { i: 'm', text: '[30]', sup: true, iUrl: 'https://example.org/#c' },
      { i: 'i', url, width: 10, height: 20, title: 'pic' },
      { i: 'x', text: 'E=mc^2' },
      { i: 'x', text: '\\frac{1}{2}', block: true },
    ];
    assert.deepEqual(sanitizeExtractRichText(items), items);
  });
  it('drops what a page should not be able to create', () => {
    assert.deepEqual(
      sanitizeExtractRichText([
        { i: 'q', _id: 'someRem' },
        { i: 's' },
        { i: 'm', text: 'x', qId: 'someRem', cId: 'c', iUrl: 'javascript:alert(1)' },
        { i: 'i', url: 'data:image/png;base64,AAAA' },
        '',
        null,
        7,
      ]),
      [{ i: 'm', text: 'x' }]
    );
  });
  it('gives nothing for anything but a list', () => {
    assert.deepEqual(sanitizeExtractRichText(undefined), []);
    assert.deepEqual(sanitizeExtractRichText('text'), []);
  });
});
