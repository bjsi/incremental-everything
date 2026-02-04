import {
  ReactRNPlugin,
  RNPlugin,
  SelectionType,
} from '@remnote/plugin-sdk';
import {
  powerupCode,
  nextRepCommandId,
  currentIncRemKey,
  pageRangeWidgetId,
  noIncRemTimerKey,
  alwaysUseLightModeOnMobileId,
  alwaysUseLightModeOnWebId,
  dismissedPowerupCode,
} from '../lib/consts';
import { initIncrementalRem } from './powerups';
import { getIncrementalRemFromRem, handleNextRepetitionClick, getCurrentIncrementalRem } from '../lib/incremental_rem';
import { findPDFinRem, safeRemTextToString } from '../lib/pdfUtils';
import {
  getOperatingSystem,
  getPlatform,
  isMobileDevice,
  isWebPlatform,
  shouldUseLightMode,
  getEffectivePerformanceMode,
  getFriendlyOSName,
  getFriendlyPlatformName,
  handleMobileDetectionOnStartup,
} from '../lib/mobileUtils';
import { handleQuickPriorityChange } from '../lib/quick_priority';
import {
  removeAllCardPriorityTags,
  updateAllCardPriorities,
} from '../lib/card_priority';
import { loadCardPriorityCache } from '../lib/card_priority/cache';
import { getPerformanceMode } from '../lib/utils';

