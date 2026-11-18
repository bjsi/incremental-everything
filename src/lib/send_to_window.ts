import { ReactRNPlugin } from '@remnote/plugin-sdk';
import type { PaneRem, PaneRemWindowTree, RemIdWindowTree } from '@remnote/plugin-sdk/dist/interfaces';
import { noticesKey, sendToWindowPendingKey } from './consts';
import { getOperatingSystem } from './mobileUtils';
import { dismissNotices, Notice, showNotice } from './notice';
import {
  canOpenInAnotherWindow,
  cancelOpenRequest,
  OPEN_REQUEST_TTL_MS,
  openRequestState,
  requestOpenInAnotherWindow,
} from './open_in_window';
import { resolveRemTextAsTitle } from './richTextRemRefs';

/**
 * "Send to Another Window" (Menu Hub, and a command for the focused pane): moves a document from this window's pane to
 * another RemNote window.
 *
 * The Menu Hub leaves an open request (lib/open_in_window.ts) and a notice saying to
 * press Cmd+Shift+N when no other window is open, then closes; the hub's iframe goes
 * with it. So the wait runs in the index (registerSendToWindowWatcher): once the other
 * window confirms the document is open there, it closes the document's pane here and
 * says so. Dismissing the waiting notice withdraws the request.
 *
 * Only the document's pane closes, never the tab: a document that is the only pane of
 * its tab stays open, and the notice says so.
 */

interface PendingSend {
  requestId: string;
  remId: string;
  /** The pane it was sent from, which is the one to close. */
  paneId?: string;
  name: string;
  noticeId: string;
  at: number;
}

const WATCH_MS = 1000;
// The other window may take the request at the last second of its life and still
// need a few seconds to open the document.
const CONFIRM_SLACK_MS = 15_000;

const newWindowKeys = async (plugin: ReactRNPlugin) =>
  (await getOperatingSystem(plugin)) === 'mac' ? '⌘⇧N' : 'Ctrl+Shift+N';

/**
 * The focused pane and the document it shows: the Rem the pane is zoomed into, not the
 * one the cursor is on. With the cursor on a bullet of "Section V", that is Section V.
 */
export async function focusedPaneDocument(
  plugin: ReactRNPlugin
): Promise<{ paneId: string; remId: string } | undefined> {
  const paneId = await plugin.window.getFocusedPaneId().catch(() => undefined);
  const remId = paneId ? await plugin.window.getOpenPaneRemId(paneId).catch(() => undefined) : undefined;
  return paneId && remId ? { paneId, remId } : undefined;
}

/** Command: sends the focused pane's document. */
export async function sendFocusedPaneToAnotherWindow(plugin: ReactRNPlugin): Promise<void> {
  if (!(await canOpenInAnotherWindow(plugin))) {
    await plugin.app.toast('Sending to another window needs the desktop app: only it has more than one window.');
    return;
  }
  const pane = await focusedPaneDocument(plugin);
  if (!pane) {
    await plugin.app.toast('Focus a pane with a document to send it to another window.');
    return;
  }
  await sendDocumentToAnotherWindow(plugin, pane.remId, pane.paneId);
}

/**
 * Asks another window to open the document. `paneId` is the pane to close once it is
 * open there; without it, the focused pane if it shows the document.
 */
export async function sendDocumentToAnotherWindow(
  plugin: ReactRNPlugin,
  remId: string,
  paneId?: string
): Promise<void> {
  if (!paneId) {
    const focused = await focusedPaneDocument(plugin);
    if (focused?.remId === remId) paneId = focused.paneId;
  }
  const rem = await plugin.rem.findOne(remId);
  if (!rem) throw new Error('This document no longer exists.');
  const name = (await resolveRemTextAsTitle(plugin, rem.text)) || 'This document';

  // One request at a time: a new one replaces the last, and so does its notice.
  const previous = await plugin.storage.getSession<PendingSend>(sendToWindowPendingKey);
  if (previous) await dismissNotices(plugin, previous.noticeId);

  const requestId = await requestOpenInAnotherWindow(plugin, remId, null);
  const pending: PendingSend = { requestId, remId, paneId, name, noticeId: `send-to-window-${requestId}`, at: Date.now() };
  await plugin.storage.setSession(sendToWindowPendingKey, pending);
  await showNotice(plugin, {
    id: pending.noticeId,
    title: 'Sending to another window',
    message: `“${name}” opens in another RemNote window. If no other window is open, press ${await newWindowKeys(plugin)}.`,
    detail: 'Its pane here closes once it is open there. Dismiss this to cancel.',
    tone: 'info',
  });
}

