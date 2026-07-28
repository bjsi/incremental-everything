// Resolves which rems a priority command should act on.
//
// Extracted from the near-identical blocks that `set-priority` (Opt+P) and
// `set-priority-light` (Ctrl+Opt+P) used to carry inline. Those blocks read
// `sel.remIds[0]` in the queue branch and fell back to `focus.getFocusedRem()`
// in the editor branch, so a multi-row selection collapsed to one rem — and in
// a table, where nothing is "focused" while rows are checkbox-selected, it
// collapsed to none at all ("No Rem found to set priority").
//
// Uses getEffectiveSelection() so the Omnibar (Cmd+/) path keeps working, and
// returns every selected rem so callers can open their popup in batch mode.
// Mirrors how createExtract() resolves targets for Opt+X / Opt+Shift+X.

import { RNPlugin, ReactRNPlugin, SelectionType } from '@remnote/plugin-sdk';
import { currentIncRemKey, powerupCode } from './consts';
import { CARD_PRIORITY_CODE } from './card_priority';
import { getEffectiveSelection } from './editor_selection';

export type PriorityTargets = {
  remIds: string[];
  /** Where the targets came from — useful for logging and popup context. */
  source: 'queue' | 'selection' | 'focus' | 'none';
};

/** How many rems a batch popup will inspect before giving up on exact counts. */
export const BATCH_SCAN_CAP = 300;

export type BatchTargetScan = {
  /** Targets carrying the Incremental powerup — the Inc slider applies to these. */
  incCount: number;
  /** Targets with cards or the CardPriority powerup — the Card slider applies to these. */
  cardCount: number;
  /** Targets that are neither, and which a batch edit deliberately skips. */
  skippedCount: number;
  total: number;
  /** True when `total` exceeded BATCH_SCAN_CAP, so the counts are of the sample. */
  capped: boolean;
};

// Classifies a batch selection so the popup can show the Inc section when ANY
// target is an IncRem and the Card section when ANY target has cards — rather
// than mirroring whatever the first rem happens to be, which silently dropped
// one dimension on mixed selections. The routing itself lives in tracker.ts;
// this only decides what the user is offered, and reports the counts.
export async function scanBatchTargets(
  plugin: RNPlugin,
  remIds: string[]
): Promise<BatchTargetScan> {
  const sample = remIds.slice(0, BATCH_SCAN_CAP);
  let incCount = 0;
  let cardCount = 0;
  let skippedCount = 0;

  for (const remId of sample) {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) {
      skippedCount++;
      continue;
    }
    const [isInc, hasCardPowerup] = await Promise.all([
      rem.hasPowerup(powerupCode),
      rem.hasPowerup(CARD_PRIORITY_CODE),
    ]);
    const isCard = hasCardPowerup || (await rem.getCards()).length > 0;

    if (isInc) incCount++;
    if (isCard) cardCount++;
    if (!isInc && !isCard) skippedCount++;
  }

  return {
    incCount,
    cardCount,
    skippedCount,
    total: remIds.length,
    capped: remIds.length > BATCH_SCAN_CAP,
  };
}

export async function resolvePriorityTargets(
  plugin: ReactRNPlugin
): Promise<PriorityTargets> {
  const url = await plugin.window.getURL();
  const sel = await getEffectiveSelection(plugin);
  const selType = sel?.type;

  const selectedRemIds: string[] =
    selType === SelectionType.Rem && sel && 'remIds' in sel
      ? (sel as any).remIds ?? []
      : selType === SelectionType.Text && sel && 'remId' in sel
      ? [(sel as any).remId]
      : [];

  // Queue: the visible card wins unless the user explicitly selected something
  // else. Same precedence the two commands had before, just factored out.
  if (url.includes('/flashcards')) {
    const currentQueueItem = await plugin.queue.getCurrentCard();
    const currentIncRemId =
      (await plugin.storage.getSession<string>(currentIncRemKey)) || undefined;
    const queueRemId = currentQueueItem?.remId ?? currentIncRemId;

    const selectionTargetsQueueItem =
      !selType ||
      (!!queueRemId && selectedRemIds.length <= 1 && selectedRemIds[0] === queueRemId);

    if (selectionTargetsQueueItem) {
      return queueRemId
        ? { remIds: [queueRemId], source: 'queue' }
        : { remIds: [], source: 'none' };
    }
    if (selectedRemIds.length) {
      return { remIds: selectedRemIds, source: 'selection' };
    }
  }

  // Editor. A checkbox/multi-row selection surfaces here as SelectionType.Rem
  // with several ids — including table rows, which is the case this exists for.
  if (selectedRemIds.length) {
    return { remIds: selectedRemIds, source: 'selection' };
  }

  const focusedRem = await plugin.focus.getFocusedRem();
  return focusedRem
    ? { remIds: [focusedRem._id], source: 'focus' }
    : { remIds: [], source: 'none' };
}
