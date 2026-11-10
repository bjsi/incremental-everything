import { AppEvents, RNPlugin } from '@remnote/plugin-sdk';
import { cardVideoPowerupCode } from './consts';
import { chooseLocalVideo, scanVideoFolder, setCardVideo, VideoFolder } from './local_video';
import { firstTime, reply, unwrap } from './external_priority_bridge';

/**
 * Card videos for other plugins (e.g. an importer that has a video explaining
 * each question it creates): the same thing as Link Local Video as Card Extra,
 * a local video on the card's own Rem, shown under the answer after Show
 * Answer. Same channel and conventions as the priority bridge
 * (external_priority_bridge.ts); documented in
 * docs/Priority-Bridge-for-Other-Plugins.md.
 *
 * A plugin can't open a file dialog or reach the local helper that serves the
 * videos, so the folder is picked here, in the helper's macOS dialog, and the
 * client gets back the videos in it to match to its cards by name.
 *
 * PROTOCOL v2 (every payload carries a requestId, answers echo it)
 *   video-folder     {requestId, prompt?}                 → video-folder-answer
 *                    {requestId, status: 'ok' | 'cancelled' | 'error', error?,
 *                     library?, root?, path?, videos?: [{name, path}]}
 *                    — every video under the picked folder, subfolders included:
 *                    `name` is the file name without its extension, `path` is
 *                    relative to the library (pass it back as is).
 *   set-card-video   {requestId, items: [{remId, library, path} | {remId, remove: true}]}
 *                    → set-card-video-ack {requestId, done: remId[], failed: remId[]}
 */
export const CARD_VIDEO_BRIDGE_KEYS = {
  folder: 'ie-bridge.v1.video-folder',
  folderAnswer: 'ie-bridge.v1.video-folder-answer',
  set: 'ie-bridge.v1.set-card-video',
  ack: 'ie-bridge.v1.set-card-video-ack',
} as const;

/** The files the helper plays (VIDEO_TYPES in scripts/ai_ocr_helper.py). */
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm)$/i;

const flatten = (folder: VideoFolder): { name: string; path: string }[] => [
  ...folder.videos.map(({ name, path }) => ({ name, path })),
  ...folder.folders.flatMap(flatten),
];

/**
 * A library path as the scan gave it: relative, inside the library, a video.
 * The helper refuses anything outside the library anyway; this only keeps
 * nonsense off the Rem.
 */
const validPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  !!path &&
  !path.startsWith('/') &&
  !path.split('/').some((part) => part === '..' || part === '') &&
  VIDEO_EXTENSIONS.test(path);

export function registerExternalCardVideoBridge(plugin: RNPlugin) {
  plugin.event.addListener(AppEvents.StorageSessionChange, CARD_VIDEO_BRIDGE_KEYS.folder, async (raw: any) => {
    const msg = unwrap(raw);
    if (!firstTime('video-folder', msg?.requestId)) return;
    const answer = (value: Record<string, unknown>) =>
      reply(plugin, CARD_VIDEO_BRIDGE_KEYS.folderAnswer, { requestId: msg!.requestId, ...value });
    try {
      const prompt = typeof msg!.prompt === 'string' && msg!.prompt ? msg!.prompt : 'Choose a folder of videos';
      const picked = await chooseLocalVideo('folder', prompt);
      if (!picked) return await answer({ status: 'cancelled' });
      const tree = await scanVideoFolder(picked.library, picked.path);
      await answer({
        status: 'ok',
        library: picked.library,
        root: picked.root,
        path: picked.path,
        videos: flatten(tree),
      });
    } catch (e) {
      console.error('[CardVideoBridge] video-folder failed', e);
      await answer({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  });

  plugin.event.addListener(AppEvents.StorageSessionChange, CARD_VIDEO_BRIDGE_KEYS.set, async (raw: any) => {
    const msg = unwrap(raw);
    if (!firstTime('set-card-video', msg?.requestId)) return;
    const done: string[] = [];
    const failed: string[] = [];
    for (const item of Array.isArray(msg!.items) ? msg!.items : []) {
      try {
        const rem = typeof item?.remId === 'string' ? await plugin.rem.findOne(item.remId) : undefined;
        if (!rem) throw new Error('no such Rem');
        if (item.remove === true) {
          if (await rem.hasPowerup(cardVideoPowerupCode)) await rem.removePowerup(cardVideoPowerupCode);
        } else {
          if (typeof item.library !== 'string' || !item.library || !validPath(item.path)) {
            throw new Error('invalid video');
          }
          await setCardVideo(rem, { library: item.library, path: item.path });
        }
        done.push(rem._id);
      } catch (e) {
        console.error('[CardVideoBridge] set-card-video failed for', item, e);
        failed.push(item?.remId);
      }
    }
    await reply(plugin, CARD_VIDEO_BRIDGE_KEYS.ack, { requestId: msg!.requestId, done, failed });
  });
}
