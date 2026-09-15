/**
 * Tests for quote cleaning and candidate selection. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { broadestMatch, quoteCandidates, stripListMarker } from './quote';

describe('stripListMarker', () => {
  it('drops numbered, lettered and bulleted list markers', () => {
    assert.equal(stripListMarker('3. Build upon the basics'), 'Build upon the basics');
    assert.equal(stripListMarker('  12) Avoid sets'), 'Avoid sets');
    assert.equal(stripListMarker('b) geometrical similarity'), 'geometrical similarity');
    assert.equal(stripListMarker('• kinematical similarity;'), 'kinematical similarity;');
    assert.equal(stripListMarker('- dynamical similarity.'), 'dynamical similarity.');
  });

  it('keeps numbers that are part of the text', () => {
    assert.equal(stripListMarker('5.1 The standard manoeuvres'), '5.1 The standard manoeuvres');
    assert.equal(stripListMarker('11.10. Manobra teste de RPM mínima'), '11.10. Manobra teste de RPM mínima');
    assert.equal(stripListMarker('3 knots is the limit'), '3 knots is the limit');
    assert.equal(stripListMarker('1999 was the year'), '1999 was the year');
  });
});

describe('quoteCandidates', () => {
  it('tries both sides joined in either order, then each side alone', () => {
    assert.deepEqual(quoteCandidates('The drag coefficient', 'has two components'), [
      'The drag coefficient has two components',
      'has two components The drag coefficient',
      'The drag coefficient',
      'has two components',
    ]);
  });

  it('uses the only side there is, with its list marker stripped', () => {
    assert.deepEqual(quoteCandidates('3. Build upon the basics', ''), ['Build upon the basics']);
    assert.deepEqual(quoteCandidates('  ', 'Only the back'), ['Only the back']);
    assert.deepEqual(quoteCandidates('', ''), []);
  });
});

describe('broadestMatch', () => {
  it('prefers the candidate that matched the most of its own words, not the widest span', () => {
    // Replayed from a real PDF: front + back stretched over the next sentence
    // (38 source words, 30 of its own matched); back + front is the true passage.
    const results = [
      { found: true, matched: 30, score: 0.784 }, // front + back
      { found: true, matched: 32, score: 1 }, // back + front
      { found: true, matched: 26, score: 1 }, // front
      { found: true, matched: 6, score: 1 }, // back (a table-of-contents hit)
    ];
    assert.equal(broadestMatch(results), 1);
  });

  it('breaks a tie on the higher score, and returns -1 when nothing was found', () => {
    assert.equal(broadestMatch([{ found: true, matched: 5, score: 0.8 }, { found: true, matched: 5, score: 1 }]), 1);
    assert.equal(broadestMatch([{ found: false }, { found: false }]), -1);
  });
});
