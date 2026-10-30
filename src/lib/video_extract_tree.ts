import { BuiltInPowerupCodes, PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { localVideoPowerupCode } from './consts';

/**
 * Video Extracts nest: an extract longer than SUB_EXTRACT_MIN_SECONDS can be
 * cut again, and the new extract goes under the one it was cut from. So the
 * video an extract is of isn't always its parent: it is the nearest ancestor
 * that holds the video, above any extracts in between.
 */

/** Extracts at least this long offer ✂️ to cut a shorter extract out of them. */
export const SUB_EXTRACT_MIN_SECONDS = 90;

export const allowsSubExtracts = (segment: { start: number; end: number }) =>
  segment.end - segment.start >= SUB_EXTRACT_MIN_SECONDS;

/** How far up to look; an outline nested deeper than this is not an extract chain. */
const MAX_DEPTH = 30;

export const isYouTubeUrl = (url: string | undefined) => !!url && ['youtube', 'youtu.be'].some((x) => url.includes(x));

/** The Rem holds a video: a RemNote video, a local video, or a YouTube link. */
async function holdsVideo(rem: PluginRem): Promise<boolean> {
  if ((await rem.hasPowerup('vi')) || (await rem.hasPowerup(localVideoPowerupCode))) return true;
  if (!(await rem.hasPowerup(BuiltInPowerupCodes.Link))) return false;
  return isYouTubeUrl(await rem.getPowerupProperty<BuiltInPowerupCodes.Link>(BuiltInPowerupCodes.Link, 'URL'));
}

/** The video Rem an extract is of: its nearest ancestor that holds a video. */
export async function findExtractVideoRem(plugin: RNPlugin, extract: PluginRem): Promise<PluginRem | undefined> {
  let parentId = extract.parent;
  for (let depth = 0; parentId && depth < MAX_DEPTH; depth++) {
    const rem = await plugin.rem.findOne(parentId);
    if (!rem) return undefined;
    if (await holdsVideo(rem)) return rem;
    parentId = rem.parent;
  }
  return undefined;
}
