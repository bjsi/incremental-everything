/**
 * Video snapshot outline parsing. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutline } from './video_snapshot';

describe('parseOutline', () => {
  it('nests by two-space indentation', () => {
    const markup = [
      '- **Law of the Sea**',
      '  - **Territorial sea**: 12 nm',
      '    - **Full sovereignty**',
      '  - **EEZ**: 200 nm',
      '- Footer',
    ].join('\n');
    assert.deepEqual(parseOutline(markup), [
      { depth: 0, text: '**Law of the Sea**' },
      { depth: 1, text: '**Territorial sea**: 12 nm' },
      { depth: 2, text: '**Full sovereignty**' },
      { depth: 1, text: '**EEZ**: 200 nm' },
      { depth: 0, text: 'Footer' },
    ]);
  });

  it('accepts four spaces, tabs, * markers and blank lines', () => {
    assert.deepEqual(parseOutline('* a\n\n    * b\n\t\t* c\n* d'), [
      { depth: 0, text: 'a' },
      { depth: 1, text: 'b' },
      { depth: 1, text: 'c' },
      { depth: 0, text: 'd' },
    ]);
  });

  it('never skips a level', () => {
    assert.deepEqual(parseOutline('  - a\n        - b\n    - c'), [
      { depth: 0, text: 'a' },
      { depth: 1, text: 'b' },
      { depth: 1, text: 'c' },
    ]);
  });

  it('keeps lines without a marker', () => {
    assert.deepEqual(parseOutline('Title\n  - item'), [
      { depth: 0, text: 'Title' },
      { depth: 1, text: 'item' },
    ]);
  });
});
