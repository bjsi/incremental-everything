// lib/remReadPoint.ts
import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { addPageToHistory, getPageHistory, PageHistoryEntry } from './pdfUtils';
import { powerupCode, currentIncRemKey, editorReviewTimerRemIdKey } from './consts';

/**
 * Read points (bookmarks) for rem-type IncRems — outline headers whose reading
 * content lives in their descendants (see the Outline shown in the plugin UI).
 *
 * These reuse the PDF/HTML bookmark storage with one twist: a rem-type IncRem
 * "reads from itself", so we key the history under (incRemId, incRemId) and
 * store the descendant rem chosen as the reading position in the entry's
 * `highlightId`. `page` stays undefined — outlines have no pages. This means
 * the entire history/stats/carry-forward machinery in pdfUtils applies for free.
 */

/**
 * Save a read point: associate `descendantRemId` as the current reading
 * position of the rem-type IncRem `incRemId`.
 */
export const setRemReadPoint = async (
  plugin: RNPlugin,
  incRemId: string,
  descendantRemId: string
): Promise<void> => {
  await addPageToHistory(plugin, incRemId, incRemId, null, undefined, descendantRemId);
};

/**
 * The most recent read point (current reading position) for a rem-type IncRem,
 * or null if none has been set.
 */
export const getRemReadPoint = async (
  plugin: RNPlugin,
  incRemId: string
): Promise<PageHistoryEntry | null> => {
  const history = await getPageHistory(plugin, incRemId, incRemId);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].highlightId) return history[i];
  }
  return null;
};

/**
 * Full read-point history for a rem-type IncRem, most recent first, filtered to
 * entries that point at a target rem.
 */
export const getRemReadPointHistory = async (
  plugin: RNPlugin,
  incRemId: string
): Promise<PageHistoryEntry[]> => {
  const history = await getPageHistory(plugin, incRemId, incRemId);
  return history
    .filter((h) => h.highlightId)
    .sort((a, b) => b.timestamp - a.timestamp);
};

/**
 * True if `candidate` is a (strict) descendant of the rem `ancestorId`.
 */
export const isDescendantOf = async (
  plugin: RNPlugin,
  candidate: PluginRem,
  ancestorId: string,
  maxDepth = 50
): Promise<boolean> => {
  // Untyped walker: getParentRem() is loosely typed in the SDK, so an annotated
  // `current` trips TS7022/18048 — matches determineIncRemType's pattern.
  let current: any = candidate;
  for (let i = 0; i < maxDepth; i++) {
    const parent = await current.getParentRem();
    if (!parent) return false;
    if (parent._id === ancestorId) return true;
    current = parent;
  }
  return false;
};

/**
 * Walk up from `rem` and return the nearest ancestor tagged as an Incremental
 * Rem, or null. Excludes `rem` itself (starts from its parent), so the result
 * is always a strict ancestor — appropriate for choosing the IncRem a focused
 * descendant belongs to.
 */
export const findNearestAncestorIncRem = async (
  plugin: RNPlugin,
  rem: PluginRem,
  maxDepth = 50
): Promise<string | null> => {
  let current: any = rem;
  for (let i = 0; i < maxDepth; i++) {
    const parent = await current.getParentRem();
    if (!parent) return null;
    if (await parent.hasPowerup(powerupCode)) return parent._id;
    current = parent;
  }
  return null;
};

/**
 * Resolve which rem-type IncRem a read-point action targets, for read-only
 * consumers (e.g. the history popup) that don't require a specific descendant.
 *
 * Priority: an active review session whose IncRem contains the focused rem →
 * the focused rem itself if it is an IncRem → the nearest ancestor IncRem of
 * the focused rem → otherwise the active session's IncRem (if any).
 */
export const resolveReadPointIncRem = async (
  plugin: RNPlugin,
  focused?: PluginRem | null
): Promise<string | null> => {
  const sessionIncRemId =
    (await plugin.storage.getSession<string>(editorReviewTimerRemIdKey)) ||
    (await plugin.storage.getSession<string>(currentIncRemKey)) ||
    null;

  if (focused) {
    if (
      sessionIncRemId &&
      sessionIncRemId !== focused._id &&
      (await isDescendantOf(plugin, focused, sessionIncRemId))
    ) {
      return sessionIncRemId;
    }
    if (await focused.hasPowerup(powerupCode)) return focused._id;
    const ancestor = await findNearestAncestorIncRem(plugin, focused);
    if (ancestor) return ancestor;
  }

  return sessionIncRemId;
};
