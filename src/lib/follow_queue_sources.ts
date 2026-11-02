import { AppEvents, BuiltInPowerupCodes, PluginRem, ReactRNPlugin } from '@remnote/plugin-sdk';
import {
  currentIncRemKey,
  followQueueBarDefaultPosition,
  followQueueBarIdKey,
  followQueueBarPositionKey,
  followQueueShownKey,
  followQueueStopKey,
  followQueueTargetKey,
  followQueueWindowKey,
} from './consts';
import {
  followedSourcesLayout,
  PinnedSource,
  planFollowedSources,
  sameSources,
} from './follow_queue_sources_plan';
import { canOpenInAnotherWindow, isQueueUrl } from './open_in_window';
import { resolveSourcePopupTarget } from './pdfUtils';
import { getQueueVisibleCard } from './queue_visible_card';

/**
 * "Follow the queue": one RemNote window shows the sources of the card being
 * practiced in another, so they can sit on a second screen.
 *
 * A window volunteers with the command. Its id goes in the local store, which the
 * windows share (findings/PLUGIN_BRIDGE_AND_SDK.md), and the window running a queue
 * leaves each card's sources there for it to open. With no follower, every window
 * only reads one key per tick. All of this runs in the index widget: its iframe
 * outlives the pane changes, and it is the only iframe that loads this module's
 * state, so WINDOW_ID does identify the window here.
 */

// A card with no pins of its own takes them from its parent, then its grandparent.
const ANCESTORS_CHECKED = 2;
const TICK_MS = 1000;
// A closed window can't withdraw, so a follower must keep confirming it is there.
const FOLLOWER_HEARTBEAT_MS = 30_000;
const FOLLOWER_TTL_MS = 90_000;
// The local store survives restarts, so an old target must not replace a document.
const TARGET_TTL_MS = 60_000;
// Lets the queue settle after a card change, and bridges the moment a new IncRem's
// widget hasn't yet replaced the previous IncRem's id.
const SETTLE_MS = 350;
const AFTER_CARD_LOAD_MS = 300;
// A reader takes seconds to mount, and an early scroll is dropped.
const SCROLL_DELAYS_MOUNTING_MS = [1200, 2500, 4000, 6000];
const SCROLL_DELAYS_MOUNTED_MS = [0, 700];
const MOUNTING_MS = 6000;

interface Follower {
  windowId: string;
  at: number;
}

interface FollowTarget {
  id: string;
  sources: PinnedSource[];
  at: number;
}

const WINDOW_ID = Math.random().toString(36).slice(2, 10);

let following = false;
let barId: string | null = null;
let lastHeartbeatAt = 0;
let handledTargetId: string | null = null;
let lastMountAt = 0;
let scrollTimers: ReturnType<typeof setTimeout>[] = [];

let publishedFor: { followerId: string; remId: string } | null = null;
let settlingRemId: string | null = null;

const readFollower = (plugin: ReactRNPlugin) =>
  plugin.storage.getLocal<Follower>(followQueueWindowKey).catch(() => undefined);

/** True while some window, possibly a closed one not yet timed out, follows the queue. Safe from any widget. */
export async function isQueueFollowed(plugin: ReactRNPlugin): Promise<boolean> {
  const follower = await readFollower(plugin);
  return !!follower && Date.now() - follower.at < FOLLOWER_TTL_MS;
}

// ---------------------------------------------------------------------------
// The window running the queue
// ---------------------------------------------------------------------------

/**
 * The card Rem's source pins, in reading order: the Rem itself when it is a
 * highlight, then its front and back. A reference to a highlight counts with or
 * without the pin mark, but a reference to a whole document counts only when
 * pinned, since a card can mention a book or a web page without coming from it.
 */
