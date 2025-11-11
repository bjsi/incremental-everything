import { declareIndexPlugin, ReactRNPlugin } from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import { allCardPriorityInfoKey } from '../lib/consts';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { handleMobileDetectionOnStartup, shouldUseLightMode } from '../lib/mobileUtils';
import { cacheAllCardPriorities } from '../lib/cardPriority';
import { registerEventListeners } from './register/events';
import { registerPluginPowerups, initIncrementalRem } from './register/powerups';
import { registerPluginSettings } from './register/settings';
import { registerWidgets } from './register/widgets';
import { registerMenus } from './register/menus';
import { registerCommands } from './register/commands';
import { registerCallbacks, resetSessionItemCounter } from './register/callbacks';
import { registerIncrementalRemTracker } from './register/tracker';
import { registerJumpToRemHelper } from './register/window';
dayjs.extend(relativeTime);

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
  await registerPluginSettings(plugin);

  registerEventListeners(plugin, resetSessionItemCounter);

  registerIncrementalRemTracker(plugin);

  registerCallbacks(plugin);
  registerWidgets(plugin);

  await registerCommands(plugin);
  await registerMenus(plugin);

  // Mobile and Web Browser Light Mode Features
  await handleMobileDetectionOnStartup(plugin);

  // Get the performance mode
  const useLightMode = await shouldUseLightMode(plugin);
  if (!useLightMode) {
    // Run the full, expensive cache build
    cacheAllCardPriorities(plugin);
  } else {
    // In 'light' mode, just set an empty cache.
    console.log('CACHE: Light mode enabled. Skipping card priority cache build.');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
  }
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
