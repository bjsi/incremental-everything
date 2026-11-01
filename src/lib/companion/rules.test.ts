/**
 * Chrome companion decisions. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION_SHARD_COUNT, indexInReadingOrder, isInReadingOrder, shardOfPage, splitMarkdownImages } from './rules';

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

describe('splitMarkdownImages', () => {
  const url = 'https://help.supermemo.org/images/thumb/f/f5/800px-Extract.jpg';
  it('leaves text without images alone', () => {
    assert.deepEqual(splitMarkdownImages('**Figure:** a [link](https://x.org/a)'), [
      { markdown: '**Figure:** a [link](https://x.org/a)' },
    ]);
  });
  it('splits an image with its size out of the text', () => {
    assert.deepEqual(splitMarkdownImages(`![alt](${url} =800x600) **Figure:** text`), [
      { image: { url, width: 800, height: 600 } },
      { markdown: ' **Figure:** text' },
    ]);
  });
  it('handles an image with no size, and several in a row', () => {
    assert.deepEqual(splitMarkdownImages(`a ![](${url}) b ![x\\]y](${url} =1x2)`), [
      { markdown: 'a ' },
      { image: { url } },
      { markdown: ' b ' },
      { image: { url, width: 1, height: 2 } },
    ]);
  });
  it('does not take escaped page text for an image', () => {
    const text = `!\\[not an image\\](${url})`;
    assert.deepEqual(splitMarkdownImages(text), [{ markdown: text }]);
  });
  it('ignores addresses that are not on the web', () => {
    const text = '![x](data:image/png;base64,AAAA)';
    assert.deepEqual(splitMarkdownImages(text), [{ markdown: text }]);
  });
});
