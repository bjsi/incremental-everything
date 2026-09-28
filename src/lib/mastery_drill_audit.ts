// lib/mastery_drill_audit.ts
//
// What is actually in the Mastery Drill, card by card, and whether RemNote will
// serve each one.
//
// WHY THIS EXISTS
//
// The drill hands its card ids to RemNote's embedded <Queue>, and that queue
// silently drops any id it cannot practise. So a drill whose only card was
// deleted reads "1 Remaining" in the toolbar and "You've finished practicing
// all your cards!" underneath, with nothing to say which card or why. This
// resolves every drill item into a status the list view can show and act on.
//
// HOW A CARD IS JUDGED
//
// `rem.getCards()` is the "currently surfaced" filter (findings/CARD_STATE_REFERENCE.md):
// a card present there is practicable, whatever else is true. Only when it is
// absent do the Rem-level causes get read, in the same precedence
// card_enablement/scan.ts#classifyRow uses — an ancestor that disables cards
// outranks the Rem's own switch, because flipping the switch under it would
// change nothing. The ancestor walk goes through the same memoised
// AncestorChainCache, so drill cards filed under one document share one walk.

import { BuiltInPowerupCodes, QueueInteractionScore, RNPlugin } from '@remnote/plugin-sdk';
import { AncestorChainCache, formatBreadcrumb } from './card_enablement/scan';
import { clozeIdOfCard, collectClozeIds, directionEnabled } from './card_analytics_export';
import { getCardPriority } from './card_priority';
import { CardPriorityInfo } from './card_priority/types';

export type FinalDrillItem = string | { cardId: string; kbId?: string; addedAt?: number };

export const drillItemCardId = (item: FinalDrillItem): string =>
  typeof item === 'string' ? item : item.cardId;

/** Legacy string items predate KB tagging and belong to the primary KB. */
export const isDrillItemInKb = (item: FinalDrillItem, currentKbId: string, isPrimary: boolean): boolean =>
  typeof item === 'string' ? isPrimary : item.kbId === currentKbId;

export type DrillCardStatus =
  /** RemNote surfaces the card; the drill can serve it. */
  | 'ok'
  /** Surfaced, but the last real rating was Good or Easy — it should have left the drill. */
  | 'rated-good'
  /** Surfaced, but under a paused deck. */
  | 'in-paused-deck'
  /** No card record: deleted with its Rem, or its cloze / back side was edited away. */
  | 'card-missing'
  /** The card record survives but its Rem does not. */
  | 'rem-missing'
  | 'disabled-by-ancestor'
  | 'in-table'
  | 'practice-off'
  /** A forward/backward card whose direction is no longer enabled on the Rem. */
  | 'direction-off'
  /** The cloze or back side this card came from is no longer in the Rem. */
  | 'markup-removed'
  /** Markup intact, nothing Rem-wide explains it: switched off one card at a time. */
  | 'cloze-disabled'
  | 'not-surfaced';

export const DRILL_STATUS_LABELS: Record<DrillCardStatus, string> = {
  ok: 'OK',
  'rated-good': 'Last rated Good',
  'in-paused-deck': 'Paused deck',
  'card-missing': 'Card deleted',
  'rem-missing': 'Rem deleted',
  'disabled-by-ancestor': 'Disabled by ancestor',
  'in-table': 'In a table',
  'practice-off': 'Cards off on Rem',
  'direction-off': 'Direction off',
  'markup-removed': 'Cloze/back removed',
  'cloze-disabled': 'Card switched off',
  'not-surfaced': 'Not surfaced',
};

/** Why the status matters and what to do about it — the row's tooltip. */
export const DRILL_STATUS_HINTS: Record<DrillCardStatus, string> = {
  ok: 'RemNote will serve this card in the drill.',
  'rated-good':
    'Its last rating was Good or Easy, so it should already have left the drill. Remove it, or run “Mastery Drill: Remove cards whose last rating was Good or Easy”.',
  'in-paused-deck': 'It sits inside a paused deck. Unpause the deck, or remove the card from the drill.',
  'card-missing':
    'The card no longer exists — its Rem was deleted, or the cloze or back side it came from was edited away. RemNote cannot show it, so it only inflates the count. Remove it.',
  'rem-missing': 'The card record survives but its Rem is gone. RemNote cannot show it. Remove it.',
  'disabled-by-ancestor': 'An ancestor carries “Disable Descendant Cards”, so RemNote will not show this card.',
  'in-table': 'The Rem is in a table, where RemNote ships cards switched off.',
  'practice-off': '“Enable Cards” is off on the Rem, so RemNote will not show this card.',
  'direction-off': 'The Rem’s flashcard direction no longer includes this card’s direction.',
  'markup-removed': 'The cloze or back side this card was generated from is no longer in the Rem.',
  'cloze-disabled':
    'This card was switched off on its own. Open the Rem and click the greyed cloze → “Enable this card”, or run /Enable All Cloze Cards.',
  'not-surfaced': 'RemNote does not surface this card and no Rem-level cause explains it.',
};

