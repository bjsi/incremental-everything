import { RNPlugin } from '@remnote/plugin-sdk';

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
