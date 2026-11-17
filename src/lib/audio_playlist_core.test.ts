/**
 * Audio Playlist core: audio in rich text, MP3 length, the joined timeline, resume.
 * Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  audioUrlsIn,
  captionOf,
  emptyPlayerState,
  formatClock,
  globalTimeOf,
  isGenericCaption,
  locate,
  MAX_SAVED_PLAYLISTS,
  mp3Length,
  normalizePlayerState,
  playableUrl,
  resumePoint,
  specKey,
  timelineOf,
  urlKey,
  withPosition,
} from './audio_playlist_core';

const HOST = 'https://remnote-user-data.s3.amazonaws.com/';
const NAME = 'P3CsT4nLs2rb-eolI3F971LF4FcEG6iaLDA7B2-Id_Yl0V8AhMUDGpZDYMKtsBhqhcZh.mpga';

/** A constant-bitrate MP3: `frames` identical frames, optionally behind an ID3v2 tag. */
function mp3(opts: { frames: number; id3?: number; xingFrames?: number; mpeg1?: boolean }): Uint8Array {
  // MPEG2 Layer III 64 kbit/s 24 kHz mono (a Gemini TTS file), or MPEG1 160 kbit/s 44.1 kHz stereo.
  const header = opts.mpeg1 ? [0xff, 0xfb, 0xa0, 0x00] : [0xff, 0xf3, 0x84, 0xc0];
  const size = opts.mpeg1 ? Math.floor((144 * 160000) / 44100) : Math.floor((72 * 64000) / 24000);
  const id3 = opts.id3 ?? 0;
  const out = new Uint8Array(id3 + size * opts.frames);
  if (id3) {
    const body = id3 - 10;
    out.set([0x49, 0x44, 0x33, 4, 0, 0, (body >> 21) & 0x7f, (body >> 14) & 0x7f, (body >> 7) & 0x7f, body & 0x7f]);
  }
  for (let f = 0; f < opts.frames; f++) out.set(header, id3 + f * size);
  if (opts.xingFrames) {
    const at = id3 + 4 + (opts.mpeg1 ? 32 : 9);
    out.set([...'Info'].map((c) => c.charCodeAt(0)), at);
    out.set([0, 0, 0, 1], at + 4);
    const n = opts.xingFrames;
    out.set([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], at + 8);
  }
  return out;
}

