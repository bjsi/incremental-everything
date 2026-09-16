/**
 * Tests for the Priority Queue fill split. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitFillTarget } from './fill_split';

describe('splitFillTarget', () => {
  it('gives IncRems ceil(target / (ratio + 1)) slots and flashcards the rest', () => {
    assert.deepEqual(splitFillTarget(25, 10), { flashcards: 22, incRems: 3 });
    assert.deepEqual(splitFillTarget(50, 10), { flashcards: 45, incRems: 5 });
    assert.deepEqual(splitFillTarget(25, 3), { flashcards: 18, incRems: 7 });
  });

  it('keeps at least one IncRem slot for any numeric ratio', () => {
    assert.deepEqual(splitFillTarget(5, 100), { flashcards: 4, incRems: 1 });
  });

  it('follows the all-or-nothing ratios', () => {
    assert.deepEqual(splitFillTarget(25, 'no-cards'), { flashcards: 0, incRems: 25 });
    assert.deepEqual(splitFillTarget(25, 'no-rem'), { flashcards: 25, incRems: 0 });
  });

  it('treats a zero or broken ratio as IncRems only, and a zero target as empty', () => {
    assert.deepEqual(splitFillTarget(10, 0), { flashcards: 0, incRems: 10 });
    assert.deepEqual(splitFillTarget(10, NaN), { flashcards: 0, incRems: 10 });
    assert.deepEqual(splitFillTarget(0, 10), { flashcards: 0, incRems: 0 });
  });
});
