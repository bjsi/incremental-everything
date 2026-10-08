import { RNPlugin } from '@remnote/plugin-sdk';
import { hasCardClusterPowerup } from './priority_review_document/cluster';

// Broadcast by card_info_bar for the card it sits under; cleared by
// queue_session on every QueueLoadCard and by the URLChange listener on leaving
// the queue.
const CLUSTER_VISIBLE_CARD_KEY = 'clusterVisibleCardId';

export interface QueueVisibleCard {
  remId: string;
  cardId: string;
}

// Last sibling verdict, so the toolbar badge's 500 ms poll costs no Rem reads
// while the same sibling stays on screen.
let memo: { anchorCardId: string; visibleCardId: string; result: QueueVisibleCard } | undefined;

/**
 * The flashcard actually on screen in the queue.
 *
 * Inside a Card Cluster `plugin.queue.getCurrentCard()` stays pinned to the
 * cluster's anchor card while RemNote walks the siblings, so anything acting on
 * "the current card" would hit the anchor's Rem. card_info_bar is the one widget
 * that sees each sibling, and it broadcasts the card id it is under.
 *
 * That broadcast is only ever used to REFINE getCurrentCard(), never on its own:
 * no current card means undefined, and the broadcast card is accepted only when
 * it belongs to the same Rem as the anchor or to the anchor's own cluster. A
 * value left behind by an earlier card, or by a queue the user has since
 * navigated away from, therefore falls back to the anchor instead of redirecting
 * the caller to an unrelated Rem. Callers still decide from the URL whether the
 * queue is what the user is looking at.
 *
 * Coverage: card_info_bar mounts only on cards carrying the cardPriority
 * powerup, so a cluster sibling without one still resolves to the anchor.
 */
export async function getQueueVisibleCard(plugin: RNPlugin): Promise<QueueVisibleCard | undefined> {
  const anchor = await plugin.queue.getCurrentCard();
  if (!anchor) return undefined;
  const fallback: QueueVisibleCard = { remId: anchor.remId, cardId: anchor._id };

  try {
    const visibleCardId = await plugin.storage.getSession<string>(CLUSTER_VISIBLE_CARD_KEY);
    if (!visibleCardId || visibleCardId === anchor._id) return fallback;
    if (memo && memo.anchorCardId === anchor._id && memo.visibleCardId === visibleCardId) {
      return memo.result;
    }

    const visible = await plugin.card.findOne(visibleCardId);
    let result = fallback;
    if (
      visible?.remId &&
      (visible.remId === anchor.remId || (await shareCluster(plugin, anchor.remId, visible.remId)))
    ) {
      result = { remId: visible.remId, cardId: visibleCardId };
    }
    memo = { anchorCardId: anchor._id, visibleCardId, result };
    return result;
  } catch (e) {
    console.warn('[QueueVisibleCard] Sibling lookup failed; using the current card:', e);
    return fallback;
  }
}

/* Two Rems are in one cluster when a Rem both of them are, or sit directly
   under, carries the Card Cluster powerup — the anchor may be a member or the
   cluster Rem itself. */
async function shareCluster(plugin: RNPlugin, remIdA: string, remIdB: string): Promise<boolean> {
  const [a, b] = await Promise.all([plugin.rem.findOne(remIdA), plugin.rem.findOne(remIdB)]);
  if (!a || !b) return false;
  const familyB = new Set([b._id, b.parent].filter((id): id is string => !!id));
  const shared = [a._id, a.parent].filter((id): id is string => !!id && familyB.has(id));
  for (const id of shared) {
    const candidate = id === a._id ? a : id === b._id ? b : await plugin.rem.findOne(id);
    if (candidate && (await hasCardClusterPowerup(plugin, candidate))) return true;
  }
  return false;
}
