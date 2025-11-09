import { declareIndexPlugin, ReactRNPlugin } from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import { allCardPriorityInfoKey } from '../lib/consts';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { handleMobileDetectionOnStartup, shouldUseLightMode } from '../lib/mobileUtils';
import { cacheAllCardPriorities } from '../lib/cardPriority';
import {
  registerQueueExitListener,
  registerQueueEnterListener,
  registerURLChangeListener,
  registerQueueCompleteCardListener,
  registerGlobalRemChangedListener,
} from './events';
import { registerPluginPowerups, initIncrementalRem } from './powerups';
import { registerPluginSettings } from './settings';
import { registerWidgets } from './widgets';
import { registerMenus } from './menus';
import { registerCommands } from './commands';
import { registerCallbacks, resetSessionItemCounter } from './callbacks';
import { registerIncrementalRemTracker } from './tracker';
import { registerJumpToRemHelper } from './jumpToRem';
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

  registerQueueExitListener(plugin, () => {
    resetSessionItemCounter();
  });

  registerQueueEnterListener(plugin, () => {
    resetSessionItemCounter();
  });

  registerURLChangeListener(plugin);
  registerQueueCompleteCardListener(plugin);
  registerGlobalRemChangedListener(plugin);


  registerIncrementalRemTracker(plugin);

  registerCallbacks(plugin);
  registerWidgets(plugin);

  await registerCommands(plugin);
  await registerMenus(plugin);


  // Mobile and Web Browser Light Mode Features
  await handleMobileDetectionOnStartup(plugin);
  console.log('Mobile detection completed');




  // Run the cache build in the background without blocking plugin initialization.

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
