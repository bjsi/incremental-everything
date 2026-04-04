import {
  ReactRNPlugin,
  RNPlugin,
  SelectionType,
  PluginRem,
  BuiltInPowerupCodes,
} from '@remnote/plugin-sdk';
import {
  powerupCode,
  currentIncRemKey,
  pageRangeWidgetId,
  noIncRemTimerKey,
  alwaysUseLightModeOnMobileId,
  alwaysUseLightModeOnWebId,
  dismissedPowerupCode,
  currentSubQueueIdKey,
  dismissIncRemCommandId,
  nextInQueueCommandId,
  currentIncrementalRemTypeKey,
  incremReviewStartTimeKey,
} from '../lib/consts';
import { initIncrementalRem } from './powerups';
import { getIncrementalRemFromRem, handleNextRepetitionClick, getCurrentIncrementalRem } from '../lib/incremental_rem';
import { removeIncrementalRemCache } from '../lib/incremental_rem/cache';
import { IncrementalRep } from '../lib/incremental_rem/types';
import { findPDFinRem, safeRemTextToString, getCurrentPageKey, addPageToHistory, registerRemsAsPdfKnown } from '../lib/pdfUtils';
import { transferToDismissed } from '../lib/dismissed';
import { handleCardPriorityInheritance } from '../lib/card_priority/card_priority_inheritance';
import dayjs from 'dayjs';
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
import { handleReviewInEditorRem } from '../lib/review_actions';

