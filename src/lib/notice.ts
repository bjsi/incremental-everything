import { RNPlugin } from '@remnote/plugin-sdk';
import { NOTICE_FLOAT, noticesKey } from './consts';
import { MessageDialog } from './message_dialog';
import { MEDIA_BRIDGE_URL } from './media_bridge_url';

/**
 * Notices: the report of work that ran in the background (a Read Aloud job, a review
 * the tracker could not save), which arrives at a moment the user did not choose.
 *
 * A message dialog is a popup, and RemNote shows one popup at a time: opening one
 * replaces whatever popup is up, killing the work going on in it (a Read Aloud popup
 * writing its script, a priority popup mid-edit). A floating widget sits beside popups
 * instead (it only adds to the host's list of floats) and paints above them. So notices
 * go to one floating card, top right, that stays until dismissed and never takes focus.
 *
 * Use showMessageDialog for the answer to something the user just did (a command that
 * cannot start), where the popup's keyboard flow is worth more; use showNotice for
 * anything that can land while the user is busy elsewhere.
 */
export type Notice = MessageDialog & {
  id: string;
  at: number;
  /**
   * A button that opens a popup with this data (the Upscale review). The notice stays
   * after the click: the popup dismisses it (by `id`) once its work is finished, so a
   * popup closed half-way can be opened again from the notice.
   */
  action?: { label: string; popup: string; data: unknown };
  /**
   * A question from an outside tool (`media_bridge.py ask`): one button per choice in
   * place of Dismiss. The click posts the choice to the bridge (POST /answers), where the
   * tool is waiting for it, and dismisses the notice. Dismissing it any other way
   * (Dismiss all, Esc) answers "dismissed", so the tool never waits for nothing.
   */
  ask?: { id: string; choices: string[] };
};

/** Kept at most; the oldest go first. */
const MAX_NOTICES = 10;
/** Where the card always opens; the user can drag it elsewhere once it is up. */
export const NOTICE_POSITION = { top: 64, right: 24 };

export async function showNotice(
  plugin: RNPlugin,
  dialog: MessageDialog & { action?: Notice['action']; ask?: Notice['ask']; id?: string }
): Promise<void> {
  const notice: Notice = {
    ...dialog,
    id: dialog.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
  };
  // A notice with the id of one already up replaces it (a background job's progress, then its result).
  const list = [
    ...((await plugin.storage.getSession<Notice[]>(noticesKey)) || []).filter((n) => n.id !== notice.id),
    notice,
  ];
  // Over the limit, the oldest plain notices go first: an open question stays until answered.
  while (list.length > MAX_NOTICES) {
    const k = list.findIndex((n) => !n.ask);
    list.splice(k >= 0 ? k : 0, 1);
  }
  await plugin.storage.setSession(noticesKey, list);
}

/** Send the answer of an `ask` notice to the bridge; false when the helper is not reachable. */
export async function postNoticeAnswer(askId: string, answer: string): Promise<boolean> {
  try {
    const res = await fetch(`${MEDIA_BRIDGE_URL}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ askId, answer }),
    });
    return res.ok;
  } catch (err) {
    console.warn('[Notice] could not post the answer', askId, err);
    return false;
  }
}

/** Drop one notice, or all of them; the card closes when none is left. */
export async function dismissNotices(plugin: RNPlugin, id?: string): Promise<void> {
  const list = (await plugin.storage.getSession<Notice[]>(noticesKey)) || [];
  const gone = id ? list.filter((n) => n.id === id) : list;
  await plugin.storage.setSession(noticesKey, id ? list.filter((n) => n.id !== id) : []);
  // A question closed without a choice: say so, so its tool stops waiting.
  await Promise.all(gone.filter((n) => n.ask).map((n) => postNoticeAnswer(n.ask!.id, 'dismissed')));
}

/** Answer an `ask` notice with one of its choices and close it. */
export async function answerNotice(plugin: RNPlugin, notice: Notice, answer: string): Promise<boolean> {
  if (!notice.ask) return false;
  const sent = await postNoticeAnswer(notice.ask.id, answer);
  if (!sent) return false;
  const list = (await plugin.storage.getSession<Notice[]>(noticesKey)) || [];
  await plugin.storage.setSession(noticesKey, list.filter((n) => n.id !== notice.id));
  return true;
}

/**
 * Index only: open the card while there are notices, close it when there are none.
 * A new notice reopens a card that went away some other way, with the ones not yet
 * dismissed.
 */
export function registerNoticeHost(plugin: RNPlugin) {
  let floatId: string | undefined;
  let busy = Promise.resolve();
  plugin.track(async (rp) => {
    const list = (await rp.storage.getSession<Notice[]>(noticesKey)) || [];
    busy = busy.then(async () => {
      const open = !!floatId && (await plugin.window.isFloatingWidgetOpen(floatId).catch(() => false));
      if (list.length && !open) {
        floatId = await plugin.window.openFloatingWidget(NOTICE_FLOAT, NOTICE_POSITION, undefined, false);
      } else if (!list.length && open && floatId) {
        await plugin.window.closeFloatingWidget(floatId).catch(() => {});
        floatId = undefined;
      }
    }).catch((err) => console.warn('[Notice] could not open or close the card', err));
    await busy;
  });
}
