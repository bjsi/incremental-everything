/**
 * History snapshots of where a video was left. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import {
  buildVideoContext,
  extractPositionKey,
  formatVideoContext,
  formatVideoTime,
  videoPositionKey,
  videoRateKey,
} from './video_position';

/** A Rem with the given powerups, as { code: { slot: value } }. */
const fakeRem = (id: string, powerups: Record<string, Record<string, string>>) =>
  ({
    _id: id,
    hasPowerup: async (code: string) => code in powerups,
    getPowerupProperty: async (code: string, slot: string) => powerups[code]?.[slot] ?? '',
  }) as unknown as PluginRem;

const fakePlugin = (synced: Record<string, unknown>) =>
  ({ storage: { getSynced: async (key: string) => synced[key] } }) as unknown as RNPlugin;

const YT = 'https://www.youtube.com/watch?v=abc';

describe('buildVideoContext', () => {
  it("records an extract's own position, its segment and the speed", async () => {
    const rem = fakeRem('ex1', { videoExtract: { videoUrl: YT, startTime: '86', endTime: '124' } });
    const plugin = fakePlugin({
      [extractPositionKey('ex1')]: 102.4,
      [videoPositionKey(YT)]: 900,
      [videoRateKey(YT)]: 1.5,
    });
    assert.deepEqual(await buildVideoContext(plugin, rem), {
      videoTime: 102,
      videoStart: 86,
      videoEnd: 124,
      videoRate: 1.5,
    });
  });

  it("records a RemNote video's position with the length its player recorded", async () => {
    const rem = fakeRem('v1', { vi: { u: YT }, ip: { l: '0', d: '2700.2' } });
    const plugin = fakePlugin({ [videoPositionKey(YT)]: 754, [videoRateKey(YT)]: 1 });
    assert.deepEqual(await buildVideoContext(plugin, rem), { videoTime: 754, videoDuration: 2700 });
  });

  it('records a YouTube link, but not any other link', async () => {
    const plugin = fakePlugin({ [videoPositionKey(YT)]: 60, [videoPositionKey('https://x.org')]: 60 });
    assert.deepEqual(await buildVideoContext(plugin, fakeRem('l1', { b: { URL: YT } })), { videoTime: 60 });
    assert.equal(await buildVideoContext(plugin, fakeRem('l2', { b: { URL: 'https://x.org' } })), undefined);
  });

  it('records nothing for a video never played, or a Rem that is not a video', async () => {
    const plugin = fakePlugin({});
    assert.equal(await buildVideoContext(plugin, fakeRem('v1', { vi: { u: YT } })), undefined);
    assert.equal(
      await buildVideoContext(plugin, fakeRem('ex1', { videoExtract: { videoUrl: YT, startTime: '1', endTime: '9' } })),
      undefined
    );
    assert.equal(await buildVideoContext(plugin, fakeRem('r1', {})), undefined);
  });
});

describe('formatVideoContext', () => {
  it('reads like a page within a range for an extract', () => {
    assert.equal(formatVideoContext({ videoTime: 102, videoStart: 86, videoEnd: 124, videoRate: 1.5 }), '▶ 1:42 of 1:26–2:04 · 1.5×');
    assert.equal(formatVideoContext({ videoTime: 121, videoStart: 86, videoEnd: 124 }), '▶ 2:01 of 1:26–2:04 · ✓ end');
  });

  it('shows progress when the length is known', () => {
    assert.equal(formatVideoContext({ videoTime: 754, videoDuration: 2700 }), '▶ 12:34 / 45:00 (28%)');
    assert.equal(formatVideoContext({ videoTime: 2698, videoDuration: 2700 }), '▶ 44:58 / 45:00 · ✓ end');
    assert.equal(formatVideoContext({ videoTime: 754 }), '▶ 12:34');
    assert.equal(formatVideoContext({}), undefined);
  });

  it('adds hours past the first one', () => {
    assert.equal(formatVideoTime(3725), '1:02:05');
    assert.equal(formatVideoTime(75), '1:15');
  });
});
