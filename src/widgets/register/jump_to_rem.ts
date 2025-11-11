import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { jumpToRemById } from '../../lib/remHelpers';

/**
 * Registers the jumpToRemById helper function globally on the window object
 * for easy access from the browser console during development.
 */
export function registerJumpToRemHelper(plugin: ReactRNPlugin) {
  // Expose the function globally with plugin context captured
  (window as any).jumpToRemById = (remId: string) => jumpToRemById(plugin, remId);

  // Print usage instructions
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
  console.log("   • Example: jumpToRemById('abc123xyz')");
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}
