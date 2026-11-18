/**
 * Search & Browse (plans/implemented/SEARCH_ENGINE_PLAN.md, phase 4): saved searches, the
 * Search Queue document a saved search can be practised from, and the bulk
 * actions of the popup. The table itself comes from the AI helper
 * (rem_search_client.browseViaHelper).
 */
import type { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { savedSearchesKey, searchBrowseRecentsKeyPrefix, searchQueuesParentName } from './consts';
import { browseViaHelper, currentKbId } from './rem_search_client';
import type { BrowseMode, BrowseSort } from './rem_search_protocol';
import { setCardPriority } from './card_priority';
import { updateCardPriorityCache } from './card_priority/cache';
import { reEnableRems } from './card_analytics_export';

// --- saved searches ------------------------------------------------------------------

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  mode: BrowseMode;
  sort: BrowseSort;
  desc: boolean;
  /** The Search Queue document, per knowledge base (synced storage is account-wide). */
  queueDocs?: Record<string, string>;
  updatedAt: number;
}

export async function loadSavedSearches(plugin: RNPlugin): Promise<SavedSearch[]> {
  try {
    const list = await plugin.storage.getSynced<SavedSearch[]>(savedSearchesKey);
    return Array.isArray(list) ? list.filter((s) => s && typeof s.query === 'string') : [];
  } catch {
    return [];
  }
}

async function storeSavedSearches(plugin: RNPlugin, list: SavedSearch[]): Promise<void> {
  await plugin.storage.setSynced(savedSearchesKey, list);
}

/** Save (or overwrite, by name) a search. */
export async function saveSearch(
  plugin: RNPlugin,
  entry: Omit<SavedSearch, 'id' | 'updatedAt' | 'queueDocs'>
): Promise<SavedSearch[]> {
  const list = await loadSavedSearches(plugin);
  const name = entry.name.trim();
  const existing = list.find((s) => s.name.toLowerCase() === name.toLowerCase());
  const next: SavedSearch = {
    ...existing,
    ...entry,
    name,
    id: existing?.id ?? `s${Date.now().toString(36)}`,
    updatedAt: Date.now(),
  };
  const out = existing ? list.map((s) => (s.id === existing.id ? next : s)) : [...list, next];
  await storeSavedSearches(plugin, out);
  return out;
}

export async function deleteSavedSearch(plugin: RNPlugin, id: string): Promise<SavedSearch[]> {
  const out = (await loadSavedSearches(plugin)).filter((s) => s.id !== id);
  await storeSavedSearches(plugin, out);
  return out;
}

// --- Search Queue documents ----------------------------------------------------------

/** Rems written into a Search Queue document at most. RemNote serves a document's
 *  cards in random order, so a smaller document is a more focused session. */
export const SEARCH_QUEUE_LIMIT = 500;

async function findOrCreateParent(plugin: RNPlugin): Promise<PluginRem> {
  const found = await plugin.rem.findByName([searchQueuesParentName], null);
  if (found) return found;
  const parent = await plugin.rem.createRem();
  if (!parent) throw new Error('Could not create the Search Queues document.');
  await parent.setText([searchQueuesParentName]);
  await parent.setIsDocument(true);
  return parent;
}

/**
 * Fill the saved search's Search Queue document with references to its current
 * results (up to SEARCH_QUEUE_LIMIT, in the search's order), creating it under
 * "Search Queues" the first time. Practising a document of references serves exactly
 * those Rems' cards, as the Priority Queue does. Returns the document and how many
 * Rems it now holds; the saved search remembers the document.
 */
