/**
 * Localize-media helpers. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectExternalMedia,
  findHostedImageUrl,
  imageMimeFor,
  imageUrlsOf,
  isExternalMediaUrl,
  isRemNoteHostedUrl,
  markdownImageFor,
  replaceMediaUrls,
} from './localize_media';

const OXFORD = 'https://www.oxfordlearnersdictionaries.com/media/english/us_pron/r/rou/route/routeing__us_2.mp3';
const WIKI = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c3/Vts.jpg/500px-Vts.jpg?utm_source=en.wikipedia.org&utm_campaign=parser';
const LOCAL = '%LOCAL_FILE%GuaGpiDJOHhemG6vA9O2.png';
const S3 = 'https://remnote-user-data.s3.amazonaws.com/a9hX2GgMc9CABw8Q.mpga';

describe('isRemNoteHostedUrl / isExternalMediaUrl', () => {
  it('recognises both spellings of a stored file', () => {
    assert.equal(isRemNoteHostedUrl(LOCAL), true);
    assert.equal(isRemNoteHostedUrl(S3), true);
    assert.equal(isRemNoteHostedUrl(WIKI), false);
  });

  it('treats only outside http(s) links as external', () => {
    assert.equal(isExternalMediaUrl(OXFORD), true);
    assert.equal(isExternalMediaUrl(LOCAL), false);
    assert.equal(isExternalMediaUrl(S3), false);
    assert.equal(isExternalMediaUrl('data:image/png;base64,AAAA'), false);
    assert.equal(isExternalMediaUrl(undefined), false);
  });
});

describe('collectExternalMedia', () => {
  it('takes linked images and audio, and leaves stored files and videos alone', () => {
    const richText: any = [
      'Teste ',
      { i: 'i', url: LOCAL, width: 766 },
      ' and ',
      { i: 'i', url: WIKI, width: 500 },
      { i: 'a', url: OXFORD, onlyAudio: true, percent: 100 },
      { i: 'a', url: S3, onlyAudio: true },
      { i: 'a', url: 'https://youtu.be/7nY0Et5TjU0', onlyAudio: false },
      { i: 'm', text: 'bold', b: true, url: 'https://example.com' },
    ];
    assert.deepEqual(collectExternalMedia(richText), [
      { kind: 'image', url: WIKI },
      { kind: 'audio', url: OXFORD },
    ]);
    assert.deepEqual(collectExternalMedia(undefined), []);
  });
});

describe('replaceMediaUrls', () => {
  it('swaps the URL and keeps every other field of the element', () => {
    const richText: any = ['/ˈraʊtɪŋ/ ', { i: 'a', url: OXFORD, onlyAudio: true, percent: 100 }, ' '];
    assert.deepEqual(replaceMediaUrls(richText, new Map([[OXFORD, S3]])), [
      '/ˈraʊtɪŋ/ ',
      { i: 'a', url: S3, onlyAudio: true, percent: 100 },
      ' ',
    ]);
  });

  it('returns the same array when nothing matches, and never touches a text link', () => {
    const richText: any = [{ i: 'm', text: 'link', url: OXFORD }, { i: 'i', url: WIKI }];
    assert.equal(replaceMediaUrls(richText, new Map([[OXFORD, S3]])), richText);
  });
});

describe('markdownImageFor', () => {
  it('escapes what would end the markdown link and leaves the query string alone', () => {
    assert.equal(markdownImageFor(WIKI), `![](${WIKI})`);
    assert.equal(
      markdownImageFor('https://example.com/a (1).png'),
      '![](https://example.com/a%20%281%29.png)'
    );
  });
});

describe('imageUrlsOf', () => {
  it('lists image URLs in order, skipping text and audio', () => {
    const richText: any = [{ i: 'i', url: LOCAL }, ' ', { i: 'a', url: OXFORD }, { i: 'i', url: WIKI }];
    assert.deepEqual(imageUrlsOf(richText), [LOCAL, WIKI]);
    assert.deepEqual(imageUrlsOf(undefined), []);
  });
});

describe('findHostedImageUrl', () => {
  it('finds the stored image once the URL has been swapped', () => {
    assert.equal(findHostedImageUrl([{ i: 'i', url: WIKI }] as any), undefined);
    assert.equal(findHostedImageUrl(['x', { i: 'i', url: LOCAL }] as any), LOCAL);
  });
});

describe('imageMimeFor', () => {
  it('prefers the response type and falls back on the extension', () => {
    assert.equal(imageMimeFor('image/svg+xml; charset=utf-8', WIKI), 'image/svg+xml');
    assert.equal(imageMimeFor('application/octet-stream', WIKI), 'image/jpeg');
    assert.equal(imageMimeFor('', 'https://example.com/file'), undefined);
    assert.equal(imageMimeFor('audio/mpeg', OXFORD), undefined);
  });
});
