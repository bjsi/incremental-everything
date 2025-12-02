import {
  PluginCommandMenuLocation,
  ReactRNPlugin,
  BuiltInPowerupCodes,
} from '@remnote/plugin-sdk';
import {
  powerupCode,
  priorityShieldHistoryMenuItemId,
  currentSubQueueIdKey,
  pdfHighlightColorId,
  noIncRemMenuItemId,
  noIncRemTimerKey,
  pageRangeWidgetId,
} from '../lib/consts';
import { safeRemTextToString, findPDFinRem, findIncrementalRemForPDF } from '../lib/pdfUtils';
import { initIncrementalRem } from './powerups';
import { createRemFromHighlight } from '../lib/highlightActions';

export async function registerMenus(plugin: ReactRNPlugin) {
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
      const subQueueId = await plugin.storage.getSession<string | null>(currentSubQueueIdKey);
      console.log('Opening Priority Shield Graph with subQueueId:', subQueueId);

      await plugin.widget.openPopup('priority_shield_graph', {
        subQueueId,
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
        await rem.setHighlightColor('Yellow');
        await plugin.app.toast('❌ Removed Incremental tag');
      } else {
        await initIncrementalRem(plugin, rem);
        const highlightColor =
          ((await plugin.settings.getSetting(pdfHighlightColorId)) as
            | 'Red'
            | 'Orange'
            | 'Yellow'
            | 'Green'
            | 'Blue'
            | 'Purple') || 'Blue';
        await rem.setHighlightColor(highlightColor);
        await plugin.app.toast('✅ Tagged as Incremental Rem');
        await plugin.widget.openPopup('priority', {
          remId: rem._id,
        });
      }
    },
  });

  plugin.app.registerMenuItem({
    id: 'create_inc_rem_highlight',
    location: PluginCommandMenuLocation.PDFHighlightPopupLocation,
    name: 'Create Incremental Rem',
    action: async (args: { remId: string }) => {
      const highlight = await plugin.rem.findOne(args.remId);
      if (!highlight) return;

      await createRemFromHighlight(plugin, highlight, {
        makeIncremental: true,
      });
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

      await plugin.storage.setSession('batchPriorityFocusedRem', args.remId);

      await plugin.widget.openPopup('batch_priority', {
        remId: args.remId,
      });
    },
  });

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

      const taggedRems = await rem.taggedRem();
      if (!taggedRems || taggedRems.length === 0) {
        await plugin.app.toast('This rem is not used as a tag. No rems are tagged with it.');
        return;
      }

      await plugin.storage.setSession('batchCardPriorityTagRem', rem._id);

      await plugin.widget.openPopup('batch_card_priority');
    },
  });

  plugin.app.registerMenuItem({
    id: noIncRemMenuItemId,
    name: 'No Inc Rem for 15 min',
    location: PluginCommandMenuLocation.QueueMenu,
    action: async () => {
      const currentTimer = await plugin.storage.getSynced<number>(noIncRemTimerKey);
      if (currentTimer && currentTimer > Date.now()) {
        const remainingMinutes = Math.ceil((currentTimer - Date.now()) / 60000);
        await plugin.app.toast(`Timer already active: ${remainingMinutes} minutes remaining`);
        return;
      }

      const endTime = Date.now() + 15 * 60 * 1000;
      await plugin.storage.setSynced(noIncRemTimerKey, endTime);

      await plugin.app.toast('Incremental rems disabled for 15 minutes. Only flashcards will be shown.');

      await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
    },
  });

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
        scopeName: remName,
      });

      await plugin.widget.openPopup('review_document_creator');
    },
  });

  plugin.app.registerMenuItem({
    id: 'pdf_control_panel_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'PDF Control Panel',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) return;

      const pdfRem = await findPDFinRem(plugin, rem);

      if (!pdfRem) {
        await plugin.app.toast('No PDF found in this rem or its sources');
        return;
      }

      const incrementalRem = await findIncrementalRemForPDF(plugin, pdfRem, false);

      if (!incrementalRem) {
        await plugin.app.toast('No incremental rem found for this PDF');
        return;
      }

      const context = {
        incrementalRemId: incrementalRem._id,
        pdfRemId: pdfRem._id,
        totalPages: 0,
        currentPage: 1
      };

      await plugin.storage.setSession('pageRangeContext', context);
      await plugin.storage.setSession('pageRangePopupOpen', true);

      await plugin.widget.openPopup(pageRangeWidgetId);
    },
  });

  plugin.app.registerMenuItem({
    id: 'create_priority_review_queue_menuitem',
    location: PluginCommandMenuLocation.QueueMenu,
    name: 'Create Priority Review Document',
    action: async () => {
      const subQueueId = await plugin.storage.getSession<string>(currentSubQueueIdKey);

      if (subQueueId) {
        const rem = await plugin.rem.findOne(subQueueId);
        const remName = rem ? await safeRemTextToString(plugin, rem.text) : 'Queue Scope';

        await plugin.storage.setSession('reviewDocContext', {
          scopeRemId: subQueueId,
          scopeName: remName,
        });
      } else {
        await plugin.storage.setSession('reviewDocContext', {
          scopeRemId: null,
          scopeName: 'Full KB',
        });
      }

      await plugin.widget.openPopup('review_document_creator');
    },
  });
}
