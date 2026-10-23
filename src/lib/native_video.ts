// RemNote's own YouTube Rems — the ones made with Create › Upload File › "Paste
// YouTube URL", which open in RemNote's video learning page (transcript,
// Highlight Moment, AI Tutor). Neither powerup is in the SDK enum, so the SDK
// passes these slot codes through unchanged. See findings/VIDEO_PLAYBACK.md.

import { PluginRem } from '@remnote/plugin-sdk';

/** Video powerup: marks the Rem as a RemNote video source. */
export const NATIVE_VIDEO_POWERUP = 'vi';
export const NATIVE_VIDEO_SLOTS = { url: 'u', name: 'n', title: 't', transcriptUrl: 'tu' } as const;

/** "In Progress" powerup: RemNote's playback bookkeeping for the video page. */
export const IN_PROGRESS_POWERUP = 'ip';
export const IN_PROGRESS_SLOTS = { lastWatchedTime: 'l', totalDuration: 'd' } as const;

export interface NativeVideoInfo {
  url: string | undefined;
  name: string | undefined;
  title: string | undefined;
  transcriptUrl: string | undefined;
  hasInProgress: boolean;
  /** Seconds. RemNote writes it at most every 3 s while the video plays. */
  lastWatchedTime: number | undefined;
  /** Seconds, written when the player becomes ready. */
  totalDuration: number | undefined;
}

const toSeconds = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
};

const readSlot = async (rem: PluginRem, code: string, slot: string): Promise<string | undefined> => {
  try {
    return (await rem.getPowerupProperty(code, slot)) || undefined;
  } catch {
    return undefined;
  }
};

export async function isNativeVideoRem(rem: PluginRem): Promise<boolean> {
  return rem.hasPowerup(NATIVE_VIDEO_POWERUP);
}

export async function readNativeVideoInfo(rem: PluginRem): Promise<NativeVideoInfo> {
  const [url, name, title, transcriptUrl, hasInProgress, lastWatched, duration] = await Promise.all([
    readSlot(rem, NATIVE_VIDEO_POWERUP, NATIVE_VIDEO_SLOTS.url),
    readSlot(rem, NATIVE_VIDEO_POWERUP, NATIVE_VIDEO_SLOTS.name),
    readSlot(rem, NATIVE_VIDEO_POWERUP, NATIVE_VIDEO_SLOTS.title),
    readSlot(rem, NATIVE_VIDEO_POWERUP, NATIVE_VIDEO_SLOTS.transcriptUrl),
    rem.hasPowerup(IN_PROGRESS_POWERUP),
    readSlot(rem, IN_PROGRESS_POWERUP, IN_PROGRESS_SLOTS.lastWatchedTime),
    readSlot(rem, IN_PROGRESS_POWERUP, IN_PROGRESS_SLOTS.totalDuration),
  ]);
  return {
    url,
    name,
    title,
    transcriptUrl,
    hasInProgress,
    lastWatchedTime: toSeconds(lastWatched),
    totalDuration: toSeconds(duration),
  };
}

/**
 * Sets the position RemNote's video page offers as "Resume watching at …" the
 * next time it loads. It does not seek a player that is already open, and the
 * player overwrites it every few seconds while it plays.
 */
export async function writeLastWatchedTime(rem: PluginRem, seconds: number): Promise<void> {
  if (!(await rem.hasPowerup(IN_PROGRESS_POWERUP))) {
    await rem.addPowerup(IN_PROGRESS_POWERUP);
  }
  await rem.setPowerupProperty(IN_PROGRESS_POWERUP, IN_PROGRESS_SLOTS.lastWatchedTime, [`${seconds}`]);
}
