// lib/history_move_end.ts
//
// Ending a pending "↪ Move to another Rem" pick (lib/history_move_pick.ts). On
// its own, importing nothing but consts, so lib/parent_pick.ts can end a move
// when a parent pick starts while history_move_pick imports parent_pick to do
// the reverse — static imports both ways, no cycle. (A dynamic import() here
// became a lazily loaded chunk in the dev build, which RemNote can't load.)

import { RNPlugin } from '@remnote/plugin-sdk';
import { historyMoveActiveIdKey, historyMoveConfirmRequestKey, historyMoveContextKey } from './consts';

/**
 * Drops the pending move and closes its card. Safe to call when none is
 * pending. The card may be the caller, so closing it comes last.
 */
export async function endHistoryMove(plugin: RNPlugin): Promise<void> {
  await plugin.storage.setSession(historyMoveContextKey, undefined);
  await plugin.storage.setSession(historyMoveConfirmRequestKey, undefined);
  const id = await plugin.storage.getSession<string>(historyMoveActiveIdKey);
  await plugin.storage.setSession(historyMoveActiveIdKey, undefined);
  if (id) {
    try {
      await plugin.window.closeFloatingWidget(id);
    } catch {
      /* already gone */
    }
  }
}
