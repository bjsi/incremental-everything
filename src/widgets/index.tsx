import { declareIndexPlugin, ReactRNPlugin } from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import { allCardPriorityInfoKey } from '../lib/consts';
import { 
  handleMobileDetectionOnStartup,
  shouldUseLightMode,
} from '../lib/mobileUtils';
import {
  registerQueueExitListener,
  registerQueueEnterListener,
  registerURLChangeListener,
  registerQueueCompleteCardListener,
  registerGlobalRemChangedListener,
} from './events';
import { registerPluginPowerups } from './powerups';
import { registerPluginSettings } from './settings';
import { jumpToRemById } from './jump_to_rem_input';
import { registerPluginCommands } from './commands';
import { registerWidgets } from './widgets';
import { registerMenuItems } from './menu_items';
import { registerIncrementalRemTracker } from './tracker';
import { registerGetNextCardCallback, resetQueueSessionItemCounter } from './queue_logic';
import { cacheAllCardPriorities } from '../lib/cache';

async function onActivate(plugin: ReactRNPlugin) {
  //Debug
  console.log('🚀 INCREMENTAL EVERYTHING onActivate CALLED');
  console.log('Plugin type:', typeof plugin);
  console.log('Plugin methods:', Object.keys(plugin));
  console.log('Plugin.app methods:', Object.keys(plugin.app));
  console.log('Plugin.storage methods:', Object.keys(plugin.storage));

  // Store plugin reference globally for helper functions
  (window as any).__plugin = plugin;

  // Define console helper function (works only within plugin's iframe context)
  // For easier access, use the "Jump to Rem by ID" plugin command instead (Ctrl+P)
  const jumpToRemByIdFunction = async function(remId: string) {
    try {
      await jumpToRemById(remId);
    } catch (error) {
      console.error('❌ Error finding rem:', error);
      console.log('💡 Try reloading the plugin if this error persists.');
    }
  };

  // Attach to window object (works only in iframe context)
  (window as any).jumpToRemById = jumpToRemByIdFunction;

  // Log availability information
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💡 Jump to Rem by ID - Available Methods:');
  console.log('');
  console.log('   RECOMMENDED: Use plugin command');
  console.log('   • Press Ctrl+/ (or Cmd+/)');
  console.log('   • Type: "Jump to Rem by ID"');
  console.log('   • Enter your RemId');
  console.log('');
  console.log('   ADVANCED: Console function (iframe context only)');
  console.log('   • Only works if console context is set to plugin iframe');
  console.log('   • Usage: jumpToRemById(\'your-rem-id-here\')');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   Usage: jumpToRemById(\'your-rem-id-here\')');
  console.log('   Example: jumpToRemById(\'abc123xyz\')');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Register all plugin components
  await registerPluginPowerups(plugin);
  await registerPluginSettings(plugin);
  await registerWidgets(plugin);
  await registerPluginCommands(plugin);
  await registerMenuItems(plugin);

  registerQueueExitListener(plugin, resetQueueSessionItemCounter);

  registerQueueEnterListener(plugin, resetQueueSessionItemCounter);

  registerURLChangeListener(plugin);
  registerQueueCompleteCardListener(plugin);
  registerGlobalRemChangedListener(plugin);

  registerIncrementalRemTracker(plugin);
  registerGetNextCardCallback(plugin);

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
