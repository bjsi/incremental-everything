import {
  PluginCommandMenuLocation,
  ReactRNPlugin,
  BuiltInPowerupCodes,
} from '@remnote/plugin-sdk';
import {
  powerupCode,
  priorityShieldHistoryMenuItemId,
  currentSubQueueIdKey,
  noIncRemMenuItemId,
  noIncRemTimerKey,
  pageRangeWidgetId,
  incRemDisabledDeviceKey,
} from '../lib/consts';
import { safeRemTextToString, getActivePdfForIncRem, findIncrementalRemForPDF, getPdfInfoFromHighlight, addPageToHistory, setIncrementalReadingPosition } from '../lib/pdfUtils';
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
    id: 'priority_shield_document_menuitem',
    name: 'Priority Shield History',
    location: PluginCommandMenuLocation.DocumentMenu,
    action: async (args: { remId: string }) => {
      // For document menu, the remId IS the scope/subQueueId
      await plugin.widget.openPopup('priority_shield_graph', {
        subQueueId: args.remId,
      });
    },
  });

  plugin.app.registerMenuItem({
    id: 'tag_rem_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Toggle Incremental Rem',
    iconUrl: 'https://cdn-icons-png.flaticon.com/512/12809/12809374.png',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) return;

      const isIncremental = await rem.hasPowerup(powerupCode);

      if (isIncremental) {
        await rem.removePowerup(powerupCode);
        // Removed setHighlightColor -> CSS handles cleanup when tag is removed
        await plugin.app.toast('❌ Removed Incremental tag');
      } else {
        await initIncrementalRem(plugin, rem);
        // Removed setHighlightColor -> CSS handles styling via "incremental" tag
        await plugin.app.toast('✅ Tagged as Incremental Rem');
        // Clear stale session storage to prevent race condition with widget context
        await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
        await plugin.widget.openPopup('priority_interval', {
          remId: rem._id,
        });
      }
    },
  });

  plugin.app.registerMenuItem({
    id: 'set_priority_document_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Set Priority',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        await plugin.app.toast('Could not find a Rem to set priority for.');
        return;
      }

      await plugin.storage.setSession('priorityPopupTargetRemId', undefined);

      await plugin.widget.openPopup('priority', {
        remId: rem._id,
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
    name: 'Batch Assign Card Priority for tagged/referencing Rems',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        await plugin.app.toast('Could not find the rem');
        return;
      }

      // Allow opening if this rem is used as a tag OR is referenced by other rems
      const [taggedRems, referencingRems] = await Promise.all([
        rem.taggedRem(),
        rem.remsReferencingThis(),
      ]);

      const hasTagged = taggedRems && taggedRems.length > 0;
      const hasReferencing = referencingRems && referencingRems.length > 0;

      if (!hasTagged && !hasReferencing) {
        await plugin.app.toast('No rems are tagged with or referencing this rem.');
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
    id: 'toggle-inc-rem-device',
    name: 'Toggle Inc Rems in this device',
    location: PluginCommandMenuLocation.QueueMenu,
    action: async () => {
      const isCurrentlyDisabled = await plugin.storage.getLocal<boolean>(incRemDisabledDeviceKey);
      const newState = !isCurrentlyDisabled;
      
      await plugin.storage.setLocal(incRemDisabledDeviceKey, newState);
      
      if (newState) {
        await plugin.app.toast('🚫 Incremental Rems disabled on this device.');
      } else {
        await plugin.app.toast('✅ Incremental Rems enabled on this device.');
      }

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
      console.log('[PDF Control Panel] Menu item clicked, resolving PDF rem...');
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) return;

      const pdfRem = await getActivePdfForIncRem(plugin, rem);
      if (!pdfRem) {
        await plugin.app.toast('No PDF found in this rem or its sources');
        return;
      }

      // Open the popup immediately with a partial context (no incrementalRemId yet).
      // The widget will resolve incrementalRemId itself using a fast cache-first path.
      console.log('[PDF Control Panel] Opening popup immediately with pdfRemId:', pdfRem._id);
      await plugin.storage.setSession('pageRangeContext', {
        pdfRemId: pdfRem._id,
        incrementalRemId: null,   // widget will fill this in
        totalPages: 0,
        currentPage: 1,
      });
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
