/**
 * Mislabelled-audio detection. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBridgeFileUrl, isMislabelledAudioUrl, storedFileName } from './audio_restore';

// Real names from the main KB: Sierra's relabelled audio (no extension) and a Read Aloud .mpga.
const BAD = 'YfpPnm4mdwzoZPmljVyqhmRE3gOYRrcHJsKp0cGcWujAn3yUvci-8LvdRVyEAhWAxJpfIhibLLAv9lVqoiMGWGUWmcwroRxtuLCOG49Q0UAv-CQQ6090XsEuesl7HKJO';
const GOOD = 'a9hX2GgMc9CABw8Q.mpga';

describe('audio_restore', () => {
  it('reads the stored name from both spellings', () => {
    assert.equal(storedFileName(`%LOCAL_FILE%${BAD}`), BAD);
    assert.equal(storedFileName(`https://remnote-user-data.s3.amazonaws.com/${GOOD}`), GOOD);
    assert.equal(storedFileName('https://example.com/x.mp3'), undefined);
  });

  it('flags only stored files with no extension', () => {
    assert.equal(isMislabelledAudioUrl(`%LOCAL_FILE%${BAD}`), true);
    assert.equal(isMislabelledAudioUrl(`https://remnote-user-data.s3.amazonaws.com/${BAD}`), true);
    assert.equal(isMislabelledAudioUrl(`%LOCAL_FILE%${GOOD}`), false);
    assert.equal(isMislabelledAudioUrl('https://media.merriam-webster.com/audio/prons/en/us/mp3/r/route001'), false);
    assert.equal(isMislabelledAudioUrl('%LOCAL_FILE%'), false);
  });

  it('accepts only the helper’s own files for store-media', () => {
    assert.equal(isBridgeFileUrl('http://127.0.0.1:3460/files/9cf36590b2-Aula-1.mp3'), true);
    assert.equal(isBridgeFileUrl('http://127.0.0.1:3460/tts/x'), false);
    assert.equal(isBridgeFileUrl('https://example.com/files/x.mp3'), false);
  });
});
