import { PluginRem, RNPlugin, RemId } from '@remnote/plugin-sdk';
import { remToActionItemType } from './incremental_rem/action_items';
import { fetchTranscript, segmentsInRange, Transcript, TranscriptSegment } from './youtube_transcript';
import { formatVideoTime } from './video_snapshot';

/**
 * Transcript Rems for a YouTube video or a Video Extract, from the video's
 * captions (lib/youtube_transcript.ts).
 *
 * - An extract gets the lines of its range as ~300-character blocks, directly
 *   under it, as extracts always have.
 * - A whole video gets one "📜 Transcript" Rem holding larger blocks, each
 *   starting with its time, so a long video doesn't flood its notes.
 */

const EXTRACT_BLOCK_CHARS = 300;
const VIDEO_BLOCK_CHARS = 600;

export interface TranscriptTarget {
  /** Where the transcript goes: the extract, or the video's Rem. */
  parentId: RemId;
  url: string;
  /** An extract's range, in seconds; none for a whole video. */
  range?: { start: number; end: number };
}

/**
 * The video or Video Extract a Rem belongs to: the Rem itself or its nearest
 * ancestor that is one, so a command run from a note under an extract works.
 */
export async function transcriptTargetForRem(plugin: RNPlugin, rem: PluginRem): Promise<TranscriptTarget | null> {
  let current: PluginRem | undefined = rem;
  for (let depth = 0; current && depth < 10; depth++) {
    const item = await remToActionItemType(plugin, current, { silent: true });
    if (item?.type === 'youtube-highlight') {
      return { parentId: item.extract._id, url: item.url, range: { start: item.startTime, end: item.endTime } };
    }
    if (item?.type === 'youtube') return { parentId: current._id, url: item.url };
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

async function addChild(plugin: RNPlugin, parentId: RemId, text: string): Promise<PluginRem> {
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('Could not create a Rem.');
  await rem.setText([text]);
  await rem.setParent(parentId);
  return rem;
}

export const describeTranscript = (t: Transcript) =>
  `${t.language}, ${t.kind === 'manual' ? 'captions by the uploader' : "YouTube's automatic captions"}`;

/**
 * Fetches the captions and writes them under the target. Returns how many
 * blocks were added. Throws with a message for the user.
 */
export async function addVideoTranscript(
  plugin: RNPlugin,
  target: TranscriptTarget
): Promise<{ blocks: number; transcript: Transcript }> {
  const transcript = await fetchTranscript(target.url);
  const { range } = target;
  const segments = range ? segmentsInRange(transcript.segments, range.start, range.end) : transcript.segments;
  if (!segments.length) {
    throw new Error(
      range
        ? `The captions have no lines between ${formatVideoTime(range.start)} and ${formatVideoTime(range.end)}.`
        : 'The captions came back empty.'
    );
  }

  let parentId = target.parentId;
  if (!range) {
    parentId = (await addChild(plugin, parentId, `📜 Transcript (${describeTranscript(transcript)})`))._id;
  }
  const blocks = transcriptBlocks(segments, {
    maxChars: range ? EXTRACT_BLOCK_CHARS : VIDEO_BLOCK_CHARS,
    timestamps: !range,
  });
  for (const block of blocks) await addChild(plugin, parentId, block);
  return { blocks: blocks.length, transcript };
}
