import { RNPlugin, RemId, RichTextInterface } from '@remnote/plugin-sdk';
import { AI_OCR_HELPER_URL, markupToRichText } from './ai_ocr';
import { findHostedImageUrl } from './localize_media';
import { sanitizeRichTextForSetText } from './richTextSanitize';

/**
 * Screenshots of the plugin's YouTube player, saved under the IncRem.
 *
 * The player can't be captured from inside RemNote: its frame is cross-origin
 * and RemNote grants no screen capture. So the local helper
 * (scripts/ai_ocr_helper.py) grabs the exact frame from the video itself with
 * yt-dlp and ffmpeg, and can transcribe it into an outline with the user's
 * `claude` CLI. Each shot becomes a "📸 MM:SS" Rem holding the image and,
 * when transcribed, the outline nested under it.
 */

export interface VideoHelperStatus {
  /** The helper answered. */
  reachable: boolean;
  /** It can grab frames: a version with video support, yt-dlp and ffmpeg found. */
  frames: boolean;
  /** It can transcribe: the claude CLI was found. */
  ai: boolean;
}

export const HELPER_DOWN: VideoHelperStatus = { reachable: false, frames: false, ai: false };

export async function checkVideoHelper(): Promise<VideoHelperStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${AI_OCR_HELPER_URL}/`, { signal: controller.signal });
    const body = await res.json();
    return { reachable: true, frames: !!(body?.ytDlp && body?.ffmpeg), ai: !!body?.claude };
  } catch {
    return HELPER_DOWN;
  } finally {
    clearTimeout(timer);
  }
}

async function callHelper<T>(route: string, payload: object): Promise<T> {
  let body: any;
  try {
    const res = await fetch(`${AI_OCR_HELPER_URL}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    body = await res.json();
  } catch (e) {
    throw new Error(
      `The helper is not running (${AI_OCR_HELPER_URL}). Start scripts/ai_ocr_helper.py.`
    );
  }
  if (!body?.ok) throw new Error(body?.error ?? 'the helper returned no result');
  return body as T;
}

export const formatVideoTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

async function createChild(plugin: RNPlugin, parentId: RemId, text: RichTextInterface) {
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('Could not create a Rem.');
  await rem.setText(text);
  await rem.setParent(parentId);
  return rem;
}

interface OutlineLine {
  depth: number;
  text: string;
}

/**
 * The helper's outline: "- " lines nested by indentation. Depths are taken from
 * the indentation actually used, so two or four spaces (or tabs) both work, and
 * a line can't sit more than one level below the line before it.
 */
export function parseOutline(markup: string): OutlineLine[] {
  const lines: OutlineLine[] = [];
  const indents: number[] = [];
  for (const raw of markup.split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.replace(/\t/g, '  ').search(/\S/);
    const text = raw.trim().replace(/^[-*]\s+/, '');
    if (!text) continue;
    while (indents.length && indents[indents.length - 1] >= indent) indents.pop();
    const depth = Math.min(indents.length, lines.length ? lines[lines.length - 1].depth + 1 : 0);
    indents.push(indent);
    lines.push({ depth, text });
  }
  return lines;
}

export interface SnapshotProgress {
  (stage: 'grabbing' | 'saving' | 'transcribing'): void;
}

/**
 * Grabs the frame at `seconds` and saves it as "📸 MM:SS" › image under
 * `parentId`; with `transcribe`, the frame's text follows the image as an
 * outline. Returns how many text Rems were added. Throws with a message for the
 * user; a failed transcription leaves the screenshot in place.
 */
export async function saveVideoSnapshot(
  plugin: RNPlugin,
  opts: {
    videoId: string;
    seconds: number;
    parentId: RemId;
    transcribe: boolean;
    onProgress?: SnapshotProgress;
  }
): Promise<{ heading: RemId; lines: number }> {
  const { videoId, seconds, parentId, transcribe, onProgress } = opts;
  onProgress?.('grabbing');
  const frame = await callHelper<{ frameId: string; mime: string; image: string }>('/video-frame', {
    videoId,
    seconds,
  });

  onProgress?.('saving');
  // The markdown parser uploads a data-URI image and returns RemNote's stored
  // copy (see localize_media.ts, "door 1").
  const image = await plugin.richText.parseFromMarkdown(
    `![](data:${frame.mime};base64,${frame.image})`
  );
  if (!findHostedImageUrl(image)) throw new Error('RemNote did not store the screenshot.');
  const heading = await createChild(plugin, parentId, [`📸 ${formatVideoTime(seconds)}`]);
  await createChild(plugin, heading._id, sanitizeRichTextForSetText(image));
  if (!transcribe) return { heading: heading._id, lines: 0 };

  onProgress?.('transcribing');
  const { markup } = await callHelper<{ markup: string }>('/video-transcribe', {
    frameId: frame.frameId,
  });
  if (markup.trim() === '[no text]') return { heading: heading._id, lines: 0 };

  const parents: RemId[] = [heading._id];
  const lines = parseOutline(markup);
  for (const line of lines) {
    const rem = await createChild(plugin, parents[line.depth], markupToRichText(line.text));
    parents[line.depth + 1] = rem._id;
  }
  return { heading: heading._id, lines: lines.length };
}
