/**
 * The live shields shown in the queue bars: the Priority Shield (IncRems +
 * cards, see unified_shield.ts) and its two sides. Shared by the IncRem bar
 * (answer_buttons.tsx) and the flashcard bar (card_info_bar.tsx) so both show
 * the same number, computed with the same rules as the history saved at
 * QueueExit:
 *
 * - card side: due before the start of today, unseen this session, and not
 *   cooling (cooling only decides who sets the shield, never the ranking);
 * - IncRem side: due now and unseen this session.
 *
 * The item on screen always counts as still pending, so the value does not
 * move the moment it is graded.
 */
import { CardPriorityInfo, PerCardShieldItem, expandCardInfosToCards, isPerCardDue } from './card_priority/types';
import type { IncrementalRem } from './incremental_rem';
import { UnifiedShieldEntry, computeUnifiedShield } from './unified_shield';
import { calculateVolumeBasedPercentile } from './shield_math';

/**
 * The per-CARD universe, built once per cache version. Keyed by the cache
 * array's identity: a new cache write is a new array, so it never goes stale.
 */
const perCardUniverseCache = new WeakMap<object, PerCardShieldItem[]>();
export function perCardUniverse(infos: CardPriorityInfo[]): PerCardShieldItem[] {
  let universe = perCardUniverseCache.get(infos);
  if (!universe) {
    universe = expandCardInfosToCards(infos);
    perCardUniverseCache.set(infos, universe);
  }
  return universe;
}

export function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface LiveShieldSlice {
  absolute: number;
  percentile: number | undefined;
}

export interface LiveShieldContext {
  /** Every IncRem in the KB (allIncrementalRemKey). */
  allIncRems: IncrementalRem[];
  /** IncRems due at QueueEnter (sessionCache.dueIncRemsInKB / InScope). */
  dueIncRemsKb: IncrementalRem[];
  dueIncRemsDoc: IncrementalRem[];
  seenRemIds: ReadonlySet<string>;
  /** Every Rem-with-cards (allCardPriorityInfoKey). */
  allCardInfos: CardPriorityInfo[];
  /** Cards overdue at QueueEnter (sessionCache.overdueCardsInKB / InScope). */
  overdueCardsKb: CardPriorityInfo[];
  overdueCardsDoc: CardPriorityInfo[];
  seenCardRemIds: ReadonlySet<string>;
  coolingRemIds: ReadonlySet<string>;
  /** priorityCalcScopeRemIdsKey; null outside a document queue. */
  scopeRemIds: ReadonlySet<string> | null;
  /** The IncRem on screen (IncRem bar), if any. */
  currentIncRemId?: string;
  /** The Rem whose card is on screen (flashcard bar), if any. */
  currentCardRemId?: string;
  computeWeighted?: boolean;
  /**
   * False skips the Priority Shield (and the joint list): the flashcard bar
   * showing the Card Shield needs only the card side. Default true.
   */
  unified?: boolean;
}

export interface LiveShieldScope {
  incRem: number | null;
  card: number | null;
  unified: UnifiedShieldEntry | null;
  /** The card-only percentile (flashcard bar). */
  cardPercentile: number | undefined;
}

export interface LiveShields {
  kb: LiveShieldScope;
  doc: LiveShieldScope | null;
  /** Joint items with their pending flag, for the Weighted Shield popup. */
  jointKb: JointItem[];
  jointDoc: JointItem[] | null;
}

export type JointItem = { priority: number; remId: string; due: boolean };

const minPriority = <T extends { priority: number; remId: string }>(
  list: T[],
  canSet: (item: T) => boolean
): number | null => {
  let best: number | null = null;
  for (const item of list) {
    if ((best === null || item.priority < best) && canSet(item)) best = item.priority;
  }
  return best;
};

export function computeLiveShields(c: LiveShieldContext): LiveShields {
  const now = Date.now();
  const startOfToday = startOfTodayMs();

  const incRemPending = (r: IncrementalRem) =>
    now >= r.nextRepDate && (!c.seenRemIds.has(r.remId) || r.remId === c.currentIncRemId);
  const cardPending = (item: PerCardShieldItem) =>
    isPerCardDue(item, startOfToday) &&
    (!c.seenCardRemIds.has(item.remId) || item.remId === c.currentCardRemId);

  const incRemCanSet = (r: IncrementalRem) =>
    !c.seenRemIds.has(r.remId) || r.remId === c.currentIncRemId;
  const cardCanSet = (info: CardPriorityInfo) =>
    (!c.seenCardRemIds.has(info.remId) && !c.coolingRemIds.has(info.remId)) ||
    info.remId === c.currentCardRemId;

  const cards = perCardUniverse(c.allCardInfos);

  const scopeOf = (
    incRems: IncrementalRem[],
    scopeCards: PerCardShieldItem[],
    dueIncRems: IncrementalRem[],
    overdueCards: CardPriorityInfo[]
  ): { scope: LiveShieldScope; joint: JointItem[] } => {
    const incRem = minPriority(dueIncRems, incRemCanSet);
    const card = minPriority(overdueCards, cardCanSet);
    const wantUnified = c.unified !== false;
    const unified =
      wantUnified && incRems.length + scopeCards.length > 0
        ? computeUnifiedShield({
            incRems,
            isIncRemDue: incRemPending,
            cards: scopeCards,
            isCardDue: cardPending,
            incRemAbsolute: incRem,
            cardAbsolute: card,
            computeWeighted: c.computeWeighted,
          })
        : null;
    const cardPercentile =
      card !== null && scopeCards.length > 0
        ? calculateVolumeBasedPercentile(scopeCards, card, cardPending)
        : undefined;
    const joint: JointItem[] = [];
    if (wantUnified && c.computeWeighted) {
      for (const r of incRems) joint.push({ priority: r.priority, remId: r.remId, due: incRemPending(r) });
      for (const x of scopeCards) joint.push({ priority: x.priority, remId: x.remId, due: cardPending(x) });
    }
    return { scope: { incRem, card, unified, cardPercentile }, joint };
  };

  const kb = scopeOf(c.allIncRems, cards, c.dueIncRemsKb, c.overdueCardsKb);

  let doc: ReturnType<typeof scopeOf> | null = null;
  if (c.scopeRemIds) {
    const scope = c.scopeRemIds;
    doc = scopeOf(
      c.unified === false ? [] : c.allIncRems.filter((r) => scope.has(r.remId)),
      cards.filter((x) => scope.has(x.remId)),
      c.dueIncRemsDoc,
      c.overdueCardsDoc
    );
  }

  return {
    kb: kb.scope,
    doc: doc?.scope ?? null,
    jointKb: kb.joint,
    jointDoc: doc?.joint ?? null,
  };
}
