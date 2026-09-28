/**
 * Fixture tests for PDF reading state. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { repointBookmarksInState } from './pdf_state';

describe('repointBookmarksInState', () => {
  const state = {
    v: 1,
    active: 'pdf1',
    bySource: {
      pdf1: { page: 16, history: [{ page: 15, timestamp: 1, highlightId: 'small' }, { page: 16, timestamp: 2 }] },
      pdf2: { history: [{ page: 3, timestamp: 3, highlightId: 'other' }, { page: 4, timestamp: 4, highlightId: 'small' }] },
    },
  };

  it('moves every bookmark on a merged highlight to the one it merged into', () => {
    const out = JSON.parse(repointBookmarksInState(JSON.stringify(state), { small: 'large' })!);
    assert.equal(out.bySource.pdf1.history[0].highlightId, 'large');
    assert.equal(out.bySource.pdf1.history[1].highlightId, undefined);
    assert.deepEqual(out.bySource.pdf2.history.map((h: any) => h.highlightId), ['other', 'large']);
    assert.equal(out.active, 'pdf1');
    assert.equal(out.bySource.pdf1.page, 16);
  });

  it('returns null when no bookmark points at a merged highlight, or there is no state', () => {
    assert.equal(repointBookmarksInState(JSON.stringify(state), { unrelated: 'large' }), null);
    assert.equal(repointBookmarksInState(null, { small: 'large' }), null);
  });
});
