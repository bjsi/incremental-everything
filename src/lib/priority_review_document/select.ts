import { RNPlugin, PluginRem, RemId, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import * as _ from 'remeda';
import { IncrementalRem } from '../incremental_rem';
import { getCardRandomness, getSortingRandomness, getWeightSelectionK, applySortingCriteria } from '../sorting';
import { getDueCardsWithPriorities, CardPriorityInfo, calculateCardRemPercentilesFromCards } from '../card_priority';
import { allIncrementalRemKey, allCardPriorityInfoKey } from '../consts';
import { calculateAllPercentiles } from '../utils';
import { buildComprehensiveScope } from '../scope_helpers';
import { safeRemTextToString } from '../pdfUtils';
import { hasCardClusterPowerup } from './cluster';
import { CoolingScanner } from './cooling_gather';
import { COOLING_RELATION_LABELS, CoolingVerdict } from './cooling';

/**
 * Item selection for review documents — the one ranking both the snapshot
 * creator and the persistent Priority Queue use.
 *
 * What it does, in order: gather what is due in scope (IncRems from the cache,
 * flashcard Rems from the priority cache), rank each list by priority with the
 * user's lottery on top, then interleave them at the flashcard ratio, pulling
 * cards through four gates as they are drawn — paused document, due ancestor
 * (swap the ancestor in), cooling, and Card Cluster expansion. Every gate is
 * lazy: it costs reads only for the cards actually considered, so the work is
 * bounded by the number of items requested, not by the knowledge base.
 *
 * The SHIELD SLICE is the one addition over the original creator. The lottery
 * deliberately lets lower priorities surface, which is right for a whole
 * session but wrong for the front of a small burst: a 25-item document that
 * happens to skip the two most important due Rems leaves the Priority Shield
 * exactly where it was. So the first share of each list is filled strictly by
 * priority, no lottery, and the lottery runs over the rest. With the default
 * 20% a burst of 25 always carries the 5 most important due items.
 */

export interface SkippedPausedItem {
  remId: string;
  name: string;
  priority: number;
}

export interface SkippedAncestorItem {
  remId: string;
  name: string;
  priority: number;
  /** The due ancestor that would have been given away. */
  ancestorRemId: string;
  ancestorName: string;
  /** 1 = parent, 2 = grandparent. */
  level: 1 | 2;
  /** What happened to the ancestor: pulled in as a replacement, already in the
   * document, cooling (so it cannot be pulled in yet), or unreadable — the
   * descendant is held back in every case. */
  ancestorAction: 'added' | 'already-included' | 'cooling' | 'unavailable';
}

export interface SkippedCoolingItem {
  remId: string;
  name: string;
  priority: number;
  until: number;
  windowDays: number;
  /** Human summary of the first reason, e.g. "another card of this Rem was reviewed 2 days ago". */
  reason: string;
}

export interface SelectedItem {
  rem: PluginRem;
  type: 'incremental' | 'flashcard';
  priority: number;
  percentile: number;
}

export interface SelectionOptions {
  scopeRemId: string | null;
  /** How many items to select. 0 is allowed: the universe is still computed. */
  itemCount: number;
  cardRatio: number | 'no-cards' | 'no-rem';
  filterPaused: boolean;
  pausedPriorityThreshold: number;
  /** Never select these (already in the document, for instance). */
  excludeRemIds?: ReadonlySet<RemId>;
  /** Share of each list filled strictly by priority before the lottery. 0 = off. */
  shieldSliceFraction?: number;
  /**
   * A scanner to judge cooling with. When given, cooling Rems are skipped and
   * reported; the caller owns the scanner and decides whether to publish it.
   */
  coolingScanner?: CoolingScanner | null;
}

export interface SelectionStats {
  scopeName: string;
  scopedIncRems: number;
  remsWithCards: number;
  totalCardsInScope: number;
  dueIncRems: number;
  dueCardRems: number;
  dueCards: number;
}

export interface SelectionResult {
  items: SelectedItem[];
  skippedPausedItems: SkippedPausedItem[];
  skippedAncestorItems: SkippedAncestorItem[];
  skippedCoolingItems: SkippedCoolingItem[];
  /** How many of the selected items came from the shield slice. */
  shieldSliceCount: number;
  stats: SelectionStats;
  /** Randomness applied, as 0–100 percentages. */
  randomnessPct: { incRem: number; card: number };
  /** Percentile per Rem in the scope universe, for graphing items chosen earlier. */
  cardPercentiles: Record<string, number>;
  incRemPercentiles: Record<string, number>;
  /** Priority per Rem the caches know, for the same purpose. */
  priorityByRemId: Map<RemId, number>;
}

/**
 * Walks the ancestor chain of a rem to detect if it lives inside a paused
 * document. A document is considered paused when its Deck powerup Status
 * slot equals "Paused".
 */
async function isInPausedDocument(rem: PluginRem): Promise<boolean> {
  let cursor = await rem.getParentRem();
  while (cursor) {
    if (await cursor.hasPowerup(BuiltInPowerupCodes.Deck)) {
      const status = await cursor.getPowerupProperty(BuiltInPowerupCodes.Deck, 'Status');
      return status === 'Paused';
    }
    cursor = await cursor.getParentRem();
  }
  return false;
}

interface AncestorInfo {
  parentId: RemId | null;
  hasDueCard: boolean;
  text: any;
}

/**
 * Reads the one thing the spoiler gate needs to know about an ancestor — does it
 * still owe the queue a card — plus its own parent. Memoised per Rem id because
 * siblings share ancestors. `getCards()` (not the priority cache) is the source
 * of truth on purpose: a card created since the last cache build is exactly the
 * case that matters most. Fails OPEN.
 */
async function readAncestorInfo(
  plugin: RNPlugin,
  remId: RemId,
  now: number,
  cache: Map<RemId, AncestorInfo>
): Promise<AncestorInfo> {
  const cached = cache.get(remId);
  if (cached) return cached;

  let info: AncestorInfo = { parentId: null, hasDueCard: false, text: undefined };
  try {
    const rem = await plugin.rem.findOne(remId);
    if (rem) {
      const cards = (await rem.getCards()) || [];
      info = {
        parentId: (rem.parent as RemId | undefined) ?? null,
        hasDueCard: cards.some((c: any) => (c.nextRepetitionTime ?? Infinity) <= now),
        text: rem.text,
      };
    }
  } catch (e) {
    console.warn(`[PRD] Ancestor read failed for ${remId}:`, e);
  }

  cache.set(remId, info);
  return info;
}

/**
 * Finds the ancestor whose answer this card would give away: parent and
 * grandparent only, HIGHEST due ancestor first so the tree unblocks top-down.
 * See the Ancestor Spoiler Protection section of the docs.
 */
async function findDueAncestorSpoiler(
  plugin: RNPlugin,
  rem: PluginRem,
  now: number,
  cache: Map<RemId, AncestorInfo>
): Promise<{ remId: RemId; level: 1 | 2; text: any } | null> {
  const parentId = (rem.parent as RemId | undefined) ?? null;
  if (!parentId) return null;

  const parent = await readAncestorInfo(plugin, parentId, now, cache);

  if (parent.parentId) {
    const grandparent = await readAncestorInfo(plugin, parent.parentId, now, cache);
    if (grandparent.hasDueCard) {
      return { remId: parent.parentId, level: 2, text: grandparent.text };
    }
  }

  if (parent.hasDueCard) {
    return { remId: parentId, level: 1, text: parent.text };
  }

  return null;
}

const daysAgo = (ms: number, now: number) => Math.max(0, (now - ms) / 86_400_000);

export function describeCoolingVerdict(v: CoolingVerdict, now: number): string {
  const first = v.reasons[0];
  if (!first) return v.extendedUntil ? 'extended by you' : 'cooling';
  const ago = daysAgo(first.seenAt, now);
  const when = ago < 1 ? 'today' : ago < 2 ? 'yesterday' : `${Math.round(ago)} days ago`;
  return `${COOLING_RELATION_LABELS[first.relation]} ${when}`;
}

/**
 * Strict-top head, lottery over the rest. `applySortingCriteria` sorts by
 * priority and then runs the lottery; here the head is carved off BEFORE the
 * lottery so it is untouched by it.
 */
function rankWithShieldSlice<T extends { priority: number }>(
  items: T[],
  headCount: number,
  randomness: number,
  weightK: number
): { ranked: T[]; head: number } {
  const sorted = [...items].sort((a, b) => a.priority - b.priority);
  const head = Math.max(0, Math.min(headCount, sorted.length));
  const strict = sorted.slice(0, head);
  const rest = applySortingCriteria(sorted.slice(head), randomness, weightK);
  return { ranked: [...strict, ...rest], head };
}

export async function selectPriorityItems(
  plugin: RNPlugin,
  options: SelectionOptions
): Promise<SelectionResult> {
  const { scopeRemId, itemCount, cardRatio, filterPaused, pausedPriorityThreshold } = options;
  const excludeRemIds = options.excludeRemIds ?? new Set<RemId>();
  const scanner = options.coolingScanner ?? null;
  const shieldFraction = Math.max(0, Math.min(1, options.shieldSliceFraction ?? 0));
  const now = Date.now();

  const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
  const scopeRem = scopeRemId ? (await plugin.rem.findOne(scopeRemId)) ?? null : null;
  const comprehensiveScopeIds = scopeRem ? await buildComprehensiveScope(plugin, scopeRem._id) : null;

  const scopedIncRems = comprehensiveScopeIds
    ? allIncRems.filter((r) => comprehensiveScopeIds.has(r.remId))
    : allIncRems;
  const dueIncRems = scopedIncRems.filter((rem) => rem.nextRepDate <= now);

  const cardsWithPriority = await getDueCardsWithPriorities(
    plugin,
    scopeRem,
    true,
    comprehensiveScopeIds ?? undefined
  );

  // Universe for percentiles: the cached infos in scope, plus any due card the
  // gatherer found that the cache did not know about.
  const allCardInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
  let universeCardInfos = comprehensiveScopeIds
    ? allCardInfos.filter((c) => comprehensiveScopeIds.has(c.remId))
    : allCardInfos;
  const universeRemIds = new Set(universeCardInfos.map((c) => c.remId));
  const missingCards = cardsWithPriority.filter((c) => !universeRemIds.has(c.rem._id));
  if (missingCards.length > 0) {
    const uniqueMissing = _.uniqBy(missingCards, (c) => c.rem._id);
    console.warn(`[PriorityGraph] ${missingCards.length} due cards missing from cache; merged ${uniqueMissing.length} Rems into the universe.`);
    universeCardInfos = [
      ...universeCardInfos,
      ...uniqueMissing.map((item) => ({
        remId: item.rem._id,
        priority: item.priority,
        source: item.source,
        cardCount: 1,
        dueCards: 1,
        lastUpdated: now,
      })),
    ];
  }

  const incRemPercentiles = calculateAllPercentiles(scopedIncRems as any);
  const cardPercentiles = calculateCardRemPercentilesFromCards(universeCardInfos);
  const priorityByRemId = new Map<RemId, number>(allCardInfos.map((c) => [c.remId, c.priority]));
  for (const inc of allIncRems) if (!priorityByRemId.has(inc.remId)) priorityByRemId.set(inc.remId, inc.priority);

  // Ranking: strict head, lottery tail.
  const incRemRandomness = await getSortingRandomness(plugin);
  const cardRandomness = await getCardRandomness(plugin);
  const weightK = await getWeightSelectionK(plugin);

  const expectedInc =
    cardRatio === 'no-cards' ? itemCount : cardRatio === 'no-rem' ? 0 : Math.ceil(itemCount / (cardRatio + 1));
  const expectedCards = itemCount - expectedInc;
  const incHead = Math.ceil(expectedInc * shieldFraction);
  const cardHead = Math.ceil(expectedCards * shieldFraction);

  const incRanked = rankWithShieldSlice(dueIncRems as any[], incHead, incRemRandomness, weightK);
  const cardRanked = rankWithShieldSlice(cardsWithPriority, cardHead, cardRandomness, weightK);
  const sortedIncRems = incRanked.ranked;
  const sortedCards = cardRanked.ranked;

  // Cooling: judge the head of the card list in one batch up front; anything
  // drawn from beyond it (or an ancestor swapped in) is judged lazily.
  if (scanner && itemCount > 0) {
    const prescan = sortedCards.slice(0, itemCount * 3 + 25).map((c) => c.rem._id);
    await scanner.scan(prescan);
  }

  const items: SelectedItem[] = [];
  const addedRemIds = new Set<RemId>();
  const skippedPausedItems: SkippedPausedItem[] = [];
  const skippedAncestorItems: SkippedAncestorItem[] = [];
  const skippedCoolingItems: SkippedCoolingItem[] = [];
  const ancestorInfoCache = new Map<RemId, AncestorInfo>();
  const dueCardByRemId = new Map(sortedCards.map((c) => [c.rem._id, c]));
  let shieldSliceCount = 0;

  const isBlocked = (remId: RemId) => excludeRemIds.has(remId) || addedRemIds.has(remId);

  const coolingVerdict = async (remId: RemId): Promise<CoolingVerdict | null> =>
    scanner ? scanner.verdictFor(remId) : null;

  const noteCooling = async (rem: PluginRem, priority: number, v: CoolingVerdict) => {
    skippedCoolingItems.push({
      remId: rem._id,
      name: await safeRemTextToString(plugin, rem.text),
      priority,
      until: v.until,
      windowDays: v.windowDays,
      reason: describeCoolingVerdict(v, now),
    });
  };

  const addIncRem = async (idx: number): Promise<boolean> => {
    if (idx >= sortedIncRems.length) return false;
    const item = sortedIncRems[idx];
    if (isBlocked(item.remId)) return true;
    const rem = await plugin.rem.findOne(item.remId);
    if (!rem) return true;
    items.push({
      rem,
      type: 'incremental',
      priority: item.priority,
      percentile: incRemPercentiles[item.remId] ?? 100,
    });
    addedRemIds.add(item.remId);
    if (idx < incRanked.head) shieldSliceCount++;
    return true;
  };

  const addCard = async (idx: number): Promise<boolean> => {
    if (idx >= sortedCards.length) return false;
    const item = sortedCards[idx];
    if (isBlocked(item.rem._id)) return true;

    if (filterPaused && item.priority > pausedPriorityThreshold && (await isInPausedDocument(item.rem))) {
      skippedPausedItems.push({
        remId: item.rem._id,
        name: await safeRemTextToString(plugin, item.rem.text),
        priority: item.priority,
      });
      return true;
    }

    // Ancestor spoiler: hold the descendant, swap the blocking ancestor in —
    // unless the ancestor is itself cooling, in which case nothing is added
    // and both wait.
    const spoiler = await findDueAncestorSpoiler(plugin, item.rem, now, ancestorInfoCache);
    if (spoiler) {
      let ancestorAction: SkippedAncestorItem['ancestorAction'] = 'already-included';
      if (!isBlocked(spoiler.remId)) {
        const ancestorCooling = await coolingVerdict(spoiler.remId);
        if (ancestorCooling) {
          ancestorAction = 'cooling';
        } else {
          const ancestorRem = await plugin.rem.findOne(spoiler.remId);
          if (ancestorRem) {
            const ancestorEntry = dueCardByRemId.get(spoiler.remId);
            items.push({
              rem: ancestorRem,
              type: 'flashcard',
              priority: ancestorEntry?.priority ?? priorityByRemId.get(spoiler.remId) ?? item.priority,
              percentile: cardPercentiles[spoiler.remId] ?? 100,
            });
            addedRemIds.add(spoiler.remId);
            ancestorAction = 'added';
          } else {
            ancestorAction = 'unavailable';
          }
        }
      } else if (excludeRemIds.has(spoiler.remId)) {
        ancestorAction = 'already-included';
      }
      skippedAncestorItems.push({
        remId: item.rem._id,
        name: await safeRemTextToString(plugin, item.rem.text),
        priority: item.priority,
        ancestorRemId: spoiler.remId,
        ancestorName: await safeRemTextToString(plugin, spoiler.text),
        level: spoiler.level,
        ancestorAction,
      });
      return true;
    }

    const cooling = await coolingVerdict(item.rem._id);
    if (cooling) {
      await noteCooling(item.rem, item.priority, cooling);
      return true;
    }

    items.push({
      rem: item.rem,
      type: 'flashcard',
      priority: item.priority,
      percentile: cardPercentiles[item.rem._id] ?? 100,
    });
    addedRemIds.add(item.rem._id);
    if (idx < cardRanked.head) shieldSliceCount++;

    // Card Cluster expansion: bring every due sibling along, cooling or not —
    // a partial cluster breaks the queue experience, and cluster members are
    // meant to be seen together anyway.
    try {
      const parentId = item.rem.parent as RemId | undefined;
      if (parentId) {
        const parentRem = await plugin.rem.findOne(parentId);
        if (parentRem && (await hasCardClusterPowerup(plugin, parentRem))) {
          const siblings = await parentRem.getChildrenRem();
          for (const sibling of siblings ?? []) {
            if (sibling._id === item.rem._id || isBlocked(sibling._id)) continue;
            const siblingEntry = dueCardByRemId.get(sibling._id);
            if (!siblingEntry) continue;
            items.push({
              rem: sibling,
              type: 'flashcard',
              priority: siblingEntry.priority,
              percentile: cardPercentiles[sibling._id] ?? 100,
            });
            addedRemIds.add(sibling._id);
          }
        }
      }
    } catch (clusterErr) {
      console.warn('[CardCluster] Error during cluster expansion:', clusterErr);
    }

    return true;
  };

  let incRemIndex = 0;
  let cardIndex = 0;
  if (typeof cardRatio === 'number') {
    while (items.length < itemCount) {
      let addedThisCycle = false;
      if (incRemIndex < sortedIncRems.length) {
        if (await addIncRem(incRemIndex)) { incRemIndex++; addedThisCycle = true; }
      }
      for (let i = 0; i < cardRatio && items.length < itemCount; i++) {
        if (cardIndex < sortedCards.length) {
          if (await addCard(cardIndex)) { cardIndex++; addedThisCycle = true; }
        }
      }
      if (!addedThisCycle) break;
    }
  } else if (cardRatio === 'no-cards') {
    for (let i = 0; items.length < itemCount && i < sortedIncRems.length; i++) await addIncRem(i);
  } else {
    for (let i = 0; items.length < itemCount && i < sortedCards.length; i++) await addCard(i);
  }

  skippedPausedItems.sort((a, b) => a.priority - b.priority);
  skippedAncestorItems.sort((a, b) => a.priority - b.priority);
  skippedCoolingItems.sort((a, b) => a.priority - b.priority);

  if (skippedPausedItems.length) {
    console.log(`[PRD] ${skippedPausedItems.length} flashcard rems skipped (paused documents):`,
      skippedPausedItems.map((s) => `P${s.priority} — ${s.name} [${s.remId}]`));
  }
  if (skippedAncestorItems.length) {
    console.log(`[PRD] ${skippedAncestorItems.length} flashcard rems held back (due ancestor):`,
      skippedAncestorItems.map((s) => `P${s.priority} — ${s.name} [${s.remId}] ← ${s.level === 1 ? 'parent' : 'grandparent'} "${s.ancestorName}" (${s.ancestorAction})`));
  }
  if (skippedCoolingItems.length) {
    console.log(`[PRD] ${skippedCoolingItems.length} flashcard rems cooling:`,
      skippedCoolingItems.map((s) => `P${s.priority} — ${s.name} [${s.remId}] — ${s.reason}, until ${new Date(s.until).toLocaleDateString()}`));
  }

  const remsWithCards = universeCardInfos.filter((c) => (typeof c.cardCount === 'number' ? c.cardCount : 1) > 0);
  const stats: SelectionStats = {
    scopeName: scopeRem ? (await safeRemTextToString(plugin, scopeRem.text)) || 'Document' : 'Full Knowledge Base',
    scopedIncRems: scopedIncRems.length,
    remsWithCards: remsWithCards.length,
    totalCardsInScope: remsWithCards.reduce((n, c) => n + (typeof c.cardCount === 'number' ? c.cardCount : 1), 0),
    dueIncRems: dueIncRems.length,
    dueCardRems: remsWithCards.filter((c) => (c.dueCards || 0) > 0).length,
    dueCards: remsWithCards.reduce((n, c) => n + (c.dueCards || 0), 0),
  };

  return {
    items,
    skippedPausedItems,
    skippedAncestorItems,
    skippedCoolingItems,
    shieldSliceCount,
    stats,
    randomnessPct: { incRem: Math.round(incRemRandomness * 100), card: Math.round(cardRandomness * 100) },
    cardPercentiles,
    incRemPercentiles,
    priorityByRemId,
  };
}