export async function registerCommands(plugin: ReactRNPlugin) {
  const createExtract = async (): Promise<PluginRem | PluginRem[] | undefined> => {
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
      // Single outer flag bracket for the entire batch — each initIncrementalRem
      // skips its own flag management so the flag stays UP for the whole loop.
      await plugin.storage.setSession('plugin_operation_active', true);
      try {
        for (const rem of rems) {
          await initIncrementalRem(plugin, rem, { skipFlagManagement: true });
        }
      } finally {
        // Don't clear the flag — each initIncrementalRem fires pendingInheritanceCascade,
        // and the cascade tracker will clear the flag when the cascade completes.
        // Only clear defensively if no rems were processed (e.g., empty selection).
        if (rems.length === 0) {
          await plugin.storage.setSession('plugin_operation_active', false);
        }
      }
      return rems;
    } else {
      const highlight = await plugin.reader.addHighlight();
      if (!highlight) {
        return;
      }
      await initIncrementalRem(plugin, highlight);
      return highlight;
    }
  };



  await plugin.app.registerCommand({
    id: 'extract-with-priority',
    name: 'Extract with Priority',
    keyboardShortcut: 'opt+shift+x',
    action: async () => {
      const result = await createExtract();
      if (!result) {
        return;
      }
      // Clear stale session storage to prevent race condition with widget context
      await plugin.storage.setSession('priorityPopupTargetRemId', undefined);

      if (Array.isArray(result)) {
        // Multi-rem selection: store all remIds for the popup to apply in batch
        const remIds = result.map(r => r._id);
        if (remIds.length === 0) return;
        await plugin.storage.setSession('batchPriorityIntervalRemIds', remIds);
        await plugin.widget.openPopup('priority_interval', {
          remId: remIds[0], // First rem as reference for defaults
          batchMode: true,
        });
      } else {
        // Single rem
        await plugin.storage.setSession('batchPriorityIntervalRemIds', null);
        await plugin.widget.openPopup('priority_interval', {
          remId: result._id,
        });
      }
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

      // Check if we are in the queue AND targeting the flashcard explicitly
      if (url.includes('/flashcards')) {
        console.log('In flashcards view.');
        const currentQueueItem = await plugin.queue.getCurrentCard();
        const sel = await plugin.editor.getSelection();
        const selType = sel?.type;

        let isTargetingQueueContext = false;

        // If no editor selection, we assume queue context
        if (!selType) {
          isTargetingQueueContext = true;
        } else if (currentQueueItem) { // We have a native card AND a selection
          if (selType === SelectionType.Rem && sel.remIds.includes(currentQueueItem.remId)) {
            isTargetingQueueContext = true;
          } else if (selType === SelectionType.Text && sel.remId === currentQueueItem.remId) {
            isTargetingQueueContext = true;
          }
        } else {
          // No current native card, maybe our Incremental Rem view
          const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
          if (currentIncRemId) {
            if (selType === SelectionType.Rem && sel.remIds.includes(currentIncRemId)) {
              isTargetingQueueContext = true;
            } else if (selType === SelectionType.Text && sel.remId === currentIncRemId) {
              isTargetingQueueContext = true;
            }
          }
        }

        if (isTargetingQueueContext) {
          if (currentQueueItem) {
            remId = currentQueueItem.remId;
            console.log('Found native card. remId:', remId);
          } else {
            console.log('Not a native card. Checking session storage for incremental rem...');
            remId = await plugin.storage.getSession<string>(currentIncRemKey) || undefined;
            console.log('remId from session storage (currentIncRemKey):', remId);
          }
        } else {
          console.log('In flashcards view, but explicit selection detected. Using selection.');
          if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
            remId = (sel as any).remIds[0];
          } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
            remId = (sel as any).remId;
          }
        }
      } else {
        console.log('Not in flashcards view. Getting focused editor rem.');
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
      const tCmd = performance.now();
      console.log('[set-priority-light] Command triggered');
      let remId: string | undefined;
      const url = await plugin.window.getURL();

      // Context detection logic (Same as main command)
      if (url.includes('/flashcards')) {
        const currentQueueItem = await plugin.queue.getCurrentCard();
        const sel = await plugin.editor.getSelection();
        const selType = sel?.type;

        let isTargetingQueueContext = false;

        if (!selType) {
          isTargetingQueueContext = true;
        } else if (currentQueueItem) {
          if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(currentQueueItem.remId)) {
            isTargetingQueueContext = true;
          } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === currentQueueItem.remId) {
            isTargetingQueueContext = true;
          }
        } else {
          const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
          if (currentIncRemId) {
            if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(currentIncRemId)) {
              isTargetingQueueContext = true;
            } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === currentIncRemId) {
              isTargetingQueueContext = true;
            }
          }
        }

        if (isTargetingQueueContext) {
          if (currentQueueItem) {
            remId = currentQueueItem.remId;
          } else {
            remId = await plugin.storage.getSession<string>(currentIncRemKey) || undefined;
          }
        } else {
          if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
            remId = sel.remIds[0];
          } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
            remId = sel.remId;
          }
        }
      } else {
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
      }

      console.log(`[set-priority-light] context detection done: ${Math.round(performance.now() - tCmd)}ms, remId: ${remId}`);

      if (!remId) {
        await plugin.app.toast('No Rem found to set priority.');
        return;
      }

      // Clear stale session storage to prevent race condition with widget context
      await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
      console.log(`[set-priority-light] session cleared: ${Math.round(performance.now() - tCmd)}ms`);

      await plugin.widget.openPopup('priority_light', {
        remId: remId,
      });
      console.log(`[set-priority-light] openPopup returned: ${Math.round(performance.now() - tCmd)}ms`);
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

      let isTargetingQueueContext = false;

      // Check if we are in the queue AND targeting the flashcard explicitly
      if (url.includes('/flashcards')) {
        console.log('In flashcards view.');
        const currentQueueItem = await plugin.queue.getCurrentCard();
        console.log('Result of getCurrentCard():', currentQueueItem);
        const sel = await plugin.editor.getSelection();
        const selType = sel?.type;

        // If no editor selection, we assume queue context
        if (!selType) {
          isTargetingQueueContext = true;
        } else if (currentQueueItem) { // We have a native card AND a selection
          if (selType === SelectionType.Rem && sel.remIds.includes(currentQueueItem.remId)) {
            isTargetingQueueContext = true;
          } else if (selType === SelectionType.Text && sel.remId === currentQueueItem.remId) {
            isTargetingQueueContext = true;
          }
        } else {
          // No current native card, maybe our Incremental Rem view
          const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
          if (currentIncRemId) {
            if (selType === SelectionType.Rem && sel.remIds.includes(currentIncRemId)) {
              isTargetingQueueContext = true;
            } else if (selType === SelectionType.Text && sel.remId === currentIncRemId) {
              isTargetingQueueContext = true;
            }
          }
        }

        if (isTargetingQueueContext) {
          if (currentQueueItem) {
            remId = currentQueueItem.remId;
            console.log('Found native card. remId:', remId);
          } else {
            console.log('Not a native card. Checking session storage for incremental rem...');
            remId = await plugin.storage.getSession<string>(currentIncRemKey) || undefined;
            console.log('remId from session storage (currentIncRemKey):', remId);
          }
        } else {
          console.log('In flashcards view, but explicit selection detected. Using selection.');
          if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
            remId = (sel as any).remIds[0];
          } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
            remId = (sel as any).remId;
          }
        }
      } else {
        console.log('Not in flashcards view. Getting focused editor rem.');
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
      const context = (isQueue && isTargetingQueueContext) ? 'queue' : 'editor';

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
    name: 'Batch Assign Card Priority for tagged/referencing rems',
    keyboardShortcut: 'opt+shift+c',
    action: async () => {
      const focused = await plugin.focus.getFocusedRem();

      if (!focused) {
        await plugin.app.toast('Please focus on a rem first');
        return;
      }

      // Allow opening if this rem is used as a tag OR is referenced by other rems
      const [taggedRems, referencingRems] = await Promise.all([
        focused.taggedRem(),
        focused.remsReferencingThis(),
      ]);

      const hasTagged = taggedRems && taggedRems.length > 0;
      const hasReferencing = referencingRems && referencingRems.length > 0;

      if (!hasTagged && !hasReferencing) {
        await plugin.app.toast('No rems are tagged with or referencing this rem.');
        return;
      }

      // Store the anchor rem ID in session storage
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
    name: 'Review in Editor (Execute Repetition)',
    keyboardShortcut: 'ctrl+shift+j',
    action: async () => {
      console.log('--- Review Incremental Rem in Editor Command Triggered ---');

      const url = await plugin.window.getURL();
      const isQueue = url && url.includes('/flashcards');

      if (isQueue) {
        // Queue context behavior
        const currentQueueItem = await plugin.queue.getCurrentCard();
        let remId = currentQueueItem?.remId;

        if (!remId) {
          // If the SDK doesn't report an active card (because it's an IncRem or document), fall back to session storage
          remId = (await plugin.storage.getSession<string>(currentIncRemKey)) || undefined;
          console.log('review-increm-in-editor: remId from session storage (currentIncRemKey):', remId);
        }

        if (!remId) {
          await plugin.app.toast('No card or Incremental Rem currently active in the queue.');
          return;
        }

        const rem = await plugin.rem.findOne(remId);
        if (!rem) return;

        const hasIncPowerup = await rem.hasPowerup(powerupCode);
        if (!hasIncPowerup) {
          await plugin.app.toast('Current card is not an Incremental Rem.');
          return;
        }

        // Delegate to exact function used by "Review in Editor"
        await handleReviewInEditorRem(plugin, rem, null);
      } else {
        // Editor context behavior
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
      }
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
    action: async () => {
      // Small safety delay to ensure previous UI operations (like closing parent selector) have settled
      await new Promise(resolve => setTimeout(resolve, 50));

      // Try reading remId from a custom session key if invoked programmatically
      let remId = await plugin.storage.getSession<string>('forceOpenPriorityTargetRemId');

      // Fallback: look for focused rem or queue card if no session key provided
      if (!remId) {
        const url = await plugin.window.getURL();
        if (url.includes('/flashcards')) {
          const card = await plugin.queue.getCurrentCard();
          if (card) {
            remId = card.remId;
          } else {
            remId = (await plugin.storage.getSession<string>(currentIncRemKey)) || undefined;
          }
        } else {
          const focusedRem = await plugin.focus.getFocusedRem();
          remId = focusedRem?._id;
        }
      }

      if (remId) {
        // Clear stale session storage to prevent race condition with widget context
        await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
        await plugin.storage.setSession('forceOpenPriorityTargetRemId', undefined); // Clear the argument
        await plugin.widget.openPopup('priority_interval', {
          remId: remId,
        });
      } else {
        await plugin.app.toast('No Rem found to open priority popup for.');
      }
    },
  });

  // NEW: Quick Priority Shortcuts
  // Module-level counter to confirm how many times RemNote actually fires the command.
  // Open DevTools → Console and filter by '[QuickPriority]' to count invocations.
  let _quickPriorityCallCount = 0;

  plugin.app.registerCommand({
    id: 'quick-increase-priority',
    name: 'Quick Increase Priority Number (Less Important)',
    description: 'Increases the priority number by the step size (default 10), making it LESS important.',
    keyboardShortcut: 'ctrl+opt+up',
    action: async () => {
      console.log(`[QuickPriority] #${++_quickPriorityCallCount} increase fired at ${Date.now()}`);
      await handleQuickPriorityChange(plugin, 'increase');
    },
  });

  plugin.app.registerCommand({
    id: 'quick-decrease-priority',
    name: 'Quick Decrease Priority Number (More Important)',
    description: 'Decreases the priority number by the step size (default 10), making it MORE important.',
    keyboardShortcut: 'ctrl+opt+down',
    action: async () => {
      console.log(`[QuickPriority] #${++_quickPriorityCallCount} decrease fired at ${Date.now()}`);
      await handleQuickPriorityChange(plugin, 'decrease');
    },
  });

  // Open Repetition History command
  plugin.app.registerCommand({
    id: 'open-repetition-history',
    name: 'Open Repetition History',
    keyboardShortcut: 'ctrl+shift+h',
    action: async () => {
      let remId: string | undefined;
      let cardId: string | undefined;
      const url = await plugin.window.getURL();
      const isQueue = url.includes('/flashcards');

      // Check if we are in the queue AND explicitly targeting the card
      if (isQueue) {
        const card = await plugin.queue.getCurrentCard();
        const sel = await plugin.editor.getSelection();
        const selType = sel?.type;

        // Use Selection-Aware targeting identical to setting priority
        let isTargetingQueueContext = false;

        if (!selType) {
          isTargetingQueueContext = true;
        } else if (card) {
          if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(card.remId)) {
            isTargetingQueueContext = true;
          } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === card.remId) {
            isTargetingQueueContext = true;
          }
        } else {
          const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
          if (currentIncRemId) {
            if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(currentIncRemId)) {
              isTargetingQueueContext = true;
            } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === currentIncRemId) {
              isTargetingQueueContext = true;
            }
          }
        }

        if (isTargetingQueueContext) {
          if (card) {
            remId = card.remId;
            cardId = card._id;
          } else {
            remId = await plugin.storage.getSession<string>(currentIncRemKey) || undefined;
          }
        } else {
          // Explicitly focused on another editor element (like in Preview)
          if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
            remId = (sel as any).remIds[0];
          } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
            remId = (sel as any).remId;
          }
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

      const hasIncrementalPowerup = await rem.hasPowerup(powerupCode);
      const hasDismissedPowerup = await rem.hasPowerup(dismissedPowerupCode);

      // If we are in the queue reviewing a regular flashcard (not an Incremental Rem)
      if (isQueue && !hasIncrementalPowerup) {
        await plugin.widget.openPopup('flashcard_repetition_history', {
          remId: remId,
          cardId: cardId,
        });
        return;
      }

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

  // Open Sorting Criteria Widget Command
  plugin.app.registerCommand({
    id: 'open-sorting-criteria',
    name: 'Open Sorting Criteria',
    description: 'Open the Sorting Criteria widget to adjust randomness and cards per rem.',
    action: async () => {
      await plugin.widget.openPopup('sorting_criteria');
    },
  });

  // Open Priority Shield Graph Command
  plugin.app.registerCommand({
    id: 'open-priority-shield',
    name: 'Open Priority Shield Graph',
    description: 'Open the Priority Shield Graph history.',
    action: async () => {
      let subQueueId: string | null = null;
      const url = await plugin.window.getURL();

      // Check if we are in the queue to get context
      if (url.includes('/flashcards')) {
        subQueueId = (await plugin.storage.getSession<string | null>(currentSubQueueIdKey)) ?? null;
      } else {
        // In editor, use focused rem
        const focusedRem = await plugin.focus.getFocusedRem();
        subQueueId = focusedRem?._id || null;
      }

      await plugin.widget.openPopup('priority_shield_graph', {
        subQueueId,
      });
    },
  });

  // Dismiss Incremental Rem command (Ctrl+D)
  // In Queue: replicates the Dismiss button (card priority inheritance, review time, transfer to dismissed, remove powerup)
  // In Editor: dismisses the focused Incremental Rem (transfer history to dismissed, remove powerup)
  plugin.app.registerCommand({
    id: dismissIncRemCommandId,
    name: 'Dismiss Incremental Rem',
    keyboardShortcut: 'ctrl+d',
    action: async () => {
      const url = await plugin.window.getURL();
      const isQueue = url && url.includes('/flashcards');

      let rem;
      let incRemInfo;

      if (isQueue) {
        // Queue context: check for explicit selection first
        const card = await plugin.queue.getCurrentCard();
        const sel = await plugin.editor.getSelection();
        const selType = sel?.type;

        let isTargetingQueueContext = false;

        if (!selType) {
          isTargetingQueueContext = true;
        } else if (card) {
          if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(card.remId)) {
            isTargetingQueueContext = true;
          } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === card.remId) {
            isTargetingQueueContext = true;
          }
        } else {
          const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
          if (currentIncRemId) {
            if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(currentIncRemId)) {
              isTargetingQueueContext = true;
            } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === currentIncRemId) {
              isTargetingQueueContext = true;
            }
          }
        }

        let remId: string | undefined;

        if (isTargetingQueueContext) {
          if (card) {
            remId = card.remId;
          } else {
            remId = (await plugin.storage.getSession<string>(currentIncRemKey)) || undefined;
          }
        } else {
          if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
            remId = (sel as any).remIds[0];
          } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
            remId = (sel as any).remId;
          }
        }

        if (!remId) {
          await plugin.app.toast('No Incremental Rem currently active in the queue or selected.');
          return;
        }

        rem = await plugin.rem.findOne(remId);
        if (!rem) {
          await plugin.app.toast('Could not find the Rem.');
          return;
        }

        const hasIncPowerup = await rem.hasPowerup(powerupCode);
        if (!hasIncPowerup) {
          await plugin.app.toast('This command only works with Incremental Rems, not regular flashcards.');
          return;
        }

        incRemInfo = await getIncrementalRemFromRem(plugin, rem);
        if (!incRemInfo) {
          await plugin.app.toast('Could not retrieve Incremental Rem information.');
          return;
        }

        // Replicate the Dismiss button logic from answer_buttons.tsx
        // 1. Handle card priority inheritance
        await handleCardPriorityInheritance(plugin, rem, incRemInfo);

        // 2. Calculate review time
        const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
        const reviewTimeSeconds = startTime ? dayjs().diff(dayjs(startTime), 'second') : 0;

        // 3. Build the current rep history entry
        const currentRep: IncrementalRep = {
          date: Date.now(),
          scheduled: incRemInfo.nextRepDate,
          reviewTimeSeconds: reviewTimeSeconds,
          eventType: 'rep',
          priority: incRemInfo.priority,
        };

        const updatedHistory = [...(incRemInfo.history || []), currentRep];

        // 4. Transfer history to dismissed powerup
        await transferToDismissed(plugin, rem, updatedHistory);

        // 5. Remove from session cache
        await removeIncrementalRemCache(plugin, rem._id);

        // 6. Remove incremental powerup AND conditionally advance queue simultaneously.
        // removePowerup destroys the widget sandbox on the next microtask,
        // so both IPC messages must be sent in the same tick if targeting queue.
        if (isTargetingQueueContext) {
          await Promise.allSettled([
            rem.removePowerup(powerupCode),
            plugin.queue.removeCurrentCardFromQueue(true),
          ]);
        } else {
          await rem.removePowerup(powerupCode);
        }

      } else {
        // Editor context: dismiss focused Incremental Rem(s)
        // Supports both single-focus and multi-select
        const selection = await plugin.editor.getSelection();
        const remsToDissmiss: PluginRem[] = [];

        if (selection?.type === SelectionType.Rem) {
          // Multi-select: gather all selected rems
          const selectedRems = (await plugin.rem.findMany(selection.remIds)) || [];
          for (const r of selectedRems) {
            if (await r.hasPowerup(powerupCode)) {
              remsToDissmiss.push(r);
            }
          }
        } else {
          // Single focus fallback
          const focusedRem = await plugin.focus.getFocusedRem();
          if (!focusedRem) {
            await plugin.app.toast('No Rem focused.');
            return;
          }
          const hasIncPowerup = await focusedRem.hasPowerup(powerupCode);
          if (!hasIncPowerup) {
            await plugin.app.toast('This Rem is not an Incremental Rem.');
            return;
          }
          remsToDissmiss.push(focusedRem);
        }

        if (remsToDissmiss.length === 0) {
          await plugin.app.toast('No Incremental Rems found in the selection.');
          return;
        }

        for (const r of remsToDissmiss) {
          incRemInfo = await getIncrementalRemFromRem(plugin, r);
          if (incRemInfo) {
            // Transfer existing history to dismissed (no new rep entry needed)
            await transferToDismissed(plugin, r, incRemInfo.history || []);
          }
          // Remove from session cache
          await removeIncrementalRemCache(plugin, r._id);
          // Remove incremental powerup
          await r.removePowerup(powerupCode);
        }

        const count = remsToDissmiss.length;
        await plugin.app.toast(
          count === 1
            ? 'Incremental Rem dismissed.'
            : `${count} Incremental Rems dismissed.`
        );
      }
    },
  });

  // Next item in the queue command (Ctrl+Right Arrow)
  // Only works in the queue with an Incremental Rem active.
  // Replicates the Next button logic: PDF page history + handleNextRepetitionClick.
  plugin.app.registerCommand({
    id: nextInQueueCommandId,
    name: 'Next Item in Queue',
    keyboardShortcut: 'cmd+right',
    action: async () => {
      const url = await plugin.window.getURL();

      if (!url || !url.includes('/flashcards')) {
        await plugin.app.toast('This command only works in the queue.');
        return;
      }

      // Get current incremental rem
      const currentQueueItem = await plugin.queue.getCurrentCard();
      let remId = currentQueueItem?.remId;

      if (!remId) {
        remId = (await plugin.storage.getSession<string>(currentIncRemKey)) || undefined;
      }

      if (!remId) {
        await plugin.app.toast('No Incremental Rem currently active in the queue.');
        return;
      }

      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        await plugin.app.toast('Could not find the Rem.');
        return;
      }

      const hasIncPowerup = await rem.hasPowerup(powerupCode);
      if (!hasIncPowerup) {
        await plugin.app.toast('This command only works with Incremental Rems, not regular flashcards.');
        return;
      }

      const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
      if (!incRemInfo) {
        await plugin.app.toast('Could not retrieve Incremental Rem information.');
        return;
      }

      // Handle PDF page history (same as handleNextClick in answer_buttons.tsx)
      const remType = await plugin.storage.getSession<string | null>(currentIncrementalRemTypeKey);
      if (remType === 'pdf') {
        const pdfRem = await findPDFinRem(plugin, rem);
        if (pdfRem) {
          const pageKey = getCurrentPageKey(rem._id, pdfRem._id);
          const currentPage = await plugin.storage.getSynced<number>(pageKey);
          if (currentPage) {
            await addPageToHistory(plugin, rem._id, pdfRem._id, currentPage);
          }
        }
      }

      // Advance the queue (updates SRS data + removes current card)
      await handleNextRepetitionClick(plugin, incRemInfo);
    },
  });

  // ─── Copy / Paste Rem Sources ────────────────────────────────────────────
  // Designed for the PDF-split workflow: give multiple IncRems the same PDF
  // source so the page-range widget can assign each rem a different page range.
  //
  //   1. Focus the "template" rem (the one whose sources you want to replicate).
  //   2. Run "Copy Rem Sources" → source IDs are saved to session storage.
  //   3. Select one or more target rems.
  //   4. Run "Paste Rem Sources" → every selected rem receives all copied sources
  //      (already-present sources are silently skipped to keep it idempotent).

  const COPIED_SOURCES_KEY = 'copiedRemSourceIds';

  plugin.app.registerCommand({
    id: 'copy-rem-sources',
    name: 'Copy Rem Sources',
    description: 'Copies the sources of the focused Rem to the clipboard (session storage) for pasting onto other Rems.',
    keyboardShortcut: 'ctrl+shift+F1',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        await plugin.app.toast('No Rem focused.');
        return;
      }

      const sources = await rem.getSources();
      if (!sources || sources.length === 0) {
        await plugin.app.toast('This Rem has no sources to copy.');
        return;
      }

      const sourceIds = sources.map(s => s._id);
      await plugin.storage.setSession(COPIED_SOURCES_KEY, sourceIds);

      // Register the focused rem in the known_pdf_rems_ index for each PDF source,
      // so the template rem itself is discoverable by the PDF Control Panel.
      for (const source of sources) {
        const isPdf = await source.hasPowerup(BuiltInPowerupCodes.UploadedFile);
        if (isPdf) {
          await registerRemsAsPdfKnown(plugin, source._id, [rem._id]);
        }
      }

      await plugin.app.toast(
        sources.length === 1
          ? '📋 1 source copied. Select target Rems and run "Paste Rem Sources".'
          : `📋 ${sources.length} sources copied. Select target Rems and run "Paste Rem Sources".`
      );
    },
  });

  plugin.app.registerCommand({
    id: 'paste-rem-sources',
    name: 'Paste Rem Sources',
    description: 'Adds the previously copied sources to all selected Rems (or the focused Rem). Skips sources already present.',
    keyboardShortcut: 'opt+shift+v',
    action: async () => {
      const copiedIds = await plugin.storage.getSession<string[]>(COPIED_SOURCES_KEY);
      if (!copiedIds || copiedIds.length === 0) {
        await plugin.app.toast('No sources copied yet. Run "Copy Rem Sources" first.');
        return;
      }

      // Resolve the copied source RemObjects once (shared across all targets)
      const copiedSources = (await plugin.rem.findMany(copiedIds)) || [];
      if (copiedSources.length === 0) {
        await plugin.app.toast('Could not resolve the copied sources. They may have been deleted.');
        return;
      }

      // Determine target rems: multi-select → all selected; otherwise → focused rem
      const selection = await plugin.editor.getSelection();
      let targetRems: PluginRem[] = [];

      if (selection?.type === SelectionType.Rem && selection.remIds.length > 0) {
        targetRems = (await plugin.rem.findMany(selection.remIds)) || [];
      } else {
        const focused = await plugin.focus.getFocusedRem();
        if (!focused) {
          await plugin.app.toast('No Rem focused or selected.');
          return;
        }
        targetRems = [focused];
      }

      if (targetRems.length === 0) {
        await plugin.app.toast('Could not resolve target Rems.');
        return;
      }

      let totalAdded = 0;
      let totalSkipped = 0;

      for (const target of targetRems) {
        const existingSources = await target.getSources();
        const existingIds = new Set(existingSources.map(s => s._id));

        for (const source of copiedSources) {
          if (existingIds.has(source._id)) {
            totalSkipped++;
            continue;
          }
          await target.addSource(source);
          totalAdded++;

          // If the added source is a PDF, register this target rem in the
          // known_pdf_rems_ synced index so it appears in the PDF Control Panel
          // without needing a full incremental-rem-cache scan first.
          const isPdf = await source.hasPowerup(BuiltInPowerupCodes.UploadedFile);
          if (isPdf) {
            await registerRemsAsPdfKnown(plugin, source._id, [target._id]);
          }
        }
      }

      const remLabel = targetRems.length === 1 ? '1 Rem' : `${targetRems.length} Rems`;
      if (totalAdded === 0) {
        await plugin.app.toast(`✅ All sources already present on ${remLabel}.`);
      } else {
        const skippedNote = totalSkipped > 0 ? ` (${totalSkipped} already present, skipped)` : '';
        await plugin.app.toast(`✅ Added ${totalAdded} source(s) to ${remLabel}${skippedNote}.`);
      }
    },
  });
}