async function readPinnedSources(plugin: ReactRNPlugin, rem: PluginRem): Promise<PinnedSource[]> {
  const pins: PinnedSource[] = [];
  const add = async (remId: string, pinned: boolean) => {
    const target = await resolveSourcePopupTarget(plugin, remId);
    if (!target || (target.kind !== 'highlight' && !pinned)) return;
    pins.push({
      hostRemId: target.hostRemId,
      highlightRemId: target.kind === 'highlight' ? remId : null,
    });
  };

  if (
    (await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) ||
    (await rem.hasPowerup(BuiltInPowerupCodes.HTMLHighlight))
  ) {
    await add(rem._id, false);
  }

  const seen = new Set<string>();
  for (const item of [...(rem.text ?? []), ...(rem.backText ?? [])] as any[]) {
    if (item?.i !== 'q' || !item._id || seen.has(item._id)) continue;
    seen.add(item._id);
    await add(item._id, !!item.pin);
  }
  return pins;
}

/** The sources of the card Rem or, if it has no pins, of its nearest ancestor within reach that does. */
async function readCardSources(plugin: ReactRNPlugin, cardRem: PluginRem): Promise<PinnedSource[]> {
  let rem: PluginRem | undefined = cardRem;
  for (let level = 0; rem && level <= ANCESTORS_CHECKED; level++) {
    const sources = planFollowedSources(await readPinnedSources(plugin, rem));
    if (sources.length) return sources;
    rem = await rem.getParentRem();
  }
  return [];
}

async function currentQueueRemId(plugin: ReactRNPlugin): Promise<string | undefined> {
  const card = await getQueueVisibleCard(plugin);
  return card?.remId ?? (await plugin.storage.getSession<string>(currentIncRemKey)) ?? undefined;
}

/** Leaves the on-screen card's sources for the follower. With no pins in reach, the last ones stay up. */
async function publishCurrentCard(plugin: ReactRNPlugin, followerId: string) {
  if (!isQueueUrl(await plugin.window.getURL())) return;
  const remId = await currentQueueRemId(plugin);
  if (!remId || (publishedFor?.remId === remId && publishedFor.followerId === followerId)) {
    settlingRemId = null;
    return;
  }
  if (remId !== settlingRemId) {
    settlingRemId = remId;
    setTimeout(() => void tick(plugin), SETTLE_MS);
    return;
  }

  const rem = await plugin.rem.findOne(remId);
  const sources = rem ? await readCardSources(plugin, rem) : [];
  if (sources.length) {
    const target: FollowTarget = { id: Math.random().toString(36).slice(2, 10), sources, at: Date.now() };
    await plugin.storage.setLocal(followQueueTargetKey, target);
  }
  publishedFor = { followerId, remId };
  settlingRemId = null;
}

// ---------------------------------------------------------------------------
// The following window
// ---------------------------------------------------------------------------

async function scrollToHighlights(plugin: ReactRNPlugin, sources: PinnedSource[]) {
  scrollTimers.forEach(clearTimeout);
  scrollTimers = [];
  const delays =
    Date.now() - lastMountAt < MOUNTING_MS ? SCROLL_DELAYS_MOUNTING_MS : SCROLL_DELAYS_MOUNTED_MS;
  for (const { highlightRemId } of sources) {
    const highlight = highlightRemId ? await plugin.rem.findOne(highlightRemId) : undefined;
    if (!highlight) continue;
    for (const delay of delays) {
      scrollTimers.push(
        setTimeout(() => {
          highlight.scrollToReaderHighlight().catch(() => {});
        }, delay)
      );
    }
  }
}

async function showTarget(plugin: ReactRNPlugin) {
  const target = await plugin.storage.getLocal<FollowTarget>(followQueueTargetKey).catch(() => undefined);
  if (!target || target.id === handledTargetId || Date.now() - target.at > TARGET_TTL_MS) return;
  // A queue started in this window isn't replaced: the target waits, then expires.
  if (isQueueUrl(await plugin.window.getURL())) return;
  handledTargetId = target.id;
  await plugin.storage.setSession(followQueueShownKey, target.sources);

  const remIds = target.sources.map((source) => source.hostRemId);
  // Reloading a reader that already shows the source would lose its place.
  if (!sameSources(await plugin.window.getOpenPaneRemIds(), remIds)) {
    await plugin.window.setRemWindowTree(followedSourcesLayout(remIds));
    lastMountAt = Date.now();
  }
  await scrollToHighlights(plugin, target.sources);
  if (following) await openBar(plugin);
}