describe('audio_playlist_core', () => {
  it('finds stored and linked audio, not video or pages', () => {
    const text = [
      '🔊 Áudio (Kore) ',
      { i: 'a', url: HOST + NAME, onlyAudio: true },
      { i: 'a', url: '%LOCAL_FILE%abc.mpga', onlyAudio: true },
      { i: 'a', url: 'https://example.com/clip.mp4' }, // a video
      { i: 'a', url: 'https://www.youtube.com/watch?v=x', onlyAudio: true },
      { i: 'a', url: 'blob:app://js/123', onlyAudio: true },
      { i: 'i', url: HOST + 'picture.png' },
    ];
    assert.deepEqual(audioUrlsIn(text), [HOST + NAME, HOST + 'abc.mpga']);
    assert.deepEqual(audioUrlsIn(undefined), []);
    assert.equal(playableUrl('%LOCAL_FILE%'), undefined);
  });

  it('tells a file caption from a title', () => {
    assert.equal(captionOf(['🔊 Áudio (Kore) ', { i: 'a', url: 'x', onlyAudio: true }]), '🔊 Áudio (Kore)');
    assert.equal(captionOf([{ i: 'm', text: 'Aula 3', b: true }, ' – ondas']), 'Aula 3 – ondas');
    for (const generic of ['', '🔊 Áudio (Kore)', 'Audio', 'Áudio 2', 'Pronunciation:']) {
      assert.equal(isGenericCaption(generic), true, generic);
    }
    for (const title of ['Aula 3 – ondas', 'Audio engineering basics for sailors']) {
      assert.equal(isGenericCaption(title), false, title);
    }
  });

  it('keys an address shortly and stably', () => {
    assert.equal(urlKey(HOST + NAME), NAME.slice(0, 20));
    assert.equal(urlKey('https://example.com/a.mp3'), urlKey('https://example.com/a.mp3'));
    assert.notEqual(urlKey('https://example.com/a.mp3'), urlKey('https://example.com/b.mp3'));
    assert.equal(specKey({ rootIds: ['a', 'b'], tagId: 't' }), 'a,b|t');
    assert.equal(specKey({ tagId: 't' }), '|t');
  });

  it('reads a constant-bitrate MP3 from its size', () => {
    // 1000 frames of 576 samples at 24 kHz = 24 s.
    const file = mp3({ frames: 1000 });
    const got = mp3Length(file.slice(0, 4096), file.length);
    assert.ok(got && 'seconds' in got);
    assert.ok(Math.abs(got.seconds - 24) < 0.05, String(got.seconds));
  });

  it('skips an ID3 tag, and asks for more when the tag fills what it was given', () => {
    const file = mp3({ frames: 1000, id3: 300 });
    const got = mp3Length(file.slice(0, 4096), file.length);
    assert.ok(got && 'seconds' in got && Math.abs(got.seconds - 24) < 0.05);

    const big = mp3({ frames: 1000, id3: 50000 });
    const first = mp3Length(big.slice(0, 4096), big.length);
    assert.deepEqual(first, { readFrom: 50000 });
    const second = mp3Length(big.slice(50000, 54096), big.length, 50000);
    assert.ok(second && 'seconds' in second && Math.abs(second.seconds - 24) < 0.05);
  });

  it('prefers the frame count an encoder wrote', () => {
    // 4,000 frames of 1152 samples at 44.1 kHz ≈ 104.49 s, whatever the size says.
    const file = mp3({ frames: 50, xingFrames: 4000, mpeg1: true });
    const got = mp3Length(file.slice(0, 4096), file.length);
    assert.ok(got && 'seconds' in got);
    assert.ok(Math.abs(got.seconds - (4000 * 1152) / 44100) < 0.01, String(got.seconds));
  });

  it('refuses what is not an MP3', () => {
    assert.equal(mp3Length(new Uint8Array(4096), 100000), undefined);
    const m4a = new Uint8Array(4096);
    m4a.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]); // ....ftyp
    assert.equal(mp3Length(m4a, 100000), undefined);
  });

  it('joins tracks into one timeline', () => {
    const durations = [60, undefined, 30, 10];
    const tl = timelineOf(durations);
    assert.deepEqual(tl.starts, [0, 60, 60, 90]);
    assert.equal(tl.total, 100);
    assert.equal(tl.unknown, 1);
    assert.deepEqual(locate(tl, durations, 0), { index: 0, time: 0 });
    assert.deepEqual(locate(tl, durations, 59.5), { index: 0, time: 59.5 });
    // 60 s is the start of the third track: the second has no known length to land in.
    assert.deepEqual(locate(tl, durations, 60), { index: 2, time: 0 });
    assert.deepEqual(locate(tl, durations, 95), { index: 3, time: 5 });
    assert.deepEqual(locate(tl, durations, 1e6), { index: 3, time: 9.75 });
    assert.deepEqual(locate(tl, durations, -5), { index: 0, time: 0 });
    assert.equal(globalTimeOf(tl, 2, 12), 72);
    assert.deepEqual(locate(timelineOf([]), [], 10), { index: 0, time: 0 });
  });

  it('formats a clock', () => {
    assert.equal(formatClock(0), '0:00');
    assert.equal(formatClock(75.9), '1:15');
    assert.equal(formatClock(3725), '1:02:05');
    assert.equal(formatClock(undefined), '–:––');
  });

  it('resumes on the saved track, wherever it now sits', () => {
    assert.deepEqual(resumePoint(['a', 'new', 'b'], { trackKey: 'b', time: 42 }), { index: 2, time: 42 });
    assert.deepEqual(resumePoint(['a'], { trackKey: 'gone', time: 42 }), { index: 0, time: 0 });
    assert.deepEqual(resumePoint(['a'], undefined), { index: 0, time: 0 });
  });

  it('keeps the most recent playlists and survives bad stored data', () => {
    let state = emptyPlayerState();
    for (let i = 0; i < MAX_SAVED_PLAYLISTS + 5; i++) {
      state = withPosition(state, { spec: { rootIds: [`r${i}`] }, title: `P${i}`, time: i, updatedAt: i });
    }
    assert.equal(Object.keys(state.playlists).length, MAX_SAVED_PLAYLISTS);
    assert.equal(state.playlists['r0|'], undefined);
    assert.equal(state.last, `r${MAX_SAVED_PLAYLISTS + 4}|`);

    assert.deepEqual(normalizePlayerState(null), emptyPlayerState());
    const cleaned = normalizePlayerState({
      playlists: { 'x|': { spec: {}, title: 'no source', time: 1, updatedAt: 1 }, 'r1|': state.playlists['r24|'] },
      last: 'x|',
      rate: 99,
      tags: [{ id: 't', name: 'AI audio' }, { id: 5 }],
    });
    assert.deepEqual(Object.keys(cleaned.playlists), ['r1|']);
    assert.equal(cleaned.last, undefined);
    assert.equal(cleaned.rate, 1);
    assert.deepEqual(cleaned.tags, [{ id: 't', name: 'AI audio' }]);
  });
});
