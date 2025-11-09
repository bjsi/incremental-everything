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
dayjs.extend(relativeTime);

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
    if (!remId || typeof remId !== 'string' || remId.trim() === '') {
      console.error('❌ Invalid RemId provided');
      console.log('Usage: jumpToRemById(\'your-rem-id-here\')');
      console.log('Example: jumpToRemById(\'abc123xyz\')');
      return;
    }
    
    try {
      const plugin = (window as any).__plugin;
      if (!plugin) {
        console.error('❌ Plugin not found. Make sure the Incremental Everything plugin is loaded.');
        console.log('Try reloading the plugin from RemNote Settings → Plugins');
        return;
      }
      
      console.log(`🔍 Searching for rem: ${remId}...`);
      const rem = await plugin.rem.findOne(remId.trim());
      
      if (!rem) {
        console.error(`❌ Rem not found: ${remId}`);
        console.log('💡 Possible reasons:');
        console.log('   • The rem was deleted');
        console.log('   • The RemId is incorrect');
        console.log('   • The rem is from a different knowledge base');
        return;
      }
      
      const remText = await rem.text;
      const textPreview = remText ? (typeof remText === 'string' ? remText : '[Complex content]') : '[No text]';
      const preview = textPreview.length > 100 ? textPreview.substring(0, 100) + '...' : textPreview;
      
      console.log(`✅ Found rem: "${preview}"`);
      console.log('📍 Opening rem in RemNote...');
      await plugin.window.openRem(rem);
      
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