export async function registerCommands(plugin: ReactRNPlugin) {
  const createExtract = async () => {
    const selection = await plugin.editor.getSelection();
    if (!selection) {
      return;
    }
    // TODO: extract within extract support
    if (selection.type === SelectionType.Text) {
      const focused = await plugin.focus.getFocusedRem();
      if (!focused) {
        return;
      }
      await initIncrementalRem(plugin, focused);
      return focused;
    } else if (selection.type === SelectionType.Rem) {
      const rems = (await plugin.rem.findMany(selection.remIds)) || [];
      await Promise.all(rems.map((rem) => initIncrementalRem(plugin, rem)));
    } else {
      const highlight = await plugin.reader.addHighlight();
      if (!highlight) {
        return;
      }
      await initIncrementalRem(plugin, highlight);
      return highlight;
    }
  };

  plugin.app.registerCommand({
    id: nextRepCommandId,
    name: 'Next Repetition',
    action: async () => {
      const rem = await getCurrentIncrementalRem(plugin);
      const url = await plugin.window.getURL();
      debugger;
      if (!rem || !url.includes('/flashcards')) {
        return;
      }
      const incRem = await getIncrementalRemFromRem(plugin, rem);
      if (!incRem) {
        return;
      }
      await handleNextRepetitionClick(plugin, incRem);
    },
  });

  await plugin.app.registerCommand({
    id: 'extract-with-priority',
    name: 'Extract with Priority',
    keyboardShortcut: 'opt+shift+x',
    action: async () => {
      const rem = await createExtract();
      if (!rem) {
        return;
      }
      // Clear stale session storage to prevent race condition with widget context
      await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
      await plugin.widget.openPopup('priority_light', {
        remId: rem._id,
      });
    },
  });

  plugin.app.registerCommand({
    id: 'set-priority',
    name: 'Set Priority',
    keyboardShortcut: 'opt+p',
    action: async () => {
      console.log('--- Set Priority Command Triggered ---');
      let remId: string | undefined;
      const url = await plugin.window.getURL();
      console.log('Current URL:', url);

      // Check if we are in the queue
      if (url.includes('/flashcards')) {
        console.log('In flashcards view.');
        // First, try to get the current native flashcard. This works for regular cards.
        const card = await plugin.queue.getCurrentCard();
        console.log('Result of getCurrentCard():', card);

        if (card) {
          remId = card.remId;
          console.log('Found native card. remId:', remId);
        } else {
          console.log('Not a native card. Checking session storage for incremental rem...');
          // If it's not a native card, it's our plugin's queue view.
          // The source of truth is the remId stored in session by queue.tsx.
          remId = await plugin.storage.getSession(currentIncRemKey);
          console.log('remId from session storage (currentIncRemKey):', remId);
        }
      } else {
        console.log('Not in flashcards view. Getting focused editor rem.');
        // If not in the queue, get the focused Rem from the editor
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
        console.log('Focused editor remId:', remId);
      }

      console.log('Final remId to be used:', remId);

      if (!remId) {
        console.log('Set Priority: No focused Rem or card in queue found. Aborting.');
        await plugin.app.toast('Could not find a Rem to set priority for.');
        return;
      }

      console.log(`Opening 'priority' popup for remId: ${remId}`);
      await plugin.widget.openPopup('priority', {
        remId: remId,
      });
    },
  });

  // NEW: Light Priority Command
  plugin.app.registerCommand({
    id: 'set-priority-light',
    name: 'Quick Set Priority',
    description: 'Instant popup to set Incremental and Card priorities',
    keyboardShortcut: 'ctrl+opt+p', // Shortcuts: Ctrl + Option + P
    action: async () => {
      let remId: string | undefined;
      const url = await plugin.window.getURL();

      // Context detection logic (Same as main command)
      if (url.includes('/flashcards')) {
        const card = await plugin.queue.getCurrentCard();
        if (card) {
          remId = card.remId;
        } else {
          remId = await plugin.storage.getSession(currentIncRemKey);
        }
      } else {
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
      }

      if (!remId) {
        await plugin.app.toast('No Rem found to set priority.');
        return;
      }

      // Clear stale session storage to prevent race condition with widget context
      await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
      await plugin.widget.openPopup('priority_light', {
        remId: remId,
      });
    },
  });

  plugin.app.registerCommand({
    id: 'reschedule-incremental',
    name: 'Reschedule Incremental Rem',
    keyboardShortcut: 'ctrl+j', // Will be Ctrl+J on Mac also!
    action: async () => {
      console.log('--- Reschedule Incremental Rem Command Triggered ---');
      let remId: string | undefined;
      const url = await plugin.window.getURL();
      console.log('Current URL:', url);

      // Check if we are in the queue
      if (url.includes('/flashcards')) {
        console.log('In flashcards view.');
        // First, try to get the current native flashcard
        const card = await plugin.queue.getCurrentCard();
        console.log('Result of getCurrentCard():', card);

        if (card) {
          remId = card.remId;
          console.log('Found native card. remId:', remId);
        } else {
          console.log('Not a native card. Checking session storage for incremental rem...');
          // If it's not a native card, it might be our plugin's queue view
          remId = await plugin.storage.getSession(currentIncRemKey);
          console.log('remId from session storage (currentIncRemKey):', remId);
        }
      } else {
        console.log('Not in flashcards view. Getting focused editor rem.');
        // If not in the queue, get the focused Rem from the editor
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
        console.log('Focused editor remId:', remId);
      }

      console.log('Final remId to be used:', remId);

      if (!remId) {
        console.log('Reschedule: No focused Rem or card in queue found. Aborting.');
        await plugin.app.toast('Could not find a Rem to reschedule.');
        return;
      }

      // Check if the Rem is an Incremental Rem
      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        console.log('Reschedule: PluginRem not found. Aborting.');
        await plugin.app.toast('Could not find the Rem.');
        return;
      }

      // Check if it has the Incremental powerup
      const hasIncrementalPowerup = await rem.hasPowerup(powerupCode);
      if (!hasIncrementalPowerup) {
        console.log('Reschedule: PluginRem is not tagged as Incremental. Aborting.');
        await plugin.app.toast('This command only works with Incremental Rems.');
        return;
      }

      // Verify it's actually an Incremental Rem with valid data
      const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
      if (!incRemInfo) {
        console.log('Reschedule: Could not get Incremental Rem info. Aborting.');
        await plugin.app.toast('Could not retrieve Incremental Rem information.');
        return;
      }

      // Determine context (queue vs editor) for event type
      const isQueue = url.includes('/flashcards');
      const context = isQueue ? 'queue' : 'editor';

      console.log(`Opening 'reschedule' popup for remId: ${remId}, context: ${context}`);
      await plugin.widget.openPopup('reschedule', {
        remId: remId,
        context: context,
      });
    },
  });

  plugin.app.registerCommand({
    id: 'batch-priority-change',
    name: 'Batch Priority Change',
    // keyboardShortcut: 'opt+shift+p', // Removed to avoid conflict/declutter
    action: async () => {
      const focusedRem = await plugin.focus.getFocusedRem();
      if (!focusedRem) {
        await plugin.app.toast('Please focus on a rem to perform batch priority changes');
        return;
      }

      // Store the focused rem ID in session for the popup to access
      await plugin.storage.setSession('batchPriorityFocusedRem', focusedRem._id);

      // Open the popup
      await plugin.widget.openPopup('batch_priority', {
        remId: focusedRem._id,
      });
    },
  });

  // Register command for batch card priority assignment
  plugin.app.registerCommand({
    id: 'batch-card-priority',
    name: 'Batch Assign Card Priority for tagged rems',
    keyboardShortcut: 'opt+shift+c',
    action: async () => {
      const focused = await plugin.focus.getFocusedRem();

      if (!focused) {
        await plugin.app.toast('Please focus on a tag rem first');
        return;
      }

      // Check if this rem is actually being used as a tag
      const taggedRems = await focused.taggedRem();
      if (!taggedRems || taggedRems.length === 0) {
        await plugin.app.toast('The focused rem is not used as a tag. No rems are tagged with it.');
        return;
      }

      // Store the tag rem ID in session storage
      await plugin.storage.setSession('batchCardPriorityTagRem', focused._id);

      // Open the batch card priority widget
      await plugin.widget.openPopup('batch_card_priority');
    },
  });

  plugin.app.registerCommand({
    id: 'pdf-control-panel',
    name: 'PDF Control Panel',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }

      // 1. Find the associated PDF Rem within the focused Rem or its descendants
      const pdfRem = await findPDFinRem(plugin, rem);

      // 2. If no PDF is found, inform the user and stop.
      if (!pdfRem) {
        await plugin.app.toast('No PDF found in the focused Rem or its children.');
        return;
      }

      // 3. Ensure the focused Rem is an incremental Rem, initializing it if necessary.
      if (!(await rem.hasPowerup(powerupCode))) {
        await initIncrementalRem(plugin, rem);
      }

      // 4. Prepare the context for the popup widget, similar to how the Reader does it.
      //    This context tells the popup which incremental Rem and which PDF to work with.
      const context = {
        incrementalRemId: rem._id,
        pdfRemId: pdfRem._id,
        totalPages: undefined, // Not available in the editor context
        currentPage: undefined, // Not available in the editor context
      };

      // 5. Store the context in session storage so the popup can access it.
      await plugin.storage.setSession('pageRangeContext', context);

      // 6. Open the popup widget.
      await plugin.widget.openPopup(pageRangeWidgetId, {
        remId: rem._id, // Pass remId for consistency, though the widget relies on session context.
      });
    },
  });

  plugin.app.registerCommand({
    id: 'incremental-everything',
    keyboardShortcut: 'opt+x',
    name: 'Incremental Everything',
    action: async () => {
      createExtract();
    },
  });

  plugin.app.registerCommand({
    id: 'untag-incremental-everything',
    name: 'Untag Incremental Everything',
    action: async () => {
      const selection = await plugin.editor.getSelection();
      if (!selection) {
        return;
      }
      if (selection.type === SelectionType.Text) {
        const focused = await plugin.focus.getFocusedRem();
        if (!focused) {
          return;
        }
        await focused.removePowerup(powerupCode);
      } else if (selection.type === SelectionType.Rem) {
        const rems = (await plugin.rem.findMany(selection.remIds)) || [];
        await Promise.all(rems.map((r) => r.removePowerup(powerupCode)));
      }
    },
  });
  plugin.app.registerCommand({
    id: 'debug-incremental-everything',
    name: 'Debug Incremental Everything',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }
      if (!(await rem.hasPowerup(powerupCode))) {
        return;
      }
      await plugin.widget.openPopup('debug', {
        remId: rem._id,
      });
    },
  });

  // Update the cancel command to use synced storage
  plugin.app.registerCommand({
    id: 'cancel-no-inc-rem-timer',
    name: 'Cancel No Inc Rem Timer',
    action: async () => {
      const timerEnd = await plugin.storage.getSynced<number>(noIncRemTimerKey);
      if (timerEnd && timerEnd > Date.now()) {
        await plugin.storage.setSynced(noIncRemTimerKey, null);
        await plugin.app.toast('Incremental rem timer cancelled. Normal queue behavior resumed.');
        // Force queue refresh
        await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
      } else {
        await plugin.app.toast('No active timer to cancel.');
      }
    },
  });

  // Register command to create priority review document
  plugin.app.registerCommand({
    id: 'create-priority-review',
    name: 'Create Priority Review Document',
    keyboardShortcut: 'opt+shift+r',
    action: async () => {
      const focused = await plugin.focus.getFocusedRem();

      await plugin.storage.setSession('reviewDocContext', {
        scopeRemId: focused?._id || null,
        scopeName: focused ? await safeRemTextToString(plugin, focused.text) : 'Full KB',
      });

      await plugin.widget.openPopup('review_document_creator');
    },
  });

  // Command to manually refresh the card priority cache ---
  plugin.app.registerCommand({
    id: 'refresh-card-priority-cache',
    name: 'Refresh Card Priority Cache',
    action: async () => {
      await loadCardPriorityCache(plugin);
    },
  });

  // Command to jump to rem by ID using a popup widget
  plugin.app.registerCommand({
    id: 'jump-to-rem-by-id',
    name: 'Jump to Rem by ID',
    action: async () => {
      // Open the popup widget for input
      await plugin.widget.openPopup('jump_to_rem_input');
    },
  });
  plugin.app.registerCommand({
    id: 'review-increm-in-editor',
    name: 'Execute Incremental Rem Repetition (Review in Editor)',
    keyboardShortcut: 'ctrl+shift+j',
    action: async () => {
      console.log('--- Review Incremental Rem in Editor Command Triggered ---');

      // Get focused Rem
      const focusedRem = await plugin.focus.getFocusedRem();
      if (!focusedRem) {
        await plugin.app.toast('No Rem focused');
        return;
      }

      // Check if it's an Incremental Rem
      const hasIncPowerup = await focusedRem.hasPowerup(powerupCode);
      if (!hasIncPowerup) {
        await plugin.app.toast('This Rem is not tagged as an Incremental Rem');
        return;
      }

      // Open the editor review popup
      await plugin.widget.openPopup('editor_review', {
        remId: focusedRem._id,
      });
    },
  });

  plugin.app.registerCommand({
    id: 'debug-video',
    name: 'Debug Video Detection',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        await plugin.app.toast('Please focus on a rem first');
        return;
      }
      await plugin.widget.openPopup('video_debug', {
        remId: rem._id,
      });
    },
  });

  // Pre-computation command
  await plugin.app.registerCommand({
    id: 'update-card-priorities',
    name: 'Update all inherited Card Priorities',
    description: 'Update all inherited Card Priorities (and pre-compute and tag all card not yet prioritized)',
    action: async () => {
      await updateAllCardPriorities(plugin);
    },
  });

  // Cleanup command
  await plugin.app.registerCommand({
    id: 'cleanup-card-priority',
    name: 'Remove All CardPriority Tags',
    description:
      'Completely remove all CardPriority powerup tags and data from your knowledge base',
    action: async () => {
      await removeAllCardPriorityTags(plugin);
    },
  });

  // Test console function availability (useful for debugging)
  await plugin.app.registerCommand({
    id: 'test-console-function',
    name: 'Test Console Function',
    description: 'Check if jumpToRemById() is available in console',
    action: async () => {
      // Check if function exists on window
      const isOnWindow = typeof (window as any).jumpToRemById === 'function';

      // Log detailed debugging info
      console.log('=== CONSOLE FUNCTION DEBUG ===');
      console.log('typeof (window as any).jumpToRemById:', typeof (window as any).jumpToRemById);
      console.log('typeof window.jumpToRemById:', typeof (window as any).jumpToRemById);
      console.log('Function defined on window:', isOnWindow);
      console.log('window object:', window);
      console.log('Top window === current window:', window === window.top);

      // Try to log the function itself
      if (isOnWindow) {
        console.log('Function reference:', (window as any).jumpToRemById);
      }

      // Check if we're in an iframe
      const inIframe = window !== window.top;
      if (inIframe) {
        console.warn('⚠️ Plugin is running in an iframe!');
        console.log('To use the function in console, you need to:');
        console.log('1. Open DevTools (F12)');
        console.log('2. Look for the context dropdown (usually says "top")');
        console.log('3. Select the RemNote iframe context');
        console.log("OR use: window.jumpToRemById('rem-id')");
      }

      console.log('==============================');

      if (isOnWindow) {
        await plugin.app.toast('✅ Function is defined. Check console for details.');
        console.log('✅ jumpToRemById() is available!');
        console.log("If you get 'not defined' error, try:");
        console.log("  window.jumpToRemById('your-rem-id-here')");
      } else {
        await plugin.app.toast('❌ jumpToRemById() is NOT available');
        console.error('❌ jumpToRemById() is NOT available');
        console.log('This might indicate the plugin needs to be rebuilt');
      }
    },
  });

  plugin.app.registerCommand({
    id: 'open-inc-rem-main-view',
    name: 'Open Incremental Rems Main View',
    keyboardShortcut: 'opt+shift+i',
    action: async () => {
      await plugin.widget.openPopup('inc_rem_main_view');
    },
  });

  plugin.app.registerCommand({
    id: 'test-mobile-detection',
    name: '🧪 Test Mobile & Platform Detection',
    action: async () => {
      // Get all the detection info
      const os = await getOperatingSystem(plugin);
      const platform = await getPlatform(plugin);
      const isMobile = await isMobileDevice(plugin);
      const isWeb = await isWebPlatform(plugin);
      const shouldLight = await shouldUseLightMode(plugin);
      const effective = await getEffectivePerformanceMode(plugin);

      // Get settings
      const setting = await getPerformanceMode(plugin);
      const autoSwitchMobile = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnMobileId);
      const autoSwitchWeb = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnWebId);

      // Get friendly names
      const friendlyOS = getFriendlyOSName(os);
      const friendlyPlatform = getFriendlyPlatformName(platform);

      // Log detailed info to console
      console.log('╔═══════════════════════════════════════════════╗');
      console.log('║   Mobile & Platform Detection Test Results   ║');
      console.log('╠═══════════════════════════════════════════════╣');
      console.log('║   ENVIRONMENT DETECTION:                        ║');
      console.log(`║   Operating System: ${friendlyOS.padEnd(26)} ║`);
      console.log(`║   Platform: ${friendlyPlatform.padEnd(32)} ║`);
      console.log(`║   Is Mobile Device: ${(isMobile ? 'Yes' : 'No').padEnd(26)} ║`);
      console.log(`║   Is Web Browser: ${(isWeb ? 'Yes' : 'No').padEnd(28)} ║`);
      console.log('║                                               ║');
      console.log('║ SETTINGS:                                     ║');
      console.log(`║   Performance Mode Setting: ${setting.padEnd(18)} ║`);
      console.log(
        `║   Auto Light on Mobile: ${(autoSwitchMobile !== false ? 'Enabled' : 'Disabled').padEnd(
          22
        )} ║`
      );
      console.log(
        `║   Auto Light on Web: ${(autoSwitchWeb !== false ? 'Enabled' : 'Disabled').padEnd(
          25
        )} ║`
      );
      console.log('║                                               ║');
      console.log('║ RESULT:                                       ║');
      console.log(`║   Should Use Light Mode: ${(shouldLight ? 'YES' : 'NO').padEnd(21)} ║`);
      console.log(`║   Effective Mode: ${effective.padEnd(26)} ║`);
      console.log('╚═══════════════════════════════════════════════╝');

      // Show concise toast
      await plugin.app.toast(
        `${isWeb ? '🌐' : isMobile ? '📱' : '💻'} ${friendlyPlatform} on ${friendlyOS} → ${effective.toUpperCase()} MODE`
      );

      // Optionally, trigger the full startup detection to see the startup toast
      console.log('\nRe-running startup detection...');
      await handleMobileDetectionOnStartup(plugin);
    },
  });

  // NEW: A robust command to open the priority popup that survives widget closure
  plugin.app.registerCommand({
    id: 'force-open-priority',
    name: 'Force Open Priority Popup',
    action: async (args: { remId: string }) => {
      // Small safety delay to ensure previous UI operations (like closing parent selector) have settled
      await new Promise(resolve => setTimeout(resolve, 50));

      if (args && args.remId) {
        // Clear stale session storage to prevent race condition with widget context
        await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
        await plugin.widget.openPopup('priority_light', {
          remId: args.remId,
        });
      }
    },
  });

  // NEW: Quick Priority Shortcuts
  plugin.app.registerCommand({
    id: 'quick-increase-priority',
    name: 'Quick Increase Priority Number (Less Important)',
    description: 'Increases the priority number by the step size (default 10), making it LESS important.',
    keyboardShortcut: 'ctrl+opt+up',
    action: async () => {
      await handleQuickPriorityChange(plugin, 'increase');
    },
  });

  plugin.app.registerCommand({
    id: 'quick-decrease-priority',
    name: 'Quick Decrease Priority Number (More Important)',
    description: 'Decreases the priority number by the step size (default 10), making it MORE important.',
    keyboardShortcut: 'ctrl+opt+down',
    action: async () => {
      await handleQuickPriorityChange(plugin, 'decrease');
    },
  });

  // Open Repetition History command
  plugin.app.registerCommand({
    id: 'open-repetition-history',
    name: 'Open IncRem Repetition History',
    keyboardShortcut: 'ctrl+shift+h',
    action: async () => {
      let remId: string | undefined;
      const url = await plugin.window.getURL();

      // Check if we are in the queue
      if (url.includes('/flashcards')) {
        // First, try to get the current native flashcard
        const card = await plugin.queue.getCurrentCard();
        if (card) {
          remId = card.remId;
        } else {
          // If it's not a native card, it might be our plugin's queue view
          remId = await plugin.storage.getSession(currentIncRemKey);
        }
      } else {
        // If not in the queue, get the focused Rem from the editor
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
      }

      if (!remId) {
        await plugin.app.toast('Could not find a Rem.');
        return;
      }

      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        await plugin.app.toast('Could not find the Rem.');
        return;
      }

      // Check if it has either the Incremental powerup OR the dismissed powerup
      const hasIncrementalPowerup = await rem.hasPowerup(powerupCode);
      const hasDismissedPowerup = await rem.hasPowerup(dismissedPowerupCode);

      if (hasIncrementalPowerup || hasDismissedPowerup) {
        // If it is directly an incremental/dismissed rem, open the single history widget
        await plugin.widget.openPopup('repetition_history', {
          remId: remId,
        });
        return;
      }

      // If not directly incremental, check if it has any incremental descendants
      // We'll use a quick check on getDescendants. This might be heavy for huge trees, 
      // but necessary to know if we should show the aggregated view.
      // Optimization: We could check just one? `getDescendants` returns all.
      const descendants = await rem.getDescendants();
      const hasRelevantDescendant = await Promise.race([
        (async () => {
          for (const d of descendants) {
            if (await d.hasPowerup(powerupCode)) return true;
            if (await d.hasPowerup(dismissedPowerupCode)) return true;
          }
          return false;
        })()
      ]);

      if (hasRelevantDescendant) {
        // If it has relevant descendants, default to aggregated view
        await plugin.widget.openPopup('aggregated_repetition_history', {
          remId: remId,
        });
        return;
      }

      await plugin.app.toast('This Rem has no repetition history (not Incremental/Dismissed and no such descendants).');
    },
  });
}
