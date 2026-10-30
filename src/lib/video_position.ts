import { BuiltInPowerupCodes, PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import {
  videoExtractEndSlotCode,
  videoExtractPowerupCode,
  videoExtractStartSlotCode,
  videoExtractUrlSlotCode,
} from './consts';
import type { IncrementalRep } from './incremental_rem/types';
import { localVideoUrl, readLocalVideo } from './local_video_ref';
import { findExtractVideoRem, isYouTubeUrl } from './video_extract_tree';

/**
 * Where a video was left, shared by the plugin's player and RemNote's.
 *
 * The plugin keeps its own position per URL in synced storage. RemNote's
 * player keeps its own in the In Progress powerup's LastWatchedTime (`ip.l`):
 * it writes it every 3 s while playing, offers "Resume watching at…" from it
 * when the page opens (it never seeks by itself), and very likely resets it to
 * 0 once the page has read it. So the plugin's copy is the reference: it goes
 * into `ip.l` just before RemNote's player opens, and whatever RemNote's player
 * plays is copied back while it does. See findings/VIDEO_PLAYBACK.md.
 */

export const videoPositionKey = (url: string) => `${url}-position`;

/** The speed the plugin's player plays a video at, per URL. */
export const videoRateKey = (url: string) => `${url}-playbackRate`;

/**
 * Where a Video Extract was left, per extract: several extracts share a URL.
 * The next review resumes there, unless the last one got to the extract's end
 * (or its last seconds), which starts it from the beginning again.
 */
export const extractPositionKey = (extractId: string) => `extract:${extractId}-position`;

/** Stopped this close to an extract's end, it counts as watched to the end. */
const EXTRACT_END_SLACK_SECONDS = 5;

export interface ExtractResume {
  start: number;
  /** Starts where the last review stopped, not at the extract's start. */
  resumed: boolean;
}

export async function getExtractResume(
  plugin: RNPlugin,
  extractId: string,
  segment: { start: number; end: number }
): Promise<ExtractResume> {
  const saved = await plugin.storage.getSynced<number>(extractPositionKey(extractId));
  const resumed =
    typeof saved === 'number' &&
    saved > segment.start + 1 &&
    saved < segment.end - EXTRACT_END_SLACK_SECONDS;
  return { start: resumed ? saved : segment.start, resumed };
}

export async function setExtractPosition(plugin: RNPlugin, extractId: string, seconds: number) {
  await plugin.storage.setSynced(extractPositionKey(extractId), seconds);
}

const IN_PROGRESS = 'ip';
const LAST_WATCHED = 'l';
const TOTAL_DURATION = 'd';

export async function getPluginVideoPosition(plugin: RNPlugin, url: string): Promise<number> {
  return (await plugin.storage.getSynced<number>(videoPositionKey(url))) ?? 0;
}

export async function setPluginVideoPosition(plugin: RNPlugin, url: string, seconds: number) {
  await plugin.storage.setSynced(videoPositionKey(url), seconds);
}

/** RemNote's own position for a video Rem, in seconds; undefined when it has none. */
export async function getNativeVideoPosition(rem: PluginRem): Promise<number | undefined> {
  if (!(await rem.hasPowerup(IN_PROGRESS))) return undefined;
  const raw = await rem.getPowerupProperty(IN_PROGRESS, LAST_WATCHED);
  const seconds = parseFloat(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Sets the time RemNote's player offers to resume at. Only on a Rem that
 * already has the In Progress powerup: the plugin doesn't add RemNote's
 * built-in powerups itself, and RemNote adds it once the video is played.
 */
export async function setNativeVideoPosition(rem: PluginRem, seconds: number) {
  if (!(await rem.hasPowerup(IN_PROGRESS))) return;
  await rem.setPowerupProperty(IN_PROGRESS, LAST_WATCHED, [String(seconds)]);
}

const VIDEO = 'vi';
const VIDEO_URL = 'u';

/** The URL of a RemNote video Rem (the Video powerup's), which keys the plugin's position. */
export async function nativeVideoUrl(rem: PluginRem): Promise<string | undefined> {
  if (!(await rem.hasPowerup(VIDEO))) return undefined;
  return (await rem.getPowerupProperty(VIDEO, VIDEO_URL)) || undefined;
}

/**
 * A Video Extract of a RemNote video Rem (its nearest video ancestor, above
 * any extracts it was cut from). In the editor, RemNote shows the parent's
 * video page beside a child extract, whose "Resume watching at…" is the
 * video's `ip.l`.
 */
export async function nativeVideoOfExtract(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<{ video: PluginRem; url: string; segment: { start: number; end: number } } | undefined> {
  if (!(await rem.hasPowerup(videoExtractPowerupCode))) return undefined;
  const video = await findExtractVideoRem(plugin, rem);
  const url = video ? await nativeVideoUrl(video) : undefined;
  if (!video || !url) return undefined;
  const [start, end] = await Promise.all([
    rem.getPowerupProperty(videoExtractPowerupCode, videoExtractStartSlotCode),
    rem.getPowerupProperty(videoExtractPowerupCode, videoExtractEndSlotCode),
  ]);
  if (start == null || end == null) return undefined;
  return { video, url, segment: { start: Number(start), end: Number(end) } };
}

/**
 * Before a RemNote video Rem opens in RemNote's player: offer the plugin's
 * position there as "Resume watching at…". For an extract of one, offer where
 * the extract's last review stopped (or its start) on its video's page. A
 * no-op for any other Rem.
 */
export async function primeNativeVideoPosition(plugin: RNPlugin, rem: PluginRem) {
  try {
    const url = await nativeVideoUrl(rem);
    if (url) {
      const seconds = await getPluginVideoPosition(plugin, url);
      if (seconds > 0) await setNativeVideoPosition(rem, seconds);
      return;
    }
    const of = await nativeVideoOfExtract(plugin, rem);
    if (!of) return;
    const { start } = await getExtractResume(plugin, rem._id, of.segment);
    await setNativeVideoPosition(of.video, start);
  } catch (e) {
    console.error('[VideoPosition] Could not set the resume time:', e);
  }
}

/**
 * After RemNote's player: keep where it got to as the plugin's position. Zero
 * is skipped, since the page resets `ip.l` when it opens. For an extract of a
 * video, where it got to is the extract's position (not before its start),
 * and the video's page gets the video's own position back. A no-op for any
 * other Rem.
 */
export async function pullNativeVideoPosition(plugin: RNPlugin, rem: PluginRem) {
  try {
    const url = await nativeVideoUrl(rem);
    if (url) {
      const seconds = await getNativeVideoPosition(rem);
      if (seconds) await setPluginVideoPosition(plugin, url, seconds);
      return;
    }
    const of = await nativeVideoOfExtract(plugin, rem);
    if (!of) return;
    const seconds = await getNativeVideoPosition(of.video);
    if (seconds !== undefined && seconds >= of.segment.start)
      await setExtractPosition(plugin, rem._id, seconds);
    const videoPosition = await getPluginVideoPosition(plugin, of.url);
    if (videoPosition > 0) await setNativeVideoPosition(of.video, videoPosition);
  } catch (e) {
    console.error('[VideoPosition] Could not save the position:', e);
  }
}

// ---------------------------------------------------------------------------
// History snapshot
// ---------------------------------------------------------------------------

/** The video fields of a history entry's context (IncrementalRep.context). */
export type VideoContext = Pick<
  NonNullable<IncrementalRep['context']>,
  'videoTime' | 'videoStart' | 'videoEnd' | 'videoDuration' | 'videoRate'
>;

/** The URL a whole video's position is kept under: a RemNote video, a local video, or a YouTube link. */
async function wholeVideoUrl(rem: PluginRem): Promise<string | undefined> {
  const native = await nativeVideoUrl(rem);
  if (native) return native;
  const file = await readLocalVideo(rem);
  if (file) return localVideoUrl(file);
  if (!(await rem.hasPowerup(BuiltInPowerupCodes.Link))) return undefined;
  const url = await rem.getPowerupProperty<BuiltInPowerupCodes.Link>(BuiltInPowerupCodes.Link, 'URL');
  return isYouTubeUrl(url) ? url : undefined;
}

const toNumber = (raw: unknown): number | undefined => {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Snapshot where a video IncRem was left, for its history entry: the saved
 * position (the extract's own one for a Video Extract, with its segment), the
 * video's length when RemNote's player recorded it, and the plugin player's
 * speed when it isn't 1×. Read from the same keys the players resume from, so
 * it is what the next session will start at.
 *
 * Undefined for a Rem that isn't a video, or a video with no saved position.
 */
export async function buildVideoContext(plugin: RNPlugin, rem: PluginRem): Promise<VideoContext | undefined> {
  let url: string | undefined;
  let context: VideoContext;
  if (await rem.hasPowerup(videoExtractPowerupCode)) {
    const [extractUrl, start, end, time] = await Promise.all([
      rem.getPowerupProperty(videoExtractPowerupCode, videoExtractUrlSlotCode),
      rem.getPowerupProperty(videoExtractPowerupCode, videoExtractStartSlotCode),
      rem.getPowerupProperty(videoExtractPowerupCode, videoExtractEndSlotCode),
      plugin.storage.getSynced<number>(extractPositionKey(rem._id)),
    ]);
    const videoStart = toNumber(start);
    const videoEnd = toNumber(end);
    const videoTime = toNumber(time);
    if (videoStart === undefined || videoEnd === undefined || videoTime === undefined) return undefined;
    url = extractUrl || undefined;
    context = { videoTime: Math.round(videoTime), videoStart, videoEnd };
  } else {
    url = await wholeVideoUrl(rem);
    if (!url) return undefined;
    const videoTime = toNumber(await plugin.storage.getSynced<number>(videoPositionKey(url)));
    if (!videoTime || videoTime <= 0) return undefined;
    context = { videoTime: Math.round(videoTime) };
    if (await rem.hasPowerup(IN_PROGRESS)) {
      const duration = toNumber(await rem.getPowerupProperty(IN_PROGRESS, TOTAL_DURATION));
      if (duration && duration > 0) context.videoDuration = Math.round(duration);
    }
  }
  if (url) {
    const rate = toNumber(await plugin.storage.getSynced<number>(videoRateKey(url)));
    if (rate && rate > 0 && rate !== 1) context.videoRate = rate;
  }
  return context;
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatVideoTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The history row's video part: "▶ 1:42 of 1:26–2:04 · 1.5×",
 * "▶ 12:34 / 45:00 (28%)", or "· ✓ end" when it was watched to the end (the
 * same slack the next review uses to start an extract over). Undefined when
 * the entry has no video position.
 */
export function formatVideoContext(ctx: VideoContext): string | undefined {
  const { videoTime, videoStart, videoEnd, videoDuration, videoRate } = ctx;
  if (videoTime === undefined) return undefined;
  const parts: string[] = [];
  const end = videoEnd ?? videoDuration;
  const ended = end !== undefined && videoTime >= end - EXTRACT_END_SLACK_SECONDS;
  if (videoStart !== undefined && videoEnd !== undefined) {
    parts.push(`▶ ${formatVideoTime(videoTime)} of ${formatVideoTime(videoStart)}–${formatVideoTime(videoEnd)}`);
  } else if (videoDuration) {
    const percent = ended ? '' : ` (${Math.round((videoTime / videoDuration) * 100)}%)`;
    parts.push(`▶ ${formatVideoTime(videoTime)} / ${formatVideoTime(videoDuration)}${percent}`);
  } else {
    parts.push(`▶ ${formatVideoTime(videoTime)}`);
  }
  if (ended) parts.push('✓ end');
  if (videoRate !== undefined && videoRate !== 1) parts.push(`${videoRate}×`);
  return parts.join(' · ');
}
