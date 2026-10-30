import { PluginRem } from '@remnote/plugin-sdk';
import { localVideoLibrarySlotCode, localVideoPathSlotCode, localVideoPowerupCode } from './consts';

/**
 * Video files on this computer, which RemNote has no interface for. The local
 * helper (scripts/ai_ocr_helper.py) keeps named **libraries** (folders the user
 * picked in a macOS dialog) and serves the videos inside them to a `<video>`
 * element over loopback, with HTTP Range. A Rem holds its video as library +
 * path relative to it (the Local Video powerup), so a folder that moves is
 * fixed once by re-pointing its library.
 *
 * Elsewhere a local video goes by its `local-video://<library>/<path>` URL:
 * the key of its position and speed, the URL of its extracts.
 *
 * This module is the light part, for the queue's item resolver; the helper
 * calls are in local_video.ts.
 */

export interface LocalVideoFile {
  library: string;
  /** Relative to the library's folder, with '/' separators. */
  path: string;
}

export const LOCAL_VIDEO_SCHEME = 'local-video://';

const encodePath = ({ library, path }: LocalVideoFile) =>
  `${encodeURIComponent(library)}/${path.split('/').map(encodeURIComponent).join('/')}`;

export const localVideoUrl = (file: LocalVideoFile) => LOCAL_VIDEO_SCHEME + encodePath(file);

export const isLocalVideoUrl = (url: string | undefined) => !!url?.startsWith(LOCAL_VIDEO_SCHEME);

export function parseLocalVideoUrl(url: string): LocalVideoFile | null {
  if (!isLocalVideoUrl(url)) return null;
  const rest = url.slice(LOCAL_VIDEO_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  try {
    return {
      library: decodeURIComponent(rest.slice(0, slash)),
      path: rest
        .slice(slash + 1)
        .split('/')
        .map(decodeURIComponent)
        .join('/'),
    };
  } catch {
    return null;
  }
}

/** The file's part of the helper's media URL: `/media/<this>`. */
export const localVideoMediaPath = encodePath;

/** The file's name without its folders or extension: a Rem's text when there is none. */
export const localVideoTitle = (path: string) => (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');

export async function readLocalVideo(rem: PluginRem): Promise<LocalVideoFile | null> {
  if (!(await rem.hasPowerup(localVideoPowerupCode))) return null;
  const [library, path] = await Promise.all([
    rem.getPowerupProperty(localVideoPowerupCode, localVideoLibrarySlotCode),
    rem.getPowerupProperty(localVideoPowerupCode, localVideoPathSlotCode),
  ]);
  return library && path ? { library, path } : null;
}

export async function setLocalVideo(rem: PluginRem, file: LocalVideoFile) {
  await rem.addPowerup(localVideoPowerupCode);
  await rem.setPowerupProperty(localVideoPowerupCode, localVideoLibrarySlotCode, [file.library]);
  await rem.setPowerupProperty(localVideoPowerupCode, localVideoPathSlotCode, [file.path]);
}

