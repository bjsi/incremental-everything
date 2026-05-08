import { ReactRNPlugin, SelectionType } from '@remnote/plugin-sdk';
import {
  HIDE_IN_QUEUE_POWERUP_CODE,
  REMOVE_FROM_QUEUE_POWERUP_CODE,
  NO_HIERARCHY_POWERUP_CODE,
  HIDE_PARENT_POWERUP_CODE,
  HIDE_GRANDPARENT_POWERUP_CODE,
  REMOVE_PARENT_POWERUP_CODE,
  REMOVE_GRANDPARENT_POWERUP_CODE,
} from './queue_display_powerups';

/* Powerup codes that, when applied to the CURRENT card, would hide/remove
   the card itself — likely a user mistake. The official Hide in Queue plugin
   warns the user and offers to apply to the parent instead. */
const SELF_HIDING_POWERUPS = new Set<string>([
  HIDE_IN_QUEUE_POWERUP_CODE,
  REMOVE_FROM_QUEUE_POWERUP_CODE,
]);

const POWERUP_DISPLAY_NAMES: Record<string, string> = {
  [HIDE_IN_QUEUE_POWERUP_CODE]: 'Hide in Queue',
  [REMOVE_FROM_QUEUE_POWERUP_CODE]: 'Remove from Queue',
  [NO_HIERARCHY_POWERUP_CODE]: 'No Hierarchy',
  [HIDE_PARENT_POWERUP_CODE]: 'Hide Parent',
  [HIDE_GRANDPARENT_POWERUP_CODE]: 'Hide Grandparent',
  [REMOVE_PARENT_POWERUP_CODE]: 'Remove Parent',
  [REMOVE_GRANDPARENT_POWERUP_CODE]: 'Remove Grandparent',
};

/* Ported from the standalone Hide in Queue plugin's `runAddPowerupCommand`.

   Behavior:
   1. If invoked while in the queue and targeting the current card:
      - For self-hiding powerups (hide-in-queue, remove-from-queue) → warn the
        user; on confirm, apply to the parent instead. (Applied to the current
        card itself these would make the card vanish — almost always wrong.)
      - For all other powerups → apply directly to the current card.
   2. If invoked outside the queue → apply to the editor selection. */
async function runAddPowerupCommand(plugin: ReactRNPlugin, powerup: string) {
  const url = await plugin.window.getURL();
  const currentCard = await plugin.queue.getCurrentCard();
  const sel = await plugin.editor.getSelection();
  const selType = sel?.type;

  if (url.includes('/flashcards') && currentCard) {
    let isTargetingCurrentCard = false;
    if (!selType) {
      isTargetingCurrentCard = true;
    } else if (selType === SelectionType.Rem && sel.remIds.includes(currentCard.remId)) {
      isTargetingCurrentCard = true;
    } else if (selType === SelectionType.Text && sel.remId === currentCard.remId) {
      isTargetingCurrentCard = true;
    }

    if (isTargetingCurrentCard) {
      if (SELF_HIDING_POWERUPS.has(powerup)) {
        const powerupName = POWERUP_DISPLAY_NAMES[powerup];
        const userConfirmed = window.confirm(
          `Warning: "${powerupName}" is meant for parent/ancestor Rems, not the flashcard directly.\n\n` +
          `Click "OK" to navigate to the parent Rem and apply the powerup there, or "Cancel" to abort.\n\n` +
          `Consider these alternatives if you want to affect ONLY this flashcard, not other descendants from the same ancestor:\n` +
          `  "Hide Parent" / "Hide Grandparent"\n` +
          `  "Remove Parent" / "Remove Grandparent"\n\n`
        );
        if (userConfirmed) {
          const rem = await plugin.rem.findOne(currentCard.remId);
          const parent = await rem?.getParentRem();
          if (parent) {
            await parent.addPowerup(powerup);
            await plugin.app.toast(`Applied "${powerupName}" to parent.`);
          } else {
            await plugin.app.toast('Could not find a parent Rem.');
          }
        }
      } else {
        const rem = await plugin.rem.findOne(currentCard.remId);
        await rem?.addPowerup(powerup);
        await plugin.app.toast(
          'Powerup added (will take effect next time you see this card).'
        );
      }
      return;
    }
  }

  // Outside the queue: apply to editor selection.
  if (!selType) return;
  if (selType === SelectionType.Rem) {
    const rems = (await plugin.rem.findMany(sel.remIds)) || [];
    rems.forEach((r) => r.addPowerup(powerup));
  } else {
    const rem = await plugin.rem.findOne(sel.remId);
    rem?.addPowerup(powerup);
  }
}

