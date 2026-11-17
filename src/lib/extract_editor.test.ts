/**
 * Extract Editor placement. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { editorPlacement } from './extract_editor';

const SCREEN = { width: 1440, height: 900 };

describe('extract_editor', () => {
  it('lies over the card on a wide queue', () => {
    // Frame at (60, 20) in the window; the card at (56, 216) in the frame, 1000 x 620.
    assert.deepEqual(
      editorPlacement({ top: 60, left: 20, width: 1400, height: 700 }, SCREEN, { top: 56, left: 216, width: 1000, height: 620 }),
      { width: 1000, height: 620, position: { top: 116, left: 236 }, compact: false }
    );
  });

  it('keeps the card top and width on a phone, but stays short for the keyboard', () => {
    const phone = { width: 390, height: 844 };
    const p = editorPlacement({ top: 100, left: 0, width: 390, height: 600 }, phone, { top: 12, left: 12, width: 366, height: 580 });
    assert.equal(p.compact, true);
    assert.equal(p.width, 366);
    assert.equal(p.height, Math.round(844 * 0.4));
    assert.deepEqual(p.position, { top: 112, left: 12 });
    // A card shorter than that: the card's own height.
    assert.equal(editorPlacement({ top: 100, left: 0, width: 390, height: 600 }, phone, { top: 12, left: 12, width: 366, height: 250 }).height, 250);
  });

  it('falls back to a centred panel when the frame or the card is unknown', () => {
    const p = editorPlacement(null, SCREEN);
    assert.equal(p.width, 900);
    assert.equal(p.position.left, 270);
    assert.equal(p.compact, false);
    const q = editorPlacement({ top: 0, left: 0, width: 390, height: 600 }, { width: 390, height: 844 }, null);
    assert.equal(q.compact, true);
    assert.equal(q.width, 382);
  });
});
