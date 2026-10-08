/**
 * Image size steps and the "not sized by the user" test. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyImageSizeStep,
  isSizableImage,
  isUnsizedImage,
  nextImageSizeStep,
  sizeSignature,
} from './image_sizing';

const URL = 'https://remnote-user-data.s3.amazonaws.com/x.jpeg';
// The Anki-imported image that started this: full pixel size plus percent 50.
const ANKI = { i: 'i', url: URL, title: '', percent: 50, width: 1071, height: 1017 };
const NATURAL = { width: 1071, height: 1017 };

describe('nextImageSizeStep', () => {
  it('walks fit, large, medium, original and wraps', () => {
    assert.equal(nextImageSizeStep(undefined), 'fit');
    assert.equal(nextImageSizeStep('fit'), 'large');
    assert.equal(nextImageSizeStep('large'), 'medium');
    assert.equal(nextImageSizeStep('medium'), 'original');
    assert.equal(nextImageSizeStep('original'), 'fit');
  });
});

describe('isSizableImage', () => {
  it('accepts a plain image', () => {
    assert.equal(isSizableImage(ANKI), true);
  });
  it('rejects occlusions, drawings, empty urls and non-images', () => {
    assert.equal(isSizableImage({ ...ANKI, blocks: [{ cId: 'a' }] }), false);
    assert.equal(isSizableImage({ ...ANKI, drawingData: { bounds: {} } }), false);
    assert.equal(isSizableImage({ ...ANKI, drawing: { items: [] } }), false);
    assert.equal(isSizableImage({ ...ANKI, url: 'about:blank' }), false);
    assert.equal(isSizableImage({ i: 'm', text: 'x' }), false);
    assert.equal(isSizableImage('text'), false);
  });
  it('an empty blocks array is still a plain image', () => {
    assert.equal(isSizableImage({ ...ANKI, blocks: [] }), true);
  });
});

describe('isUnsizedImage', () => {
  it('stored size equal to the file size is unsized', () => {
    assert.equal(isUnsizedImage(ANKI, NATURAL), true);
  });
  it('no stored size is unsized, measured or not', () => {
    const bare = { i: 'i', url: URL, percent: 50 };
    assert.equal(isUnsizedImage(bare, NATURAL), true);
    assert.equal(isUnsizedImage(bare, undefined), true);
  });
  it('a drag-resized image is the user\'s', () => {
    const dragged = { i: 'i', url: URL, width: 439.32, height: 417.17 };
    assert.equal(isUnsizedImage(dragged, NATURAL), false);
  });
  it('a sized image that cannot be measured is left alone', () => {
    assert.equal(isUnsizedImage(ANKI, undefined), false);
  });
});

describe('applyImageSizeStep', () => {
  it('fit caps the width, keeps the ratio and drops percent', () => {
    const out: any = applyImageSizeStep(ANKI, 'fit', NATURAL);
    assert.equal(out.width, 680);
    assert.ok(Math.abs(out.height - (1017 * 680) / 1071) < 1e-9);
    assert.equal('percent' in out, false);
    assert.equal(out.title, '');
    assert.equal(out.url, URL);
  });
  it('large and medium set the menu percentages', () => {
    assert.equal((applyImageSizeStep(ANKI, 'large', NATURAL) as any).percent, 100);
    assert.equal((applyImageSizeStep(ANKI, 'medium', NATURAL) as any).percent, 50);
  });
  it('never enlarges a small image', () => {
    const small = { i: 'i', url: URL };
    const out: any = applyImageSizeStep(small, 'fit', { width: 229, height: 171 });
    assert.equal(out.width, 229);
    assert.equal(out.height, 171);
  });
  it('original hands the element back unchanged', () => {
    assert.deepEqual(applyImageSizeStep(ANKI, 'original', NATURAL), ANKI);
  });
  it('a step changes the size signature', () => {
    const fit = applyImageSizeStep(ANKI, 'fit', NATURAL);
    assert.notEqual(sizeSignature(fit), sizeSignature(ANKI));
    assert.equal(sizeSignature(applyImageSizeStep(ANKI, 'fit', NATURAL)), sizeSignature(fit));
  });
});
