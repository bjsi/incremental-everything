import { PluginRem, RNPlugin, RemId, RichTextInterface } from '@remnote/plugin-sdk';
import { remToActionItemType } from './incremental_rem/action_items';
import {
  fetchTranscript,
  segmentsInRange,
  Transcript,
  TranscriptSegment,
  TranscriptSource,
} from './youtube_transcript';
import { callVideoHelper, checkVideoHelper, formatVideoTime } from './video_snapshot';
import { getIESetting } from './settings';
import { tidyAutoCaptionsId } from './consts';

/**
 * Transcript Rems for a YouTube video or a Video Extract, from the video's
 * captions or its audio (lib/youtube_transcript.ts).
 *
 * - An extract gets the lines of its range as ~300-character blocks, directly
 *   under it, as extracts always have.
 * - A whole video gets one "📜 Transcript" Rem holding larger blocks, each
 *   starting with its time, so a long video doesn't flood its notes.
 *
 * YouTube's automatic captions can then be tidied by Claude (tidyTranscript):
 * the raw blocks are written first and each is replaced once tidied.
 */

const EXTRACT_BLOCK_CHARS = 300;
const VIDEO_BLOCK_CHARS = 600;
// Blocks per Claude call: a whole video goes in several calls, and each call's
// blocks are replaced as soon as it answers.
const TIDY_BATCH = 15;

export interface TranscriptTarget {
  /** Where the transcript goes: the extract, or the video's Rem. */
  parentId: RemId;
  url: string;
  /** An extract's range, in seconds; none for a whole video. */
  range?: { start: number; end: number };
}

/** The blocks written, in order, for tidyTranscript. */
export interface WrittenTranscript {
  transcript: Transcript;
  remIds: RemId[];
  texts: string[];
}

/**
 * The video or Video Extract a Rem belongs to: the Rem itself or its nearest
 * ancestor that is one, so a command run from a note under an extract works.
 */
export async function transcriptTargetForRem(plugin: RNPlugin, rem: PluginRem): Promise<TranscriptTarget | null> {
  let current: PluginRem | undefined = rem;
  for (let depth = 0; current && depth < 10; depth++) {
    const item = await remToActionItemType(plugin, current, { silent: true });
    if (item?.type === 'youtube-highlight' || item?.type === 'local-video-highlight') {
      return { parentId: item.extract._id, url: item.url, range: { start: item.startTime, end: item.endTime } };
    }
    if (item?.type === 'youtube' || item?.type === 'local-video') return { parentId: current._id, url: item.url };
    current = current.parent ? await plugin.rem.findOne(current.parent) : undefined;
  }
  return null;
}

/**
 * Caption lines joined into blocks of about `maxChars`, never splitting a line.
 * With `timestamps`, each block starts with the time of its first line.
 */
export function transcriptBlocks(
  segments: TranscriptSegment[],
  { maxChars, timestamps }: { maxChars: number; timestamps: boolean }
): string[] {
  const blocks: string[] = [];
  let current = '';
  let startedAt = 0;
  const flush = () => {
    if (current) blocks.push(timestamps ? `[${formatVideoTime(startedAt)}] ${current}` : current);
  };
  for (const seg of segments) {
    if (!current) {
      current = seg.text;
      startedAt = seg.offset;
      continue;
    }
    const candidate = `${current} ${seg.text}`;
    if (candidate.length > maxChars) {
      flush();
      current = seg.text;
      startedAt = seg.offset;
    } else {
      current = candidate;
    }
  }
  flush();
  return blocks;
}

/**
 * A tidied block's text with its **bold** key terms as rich text. Only bold:
 * speech says "R$ 500" or "$5", which a markup parser would take for formulae.
 */
export function boldMarkupToRichText(markup: string): RichTextInterface {
  const parts = markup.split(/\*\*(.+?)\*\*/);
  const rich: RichTextInterface = [];
  parts.forEach((text, i) => {
    if (!text) return;
    // `b` is RICH_TEXT_FORMATTING.BOLD, written out so the module loads under the SDK test stub.
    rich.push(i % 2 ? { i: 'm', text, b: true } : text);
  });
  return rich;
}

async function addChild(plugin: RNPlugin, parentId: RemId, text: string): Promise<PluginRem> {
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('Could not create a Rem.');
  await rem.setText([text]);
  await rem.setParent(parentId);
  return rem;
}

export const describeTranscript = (t: Transcript) =>
  `${t.language || 'language unknown'}, ` +
  (t.kind === 'manual'
    ? 'captions by the uploader'
    : t.kind === 'auto'
      ? "YouTube's automatic captions"
      : 'transcribed from the audio');

/**
 * Fetches the transcript and writes it under the target, raw. Throws with a
 * message for the user.
 */
export async function addVideoTranscript(
  plugin: RNPlugin,
  target: TranscriptTarget,
  source: TranscriptSource = 'auto'
): Promise<WrittenTranscript> {
  const { range } = target;
  const transcript = await fetchTranscript(target.url, { source, range });
  const segments = range ? segmentsInRange(transcript.segments, range.start, range.end) : transcript.segments;
  if (!segments.length) {
    throw new Error(
      range
        ? `The transcript has no lines between ${formatVideoTime(range.start)} and ${formatVideoTime(range.end)}.`
        : 'The transcript came back empty.'
    );
  }

  let parentId = target.parentId;
  if (!range) {
    parentId = (await addChild(plugin, parentId, `📜 Transcript (${describeTranscript(transcript)})`))._id;
  }
  const texts = transcriptBlocks(segments, {
    maxChars: range ? EXTRACT_BLOCK_CHARS : VIDEO_BLOCK_CHARS,
    timestamps: !range,
  });
  const remIds: RemId[] = [];
  for (const text of texts) remIds.push((await addChild(plugin, parentId, text))._id);
  return { transcript, remIds, texts };
}

/**
 * Whether a written transcript should be tidied: YouTube's automatic captions,
 * with the setting on and Claude available to the helper.
 */
export async function shouldTidy(plugin: RNPlugin, written: WrittenTranscript): Promise<boolean> {
  if (written.transcript.kind !== 'auto') return false;
  if (!(await getIESetting(plugin, tidyAutoCaptionsId))) return false;
  return (await checkVideoHelper()).ai;
}

/**
 * Has Claude tidy the written blocks, a batch per call, replacing each block's
 * text as its batch comes back. Returns how many were replaced. A batch that
 * fails is left raw and the rest go on; the first failure is thrown at the end.
 */
export async function tidyTranscript(
  plugin: RNPlugin,
  written: WrittenTranscript,
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  const { remIds, texts, transcript } = written;
  let tidied = 0;
  let firstError: unknown;
  for (let i = 0; i < texts.length; i += TIDY_BATCH) {
    onProgress?.(i, texts.length);
    const batch = texts.slice(i, i + TIDY_BATCH);
    try {
      const { blocks } = await callVideoHelper<{ blocks: string[] }>('/transcript-tidy', {
        blocks: batch,
        language: transcript.language,
      });
      for (let j = 0; j < blocks.length; j++) {
        const rem = await plugin.rem.findOne(remIds[i + j]);
        if (!rem) continue; // deleted meanwhile
        await rem.setText(boldMarkupToRichText(blocks[j]));
        tidied++;
      }
    } catch (e) {
      console.warn('[VideoTranscript] A batch could not be tidied:', e);
      firstError ??= e;
    }
  }
  onProgress?.(texts.length, texts.length);
  if (firstError) throw firstError;
  return tidied;
}