export async function refreshSearchQueue(
  plugin: RNPlugin,
  saved: SavedSearch,
  onProgress?: (done: number, total: number) => void
): Promise<{ doc: PluginRem; count: number; total: number }> {
  const res = await browseViaHelper(plugin, {
    query: saved.query, mode: 'rems', sort: saved.sort, desc: saved.desc, offset: 0, limit: SEARCH_QUEUE_LIMIT,
  });
  if (res.status !== 'ok') {
    throw new Error(
      res.status === 'query-error' ? res.error.message
        : res.status === 'unpaired' ? 'The AI helper is not paired.'
        : 'The AI helper is not running.'
    );
  }
  const kbId = (await currentKbId(plugin)) ?? 'unknown';
  let doc = saved.queueDocs?.[kbId] ? await plugin.rem.findOne(saved.queueDocs[kbId]) : undefined;
  const title = [`🔎 ${saved.name}`];
  if (!doc) {
    const parent = await findOrCreateParent(plugin);
    doc = await plugin.rem.createRem();
    if (!doc) throw new Error('Could not create the Search Queue document.');
    await doc.setParent(parent);
    await doc.setIsDocument(true);
  }
  await doc.setText(title);

  const old = await doc.getChildrenRem();
  const ids = Array.from(new Set(res.rows.map((r) => r.remId)));
  const steps = old.length + ids.length;
  let done = 0;
  for (const child of old) {
    await child.remove();
    onProgress?.(++done, steps);
  }
  for (const id of ids) {
    const entry = await plugin.rem.createRem();
    if (entry) {
      await entry.setParent(doc);
      await entry.setText([{ i: 'q', _id: id }]);
    }
    onProgress?.(++done, steps);
  }

  const list = await loadSavedSearches(plugin);
  await storeSavedSearches(
    plugin,
    list.map((s) => (s.id === saved.id ? { ...s, queueDocs: { ...s.queueDocs, [kbId]: doc!._id } } : s))
  );
  return { doc, count: ids.length, total: res.total };
}

/** Opens Practice for a document: RemNote's own Practice button is this route. */
export async function practiceDocument(plugin: RNPlugin, doc: PluginRem): Promise<void> {
  await plugin.window.setURL(`/flashcards/${doc._id}`);
}

// --- bulk actions --------------------------------------------------------------------

/**
 * Give these Rems a manual card priority, the way the batch tool does: the slot
 * write through setCardPriority (it keeps the table badge in step), the cache entry,
 * then the inheritance cascade left to the background tracker.
 */
export async function setCardPriorityForRems(
  plugin: RNPlugin,
  remIds: string[],
  priority: number,
  onProgress?: (done: number, total: number) => void
): Promise<{ done: number; failed: string[] }> {
  const failed: string[] = [];
  let done = 0;
  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    for (const id of remIds) {
      try {
        const rem = await plugin.rem.findOne(id);
        if (!rem) throw new Error('gone');
        await rem.addPowerup('cardPriority');
        await setCardPriority(plugin, rem, priority, 'manual', false, { event: 'batch' });
        await updateCardPriorityCache(plugin, id);
        done++;
      } catch (e) {
        console.error('[search-browse] priority failed for', id, e);
        failed.push(id);
      }
      onProgress?.(done + failed.length, remIds.length);
    }
  } finally {
    const cascade = remIds.filter((id) => !failed.includes(id));
    if (cascade.length) await plugin.storage.setSession('pendingInheritanceCascade', cascade);
    else await plugin.storage.setSession('plugin_operation_active', false);
  }
  return { done, failed };
}

/** Switch cards back on for these Rems (their Enable Cards toggle). */
export async function reEnableCardsForRems(
  plugin: RNPlugin,
  remIds: string[],
  onProgress?: (done: number, total: number) => void
): Promise<{ enabled: number; failed: string[] }> {
  return reEnableRems(plugin, remIds, onProgress);
}

// --- Move, tags, cards on/off: the table's other bulk actions -------------------------

/** The Rems of a list that no other Rem of the list sits above: moving those carries the
 *  rest along (moving both would flatten the tree, as RemNote's own Move avoids). */
export function topmostOnly(items: { remId: string; ancestorIds?: string[] }[]): string[] {
  const ids = new Set(items.map((i) => i.remId));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.remId)) continue;
    seen.add(it.remId);
    if (!(it.ancestorIds ?? []).some((a) => ids.has(a))) out.push(it.remId);
  }
  return out;
}

/** Where a moved Rem was, to put it back. */
export interface MoveUndo {
  remId: string;
  parentId: string | null;
  position: number;
}

/**
 * Move these Rems to the end of `parentId`'s children (null: top level), keeping their
 * order. One moveRems call, as RemNote's Move Bullet does; the positions recorded first
 * let undoMove put them back. The new parent goes to the inheritance cascade, so moved
 * flashcards take its card priority (manual priorities stay).
 */
