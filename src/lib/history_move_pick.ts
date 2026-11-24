// lib/history_move_pick.ts
//
// "↪ Move to another Rem" from the Repetition History popup, picked in the
// editor: the popup closes, a floating card (widgets/history_move_floating.tsx)
// follows the Rem holding the editing cursor, and the user confirms with
// ⌥⇧↵ (the "Confirm Pick in Editor" command) or the card's button. Same
// pattern as the parent pick (lib/parent_pick.ts), and only one of the two is
// open at a time.
//
// This file owns the hand-off; the move itself is moveHistoryEntryTime in
// lib/history_edit.ts. endHistoryMove lives in ./history_move_end, which
// parent_pick imports, so this file can import parent_pick without a cycle.

import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { historyMoveActiveIdKey, historyMoveContextKey, historyMoveWidgetId } from './consts';
import { endHistoryMove } from './history_move_end';
import { endParentPick } from './parent_pick';
import { IncrementalRep } from './incremental_rem/types';
import { safeRemTextToString } from './pdfUtils';

export interface HistoryMoveContext {
  sourceRemId: string;
  sourceName: string;
  /** The review as the popup showed it; re-located on a fresh read when moving. */
  entry: IncrementalRep;
  /** Its index in the stored history, a hint for re-location. */
  index: number;
}

const BREADCRUMB_DEPTH = 3;

/**
 * Opens the floating card for `ctx` and closes the popup. Called from inside the
 * popup, so closing it comes last: once it's gone, nothing after it would run.
 */
export async function startHistoryMove(plugin: RNPlugin, ctx: HistoryMoveContext): Promise<void> {
  // Ends a parent pick too: one card listens for the confirm shortcut at a time.
  await endParentPick(plugin);
  await endHistoryMove(plugin);

  await plugin.storage.setSession(historyMoveContextKey, ctx);
  // closeWhenClickOutside must be false: every click in the editor is "outside".
  const id = await plugin.window.openFloatingWidget(historyMoveWidgetId, { top: 48, right: 24 }, undefined, false);
  await plugin.storage.setSession(historyMoveActiveIdKey, id);
  await plugin.widget.closePopup();
}

export async function isHistoryMoveActive(plugin: RNPlugin): Promise<boolean> {
  return !!(await plugin.storage.getSession<string>(historyMoveActiveIdKey));
}

export { endHistoryMove };

/** Abandons the pick and reopens the Repetition History popup on the source. */
export async function returnToHistory(plugin: RNPlugin): Promise<void> {
  const ctx = await plugin.storage.getSession<HistoryMoveContext>(historyMoveContextKey);
  if (ctx) await plugin.widget.openPopup('repetition_history', { remId: ctx.sourceRemId });
  await endHistoryMove(plugin);
}

/** The nearest ancestors' names, outermost first, for the card's breadcrumb. */
export async function remBreadcrumb(plugin: RNPlugin, rem: PluginRem): Promise<string[]> {
  const crumbs: string[] = [];
  let current: PluginRem | undefined = rem;
  while (current && crumbs.length < BREADCRUMB_DEPTH) {
    const parent: PluginRem | undefined = await current.getParentRem();
    if (!parent) break;
    crumbs.unshift((await safeRemTextToString(plugin, parent.text)).trim() || 'Untitled');
    current = parent;
  }
  return crumbs;
}
