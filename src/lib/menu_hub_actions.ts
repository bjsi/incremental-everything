import { PaneRemWindowTree, ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import {
  powerupCode,
  pageRangeWidgetId,
  cardEnablementAnchorKey,
  currentSubQueueIdKey,
  noIncRemTimerKey,
  incRemDisabledDeviceKey,
  menuHubWidgetId,
  menuHubTargetKey,
  menuHubActiveIdKey,
  menuHubAnchorPosition,
} from './consts';
import { safeRemTextToString, getActivePdfForIncRem, getAllPDFsInRem } from './pdfUtils';
import { initIncrementalRem } from './incremental_rem';
import { confirmNoDuplicateSource } from './duplicate_source';
import { markRemsAsFreshlyCreated } from './incRemHelpers';
import { playBranch, playTagged } from './audio_playlist';

// The actions of the Document menu ("…" at the top right of a document) and
// the Queue menu. RemNote lists plugin menu items flat and can't nest them
// (findings/PLUGIN_BRIDGE_AND_SDK.md, "Commands and UI"), so each menu has a
// single "Incremental RemNote…" item that opens the Menu Hub floating widget
// (widgets/menu_hub.tsx), which lists these.

type Plugin = RNPlugin | ReactRNPlugin;

export async function toggleIncrementalRem(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;

  if (await rem.hasPowerup(powerupCode)) {
    await rem.removePowerup(powerupCode);
    // CSS handles the styling cleanup when the tag is removed.
    await plugin.app.toast('❌ Removed Incremental tag');
    return;
  }
  if (!(await confirmNoDuplicateSource(plugin as ReactRNPlugin, [rem])).length) return;
  await initIncrementalRem(plugin as ReactRNPlugin, rem);
  await plugin.app.toast('✅ Tagged as Incremental Rem');
  // Clear stale session storage to prevent a race with the widget context.
  await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
  await markRemsAsFreshlyCreated(plugin as ReactRNPlugin, [rem._id]);
  await plugin.widget.openPopup('priority_interval', { remId: rem._id });
}

export async function openSetPriority(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) {
    await plugin.app.toast('Could not find a Rem to set priority for.');
    return;
  }
  await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
  await plugin.widget.openPopup('priority', { remId: rem._id });
}

export async function openBatchPriority(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;
  await plugin.storage.setSession('batchPriorityFocusedRem', remId);
  await plugin.widget.openPopup('batch_priority', { remId });
}

export async function openBatchCardPriority(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) {
    await plugin.app.toast('Could not find the rem');
    return;
  }
  // Allow opening if this rem is used as a tag OR is referenced by other rems.
  const [taggedRems, referencingRems] = await Promise.all([
    rem.taggedRem(),
    rem.remsReferencingThis(),
  ]);
  if (!taggedRems?.length && !referencingRems?.length) {
    await plugin.app.toast('No rems are tagged with or referencing this rem.');
    return;
  }
  await plugin.storage.setSession('batchCardPriorityTagRem', rem._id);
  await plugin.widget.openPopup('batch_card_priority');
}

/** The document's audios as one playlist (lib/audio_playlist.ts). */
export async function openAudioPlaylist(plugin: Plugin, remId: string) {
  await playBranch(plugin, remId);
}

/** The audios of every rem tagged with this document, for a tag's own page. */
export async function openTaggedAudioPlaylist(plugin: Plugin, remId: string) {
  await playTagged(plugin, remId);
}

export async function openCardEnablementAudit(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) {
    await plugin.app.toast('Could not find the rem');
    return;
  }
  await plugin.storage.setSession(cardEnablementAnchorKey, rem._id);
  await plugin.widget.openPopup('card_enablement_audit');
}

export async function openPriorityShieldHistory(plugin: Plugin, remId: string) {
  // From a document, the document IS the scope (subQueueId).
  await plugin.widget.openPopup('priority_shield_graph', { subQueueId: remId });
}

export async function openPriorityQueue(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;
  await plugin.storage.setSession('reviewDocContext', {
    scopeRemId: rem._id,
    scopeName: await safeRemTextToString(plugin as ReactRNPlugin, rem.text),
  });
  await plugin.widget.openPopup('priority_queue_popup');
}

export async function openPdfControlPanel(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;

  const pdfRem = await getActivePdfForIncRem(plugin as ReactRNPlugin, rem);
  if (!pdfRem) {
    await plugin.app.toast('No PDF found in this rem or its sources');
    return;
  }

  // From an IncRem document (rather than the PDF itself), pass the IncRem id.
  // Otherwise the widget falls back to findIncrementalRemForPDFFast, which
  // returns the *first* IncRem on that PDF — the wrong one when a book's
  // chapters all share the textbook. Pre-filling allPdfRemIds also lets the
  // PDF selector render at once.
  const isIncRem = await rem.hasPowerup(powerupCode);
  await plugin.storage.setSession('pageRangeContext', {
    pdfRemId: pdfRem._id,
    incrementalRemId: isIncRem ? rem._id : null, // null only from a non-IncRem doc
    totalPages: 0,
    currentPage: 1,
    allPdfRemIds: isIncRem
      ? (await getAllPDFsInRem(plugin as ReactRNPlugin, rem)).map((p) => p.rem._id)
      : undefined,
  });
  await plugin.storage.setSession('pageRangePopupOpen', true);
  await plugin.widget.openPopup(pageRangeWidgetId);
}

