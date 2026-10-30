import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { openInWindowOwnIdKey, openInWindowRequestKey } from './consts';
import { isWebPlatform, isMobileDevice } from './mobileUtils';

/**
 * "Open in another window": hands a source to another RemNote window.
 *
 * A plugin can't create a window, and each window runs its own copy of the plugin
 * (findings/PLUGIN_BRIDGE_AND_SDK.md). So the request goes in the local store,
 * which the windows share, and every window watches it: one already open takes it
 * within a few seconds, and a window opened with Cmd+Shift+N takes it as soon as
 * its plugin starts. `StorageLocalChange` only fires in the writing window, hence
 * the polling.
 */

const POLL_MS = 1500;
// Long enough to reach for the shortcut, short enough that a forgotten request
// doesn't take over a window opened much later.
export const OPEN_REQUEST_TTL_MS = 60_000;
// Spreads out the windows' claims: with three open, the first claim to be relayed
// stops the slower ones.
const MAX_CLAIM_JITTER_MS = 800;
// The reader takes seconds to mount, and an early scroll is dropped.
const SCROLL_DELAYS_MS = [1200, 2500, 4000, 6000];

interface OpenRequest {
  id: string;
  /** The source to open. */
  remId: string;
  /** The highlight to scroll to, if any. */
  highlightRemId: string | null;
  from: string;
  at: number;
  claimedBy?: string;
}

// Every widget iframe loads its own copy of this module, so this differs between
// the button and the listener of one window. The listener's is the window's id,
// and it publishes it in session storage, which is per window.
const WINDOW_ID = Math.random().toString(36).slice(2, 10);

const readRequest = (plugin: ReactRNPlugin) =>
  plugin.storage.getLocal<OpenRequest>(openInWindowRequestKey).catch(() => undefined);

/** Windows, and so this feature, exist only in the desktop app. */
export async function canOpenInAnotherWindow(plugin: ReactRNPlugin): Promise<boolean> {
  return !(await isWebPlatform(plugin)) && !(await isMobileDevice(plugin));
}

/** Leaves the request for another window. Returns its id, for the two calls below. */
export async function requestOpenInAnotherWindow(
  plugin: ReactRNPlugin,
  remId: string,
  highlightRemId: string | null
): Promise<string> {
  const id = Math.random().toString(36).slice(2, 10);
  const from = await plugin.storage.getSession<string>(openInWindowOwnIdKey);
  if (!from) throw new Error('[OpenInWindow] this window has no listener');
  const request: OpenRequest = { id, remId, highlightRemId, from, at: Date.now() };
  await plugin.storage.setLocal(openInWindowRequestKey, request);
  return id;
}

export async function isOpenRequestClaimed(plugin: ReactRNPlugin, id: string): Promise<boolean> {
  const request = await readRequest(plugin);
  return request?.id === id && !!request.claimedBy;
}

/** Withdraws the request, unless a newer one has replaced it. */
export async function cancelOpenRequest(plugin: ReactRNPlugin, id: string): Promise<void> {
  const request = await readRequest(plugin);
  if (request?.id === id) await plugin.storage.setLocal(openInWindowRequestKey, undefined);
}

async function openRequested(plugin: ReactRNPlugin, request: OpenRequest) {
  const rem = await plugin.rem.findOne(request.remId);
  if (!rem) return;
  await plugin.window.openRem(rem);
  if (!request.highlightRemId) return;
  const highlight = await plugin.rem.findOne(request.highlightRemId);
  if (!highlight) return;
  for (const delay of SCROLL_DELAYS_MS) {
    setTimeout(() => {
      highlight.scrollToReaderHighlight().catch(() => {});
    }, delay);
  }
}

export async function registerOpenInWindowListener(plugin: ReactRNPlugin) {
  if (!(await canOpenInAnotherWindow(plugin))) return;
  await plugin.storage.setSession(openInWindowOwnIdKey, WINDOW_ID);

  const handled = new Set<string>();
  const poll = async () => {
    try {
      const request = await readRequest(plugin);
      if (!request || request.claimedBy || request.from === WINDOW_ID) return;
      if (handled.has(request.id) || Date.now() - request.at > OPEN_REQUEST_TTL_MS) return;
      handled.add(request.id);

      await new Promise((resolve) => setTimeout(resolve, Math.random() * MAX_CLAIM_JITTER_MS));
      const latest = await readRequest(plugin);
      if (latest?.id !== request.id || latest.claimedBy) return;
      await plugin.storage.setLocal(openInWindowRequestKey, { ...latest, claimedBy: WINDOW_ID });
      await openRequested(plugin, latest);
    } catch (e) {
      console.warn('[OpenInWindow] poll failed', e);
    }
  };
  setInterval(poll, POLL_MS);
  void poll();
}
