/**
 * Fixture tests for source-pin planning. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocatedWord, PageHighlight, planSourcePins, positionFromWords, rectsOnPage } from './overlap';

/** `count` words on one line starting at `line`, each 10pt wide with a 2pt gap. */
const lineOfWords = (count: number, line = 0, startIndex = 0): LocatedWord[] =>
  Array.from({ length: count }, (_, k) => ({
    i: startIndex + k,
    x1: 50 + k * 12,
    y1: 100 + line * 14,
    x2: 60 + k * 12,
    y2: 110 + line * 14,
    line: `0-${line}`,
    text: `w${startIndex + k}`,
  }));

/** A highlight covering words `from`..`to` (inclusive) of `words`. */
const highlightOver = (remId: string, words: LocatedWord[], from: number, to: number): PageHighlight => ({
  remId,
  rects: [
    {
      x1: words[from].x1 - 1,
      y1: words[from].y1 - 1,
      x2: words[to].x2 + 1,
      y2: words[to].y2 + 1,
    },
  ],
});

describe('planSourcePins', () => {
  it('creates one highlight when nothing overlaps', () => {
    const words = lineOfWords(8);
    const plan = planSourcePins(words, []);
    assert.deepEqual(plan.reuse, []);
    assert.equal(plan.create.length, 1);
    assert.equal(plan.create[0].length, 8);
  });

  it('reuses an existing highlight that contains the whole quote', () => {
    const words = lineOfWords(6);
    const plan = planSourcePins(words, [highlightOver('A', words, 0, 5)]);
    assert.deepEqual(plan.reuse, ['A']);
    assert.deepEqual(plan.create, []);
    assert.equal(plan.coverage, 1);
  });

  it('reuses highlights that cover most of the quote, creating nothing', () => {
    const words = lineOfWords(10);
    const plan = planSourcePins(words, [highlightOver('A', words, 0, 6)]);
    assert.deepEqual(plan.reuse, ['A']);
    assert.deepEqual(plan.create, []);
  });

  it('on partial overlap, reuses and creates only the uncovered stretch', () => {
    const words = lineOfWords(10);
    const plan = planSourcePins(words, [highlightOver('A', words, 0, 2)]);
    assert.deepEqual(plan.reuse, ['A']);
    assert.equal(plan.create.length, 1);
    assert.deepEqual(plan.create[0].map((w) => w.i), [3, 4, 5, 6, 7, 8, 9]);
  });

  it('around a short contained highlight, drops stretches under the minimum', () => {
    const words = lineOfWords(9);
    const plan = planSourcePins(words, [highlightOver('B', words, 4, 5)]);
    assert.deepEqual(plan.reuse, ['B']);
    assert.equal(plan.create.length, 1);
    assert.deepEqual(plan.create[0].map((w) => w.i), [0, 1, 2, 3]);
  });

  it('lists several reused highlights once each, in reading order', () => {
    const words = lineOfWords(14);
    const plan = planSourcePins(words, [highlightOver('B', words, 11, 13), highlightOver('A', words, 0, 2)]);
    assert.deepEqual(plan.reuse, ['A', 'B']);
    assert.deepEqual(plan.create[0].map((w) => w.i), [3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('positionFromWords', () => {
  it('builds one rect per line and a bounding rect over all', () => {
    const words = [...lineOfWords(3, 0, 0), ...lineOfWords(2, 1, 3)];
    const pos = positionFromWords(words, 595.2, 841.92, 107);
    assert.equal(pos.rects.length, 2);
    assert.deepEqual(
      { x1: pos.rects[0].x1, x2: pos.rects[0].x2, y1: pos.rects[0].y1 },
      { x1: 50, x2: 84, y1: 100 }
    );
    assert.equal(pos.boundingRect.y2, 124);
    assert.equal(pos.boundingRect.width, 595.2);
    assert.equal(pos.pageNumber, 107);
  });
});

describe('rectsOnPage', () => {
  it('scales viewport rects to page points and keeps only the page asked for', () => {
    const data = {
      position: {
        pageNumber: 9,
        rects: [
          { x1: 100, y1: 200, x2: 300, y2: 220, width: 1080, height: 1331.944, pageNumber: 9 },
          { x1: 100, y1: 20, x2: 300, y2: 40, width: 1080, height: 1331.944, pageNumber: 10 },
        ],
      },
    };
    const rects = rectsOnPage(data, 9, 540, 665.972);
    assert.equal(rects.length, 1);
    assert.deepEqual(rects[0], { x1: 50, y1: 100, x2: 150, y2: 110 });
  });

  it('falls back to the bounding rect when there are no line rects', () => {
    const data = { position: { pageNumber: 3, boundingRect: { x1: 1, y1: 2, x2: 3, y2: 4, width: 10, height: 10 } } };
    assert.deepEqual(rectsOnPage(data, 3, 10, 10), [{ x1: 1, y1: 2, x2: 3, y2: 4 }]);
  });
});
