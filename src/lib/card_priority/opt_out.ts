// lib/card_priority/opt_out.ts
//
// Turning "Enable Flashcard Prioritisation" OFF stops the machinery, but it does
// not undo what the machinery already wrote: every rem it tagged keeps its
// CardPriority powerup and its three slots, visible in the editor, forever.
//
// Nothing in the SDK reports a setting change, and the gate itself is only ever
// read, never subscribed to. What there is, is a value we can compare against
// the last one we saw. This module records that value per knowledge base and,
// the first time it comes back as `false` after having been `true`, offers to
// run the reversible cleanup — inherited/default tags only, so nothing the user
// chose is lost. The comparison happens on activation, which is also when the
// setting's own "takes effect after reloading RemNote" note lands.
//
// Design constraints:
//  - Offered at most ONCE per switch-off. The last-seen value is written before
//    the dialog opens, so declining (or crashing) cannot turn this into a nag.
//  - Never on light mode (mobile / web). It ends in a KB-wide bulk write, which
//    is exactly what light mode exists to avoid — and the record is left
//    untouched there so the desktop session still gets the offer.
//  - Never blocks activation: the caller fires it without awaiting.
import { RNPlugin } from '@remnote/plugin-sdk';
import {
  enableFlashcardPrioritisationId,
  flashcardPrioritisationOptOutStateKey,
} from '../consts';
import { getIESetting } from '../settings';
import { shouldUseLightMode } from '../mobileUtils';
import { removeAllCardPriorityTags, summarizeCardPriorityTags } from './batch';

const LOG = '[FlashcardPrioritisation opt-out]';

type PromptOutcome = 'cleaned' | 'declined' | 'nothing-to-clean' | 'failed';

interface OptOutRecord {
  /** The gate value this KB was last seen with. */
  lastSeen: boolean;
  /** When that value was recorded. */
  changedAt: number;
  /** When the cleanup was last offered, and how it went. */
  promptedAt?: number;
  outcome?: PromptOutcome;
}

type OptOutState = Record<string, OptOutRecord>;

async function readState(plugin: RNPlugin): Promise<OptOutState> {
  return (await plugin.storage.getSynced<OptOutState>(flashcardPrioritisationOptOutStateKey)) || {};
}

/** Read-modify-write of the current KB's slice only — the key is shared by every KB. */
async function patchRecord(
  plugin: RNPlugin,
  kbId: string,
  patch: Partial<OptOutRecord>
): Promise<void> {
  const state = await readState(plugin);
  const existing: OptOutRecord = state[kbId] || { lastSeen: false, changedAt: Date.now() };
  state[kbId] = { ...existing, ...patch };
  await plugin.storage.setSynced(flashcardPrioritisationOptOutStateKey, state);
}

/**
 * Detects a switch-off of the flashcard-prioritisation gate and walks the user
 * through removing what it left behind.
 *
 * Safe to call on every activation: it is a no-op unless the value actually
 * changed since the last one recorded for this knowledge base.
 */
export async function checkFlashcardPrioritisationOptOut(plugin: RNPlugin): Promise<void> {
  let kbId = 'global';
  try {
    // Light mode first: recording the value here would consume the one-shot
    // offer on a device that must not perform the cleanup.
    if (await shouldUseLightMode(plugin)) {
      console.log(`${LOG} skipped — light mode.`);
      return;
    }

    const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
    kbId = kbData?._id || 'global';
    const kbName = kbData?.name || 'this knowledge base';

    const enabled = !!(await getIESetting(plugin, enableFlashcardPrioritisationId));
    const state = await readState(plugin);
    const record = state[kbId];

    if (!record) {
      // First sighting of this KB. Establish the baseline and say nothing — we
      // cannot tell an opt-out from a fresh install.
      await patchRecord(plugin, kbId, { lastSeen: enabled, changedAt: Date.now() });
      console.log(`${LOG} baseline recorded for "${kbName}": ${enabled}`);
      return;
    }

    if (record.lastSeen === enabled) return;

    // Record the new value BEFORE anything user-facing, so this is offered at
    // most once per switch-off however the rest of the run ends.
    await patchRecord(plugin, kbId, { lastSeen: enabled, changedAt: Date.now() });

    if (enabled) {
      console.log(`${LOG} "${kbName}": prioritisation was switched back ON.`);
      return;
    }

    console.log(`${LOG} "${kbName}": prioritisation was switched OFF — scanning for leftovers.`);
    const counts = await summarizeCardPriorityTags(plugin);
    console.log(
      `${LOG} ${counts.scanned} tag(s): ${counts.derived} inherited/default, ` +
        `${counts.intentional} manual/incremental, ${counts.unknown} unknown source.`
    );

    if (counts.derived === 0) {
      await patchRecord(plugin, kbId, {
        promptedAt: Date.now(),
        outcome: 'nothing-to-clean',
      });
      console.log(`${LOG} nothing to clean up — no inherited/default tags left behind.`);
      return;
    }

    const runNow = confirm(
      `🧹 Flashcard Prioritisation is now OFF — "${kbName}"\n\n` +
        `The plugin has stopped writing card priorities, but ${counts.derived} tag(s) it ` +
        `created automatically (source: inherited or default) are still on your rems.\n\n` +
        `Would you like to remove them now?\n\n` +
        `KEPT either way:\n` +
        `  • ${counts.intentional} manual priorit(ies) and Incremental Rem anchor(s)\n` +
        `  • Your Card Priority Shield history\n\n` +
        `Fully reversible: turn the setting back on and run "Update all inherited Card ` +
        `Priorities" to rebuild them.\n\n` +
        `OK = remove them now    •    Cancel = leave them for later`
    );

    if (!runNow) {
      await patchRecord(plugin, kbId, { promptedAt: Date.now(), outcome: 'declined' });
      console.log(`${LOG} user declined the cleanup.`);
      alert(
        `No problem — nothing was changed.\n\n` +
          `The ${counts.derived} inherited/default CardPriority tag(s) are harmless: with the ` +
          `setting off they are never read or updated.\n\n` +
          `To remove them whenever you like:\n` +
          `  1. Open the command palette (Ctrl/Cmd + K)\n` +
          `  2. Run "Remove CardPriority Tags…"\n` +
          `  3. Choose OK — "inherited & default only"\n\n` +
          `This offer will not appear again.`
      );
      return;
    }

    const result = await removeAllCardPriorityTags(plugin, {
      scope: 'derived',
      skipConfirm: true,
      skipReloadPrompt: true,
      context: 'Flashcard Prioritisation was turned off.',
    });
    await patchRecord(plugin, kbId, {
      promptedAt: Date.now(),
      outcome: result.cancelled ? 'declined' : 'cleaned',
    });
    console.log(`${LOG} cleanup finished — removed ${result.removed} tag(s).`);
  } catch (e) {
    console.warn(`${LOG} failed:`, e);
    // The last-seen value has already been written, so a failure here does not
    // re-prompt on the next launch; the command remains available manually.
    try {
      await patchRecord(plugin, kbId, { promptedAt: Date.now(), outcome: 'failed' });
    } catch {
      /* ignore */
    }
  }
}
