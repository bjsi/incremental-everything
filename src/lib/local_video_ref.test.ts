/**
 * local-video:// URLs. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localVideoTitle, localVideoUrl, parseLocalVideoUrl } from './local_video_ref';

describe('local-video URLs', () => {
  it('round-trips a library and a nested path with accents, spaces and #', () => {
    const file = { library: 'Vídeos Navegação Integrada', path: 'Módulo 1/Aula #2 (parte 1).mp4' };
    const url = localVideoUrl(file);
    assert.ok(url.startsWith('local-video://'));
    assert.ok(!url.includes(' '));
    assert.deepEqual(parseLocalVideoUrl(url), file);
  });

  it('is not a YouTube URL, and a YouTube URL is not one', () => {
    assert.equal(parseLocalVideoUrl('https://www.youtube.com/watch?v=O_XN2pCKH-w'), null);
  });

  it('titles a video by its file name', () => {
    assert.equal(localVideoTitle('Tug Use/20210802 A.mp4'), '20210802 A');
  });
});
