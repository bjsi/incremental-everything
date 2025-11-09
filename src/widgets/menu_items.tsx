import {
  PluginCommandMenuLocation,
  ReactRNPlugin,
} from '@remnote/plugin-sdk';
import {
  powerupCode,
  priorityShieldHistoryMenuItemId,
  currentSubQueueIdKey,
  noIncRemTimerKey,
  noIncRemMenuItemId,
  pdfHighlightColorId,
} from '../lib/consts';
import { initIncrementalRem } from './powerups';
import { safeRemTextToString } from '../lib/pdfUtils';

export async function registerMenuItems(plugin: ReactRNPlugin) {
  plugin.app.registerMenuItem({
    id: 'sorting_criteria_menuitem',
    location: PluginCommandMenuLocation.QueueMenu,
    name: 'Sorting Criteria',
    action: async () => {
      await plugin.widget.openPopup('sorting_criteria');
    },
  });

  plugin.app.registerMenuItem({
    id: priorityShieldHistoryMenuItemId,
    name: 'Priority Shield History',
    location: PluginCommandMenuLocation.QueueMenu,
    action: async () => {
      // Get the stored subQueueId from session
      const subQueueId = await plugin.storage.getSession<string | null>(currentSubQueueIdKey);
      console.log('Opening Priority Shield Graph with subQueueId:', subQueueId);

      await plugin.widget.openPopup('priority_shield_graph', {
        subQueueId: subQueueId
      });
    },
  });

  plugin.app.registerMenuItem({
    id: 'tag_rem_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Toggle tag as Incremental Rem',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        return;
      }
      const isIncremental = await rem.hasPowerup(powerupCode);
      if (isIncremental) {
        await rem.removePowerup(powerupCode);
      } else {
        await initIncrementalRem(plugin, rem);
      }
      const msg = isIncremental ? 'Untagged as Incremental Rem' : 'Tagged as Incremental Rem';
      await plugin.app.toast(msg);
    },
  });

  plugin.app.registerMenuItem({
    id: 'tag_highlight',
    location: PluginCommandMenuLocation.PDFHighlightPopupLocation,
    name: 'Toggle Incremental Rem',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) return;

      const isIncremental = await rem.hasPowerup(powerupCode);

      if (isIncremental) {
        await rem.removePowerup(powerupCode);
        await rem.setHighlightColor('Yellow'); // Reset to default
        await plugin.app.toast('❌ Removed Incremental tag');
      } else {
        await initIncrementalRem(plugin, rem);
        // Get the user-configured highlight color from settings
        const highlightColor = (await plugin.settings.getSetting(pdfHighlightColorId)) as 'Red' | 'Orange' | 'Yellow' | 'Green' | 'Blue' | 'Purple' || 'Blue';
        await rem.setHighlightColor(highlightColor);
        await plugin.app.toast('✅ Tagged as Incremental Rem');
        await plugin.widget.openPopup('priority', {
          remId: rem._id,
        });
      }
    },
  });

  plugin.app.registerMenuItem({
    id: 'batch_priority_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Batch Priority Change',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        return;
      }

      // Store the rem ID in session for the popup to access
      await plugin.storage.setSession('batchPriorityFocusedRem', args.remId);

      // Open the popup
      await plugin.widget.openPopup('batch_priority', {
        remId: args.remId,
      });
    },
  });

  // Add menu item for batch card priority assignment
  plugin.app.registerMenuItem({
    id: 'batch_card_priority_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Batch Assign Card Priority for tagged Rems',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        await plugin.app.toast('Could not find the rem');
        return;
      }

      // Check if this rem is actually being used as a tag
      const taggedRems = await rem.taggedRem();
      if (!taggedRems || taggedRems.length === 0) {
        await plugin.app.toast('This rem is not used as a tag. No rems are tagged with it.');
        return;
      }

      // Store the tag rem ID in session storage for the widget to access
      await plugin.storage.setSession('batchCardPriorityTagRem', rem._id);

      // Open the batch card priority widget
      await plugin.widget.openPopup('batch_card_priority');
    },
  });

  // No Inc Rem Timer
  plugin.app.registerMenuItem({
    id: noIncRemMenuItemId,
    name: 'No Inc Rem for 15 min',
    location: PluginCommandMenuLocation.QueueMenu,
    action: async () => {
      // Check if timer is already active
      const currentTimer = await plugin.storage.getSynced<number>(noIncRemTimerKey);
      if (currentTimer && currentTimer > Date.now()) {
        const remainingMinutes = Math.ceil((currentTimer - Date.now()) / 60000);
        await plugin.app.toast(`Timer already active: ${remainingMinutes} minutes remaining`);
        return;
      }

      // Set timer for 15 minutes from now using SYNCED storage
      const endTime = Date.now() + (15 * 60 * 1000);
      await plugin.storage.setSynced(noIncRemTimerKey, endTime);

      await plugin.app.toast('Incremental rems disabled for 15 minutes. Only flashcards will be shown.');

      // Force queue refresh
      await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
    },
  });

  // Add menu item for quick access
  plugin.app.registerMenuItem({
    id: 'create_priority_review_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Create Priority Review Document',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) return;

      const remName = await safeRemTextToString(plugin, rem.text);

      await plugin.storage.setSession('reviewDocContext', {
        scopeRemId: rem._id,
        scopeName: remName
      });

      await plugin.widget.openPopup('review_document_creator');
    },
  });

  // Also add to Queue Menu for easy access while in queue
  plugin.app.registerMenuItem({
    id: 'create_priority_review_queue_menuitem',
    location: PluginCommandMenuLocation.QueueMenu,
    name: 'Create Priority Review Document',
    action: async () => {
      // When called from queue menu, use current queue scope if available
      const subQueueId = await plugin.storage.getSession<string>(currentSubQueueIdKey);

      if (subQueueId) {
        const rem = await plugin.rem.findOne(subQueueId);
        const remName = rem ? await safeRemTextToString(plugin, rem.text) : 'Queue Scope';

        await plugin.storage.setSession('reviewDocContext', {
          scopeRemId: subQueueId,
          scopeName: remName
        });
      } else {
        await plugin.storage.setSession('reviewDocContext', {
          scopeRemId: null,
          scopeName: 'Full KB'
        });
      }

      await plugin.widget.openPopup('review_document_creator');
    },
  });
}
