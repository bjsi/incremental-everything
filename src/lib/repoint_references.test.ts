/**
 * Tests for repointing references to never-created targets. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRefIdMap, parseRefIdPlan, repointRichText } from './repoint_references';

/** The back of "Declividade" (CqKslkB7iQIvgkewd) as stored in remnote.db. */
const declividadeBack: any[] = [
  'É a razão entre a altura e o comprimento da onda (H/L).',
  { content: false, pin: true, _id: 'Wb4KrNxFckJjwNkAC', i: 'q' },
  '',
  { content: false, pin: true, _id: 'wlhJGflRzxCGjqcrI', i: 'q' },
  '',
  { content: false, pin: true, _id: 'c2e7wnPgO8CPRdp9U', i: 'q' },
  '   ',
];

describe('repointRichText', () => {
  it('swaps only the id and keeps the pin attributes', () => {
    const { text, changed } = repointRichText(declividadeBack, {
      Wb4KrNxFckJjwNkAC: 'BzlydjjStrtpdPSPM',
      wlhJGflRzxCGjqcrI: '4oIzIaBfu11IDUNQw',
      c2e7wnPgO8CPRdp9U: 'Q0NKZohun2VGqpzCL',
    });
    assert.equal(changed, 3);
    assert.deepEqual(text[1], { content: false, pin: true, _id: 'BzlydjjStrtpdPSPM', i: 'q' });
    assert.deepEqual(text[5], { content: false, pin: true, _id: 'Q0NKZohun2VGqpzCL', i: 'q' });
    assert.equal(text[0], declividadeBack[0]);
    assert.equal(text.length, declividadeBack.length);
  });

  it('does not mutate the input', () => {
    repointRichText(declividadeBack, { Wb4KrNxFckJjwNkAC: 'X' });
    assert.equal(declividadeBack[1]._id, 'Wb4KrNxFckJjwNkAC');
  });

  it('repoints inline links and keeps their formatting', () => {
    const { text, changed } = repointRichText([{ i: 'm', text: 'onda', qId: 'old', b: true }] as any, { old: 'new' });
    assert.equal(changed, 1);
    assert.deepEqual(text[0], { i: 'm', text: 'onda', qId: 'new', b: true });
  });

  it('leaves references outside the map alone', () => {
    const { changed } = repointRichText([{ i: 'q', _id: 'other' }] as any, { old: 'new' });
    assert.equal(changed, 0);
  });
});

describe('parseRefIdMap', () => {
  it('accepts an id map', () => {
    assert.deepEqual(parseRefIdMap('{"a":"b"}'), { a: 'b' });
  });
  it('rejects arrays and empty targets', () => {
    assert.throws(() => parseRefIdMap('[]'));
    assert.throws(() => parseRefIdMap('{"a":""}'));
  });
});

describe('parseRefIdPlan', () => {
  it('accepts a per-Rem plan', () => {
    assert.deepEqual(parseRefIdPlan('{"rem1":{"a":"b"}}'), { rem1: { a: 'b' } });
  });
  it('rejects a single-Rem map pasted by mistake', () => {
    assert.throws(() => parseRefIdPlan('{"a":"b"}'), /single-Rem map/);
  });
  it('rejects a bad inner map', () => {
    assert.throws(() => parseRefIdPlan('{"rem1":{"a":""}}'));
  });
});
