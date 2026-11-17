/**
 * Search & Browse (plans/implemented/SEARCH_ENGINE_PLAN.md, phase 4): saved searches, the
 * Search Queue document a saved search can be practised from, and the bulk
 * actions of the popup. The table itself comes from the AI helper
 * (rem_search_client.browseViaHelper).
 */
import type { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { savedSearchesKey, searchQueuesParentName } from './consts';
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
