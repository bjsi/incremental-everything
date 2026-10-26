import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';

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
 * Before a RemNote video Rem opens in RemNote's player: offer the plugin's
 * position there as "Resume watching at…". A no-op for any other Rem.
 */
export async function primeNativeVideoPosition(plugin: RNPlugin, rem: PluginRem) {
  try {
    const url = await nativeVideoUrl(rem);
    if (!url) return;
    const seconds = await getPluginVideoPosition(plugin, url);
    if (seconds > 0) await setNativeVideoPosition(rem, seconds);
  } catch (e) {
    console.error('[VideoPosition] Could not set the resume time:', e);
  }
}

/**
 * After RemNote's player: keep where it got to as the plugin's position. Zero
 * is skipped, since the page resets `ip.l` when it opens. A no-op for any
 * other Rem.
 */
export async function pullNativeVideoPosition(plugin: RNPlugin, rem: PluginRem) {
  try {
    const url = await nativeVideoUrl(rem);
    if (!url) return;
    const seconds = await getNativeVideoPosition(rem);
    if (seconds) await setPluginVideoPosition(plugin, url, seconds);
  } catch (e) {
    console.error('[VideoPosition] Could not save the position:', e);
  }
}
