import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import {
  videoExtractEndSlotCode,
  videoExtractPowerupCode,
  videoExtractStartSlotCode,
} from './consts';
import { findExtractVideoRem } from './video_extract_tree';

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