async function openBar(plugin: ReactRNPlugin) {
  if (barId && (await plugin.window.isFloatingWidgetOpen(barId).catch(() => false))) return;
  const position =
    (await plugin.storage.getSession<typeof followQueueBarDefaultPosition>(followQueueBarPositionKey)) ||
    followQueueBarDefaultPosition;
  barId = await plugin.window.openFloatingWidget('follow_queue_bar', position, undefined, false);
  await plugin.storage.setSession(followQueueBarIdKey, barId);
}

async function closeBar(plugin: ReactRNPlugin) {
  const id = barId ?? (await plugin.storage.getSession<string>(followQueueBarIdKey));
  barId = null;
  if (id) await plugin.window.closeFloatingWidget(id).catch(() => {});
  await plugin.storage.setSession(followQueueBarIdKey, undefined);
  await plugin.storage.setSession(followQueueShownKey, undefined);
  // Forgotten so that restarting brings back a bar dragged out of the window, which the
  // drag can't prevent: an iframe can't read the size of its window.
  await plugin.storage.setSession(followQueueBarPositionKey, undefined);
}

/** Makes this window follow the queue. Called from the command, or for another window's button. */
export async function startFollowingQueueSources(plugin: ReactRNPlugin): Promise<void> {
  lastHeartbeatAt = Date.now();
  await plugin.storage.setLocal(followQueueWindowKey, { windowId: WINDOW_ID, at: lastHeartbeatAt });
  following = true;
  await openBar(plugin);
}

async function stopFollowing(plugin: ReactRNPlugin) {
  following = false;
  scrollTimers.forEach(clearTimeout);
  scrollTimers = [];
  const follower = await readFollower(plugin);
  if (follower?.windowId === WINDOW_ID) await plugin.storage.setLocal(followQueueWindowKey, undefined);
  await closeBar(plugin);
}

/** Starts this window following the queue, or stops it if it already is. */
export async function toggleFollowQueueSources(plugin: ReactRNPlugin): Promise<void> {
  if (!(await canOpenInAnotherWindow(plugin))) {
    await plugin.app.toast('Following the queue needs a second window, which only the desktop app has.');
    return;
  }
  await (following ? stopFollowing(plugin) : startFollowingQueueSources(plugin));
}

// ---------------------------------------------------------------------------
// Both
// ---------------------------------------------------------------------------

let ticking = false;
async function tick(plugin: ReactRNPlugin) {
  if (ticking) return;
  ticking = true;
  try {
    const follower = await readFollower(plugin);
    if (following) {
      // Only a newer entry means a takeover: a read that started before this window's
      // own write still returns the old value.
      if (follower && follower.windowId !== WINDOW_ID && follower.at > lastHeartbeatAt) {
        following = false;
        await closeBar(plugin);
        await plugin.app.toast('Another window took over following the queue.');
        return;
      }
      if (Date.now() - lastHeartbeatAt > FOLLOWER_HEARTBEAT_MS) {
        lastHeartbeatAt = Date.now();
        await plugin.storage.setLocal(followQueueWindowKey, { windowId: WINDOW_ID, at: lastHeartbeatAt });
      }
      await showTarget(plugin);
    } else if (follower && Date.now() - follower.at < FOLLOWER_TTL_MS) {
      await publishCurrentCard(plugin, follower.windowId);
    }
  } catch (e) {
    console.warn('[FollowQueue] tick failed', e);
  } finally {
    ticking = false;
  }
}

export async function registerFollowQueueSources(plugin: ReactRNPlugin) {
  if (!(await canOpenInAnotherWindow(plugin))) return;
  // A bar left over from before a plugin reload has no owner any more.
  await closeBar(plugin);
  await plugin.storage.setSession(followQueueStopKey, undefined);
  // The bar's Stop runs in its own iframe, which can't reach this module's state.
  plugin.track(async (rp) => {
    if (!(await rp.storage.getSession<number>(followQueueStopKey))) return;
    await plugin.storage.setSession(followQueueStopKey, undefined);
    if (following) await stopFollowing(plugin);
  });
  setInterval(() => void tick(plugin), TICK_MS);
  // The tick alone would catch a new card too, up to a second later.
  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, () => {
    setTimeout(() => void tick(plugin), AFTER_CARD_LOAD_MS);
  });
}
