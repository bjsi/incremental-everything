/**
 * Extract Editor placement. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { editorPlacement } from './extract_editor';

const SCREEN = { width: 1440, height: 900 };

describe('extract_editor', () => {
  it('lies over the viewer card on a wide queue', () => {
    // A 1400-wide frame: the card is 1000 wide, centred, 48 below the top, 16 above the bottom.
    assert.deepEqual(editorPlacement({ top: 60, left: 20, width: 1400, height: 700 }, SCREEN), {
      width: 1000,
      height: 636,
      position: { top: 108, left: 220 },
      compact: false,
    });
    // Narrower than the card's maximum: the card fills the frame less its side padding.
    const p = editorPlacement({ top: 60, left: 0, width: 800, height: 700 }, SCREEN);
    assert.equal(p.width, 768);
    assert.equal(p.position.left, 16);
  });

  it('starts at the card on a phone and stays short, for the keyboard', () => {
    const p = editorPlacement({ top: 100, left: 0, width: 390, height: 600 }, { width: 390, height: 844 });
    assert.equal(p.compact, true);
    assert.equal(p.width, 382);
    assert.equal(p.height, Math.round(844 * 0.4));
    // The card's top edge, 48 below the frame's: never above the card.
    assert.deepEqual(p.position, { top: 148, left: 4 });
    // A short queue frame: no taller than the card itself.
    assert.equal(editorPlacement({ top: 100, left: 0, width: 390, height: 300 }, { width: 390, height: 844 }).height, 248);
  });

  it('falls back to a centred panel when the frame is unknown', () => {
    const p = editorPlacement(null, SCREEN);
    assert.equal(p.width, 900);
    assert.equal(p.position.left, 270);
    assert.equal(p.compact, false);
    assert.equal(editorPlacement({ top: 0, left: 0, width: 0, height: 0 }, { width: 390, height: 844 }).compact, true);
  });
});
