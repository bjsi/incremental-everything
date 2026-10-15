// lib/parent_pick.ts
//
// "Pick in editor": instead of choosing the new Rem's parent in the Select Parent
// popup, the user closes it and puts the editing cursor in the destination Rem,
// then confirms with a shortcut. A plugin never sees mouse clicks in the editor
// (and Ctrl+Click is the Mac right-click anyway), but it does see which Rem has
// the cursor — so plain clicks stay free for expanding and navigating, and only
// the shortcut commits.
//
// This file owns the hand-off and the target description. The placement itself
// lives in widgets/parent_pick_floating.tsx, which imports createRemUnderParent;
// keeping it out of here lets highlightActions call endParentPick without an
// import cycle.

import { PluginRem, RemId, RNPlugin } from '@remnote/plugin-sdk';
import {
  parentPickActiveIdKey,
  parentPickConfirmRequestKey,
  parentPickContextKey,
  parentPickWidgetId,
  parentSelectorWidgetId,
} from './consts';
import { ParentSelectorContext } from './hierarchical_parent_selector/types';
import { getHeadingLevel, HeadingLevel } from './outline_restructure';
import { safeRemTextToString } from './pdfUtils';

// How many of the target's nearest ancestors the card shows.
const BREADCRUMB_DEPTH = 3;
// A guard against a malformed parent chain; real outlines are far shallower.
const MAX_ANCESTOR_WALK = 200;

export interface PickTargetInfo {
  remId: RemId;
  name: string;
  /** Nearest ancestors, outermost first. */
  breadcrumb: string[];
  headingLevel: HeadingLevel | null;
  /**
   * Whether the target sits under the IncRem being reviewed (or is that IncRem).
   * null when no IncRem is under review, so there is nothing to compare against.
   */
  insideContext: boolean | null;
  /** Set when the target can't take the new Rem at all. */
  invalidReason: string | null;
}

/**
 * Closes the Select Parent popup and opens the floating card that waits for a
 * destination picked in the editor. Called from inside the popup, so the popup
 * closes last: once it's gone, nothing after it would run.
 */
export async function startParentPick(plugin: RNPlugin): Promise<void> {
  const ctx = await plugin.storage.getSession<ParentSelectorContext>('parentSelectorContext');
  if (!ctx) return;

  await plugin.storage.setSession(parentPickContextKey, ctx);
  await plugin.storage.setSession(parentPickConfirmRequestKey, undefined);
  await closeParentPickCard(plugin);

  // closeWhenClickOutside must be false: every click in the editor is "outside".
  const id = await plugin.window.openFloatingWidget(
    parentPickWidgetId,
    { top: 48, right: 24 },
    undefined,
    false
  );
  await plugin.storage.setSession(parentPickActiveIdKey, id);
  await plugin.widget.closePopup();
}

export async function isParentPickActive(plugin: RNPlugin): Promise<boolean> {
  return !!(await plugin.storage.getSession<string>(parentPickActiveIdKey));
}

async function closeParentPickCard(plugin: RNPlugin): Promise<void> {
  const id = await plugin.storage.getSession<string>(parentPickActiveIdKey);
  if (id) {
    try {
      await plugin.window.closeFloatingWidget(id);
    } catch {
      /* already gone */
    }
  }
  await plugin.storage.setSession(parentPickActiveIdKey, undefined);
}

/**
 * Drops the pending pick and closes its card. Safe to call when none is pending.
 * The card may be the caller, so closing it comes last.
 */
export async function endParentPick(plugin: RNPlugin): Promise<void> {
  await plugin.storage.setSession(parentPickContextKey, undefined);
  await plugin.storage.setSession(parentPickConfirmRequestKey, undefined);
  await closeParentPickCard(plugin);
}

/** Abandons the editor pick and reopens the Select Parent popup on the same highlight. */
export async function returnToParentList(plugin: RNPlugin): Promise<void> {
  const ctx = await plugin.storage.getSession<ParentSelectorContext>(parentPickContextKey);
  if (ctx) {
    await plugin.storage.setSession('parentSelectorContext', ctx);
    await plugin.widget.openPopup(parentSelectorWidgetId);
  }
  await endParentPick(plugin);
}

export async function remDisplayName(plugin: RNPlugin, rem: PluginRem): Promise<string> {
  const text = (await safeRemTextToString(plugin, rem.text)).trim();
  return text || 'Untitled';
}

/**
 * Describes a candidate destination for the card: its name, where it lives, and
 * whether it is under the IncRem being reviewed. Being outside is only a warning
 * (the card asks for a second confirmation); the highlight itself is refused.
 */
export async function describePickTarget(
  plugin: RNPlugin,
  rem: PluginRem,
  ctx: ParentSelectorContext
): Promise<PickTargetInfo> {
  const contextRemId = ctx.contextRemId;
  let insideContext: boolean | null = contextRemId ? rem._id === contextRemId : null;
  const breadcrumb: string[] = [];

  // Walk up until the breadcrumb is full and, if there is an IncRem to compare
  // against, until we either meet it or run out of ancestors.
  let current: PluginRem = rem;
  for (let i = 0; i < MAX_ANCESTOR_WALK; i++) {
    if (breadcrumb.length >= BREADCRUMB_DEPTH && insideContext !== false) break;
    const parent = await current.getParentRem();
    if (!parent) break;
    if (breadcrumb.length < BREADCRUMB_DEPTH) {
      breadcrumb.unshift(await remDisplayName(plugin, parent));
    }
    if (parent._id === contextRemId) insideContext = true;
    current = parent;
  }

  return {
    remId: rem._id,
    name: await remDisplayName(plugin, rem),
    breadcrumb,
    headingLevel: await getHeadingLevel(rem),
    insideContext,
    invalidReason: rem._id === ctx.extractRemId ? 'That is the highlight itself.' : null,
  };
}