function leaves(tree: PaneRemWindowTree | null | undefined): { remId: string; paneId: string }[] {
  if (!tree) return [];
  if ('paneId' in tree) return [tree];
  return [...leaves(tree.first as PaneRemWindowTree), ...leaves(tree.second as PaneRemWindowTree)];
}

/** The layout without the panes `drop` picks; null when no pane would be left. */
function without(node: PaneRemWindowTree, drop: (pane: PaneRem) => boolean): RemIdWindowTree | null {
  if ('paneId' in node) return drop(node) ? null : node.remId;
  const first = without(node.first as PaneRemWindowTree, drop);
  const second = without(node.second as PaneRemWindowTree, drop);
  if (!first) return second;
  if (!second) return first;
  return { direction: node.direction, first, second, splitPercentage: node.splitPercentage };
}

/**
 * Closes the pane the document was sent from, in the current tab. When that pane is
 * gone (the layout was rebuilt, or the user moved on), the panes showing the document.
 */
async function closeDocumentPane(
  plugin: ReactRNPlugin,
  remId: string,
  paneId: string | undefined
): Promise<'closed' | 'only-pane' | 'not-open'> {
  const tree = await plugin.window.getCurrentWindowTree();
  const panes = leaves(tree).filter((p) => p.remId === remId);
  if (!tree || !panes.length) return 'not-open';
  const exact = panes.some((p) => p.paneId === paneId);
  const rest = without(tree, (p) => p.remId === remId && (!exact || p.paneId === paneId));
  if (!rest) return 'only-pane';
  await plugin.window.setRemWindowTree(rest);
  return 'closed';
}

async function settle(plugin: ReactRNPlugin, pending: PendingSend) {
  const state = await openRequestState(plugin, pending.requestId);
  const notices = (await plugin.storage.getSession<Notice[]>(noticesKey)) || [];
  const finish = async () => {
    await plugin.storage.setSession(sendToWindowPendingKey, undefined);
    await dismissNotices(plugin, pending.noticeId);
  };

  if (state === 'opened') {
    await finish();
    let outcome: Awaited<ReturnType<typeof closeDocumentPane>> = 'not-open';
    try {
      outcome = await closeDocumentPane(plugin, pending.remId, pending.paneId);
    } catch (e) {
      console.error('[SendToWindow] could not close the pane', e);
    }
    await showNotice(plugin, {
      title: 'Opened in the other window',
      message:
        outcome === 'only-pane'
          ? `“${pending.name}” is open in the other RemNote window. It is the only pane of this tab here, so it stays open.`
          : outcome === 'closed'
            ? `“${pending.name}” is open in the other RemNote window, and its pane here is closed.`
            : `“${pending.name}” is open in the other RemNote window.`,
      tone: outcome === 'only-pane' ? 'info' : 'success',
    });
    return;
  }

  // Dismissed by the user: withdraw the request.
  if (!notices.some((n) => n.id === pending.noticeId)) {
    await plugin.storage.setSession(sendToWindowPendingKey, undefined);
    await cancelOpenRequest(plugin, pending.requestId);
    return;
  }

  // Withdrawn or replaced by another request (the Source viewer's button shares the channel).
  if (state === 'gone') {
    await finish();
    return;
  }

  if (Date.now() - pending.at > OPEN_REQUEST_TTL_MS + (state === 'claimed' ? CONFIRM_SLACK_MS : 0)) {
    await finish();
    await cancelOpenRequest(plugin, pending.requestId);
    await showNotice(plugin, {
      title: 'Not sent to another window',
      message:
        state === 'claimed'
          ? `Another window took “${pending.name}” but never confirmed it was open, so its pane here stays. Reload the plugin in that window and send it again.`
          : `No other RemNote window took “${pending.name}” within a minute. Open one with ${await newWindowKeys(plugin)} and send it again.`,
      tone: 'error',
      openRemId: pending.remId,
    });
  }
}

/** Index only: watches a sent document until it opens in the other window (or the request ends). */
export function registerSendToWindowWatcher(plugin: ReactRNPlugin) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const pending = await plugin.storage.getSession<PendingSend>(sendToWindowPendingKey);
      if (!pending) stop();
      else await settle(plugin, pending);
    } catch (e) {
      console.warn('[SendToWindow] watch failed', e);
    } finally {
      busy = false;
    }
  };
  plugin.track(async (rp) => {
    const pending = await rp.storage.getSession<PendingSend>(sendToWindowPendingKey);
    if (pending && !timer) timer = setInterval(tick, WATCH_MS);
  });
}