/** The Study Dashboard in Document mode on this document. */
export async function openDocumentStudyDashboard(plugin: Plugin, remId: string) {
  await plugin.widget.openPopup('study_dashboard', { remId, startInDocument: true });
}

// ── Queue menu ──────────────────────────────────────────────────────────────
// These act on the queue being practised, whose scope the queue widget keeps
// in currentSubQueueIdKey (null for the whole knowledge base).

export async function openSortingCriteria(plugin: Plugin) {
  await plugin.widget.openPopup('sorting_criteria');
}

export async function openQueueShieldHistory(plugin: Plugin) {
  const subQueueId = await plugin.storage.getSession<string | null>(currentSubQueueIdKey);
  await plugin.widget.openPopup('priority_shield_graph', { subQueueId });
}

export async function openQueuePriorityQueue(plugin: Plugin) {
  const subQueueId = await plugin.storage.getSession<string>(currentSubQueueIdKey);
  if (subQueueId) {
    const rem = await plugin.rem.findOne(subQueueId);
    await plugin.storage.setSession('reviewDocContext', {
      scopeRemId: subQueueId,
      scopeName: rem ? await safeRemTextToString(plugin as ReactRNPlugin, rem.text) : 'Queue Scope',
    });
  } else {
    await plugin.storage.setSession('reviewDocContext', { scopeRemId: null, scopeName: 'Full KB' });
  }
  await plugin.widget.openPopup('priority_queue_popup');
}

/**
 * The Study Dashboard on the queue's scope, in Document mode. A whole-KB queue
 * has no scope: Global mode, with the current card as the Rem to switch to,
 * as the Open Study Dashboard command does.
 */
export async function openQueueStudyDashboard(plugin: Plugin, cardRemId?: string) {
  const subQueueId = await plugin.storage.getSession<string | null>(currentSubQueueIdKey);
  if (subQueueId) {
    await plugin.widget.openPopup('study_dashboard', { remId: subQueueId, startInDocument: true });
  } else {
    await plugin.widget.openPopup('study_dashboard', cardRemId ? { remId: cardRemId } : undefined);
  }
}

export async function pauseIncRemsFor15Min(plugin: Plugin) {
  const currentTimer = await plugin.storage.getSynced<number>(noIncRemTimerKey);
  if (currentTimer && currentTimer > Date.now()) {
    const remainingMinutes = Math.ceil((currentTimer - Date.now()) / 60000);
    await plugin.app.toast(`Timer already active: ${remainingMinutes} minutes remaining`);
    return;
  }
  await plugin.storage.setSynced(noIncRemTimerKey, Date.now() + 15 * 60 * 1000);
  await plugin.app.toast('Incremental rems disabled for 15 minutes. Only flashcards will be shown.');
  await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
}

export async function toggleIncRemsOnThisDevice(plugin: Plugin) {
  const disable = !(await plugin.storage.getLocal<boolean>(incRemDisabledDeviceKey));
  await plugin.storage.setLocal(incRemDisabledDeviceKey, disable);
  await plugin.app.toast(
    disable ? '🚫 Incremental Rems disabled on this device.' : '✅ Incremental Rems enabled on this device.'
  );
  await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
}

// ── The hub ─────────────────────────────────────────────────────────────────

/**
 * What the hub shows: the document actions for a Rem, or the queue actions.
 * `source` says who set it: a menu item (the hub moves to that menu and takes
 * the keyboard) or the hub following the focused pane (it does neither).
 */
export type MenuHubTarget = {
  mode: 'document' | 'queue';
  remId?: string;
  at: number;
  source: 'menu' | 'pane';
};

/** From the Document menu: the hub on that document, under its "…" button. */
export async function openDocumentHub(plugin: Plugin, remId: string) {
  const paneId = await paneShowing(plugin, remId);
  const pane = paneId ? `.pane-id-${CSS.escape(paneId)}` : null;
  await openMenuHub(
    plugin,
    { mode: 'document', remId },
    { button: pane ? `${pane} .rn-doc-header__rem-options-btn` : null, pane }
  );
}

/** From the Queue menu: the hub's queue actions, under the queue's menu button. */
export async function openQueueHub(plugin: Plugin, cardRemId?: string) {
  await openMenuHub(plugin, { mode: 'queue', remId: cardRemId }, { button: '.rn-queue__menu-button', pane: null });
}