export async function moveRemsTo(
  plugin: RNPlugin,
  remIds: string[],
  parentId: string | null
): Promise<{ moved: number; failed: string[]; undo: MoveUndo[] }> {
  if (parentId && remIds.includes(parentId)) throw new Error('A Rem cannot be moved into itself.');
  const undo: MoveUndo[] = [];
  const rems: PluginRem[] = [];
  const failed: string[] = [];
  for (const id of remIds) {
    const rem = await plugin.rem.findOne(id);
    if (!rem) {
      failed.push(id);
      continue;
    }
    rems.push(rem);
    undo.push({ remId: id, parentId: rem.parent ?? null, position: (await rem.positionAmongstSiblings()) ?? 0 });
  }
  if (!rems.length) return { moved: 0, failed, undo: [] };
  if (parentId) {
    const parent = await plugin.rem.findOne(parentId);
    if (!parent) throw new Error('The new parent is gone.');
    const count = (await parent.getChildrenRem()).length;
    await plugin.rem.moveRems(rems.map((r) => r._id), parentId, count);
  } else {
    for (const r of rems) await r.setParent(null);
  }
  // RemNote refuses some moves without an error (a power-up Rem; into its own
  // descendant): read the parents back.
  let moved = 0;
  for (const r of rems) {
    const fresh = await plugin.rem.findOne(r._id);
    if ((fresh?.parent ?? null) === parentId) moved++;
    else failed.push(r._id);
  }
  const cascade = parentId ? [parentId] : rems.map((r) => r._id);
  await plugin.storage.setSession('pendingInheritanceCascade', cascade).catch(() => {});
  return { moved, failed, undo: undo.filter((u) => !failed.includes(u.remId)) };
}

/** Put moved Rems back where they were (lowest position first, per old parent). */
export async function undoMove(plugin: RNPlugin, undo: MoveUndo[]): Promise<number> {
  let done = 0;
  const sorted = [...undo].sort((a, b) => a.position - b.position);
  for (const u of sorted) {
    try {
      const rem = await plugin.rem.findOne(u.remId);
      if (!rem) continue;
      if (u.parentId) await rem.setParent(u.parentId, u.position);
      else await rem.setParent(null);
      done++;
    } catch (e) {
      console.error('[search-browse] undo move failed for', u.remId, e);
    }
  }
  const parents = Array.from(new Set(undo.map((u) => u.parentId).filter((p): p is string => !!p)));
  if (parents.length) await plugin.storage.setSession('pendingInheritanceCascade', parents).catch(() => {});
  return done;
}

async function eachRem(
  plugin: RNPlugin,
  remIds: string[],
  fn: (rem: PluginRem) => Promise<void>,
  onProgress?: (done: number, total: number) => void
): Promise<{ done: number; failed: string[] }> {
  const failed: string[] = [];
  let done = 0;
  for (const id of remIds) {
    try {
      const rem = await plugin.rem.findOne(id);
      if (!rem) throw new Error('gone');
      await fn(rem);
      done++;
    } catch (e) {
      console.error('[search-browse] failed for', id, e);
      failed.push(id);
    }
    onProgress?.(done + failed.length, remIds.length);
  }
  return { done, failed };
}

export const addTagToRems = (plugin: RNPlugin, remIds: string[], tagId: string, onProgress?: (d: number, t: number) => void) =>
  eachRem(plugin, remIds.filter((id) => id !== tagId), (rem) => rem.addTag(tagId), onProgress);

export const removeTagFromRems = (plugin: RNPlugin, remIds: string[], tagId: string, onProgress?: (d: number, t: number) => void) =>
  eachRem(plugin, remIds, (rem) => rem.removeTag(tagId), onProgress);

/** A new Rem named `name`, last under `parentId` (null: top level): the picker's
 *  "+ Create" (a tag to add, or a parent to move into). */
export async function createNamedRem(plugin: RNPlugin, name: string, parentId: string | null): Promise<string> {
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('RemNote did not create the Rem.');
  await rem.setText([name]);
  if (parentId) {
    const parent = await plugin.rem.findOne(parentId);
    if (parent) await rem.setParent(parentId, (await parent.getChildrenRem()).length);
  }
  return rem._id;
}

