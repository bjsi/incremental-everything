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
import { registerIncrementalRemTracker } from '../register/tracker';
import { registerJumpToRemHelper } from '../register/window';
import { registerQueueHidingCSS, registerPdfHighlightCSS } from '../lib/ui_helpers';
import { refreshAllPriorityGraphs } from '../lib/priority_graph_data';

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

  // Register CSS rules
  await registerPdfHighlightCSS(plugin);
  await registerQueueHidingCSS(plugin);

  await registerCommands(plugin);
  await registerMenus(plugin);

  // Mobile and Web Browser Light Mode Features
  await handleMobileDetectionOnStartup(plugin);

  // Get the performance mode
  const useLightMode = await shouldUseLightMode(plugin);
  if (!useLightMode) {
    // Run the full, expensive cache build
    loadCardPriorityCache(plugin);

    // Refresh all priority distribution graphs AFTER the card priority cache is fully loaded.
    // loadCardPriorityCache sets 'card_priority_cache_fully_loaded' to true when done.
    const waitForCacheThenRefreshGraphs = async () => {
      const pollInterval = 10_000; // Check every 10 seconds
      const maxWait = 15 * 60_000; // Give up after 15 minutes
      const startTime = Date.now();

      const poll = async () => {
        const isLoaded = await plugin.storage.getSession<boolean>('card_priority_cache_fully_loaded');
        if (isLoaded) {
          console.log('[PriorityGraph] Card priority cache loaded. Starting graph refresh...');
          await refreshAllPriorityGraphs(plugin);
        } else if (Date.now() - startTime < maxWait) {
          setTimeout(poll, pollInterval);
        } else {
          console.warn('[PriorityGraph] Timed out waiting for card priority cache. Skipping graph refresh.');
        }
      };

      // Start polling after an initial delay to let startup settle
      setTimeout(poll, pollInterval);
    };
    waitForCacheThenRefreshGraphs();
  } else {
    // In 'light' mode, just set an empty cache.
    console.log('CACHE: Light mode enabled. Skipping card priority cache build.');
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
  }
}

async function onDeactivate(_: ReactRNPlugin) { }

declareIndexPlugin(onActivate, onDeactivate);
