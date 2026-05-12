import { declareIndexPlugin, ReactRNPlugin } from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import { allCardPriorityInfoKey } from '../lib/consts';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { handleMobileDetectionOnStartup, shouldUseLightMode } from '../lib/mobileUtils';
import { loadCardPriorityCache } from '../lib/card_priority/cache';
import { registerEventListeners } from '../register/events';
import { registerPluginPowerups } from '../register/powerups';
import { registerPluginSettings } from '../register/settings';
import { registerWidgets } from '../register/widgets';
import { registerMenus } from '../register/menus';
import { registerCommands } from '../register/commands';
import { registerCallbacks, resetSessionItemCounter } from '../register/callbacks';
import {
  registerCoreQueueDisplayPowerups,
  registerHideInQueueLegacyPowerups,
} from '../register/queue_display_powerups';
import {
  registerCoreQueueDisplayCommands,
  registerHideInQueueLegacyCommands,
} from '../register/queue_display_commands';
import { enableHideInQueueIntegrationId } from '../lib/consts';
import { registerIncrementalRemTracker } from '../register/tracker';
import { cleanupOrphanedReviewGraphs } from '../lib/priority_review_document/cleanup';
import { registerJumpToRemHelper } from '../register/window';
import { registerPluginHidingCSS, registerPdfHighlightCSS, registerClozeExtractCSS } from '../lib/ui_helpers';

async function onActivate(plugin: ReactRNPlugin) {
  //Debug
  console.log('🚀 INCREMENTAL EVERYTHING onActivate CALLED');
  console.log('Plugin type:', typeof plugin);
  console.log('Plugin methods:', Object.keys(plugin));
  console.log('Plugin.app methods:', Object.keys(plugin.app));
  console.log('Plugin.storage methods:', Object.keys(plugin.storage));

  (window as any).__plugin = plugin;
  registerJumpToRemHelper(plugin);


  await registerPluginPowerups(plugin);
  // Core queue display powerups (Remove Parent / Remove Grandparent) are
  // always registered — the Cloze and Extract creators apply Remove Parent to
  // newly-created rems. These powerup codes don't exist in the standalone
  // Hide in Queue plugin, so they cannot collide with it.
  await registerCoreQueueDisplayPowerups(plugin);
  await registerPluginSettings(plugin);

  // Hide-in-Queue legacy powerups (Hide in Queue, Remove from Queue, etc.) and
  // their commands are gated by a setting. They share powerup codes with the
  // standalone Hide in Queue plugin — registering both at once causes RemNote
  // to throw "Duplicated powerup" and aborts plugin loading. The user must
  // uninstall the standalone plugin first, then enable this setting.
  const enableHideInQueueIntegration =
    (await plugin.settings.getSetting<boolean>(enableHideInQueueIntegrationId)) ?? false;
  if (enableHideInQueueIntegration) {
    await registerHideInQueueLegacyPowerups(plugin);
  }

  registerEventListeners(plugin, resetSessionItemCounter);

  registerIncrementalRemTracker(plugin);

  // Fire-and-forget: clear synced graph-data entries whose Priority Review
  // Document graph Rem was deleted. Errors are logged inside the helper and
  // must not block activation.
  void cleanupOrphanedReviewGraphs(plugin);

  registerCallbacks(plugin);
  await registerWidgets(plugin);

  // Register CSS rules
  await registerPdfHighlightCSS(plugin);
  await registerPluginHidingCSS(plugin);
  await registerClozeExtractCSS(plugin);

  await registerCommands(plugin);

  // Remove Parent / Remove Grandparent commands are always available — they
  // wrap powerups that are always registered and don't conflict with anything.
  await registerCoreQueueDisplayCommands(plugin);

  // Hide-in-Queue legacy commands gated on the same setting as the legacy
  // powerups above (must be in lockstep — registering commands without their
  // backing powerups would surface no-op commands to the user).
  if (enableHideInQueueIntegration) {
    await registerHideInQueueLegacyCommands(plugin);
  }

  await registerMenus(plugin);

  // Mobile and Web Browser Light Mode Features
  await handleMobileDetectionOnStartup(plugin);

  // Get the performance mode
  const useLightMode = await shouldUseLightMode(plugin);
  if (!useLightMode) {
    // Run the full, expensive cache build
    loadCardPriorityCache(plugin);

  } else {
    // In 'light' mode, just set an empty cache.
    console.log('CACHE: Light mode enabled. Skipping card priority cache build.');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
  }
}

async function onDeactivate(_: ReactRNPlugin) { }

declareIndexPlugin(onActivate, onDeactivate);
