/**
 * Tests for quote cleaning. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripListMarker } from './quote';

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
    assert.equal(stripListMarker('3 knots is the limit'), '3 knots is the limit');
    assert.equal(stripListMarker('1999 was the year'), '1999 was the year');
  });
});