/** Statuses under which the embedded queue will never present the card. */
export const UNPLAYABLE_STATUSES: ReadonlySet<DrillCardStatus> = new Set<DrillCardStatus>([
  'card-missing',
  'rem-missing',
  'disabled-by-ancestor',
  'in-table',
  'practice-off',
  'direction-off',
  'markup-removed',
  'cloze-disabled',
  'not-surfaced',
]);

export interface DrillCardAudit {
  cardId: string;
  addedAt: number | null;
  status: DrillCardStatus;
  remId: string | null;
  /** The card record, when it still exists — for labelling. */
  card: any | null;
  rem: any | null;
  breadcrumb: string;
  lastScore: QueueInteractionScore | null;
  lastRatedAt: number | null;
  priority: CardPriorityInfo | null;
}

/** The last rating that was a real answer, ignoring Too Early taps. */
function lastMeaningfulRep(card: any): { score: QueueInteractionScore; date: number } | null {
  const history: any[] = card?.repetitionHistory ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].score !== QueueInteractionScore.TOO_EARLY) return history[i];
  }
  return null;
}

/**
 * Resolve one drill item. `chains` is shared across a whole list so cards under
 * the same document walk their ancestors once.
 */
export async function auditDrillItem(
  plugin: RNPlugin,
  item: FinalDrillItem,
  chains: AncestorChainCache,
): Promise<DrillCardAudit> {
  const cardId = drillItemCardId(item);
  const base: DrillCardAudit = {
    cardId,
    addedAt: typeof item === 'string' ? null : item.addedAt ?? null,
    status: 'card-missing',
    remId: null,
    card: null,
    rem: null,
    breadcrumb: '',
    lastScore: null,
    lastRatedAt: null,
    priority: null,
  };

  const card: any = await plugin.card.findOne(cardId).catch(() => null);
  if (!card) return base;

  const last = lastMeaningfulRep(card);
  const withCard: DrillCardAudit = {
    ...base,
    card,
    remId: card.remId ?? null,
    lastScore: last?.score ?? null,
    lastRatedAt: last?.date ?? null,
  };

  const rem: any = card.remId ? await plugin.rem.findOne(card.remId).catch(() => null) : null;
  if (!rem) return { ...withCard, status: 'rem-missing' };

  const [surfaced, chain, priority] = await Promise.all([
    rem.getCards().catch(() => [] as any[]),
    chains.forParentOf(rem),
    getCardPriority(plugin, rem).catch(() => null),
  ]);
  const resolved: DrillCardAudit = {
    ...withCard,
    rem,
    breadcrumb: formatBreadcrumb(chain.names),
    priority,
  };

  if ((surfaced as any[]).some((c) => c?._id === cardId)) {
    if (chain.pausedAncestorId) return { ...resolved, status: 'in-paused-deck' };
    const ratedGood =
      last?.score === QueueInteractionScore.GOOD || last?.score === QueueInteractionScore.EASY;
    return { ...resolved, status: ratedGood ? 'rated-good' : 'ok' };
  }

  if (chain.disablingAncestorId) return { ...resolved, status: 'disabled-by-ancestor' };

  const [enablePractice, practiceDirection, disableCardsOwn, isTableOwn] = await Promise.all([
    rem.getEnablePractice().catch(() => null),
    rem.getPracticeDirection().catch(() => null),
    rem.hasPowerup(BuiltInPowerupCodes.DisableCards).catch(() => false),
    rem.isTable().catch(() => false),
  ]);

  // Tables report enablePractice === false natively, so they are told apart
  // before the deliberate switch-off — same order as classifyRow.
  if (isTableOwn || chain.inTable) return { ...resolved, status: 'in-table' };
  if (enablePractice === false || disableCardsOwn) return { ...resolved, status: 'practice-off' };

  const clozeId = clozeIdOfCard(card);
  if (clozeId) {
    const inText =
      collectClozeIds(rem.text).has(clozeId) || collectClozeIds(rem.backText).has(clozeId);
    return { ...resolved, status: inText ? 'cloze-disabled' : 'markup-removed' };
  }

  const cardType = String(card.type);
  if (directionEnabled(practiceDirection, cardType) === false) {
    return { ...resolved, status: 'direction-off' };
  }
  const hasBackText = Array.isArray(rem.backText) && rem.backText.length > 0;
  if ((cardType === 'forward' || cardType === 'backward') && !hasBackText) {
    return { ...resolved, status: 'markup-removed' };
  }
  return { ...resolved, status: 'not-surfaced' };
}