/**
 * Open the Menu Hub, or point the open one elsewhere, placed just below the
 * menu button it was opened from.
 *
 * A menu action gets only a Rem id, never the click, and a plugin can't
 * measure the host's DOM. So the hub opens at a marker position
 * (menuHubAnchorPosition) that a host CSS rule recognises in the float
 * wrapper's inline style and replaces with CSS anchor positioning: below the
 * menu's button, or near the top right of the pane (or the window) when that
 * button isn't there. The hub then reads where it landed (getDimensions) and
 * moves itself there with setFloatingWidgetPosition; the inline style no
 * longer matches the marker, the rule lets go, and dragging works on plain
 * coordinates again.
 *
 * Must run in the index iframe: registerCSS only works there. Menu actions do.
 * The hub stays open (no close on outside click); what it shows goes through
 * session storage, since openFloatingWidget takes no context data.
 */
async function openMenuHub(
  plugin: Plugin,
  target: Omit<MenuHubTarget, 'at' | 'source'>,
  anchor: { button: string | null; pane: string | null }
) {
  await plugin.app.registerCSS('menu-hub-anchor', menuHubAnchorCss(anchor));

  const activeId = await plugin.storage.getSession<string>(menuHubActiveIdKey);
  const open = !!activeId && (await plugin.window.isFloatingWidgetOpen(activeId).catch(() => false));
  if (open) {
    // Back to the marker, so the open hub jumps to this menu too.
    await plugin.window.setFloatingWidgetPosition(activeId!, menuHubAnchorPosition);
  }
  // Written after the move: the hub re-measures when this changes.
  await plugin.storage.setSession(menuHubTargetKey, {
    ...target,
    at: Date.now(),
    source: 'menu',
  } satisfies MenuHubTarget);
  if (open) return;

  const id = await plugin.window.openFloatingWidget(menuHubWidgetId, menuHubAnchorPosition, undefined, false);
  await plugin.storage.setSession(menuHubActiveIdKey, id);
}

function paneLeaves(tree: PaneRemWindowTree | null | undefined): { remId: string; paneId: string }[] {
  if (!tree) return [];
  if ('paneId' in tree) return [tree];
  return [...paneLeaves(tree.first as PaneRemWindowTree), ...paneLeaves(tree.second as PaneRemWindowTree)];
}

/** The pane showing the document: the focused one if it does, else the first. */
async function paneShowing(plugin: Plugin, remId: string): Promise<string | undefined> {
  const [focused, tree] = await Promise.all([
    plugin.window.getFocusedPaneId().catch(() => undefined),
    plugin.window.getCurrentWindowTree().catch(() => undefined),
  ]);
  const showing = paneLeaves(tree).filter((p) => p.remId === remId).map((p) => p.paneId);
  if (focused && showing.includes(focused)) return focused;
  return showing[0] ?? focused;
}

function menuHubAnchorCss({ button, pane }: { button: string | null; pane: string | null }): string {
  const { top, left } = menuHubAnchorPosition;
  const hubIframe = `iframe[data-plugin-id="incremental-everything"][src*="widgetName=${menuHubWidgetId}"]`;
  // The float wrapper is `<div class="absolute z-50" style="top: 1px; left: 1px;">`.
  const wrapper = `div.absolute.z-50[style*="top: ${top}px"][style*="left: ${left}px"]:has(${hubIframe})`;
  const noButton = button ? `body:not(:has(${button}))` : 'body';
  const rules: string[] = [];
  if (button) {
    rules.push(`
  ${button} { anchor-name: --ie-menu-hub-button; }
  body:has(${button}) ${wrapper} {
    position: fixed !important;
    top: calc(anchor(--ie-menu-hub-button bottom, 48px) + 6px) !important;
    right: anchor(--ie-menu-hub-button right, 24px) !important;
    left: auto !important;
  }`);
  }
  rules.push(
    pane
      ? `
  ${pane} { anchor-name: --ie-menu-hub-pane; }
  ${noButton} ${wrapper} {
    position: fixed !important;
    top: calc(anchor(--ie-menu-hub-pane top, 0px) + 48px) !important;
    right: calc(anchor(--ie-menu-hub-pane right, 0px) + 16px) !important;
    left: auto !important;
  }`
      : `
  ${noButton} ${wrapper} { top: 56px !important; left: auto !important; right: 24px !important; }`
  );
  // RemNote's own menus open in #controlled-popup-portal (z 30), under a float's
  // z-50: lift it while the hub is open, or the menu opens behind the hub.
  rules.push(`
  @media (pointer: fine) {
    body:has(${hubIframe}) #controlled-popup-portal {
      position: relative;
      z-index: 60;
    }
  }`);
  return rules.join('\n') + '\n';
}
