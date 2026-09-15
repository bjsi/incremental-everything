import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { allCardPriorityInfoKey } from '../consts';
import { CardPriorityInfo } from '../card_priority/types';
import { shouldUseLightMode } from '../mobileUtils';
import { CardLike, cardsFromCacheInfo } from './cooling';

/**
 * Where the Priority Queue gets its card facts: due dates and last-seen times.
 *
 * `card.getAll()` is a full card-database load — RemNote forces the whole store
 * into memory for it and logs that it may be slow on large knowledge bases — so
 * the refresh must not pay for it when the card-priority cache already holds the
 * same facts. The cache is updated from the Rem's own cards every time a card is
 * rated in a queue (QueueCompleteCard, Full Mode), and its card-derived fields
 * are rebuilt from one `card.getAll()` at every launch.
 *
 *   - Full Mode, cache loaded → the cache. No card read at all.
 *   - Otherwise (Light Mode, where the cache is never built, or a Full Mode
 *     cache still loading) → ONE `card.getAll()`, shared by drain, cooling and
 *     selection in the same refresh.
 *
 * The cache's blind spot is reviews synced from another device during this
 * session: they reach it only at the next launch. That affects the shields,
 * selection and cooling alike, and is documented on the flashcard priorities
 * page (#cache-blind-spot).
 */
export interface CardSource {
  kind: 'cache' | 'all';
  /** Card facts per owning Rem. */
  cardsByRem: Map<RemId, CardLike[]>;
  /** The raw cards, when they came from `card.getAll()` — for selection's cache-less path. */
  allCards?: any[];
}

/** True when the Full Mode card cache can answer card questions. */
export async function isCardCacheUsable(plugin: RNPlugin): Promise<CardPriorityInfo[] | null> {
  try {
    if (await shouldUseLightMode(plugin)) return null;
    const loaded = await plugin.storage.getSession<boolean>('card_priority_cache_fully_loaded');
    if (!loaded) return null;
    const infos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
    return infos.length ? infos : null;
  } catch {
    return null;
  }
}

/** Builds the card facts from cache entries — pure, no read. */
export function cardsByRemFromCache(infos: CardPriorityInfo[]): Map<RemId, CardLike[]> {
  const byRem = new Map<RemId, CardLike[]>();
  for (const info of infos) {
    if (!info?.remId || !info.cardsNextRep?.length) continue;
    byRem.set(info.remId, cardsFromCacheInfo(info));
  }
  return byRem;
}

/**
 * Entries that report cards but carry no per-card facts. A shortcut write can
 * leave one — Create Cloze Deletion (Alt+Z) used to store just the counts — and
 * it stays that way until the next launch, since nothing re-reads a Rem whose
 * priority did not change. Counted as due by selection but invisible to cooling
 * and the drain, such a Rem was served the day it was written.
 */
function incompleteEntryIds(infos: CardPriorityInfo[]): RemId[] {
  return infos
    .filter((info) => info?.remId && !info.cardsNextRep?.length && ((info.cardCount ?? 0) > 0 || (info.dueCards ?? 0) > 0))
    .map((info) => info.remId);
}

/**
 * The card facts from the cache, with any incomplete entry filled from its own
 * cards — one getCards per such Rem, normally none or a handful.
 */
export async function cardsByRemFromCacheComplete(
  plugin: RNPlugin,
  infos: CardPriorityInfo[]
): Promise<Map<RemId, CardLike[]>> {
  const byRem = cardsByRemFromCache(infos);
  const incomplete = incompleteEntryIds(infos);
  if (incomplete.length === 0) return byRem;
  try {
    const rems = (await plugin.rem.findMany(incomplete)) || [];
    await Promise.all(
      rems.map(async (rem) => {
        try {
          const cards = (await rem.getCards()) || [];
          if (cards.length) byRem.set(rem._id, cards as CardLike[]);
        } catch {
          /* stays without facts, as before */
        }
      })
    );
    console.log(`[CardSource] ${incomplete.length} cache entries had no card facts; read their cards directly.`);
  } catch (e) {
    console.warn('[CardSource] Could not read the cards of incomplete cache entries:', e);
  }
  return byRem;
}

export async function loadCardSource(plugin: RNPlugin): Promise<CardSource> {
  const infos = await isCardCacheUsable(plugin);
  if (infos) {
    return { kind: 'cache', cardsByRem: await cardsByRemFromCacheComplete(plugin, infos) };
  }
  let allCards: any[] = [];
  try {
    allCards = (await plugin.card.getAll()) || [];
  } catch (e) {
    console.error('[CardSource] card.getAll failed:', e);
  }
  const cardsByRem = new Map<RemId, CardLike[]>();
  for (const card of allCards) {
    const owner = card?.remId as RemId | undefined;
    if (!owner) continue;
    const list = cardsByRem.get(owner);
    if (list) list.push(card);
    else cardsByRem.set(owner, [card]);
  }
  console.log(`[CardSource] Loaded ${allCards.length} cards with card.getAll() (no usable card cache).`);
  return { kind: 'all', cardsByRem, allCards };
}
