import { RNPlugin } from '@remnote/plugin-sdk';
import { NOTICE_FLOAT, noticesKey } from './consts';
import { MessageDialog } from './message_dialog';

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
};

/** Kept at most; the oldest go first. */
const MAX_NOTICES = 10;
/** Where the card always opens; the user can drag it elsewhere once it is up. */
export const NOTICE_POSITION = { top: 64, right: 24 };

export async function showNotice(
  plugin: RNPlugin,
  dialog: MessageDialog & { action?: Notice['action']; id?: string }
): Promise<void> {
  const notice: Notice = {
    ...dialog,
    id: dialog.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
  };
  const list = (await plugin.storage.getSession<Notice[]>(noticesKey)) || [];
  await plugin.storage.setSession(noticesKey, [...list, notice].slice(-MAX_NOTICES));
}

/** Drop one notice, or all of them; the card closes when none is left. */
export async function dismissNotices(plugin: RNPlugin, id?: string): Promise<void> {
  const list = (await plugin.storage.getSession<Notice[]>(noticesKey)) || [];
  await plugin.storage.setSession(noticesKey, id ? list.filter((n) => n.id !== id) : []);
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
