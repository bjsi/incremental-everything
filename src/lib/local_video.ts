import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { AI_OCR_HELPER_URL } from './ai_ocr';
import { callVideoHelper } from './video_snapshot';
import {
  LocalVideoFile,
  localVideoMediaPath,
  localVideoUrl,
  parseLocalVideoUrl,
  readLocalVideo,
} from './local_video_ref';
import {
  localVideoPowerupCode,
  videoExtractEndSlotCode,
  videoExtractPowerupCode,
  videoExtractStartSlotCode,
  videoExtractUrlSlotCode,
} from './consts';
import type { LocalVideoActionItem, LocalVideoHighlightActionItem } from './incremental_rem/types';

export * from './local_video_ref';

/** Where the helper serves the file, for a `<video src>`. */
export const localVideoMediaUrl = (file: LocalVideoFile) =>
  `${AI_OCR_HELPER_URL}/media/${localVideoMediaPath(file)}`;

// --- the helper ---------------------------------------------------------------

export interface VideoLibrary {
  name: string;
  root: string;
  /** Its folder exists now (an external disk may be disconnected). */
  available: boolean;
}

export async function listVideoLibraries(): Promise<VideoLibrary[]> {
  return (await callVideoHelper<{ libraries: VideoLibrary[] }>('/video-libraries', {})).libraries;
}

/**
 * Opens the macOS dialog for a folder of videos or one video file. The pick is
 * placed in a library (a new one at its folder when none holds it). Null when
 * the user cancels.
 */
export async function chooseLocalVideo(
  kind: 'folder' | 'file',
  prompt?: string
): Promise<(LocalVideoFile & { root: string }) | null> {
  const result = await callVideoHelper<{
    cancelled: boolean;
    library: string;
    path: string;
    root: string;
  }>('/video-choose', { kind, prompt });
  return result.cancelled
    ? null
    : { library: result.library, path: result.path, root: result.root };
}

/** Points a library at another folder, picked in the dialog. False when cancelled. */
export async function relinkVideoLibrary(library: string): Promise<boolean> {
  return !(await callVideoHelper<{ cancelled: boolean }>('/video-library-relink', { library }))
    .cancelled;
}

export interface VideoFolder {
  name: string;
  path: string;
  videos: { name: string; path: string }[];
  folders: VideoFolder[];
}

/** The videos under a library folder, in natural order, nested by subfolder. */
export async function scanVideoFolder(library: string, path: string): Promise<VideoFolder> {
  return (await callVideoHelper<{ tree: VideoFolder }>('/video-scan', { library, path })).tree;
}

/** Throws with the helper's reason when the file can't be served (library or file missing). */
export async function checkLocalVideo(file: LocalVideoFile): Promise<void> {
  await callVideoHelper('/video-file', { file });
}

// --- the Rem ------------------------------------------------------------------

/**
 * The local video a Rem plays: a Local Video Rem, or an extract of one (a
 * VideoExtract whose URL is `local-video://`). Null for anything else.
 */
export async function localVideoItemForRem(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<LocalVideoActionItem | LocalVideoHighlightActionItem | null> {
  if (await rem.hasPowerup(localVideoPowerupCode)) {
    const file = await readLocalVideo(rem);
    return file ? { type: 'local-video', rem, file, url: localVideoUrl(file) } : null;
  }
  if (!(await rem.hasPowerup(videoExtractPowerupCode))) return null;
  const [url, start, end] = await Promise.all([
    rem.getPowerupProperty(videoExtractPowerupCode, videoExtractUrlSlotCode),
    rem.getPowerupProperty(videoExtractPowerupCode, videoExtractStartSlotCode),
    rem.getPowerupProperty(videoExtractPowerupCode, videoExtractEndSlotCode),
  ]);
  const file = url ? parseLocalVideoUrl(String(url)) : null;
  if (!file || start == null || end == null) return null;
  const parent = rem.parent ? await plugin.rem.findOne(rem.parent) : undefined;
  return {
    type: 'local-video-highlight',
    rem: parent || rem,
    extract: rem,
    file,
    url: String(url),
    startTime: Number(start),
    endTime: Number(end),
  };
}
