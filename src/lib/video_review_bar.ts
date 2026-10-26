import { AppEvents, ReactRNPlugin } from '@remnote/plugin-sdk';
import { editorReviewTimerRemIdKey, editorReviewTimerStartKey, videoReviewBarIdKey } from './consts';
import { isNativeVideoRem } from './native_video';

/**
 * The Editor Review Timer can't be used on RemNote's video page: its widget
 * spot (above the document toolbar) only shows there once Notes is pressed. So
 * while a review runs on a RemNote video Rem whose page is open, its controls
 * come in a floating bar instead (widgets/video_review_bar.tsx). This decides
 * when that bar is open. It runs in the index widget, which lives all session.
 */

const BAR_POSITION = { bottom: 90, right: 40 };

let barId: string | null = null;

async function barWanted(plugin: ReactRNPlugin): Promise<boolean> {
  const remId = await plugin.storage.getSession<string>(editorReviewTimerRemIdKey);
  if (!remId || !(await plugin.storage.getSession<number>(editorReviewTimerStartKey))) return false;
  const rem = await plugin.rem.findOne(remId);
  if (!rem || !(await isNativeVideoRem(rem))) return false;
  return (await plugin.window.getOpenPaneRemIds()).includes(remId);
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
      schedule();
    });
    plugin.event.addListener(AppEvents.URLChange, undefined, schedule);
    plugin.event.addListener(AppEvents.CurrentWindowTreeChange, undefined, schedule);
  })();
}
