import { RNPlugin } from '@remnote/plugin-sdk';
import type { PaneRemWindowTree, RemIdWindowTree } from '@remnote/plugin-sdk/dist/interfaces';
import { pendingScrollRequestKey } from './consts';

export interface PendingScrollRequest {
  hostRemId: string;
  highlightRemId: string;
  requestedAt: number;
}

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
 * Polls until the given rem is open in some pane, or until `timeoutMs` elapses.
 * Returns true when the pane appears, false on timeout.
 *
 * Intended to bridge the gap between `openRemInNewPane` resolving (the SDK
 * has registered the new pane) and the native reader inside that pane being
 * mounted enough to accept commands like `scrollToReaderHighlight`.
 */
export const waitForPaneOpen = async (
  plugin: RNPlugin,
  targetRemId: string,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<boolean> => {
  const start = Date.now();
  let polls = 0;
  while (Date.now() - start < timeoutMs) {
    polls++;
    try {
      const openRemIds = await plugin.window.getOpenPaneRemIds();
      if (openRemIds.includes(targetRemId)) {
        console.log(`[waitForPaneOpen] Pane appeared after ${Date.now() - start}ms (${polls} polls)`);
        return true;
      }
    } catch (e) {
      console.warn(`[waitForPaneOpen] poll #${polls} threw:`, e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.warn(`[waitForPaneOpen] Timed out after ${timeoutMs}ms (${polls} polls) waiting for ${targetRemId}`);
  return false;
};

/**
 * Open a PDF/HTML host rem and reliably scroll to a saved highlight inside it,
 * regardless of whether the doc is currently open (warm) or closed (cold).
 *
 * Cold-open path: PDF.js / the native reader has to mount and parse before
 * `scrollToReaderHighlight` will do anything. We poll until the pane appears,
 * then attempt the scroll twice — once after a grace period for the reader
 * to boot, and a safety retry for slow large PDFs. Both attempts are
 * idempotent (re-anchor at the same highlight).
 */
/**
 * Trigger an open-and-scroll-to-highlight from a widget context. Writes a
 * pending-scroll record to session storage, then opens the host pane. The
 * actual polling and scrolling is handled by the main-process listener in
 * `register/callbacks.ts`, because the widget's iframe is destroyed by the
 * pane layout reorganization and any setTimeouts/awaits in it are killed.
 */
export const openAndScrollToHighlight = async (
  plugin: RNPlugin,
  hostRemId: string,
  highlightRemId: string
): Promise<void> => {
  const tag = `[openAndScrollToHighlight ${highlightRemId.slice(0, 6)}]`;

  // Warm vs. cold detection: if the host is already open in some pane,
  // openRemInNewPane will only refocus (no layout reorg), so the widget
  // iframe survives and we can scroll inline. If cold, the pane reorg
  // will kill this iframe — stash the request and let the main-process
  // listener finish the work.
  let isWarmOpen = false;
  try {
    const openRemIds = await plugin.window.getOpenPaneRemIds();
    isWarmOpen = openRemIds.includes(hostRemId);
  } catch (e) {
    console.warn(`${tag} could not query open panes, treating as cold:`, e);
  }

  if (isWarmOpen) {
    console.log(`${tag} warm path — focusing existing pane and scrolling inline`);
    const bookmarkRem = await plugin.rem.findOne(highlightRemId);
    await openRemInNewPane(plugin, hostRemId); // just focuses the existing pane
    setTimeout(() => {
      console.log(`${tag} warm scroll firing`);
      try {
        bookmarkRem?.scrollToReaderHighlight();
      } catch (e) {
        console.error(`${tag} warm scroll threw:`, e);
      }
    }, 400);
    return;
  }

  console.log(`${tag} cold path — stashing pending scroll, opening pane`);
  const request: PendingScrollRequest = {
    hostRemId,
    highlightRemId,
    requestedAt: Date.now(),
  };
  await plugin.storage.setSession(pendingScrollRequestKey, request);

  await openRemInNewPane(plugin, hostRemId);
  console.log(`${tag} openRemInNewPane resolved — main-process listener will finish the scroll`);
};

/**
 * Drain a pending scroll request and execute the open+wait+scroll flow. Must
 * be called from the main-process context (e.g. inside a registered event
 * listener) so that the polling and setTimeouts survive the widget layout
 * reorganization that triggered the request.
 */
export const consumePendingScrollRequest = async (
  plugin: RNPlugin
): Promise<boolean> => {
  const request = await plugin.storage.getSession<PendingScrollRequest>(pendingScrollRequestKey);
  if (!request) return false;

  // Stale safety: ignore requests older than 30s (e.g. user closed the app).
  if (Date.now() - request.requestedAt > 30_000) {
    await plugin.storage.setSession(pendingScrollRequestKey, undefined);
    return false;
  }

  // Clear immediately so concurrent listener firings don't double-process.
  await plugin.storage.setSession(pendingScrollRequestKey, undefined);

  const { hostRemId, highlightRemId } = request;
  const tag = `[consumePendingScroll ${highlightRemId.slice(0, 6)}]`;
  console.log(`${tag} processing — host=${hostRemId.slice(0, 6)}`);

  const bookmarkRem = await plugin.rem.findOne(highlightRemId);
  if (!bookmarkRem) {
    console.warn(`${tag} highlight rem not found, aborting`);
    return true;
  }

  // Wait for the SDK to surface the new pane, then give PDF.js / the native
  // reader enough time to mount before issuing scroll commands.
  const paneOpened = await waitForPaneOpen(plugin, hostRemId);
  if (!paneOpened) {
    console.warn(`${tag} pane never opened, best-effort scroll`);
    try {
      bookmarkRem.scrollToReaderHighlight();
    } catch (e) {
      console.error(`${tag} fallback scroll threw:`, e);
    }
    return true;
  }

  console.log(`${tag} pane open confirmed — scheduling scrolls at 1500ms, 3500ms, 6000ms`);
  setTimeout(() => {
    console.log(`${tag} scroll attempt #1 firing`);
    try {
      bookmarkRem.scrollToReaderHighlight();
    } catch (e) {
      console.error(`${tag} scroll #1 threw:`, e);
    }
  }, 1500);
  setTimeout(() => {
    console.log(`${tag} scroll attempt #2 firing`);
    try {
      bookmarkRem.scrollToReaderHighlight();
    } catch (e) {
      console.error(`${tag} scroll #2 threw:`, e);
    }
  }, 3500);
  setTimeout(() => {
    console.log(`${tag} scroll attempt #3 firing`);
    try {
      bookmarkRem.scrollToReaderHighlight();
    } catch (e) {
      console.error(`${tag} scroll #3 threw:`, e);
    }
  }, 6000);

  return true;
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
