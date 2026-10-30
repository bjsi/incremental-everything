/**
 * Transcript blocks. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boldMarkupToRichText, transcriptBlocks } from './video_transcript';
import { segmentsInRange } from './youtube_transcript';

const seg = (offset: number, text: string) => ({ offset, duration: 2, text });

describe('transcriptBlocks', () => {
  it('joins lines up to the size without splitting one', () => {
    const blocks = transcriptBlocks([seg(0, 'aaaa'), seg(2, 'bbbb'), seg(4, 'cccc')], {
      maxChars: 9,
      timestamps: false,
    });
    assert.deepEqual(blocks, ['aaaa bbbb', 'cccc']);
  });

  it('keeps a line longer than the size whole', () => {
    assert.deepEqual(transcriptBlocks([seg(0, 'a very long line')], { maxChars: 4, timestamps: false }), [
      'a very long line',
    ]);
  });

  it('starts each block with the time of its first line', () => {
    const blocks = transcriptBlocks([seg(61, 'one'), seg(63, 'two'), seg(125, 'three')], {
      maxChars: 7,
      timestamps: true,
    });
    assert.deepEqual(blocks, ['[01:01] one two', '[02:05] three']);
  });

  it('returns nothing for no lines', () => {
    assert.deepEqual(transcriptBlocks([], { maxChars: 300, timestamps: true }), []);
  });
});

describe('segmentsInRange', () => {
  it('keeps lines that overlap the range', () => {
    const lines = [seg(0, 'before'), seg(9, 'overlaps start'), seg(12, 'inside'), seg(20, 'after')];
    assert.deepEqual(
      segmentsInRange(lines, 10, 20).map((s) => s.text),
      ['overlaps start', 'inside']
    );
  });
});

describe('boldMarkupToRichText', () => {
  it('turns **key terms** into bold and leaves the rest plain', () => {
    assert.deepEqual(boldMarkupToRichText('os juízes do **Tribunal Marítimo** julgam **acidentes**.'), [
      'os juízes do ',
      { i: 'm', text: 'Tribunal Marítimo', b: true },
      ' julgam ',
      { i: 'm', text: 'acidentes', b: true },
      '.',
    ]);
  });

  it('leaves dollar signs alone', () => {
    assert.deepEqual(boldMarkupToRichText('custa R$ 500 e US$ 90'), ['custa R$ 500 e US$ 90']);
  });
});
