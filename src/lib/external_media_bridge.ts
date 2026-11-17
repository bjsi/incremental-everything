import { AppEvents, RNPlugin } from '@remnote/plugin-sdk';
import { isBridgeFileUrl, storeServedMedia } from './audio_restore';
import { firstTime, reply, unwrap } from './external_priority_bridge';

/**
 * Storing audio (or any file) in RemNote for other plugins, under its real type.
 * Same channel and conventions as the priority bridge
 * (external_priority_bridge.ts); documented in
 * docs/Priority-Bridge-for-Other-Plugins.md.
 *
 * Why: the SDK has no upload call, and the only door a plugin can open on its
 * own (the markdown importer's data-URI rule) takes `data:image/…` only. Audio
 * pushed through it relabelled as an image is stored as `image/…` with no
 * extension, which iOS refuses to play. Here the file goes through RemNote's
 * import door instead, which keeps the type the file is served with
 * (lib/audio_restore.ts).
 *
 * The client first posts the bytes to the Local Media Bridge helper
 * (POST http://127.0.0.1:3460/files?name=<file name>, raw body), which keeps
 * them under their real type and answers {url}. It then sends those URLs here.
 * Only the helper's own /files/ URLs are accepted.
 *
 * PROTOCOL v3
 *   store-media   {requestId, urls: string[]}  → store-media-answer
 *                 {requestId, results: {[url]: storedUrl | null}}
 *                 — storedUrl is RemNote's own copy (%LOCAL_FILE%… or its S3
 *                 address), to put in an audio element `{i: 'a', url, onlyAudio: true}`.
 *                 About 2 s per small file; a large one takes as long as its upload.
 */
export const MEDIA_BRIDGE_KEYS = {
  store: 'ie-bridge.v1.store-media',
  answer: 'ie-bridge.v1.store-media-answer',
} as const;

/** One request at a time: each one drives RemNote's background upload job. */
let queue: Promise<unknown> = Promise.resolve();

export function registerExternalMediaBridge(plugin: RNPlugin) {
  plugin.event.addListener(AppEvents.StorageSessionChange, MEDIA_BRIDGE_KEYS.store, async (raw: any) => {
    const msg = unwrap(raw);
    if (!firstTime('store-media', msg?.requestId)) return;
    const urls: string[] = Array.isArray(msg!.urls) ? msg!.urls.filter((u: unknown): u is string => typeof u === 'string') : [];
    queue = queue.then(async () => {
      const results: Record<string, string | null> = {};
      try {
        const stored = await storeServedMedia(plugin, urls.filter(isBridgeFileUrl));
        for (const url of urls) results[url] = stored.get(url) ?? null;
      } catch (e) {
        console.error('[MediaBridge] store-media failed', e);
        for (const url of urls) results[url] ??= null;
      }
      await reply(plugin, MEDIA_BRIDGE_KEYS.answer, { requestId: msg!.requestId, results });
    });
  });
}