/* Always-on commands — Remove Parent / Remove Grandparent. Their powerups are
   net-new (don't conflict with the standalone Hide in Queue plugin), so the
   commands are always available. */
export async function registerCoreQueueDisplayCommands(plugin: ReactRNPlugin) {
  await plugin.app.registerCommand({
    id: `${REMOVE_PARENT_POWERUP_CODE}Cmd`,
    name: 'Remove Parent',
    description: 'Completely remove the immediate parent of the tagged Rem from the queue (front and back).',
    quickCode: 'rp',
    action: async () => runAddPowerupCommand(plugin, REMOVE_PARENT_POWERUP_CODE),
  });

  await plugin.app.registerCommand({
    id: `${REMOVE_GRANDPARENT_POWERUP_CODE}Cmd`,
    name: 'Remove Grandparent',
    description: 'Completely remove the grandparent of the tagged Rem from the queue (front and back).',
    quickCode: 'rgp',
    action: async () => runAddPowerupCommand(plugin, REMOVE_GRANDPARENT_POWERUP_CODE),
  });
}

/* Gated commands — registered only when the Hide-in-Queue integration setting
   is on. Mirror the standalone plugin's commands; the user must have
   uninstalled the standalone plugin first to avoid duplicate powerups. */
export async function registerHideInQueueLegacyCommands(plugin: ReactRNPlugin) {
  await plugin.app.registerCommand({
    id: `${HIDE_IN_QUEUE_POWERUP_CODE}Cmd`,
    name: 'Hide in Queue',
    description: 'Hide the tagged Rem in the queue, displaying only "Hidden in Queue".',
    quickCode: 'hiq',
    action: async () => runAddPowerupCommand(plugin, HIDE_IN_QUEUE_POWERUP_CODE),
  });

  await plugin.app.registerCommand({
    id: `${REMOVE_FROM_QUEUE_POWERUP_CODE}Cmd`,
    name: 'Remove from Queue',
    description: 'Completely remove the tagged Rem from the queue view.',
    quickCode: 'rfq',
    action: async () => runAddPowerupCommand(plugin, REMOVE_FROM_QUEUE_POWERUP_CODE),
  });

  await plugin.app.registerCommand({
    id: `${NO_HIERARCHY_POWERUP_CODE}Cmd`,
    name: 'No Hierarchy',
    description: 'Any ancestors will be hidden on the front and back of the flashcard.',
    quickCode: 'nh',
    action: async () => runAddPowerupCommand(plugin, NO_HIERARCHY_POWERUP_CODE),
  });

  await plugin.app.registerCommand({
    id: `${HIDE_PARENT_POWERUP_CODE}Cmd`,
    name: 'Hide Parent',
    description: 'Hide the immediate parent of the tagged Rem in the queue (front side).',
    quickCode: 'hp',
    action: async () => runAddPowerupCommand(plugin, HIDE_PARENT_POWERUP_CODE),
  });

  await plugin.app.registerCommand({
    id: `${HIDE_GRANDPARENT_POWERUP_CODE}Cmd`,
    name: 'Hide Grandparent',
    description: 'Hide the grandparent of the tagged Rem in the queue (front side).',
    quickCode: 'hgp',
    action: async () => runAddPowerupCommand(plugin, HIDE_GRANDPARENT_POWERUP_CODE),
  });
}
