import { PluginCommandMenuLocation, ReactRNPlugin } from '@remnote/plugin-sdk';
import { openDocumentHub, openQueueHub } from '../lib/menu_hub_actions';

// RemNote lists plugin menu items flat after its own entries and can't nest
// them (findings/PLUGIN_BRIDGE_AND_SDK.md, "Commands and UI"). So each menu
// gets one item, which opens the Menu Hub: a floating panel, placed under the
// menu's button, that lists the plugin's actions for it (widgets/menu_hub.tsx;
// the actions are in lib/menu_hub_actions.ts).
export async function registerMenus(plugin: ReactRNPlugin) {
  plugin.app.registerMenuItem({
    id: 'menu_hub_document_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Incremental RemNote…',
    action: async (args: { remId: string }) => openDocumentHub(plugin, args.remId),
  });

  plugin.app.registerMenuItem({
    id: 'menu_hub_queue_menuitem',
    location: PluginCommandMenuLocation.QueueMenu,
    name: 'Incremental RemNote…',
    action: async (args: { remId?: string }) => openQueueHub(plugin, args?.remId),
  });
}
