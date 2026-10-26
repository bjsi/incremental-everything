import { AI_OCR_HELPER_URL } from './ai_ocr';
import { callVideoHelper } from './video_snapshot';
import { LocalVideoFile, localVideoMediaPath } from './local_video_ref';

export * from './local_video_ref';

/** Where the helper serves the file, for a `<video src>`. */
export const localVideoMediaUrl = (file: LocalVideoFile) => `${AI_OCR_HELPER_URL}/media/${localVideoMediaPath(file)}`;

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
  const result = await callVideoHelper<{ cancelled: boolean; library: string; path: string; root: string }>(
    '/video-choose',
    { kind, prompt }
  );
  return result.cancelled ? null : { library: result.library, path: result.path, root: result.root };
}

/** Points a library at another folder, picked in the dialog. False when cancelled. */
export async function relinkVideoLibrary(library: string): Promise<boolean> {
  return !(await callVideoHelper<{ cancelled: boolean }>('/video-library-relink', { library })).cancelled;
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
