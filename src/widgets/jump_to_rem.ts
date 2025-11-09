import { ReactRNPlugin } from '@remnote/plugin-sdk';

export function registerJumpToRemHelper(plugin: ReactRNPlugin) {
  const jumpToRemByIdFunction = async (remId: string) => {
    if (!remId || typeof remId !== 'string' || remId.trim() === '') {
      console.error('❌ Invalid RemId provided');
      console.log("Usage: jumpToRemById('your-rem-id-here')");
      console.log("Example: jumpToRemById('abc123xyz')");
      return;
    }

    try {
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
      const preview = textPreview.length > 100 ? `${textPreview.substring(0, 100)}...` : textPreview;

      console.log(`✅ Found rem: "${preview}"`);
      console.log('📍 Opening rem in RemNote...');
      await plugin.window.openRem(rem);
    } catch (error) {
      console.error('❌ Error finding rem:', error);
      console.log('💡 Try reloading the plugin if this error persists.');
    }
  };

  (window as any).jumpToRemById = jumpToRemByIdFunction;

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
  console.log("   • Usage: jumpToRemById('your-rem-id-here')");
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log("   Usage: jumpToRemById('your-rem-id-here')");
  console.log("   Example: jumpToRemById('abc123xyz')");
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}