/** A row of the table to switch cards on or off for: a Rem (Rem mode), or one card. */
export interface CardSwitchTarget {
  remId: string;
  cardId?: string;
  kind?: 'forward' | 'backward' | 'cloze';
  /** The card's suppression causes (rem_search names). */
  suppressed?: string[];
}

type Direction = 'forward' | 'backward' | 'none' | 'both';
const toDirection = (fwd: boolean, bwd: boolean): Direction => (fwd && bwd ? 'both' : fwd ? 'forward' : bwd ? 'backward' : 'none');

/**
 * Switch cards on or off as RemNote's Browser does (read from its bundle, Nov 2026).
 * - A Rem row, or every card of a Rem selected: the Rem's own Enable Cards toggle
 *   (`forget`, what /Disable Card writes).
 * - Single forward/backward cards: that practice direction.
 * - Single cloze cards: RemNote keeps those in the Rem's `dci` field, which plugins
 *   can neither read nor write (findings/CARD_STATE_REFERENCE.md); they are skipped.
 */
export async function switchCards(
  plugin: RNPlugin,
  targets: CardSwitchTarget[],
  on: boolean,
  onProgress?: (done: number, total: number) => void
): Promise<{ rems: number; cards: number; skippedClozes: number; failed: string[] }> {
  const byRem = new Map<string, CardSwitchTarget[]>();
  for (const t of targets) byRem.set(t.remId, [...(byRem.get(t.remId) ?? []), t]);
  let rems = 0;
  let cards = 0;
  let skippedClozes = 0;
  const failed: string[] = [];
  let i = 0;
  for (const [remId, rows] of byRem) {
    try {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) throw new Error('gone');
      const cardRows = rows.filter((r) => r.cardId);
      if (!cardRows.length) {
        await rem.setEnablePractice(on);
        rems++;
      } else if (!on) {
        const live = await rem.getCards();
        const chosen = new Set(cardRows.map((r) => r.cardId));
        if (live.length > 0 && live.every((c) => chosen.has(c._id))) {
          await rem.setEnablePractice(false);
          rems++;
        } else {
          const dir = await rem.getPracticeDirection();
          let fwd = dir === 'forward' || dir === 'both';
          let bwd = dir === 'backward' || dir === 'both';
          for (const r of cardRows) {
            if (r.kind === 'forward' && fwd) {
              fwd = false;
              cards++;
            } else if (r.kind === 'backward' && bwd) {
              bwd = false;
              cards++;
            } else if (r.kind === 'cloze' && live.some((c) => c._id === r.cardId)) {
              skippedClozes++;
            }
          }
          const next = toDirection(fwd, bwd);
          if (next !== dir) await rem.setPracticeDirection(next);
        }
      } else {
        if (!(await rem.getEnablePractice())) {
          await rem.setEnablePractice(true);
          rems++;
        }
        const dir = await rem.getPracticeDirection();
        let fwd = dir === 'forward' || dir === 'both';
        let bwd = dir === 'backward' || dir === 'both';
        for (const r of cardRows) {
          if (r.kind === 'forward' && !fwd) {
            fwd = true;
            cards++;
          } else if (r.kind === 'backward' && !bwd) {
            bwd = true;
            cards++;
          } else if (r.kind === 'cloze' && r.suppressed?.includes('cloze')) {
            skippedClozes++;
          }
        }
        const next = toDirection(fwd, bwd);
        if (next !== dir) await rem.setPracticeDirection(next);
      }
    } catch (e) {
      console.error('[search-browse] switching cards failed for', remId, e);
      failed.push(remId);
    }
    onProgress?.(++i, byRem.size);
  }
  return { rems, cards, skippedClozes, failed };
}

// --- picker recents (per device) ------------------------------------------------------

const RECENTS_MAX = 10;

export async function loadPickerRecents(plugin: RNPlugin, kind: 'move' | 'tag'): Promise<string[]> {
  try {
    const v = await plugin.storage.getLocal<string[]>(searchBrowseRecentsKeyPrefix + kind);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function pushPickerRecent(plugin: RNPlugin, kind: 'move' | 'tag', remId: string): Promise<void> {
  const list = await loadPickerRecents(plugin, kind);
  const next = [remId, ...list.filter((x) => x !== remId)].slice(0, RECENTS_MAX);
  await plugin.storage.setLocal(searchBrowseRecentsKeyPrefix + kind, next).catch(() => {});
}
