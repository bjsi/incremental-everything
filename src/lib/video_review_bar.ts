import { AppEvents, ReactRNPlugin } from '@remnote/plugin-sdk';
import {
  editorReviewTimerRemIdKey,
  editorReviewTimerStartKey,
  pendingVideoPaneKey,
  videoReviewBarIdKey,
} from './consts';
import { openRemInNewPane } from './remHelpers';
import { isNativeVideoRem } from './native_video';
import { nativeVideoOfExtract } from './video_position';

/**
 * The Editor Review Timer can't be used on RemNote's video page: its widget
 * spot (above the document toolbar) only shows there once Notes is pressed. So
 * while a review runs on a RemNote video Rem whose page is open, or on an
 * extract of one with that video's page open beside it, its controls come in
 * a floating bar instead (widgets/video_review_bar.tsx). This decides when
 * that bar is open, and opens the video's page beside a nested extract
 * opened for review. It runs in the index widget, which lives all session.
 */

const BAR_POSITION = { bottom: 90, right: 40 };

let barId: string | null = null;

async function barWanted(plugin: ReactRNPlugin): Promise<boolean> {
  const remId = await plugin.storage.getSession<string>(editorReviewTimerRemIdKey);
  if (!remId || !(await plugin.storage.getSession<number>(editorReviewTimerStartKey))) return false;
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return false;
  const videoId = (await isNativeVideoRem(rem)) ? remId : (await nativeVideoOfExtract(plugin, rem))?.video._id;
  return !!videoId && (await plugin.window.getOpenPaneRemIds()).includes(videoId);
}

/** A pending video pane older than this is from a review that went elsewhere. */
const PENDING_PANE_MS = 15000;

/**
 * Once a nested extract opened for review is on screen, opens its video's
 * page in a pane to its right (lib/incRemHelpers.ts, openIncRemForReview).
 */
async function openPendingVideoPane(plugin: ReactRNPlugin) {
  const pending = await plugin.storage.getSession<{ remId: string; videoId: string; at: number }>(
    pendingVideoPaneKey
  );
  if (!pending) return;
  const open = await plugin.window.getOpenPaneRemIds();
  const stale = Date.now() - pending.at > PENDING_PANE_MS;
  if (!stale && !open.includes(pending.remId)) return; // the extract's page isn't open yet
  await plugin.storage.setSession(pendingVideoPaneKey, null);
  if (stale || open.includes(pending.videoId)) return;
  await openRemInNewPane(plugin, pending.videoId);
}

async function syncBar(plugin: ReactRNPlugin) {
  const wanted = await barWanted(plugin);
  const open = !!barId && (await plugin.window.isFloatingWidgetOpen(barId).catch(() => false));
  if (wanted && !open) {
    barId = await plugin.window.openFloatingWidget('video_review_bar', BAR_POSITION, undefined, false);
    await plugin.storage.setSession(videoReviewBarIdKey, barId);
  } else if (!wanted && open) {
    await plugin.window.closeFloatingWidget(barId!);
    barId = null;
    await plugin.storage.setSession(videoReviewBarIdKey, null);
  }
}

export function registerVideoReviewBar(plugin: ReactRNPlugin) {
  // One sync at a time, and a burst of events (a Next fires a session change,
  // then a URL change, then a pane change) settles into one.
  let running = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = running
        .then(() => openPendingVideoPane(plugin))
        .then(() => syncBar(plugin))
        .catch((e) => console.error('[VideoReviewBar] sync failed', e));
    }, 400);
  };

  // A bar left over from before a plugin reload has no owner any more.
  void (async () => {
    const stale = await plugin.storage.getSession<string>(videoReviewBarIdKey);
    if (stale) await plugin.window.closeFloatingWidget(stale).catch(() => {});
    await plugin.storage.setSession(videoReviewBarIdKey, null);
    plugin.track(async (rp) => {
      await rp.storage.getSession(editorReviewTimerRemIdKey);
      await rp.storage.getSession(editorReviewTimerStartKey);
      await rp.storage.getSession(pendingVideoPaneKey);
      schedule();
    });
    plugin.event.addListener(AppEvents.URLChange, undefined, schedule);
    plugin.event.addListener(AppEvents.CurrentWindowTreeChange, undefined, schedule);
  })();
}
