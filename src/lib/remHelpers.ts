import { RNPlugin } from '@remnote/plugin-sdk';
import type { PaneRemWindowTree, RemIdWindowTree } from '@remnote/plugin-sdk/dist/interfaces';

/**
 * Open a rem in a separate pane to the right of the current layout, or focus
 * the existing pane if one already shows that rem. Preserves whatever the user
 * has in the current pane (e.g. the IncRem they were viewing in the editor).
 *
 * Uses the SDK's window-tree API: getCurrentWindowTree → strip paneIds → wrap
 * as {direction:'row', first: existing, second: new remId} → setRemWindowTree.
 */
export const openRemInNewPane = async (
  plugin: RNPlugin,
  remId: string
): Promise<void> => {
  // If the rem is already open in some pane, just focus that pane.
  try {
    const openRemIds = await plugin.window.getOpenPaneRemIds();
    if (openRemIds.includes(remId)) {
      const paneIds = await plugin.window.getOpenPaneIds();
      for (const paneId of paneIds) {
        const paneRemId = await plugin.window.getOpenPaneRemId(paneId);
        if (paneRemId === remId) {
          await plugin.window.setFocusedPaneId(paneId);
          return;
        }
      }
    }
  } catch (e) {
    // Fall through to split-pane creation if querying fails.
    console.warn('[openRemInNewPane] Pre-check failed, will split:', e);
  }

  const currentTree = await plugin.window.getCurrentWindowTree();

  const stripPaneIds = (node: PaneRemWindowTree): RemIdWindowTree => {
    if ('remId' in node && 'paneId' in node) {
      return (node as any).remId;
    }
    const parent = node as any;
    return {
      direction: parent.direction,
      first: stripPaneIds(parent.first),
      second: stripPaneIds(parent.second),
      splitPercentage: parent.splitPercentage,
    };
  };

  const existing = stripPaneIds(currentTree);
  const newTree: RemIdWindowTree = {
    direction: 'row',
    first: existing,
    second: remId,
    splitPercentage: 50,
  };
  await plugin.window.setRemWindowTree(newTree);
};

/**
 * Jumps to a specific Rem by its ID, opening it in RemNote.
 * Useful for debugging and development.
 *
 * @param plugin - The RemNote plugin instance
 * @param remId - The ID of the Rem to navigate to
 * @returns Promise that resolves when navigation is complete, or rejects if the Rem is not found
 */
export const jumpToRemById = async (plugin: RNPlugin, remId: string): Promise<void> => {
  const trimmedId = typeof remId === 'string' ? remId.trim() : '';

  if (!trimmedId) {
    console.error('❌ Invalid RemId provided');
    console.log("Usage: jumpToRemById('your-rem-id-here')");
    console.log("Example: jumpToRemById('abc123xyz')");
    throw new Error('Invalid RemId provided');
  }

  console.log(`🔍 Searching for rem: ${trimmedId}...`);
  const rem = await plugin.rem.findOne(trimmedId);

  if (!rem) {
    console.error(`❌ Rem not found: ${remId}`);
    console.log('💡 Possible reasons:');
    console.log('   • The rem was deleted');
    console.log('   • The RemId is incorrect');
    console.log('   • The rem is from a different knowledge base');
    throw new Error(`Rem not found: ${remId}`);
  }

  const remText = await rem.text;
  const textPreview = remText
    ? (typeof remText === 'string' ? remText : '[Complex content]')
    : '[No text]';
  const preview = textPreview.length > 100
    ? `${textPreview.substring(0, 100)}...`
    : textPreview;

  console.log(`✅ Found rem: "${preview}"`);
  console.log('📍 Opening rem in RemNote...');
  await plugin.window.openRem(rem);
};
