import { AppEvents, PluginRem, QueueInteractionScore, RemId, RNPlugin } from '@remnote/plugin-sdk';
import { hasCardClusterPowerup } from './priority_review_document/cluster';
import { isNativeDrillActive } from './mastery_drill_native';

/**
 * Card Cluster ratings, read back from each card's history once it has left the screen.
 *
 * WHY: a cluster member's rating fires no QueueCompleteCard (findings/QUEUE_AND_PRACTICE.md).
 * GlobalRemChanged only names the practiced document or a deck, is skipped for an Again on a
 * card that was not due, and by the time it arrives on a cluster's last sibling the queue has
 * moved on. The card's repetitionHistory is the one reliable record.
 *
 * HOW: cards come on screen through QueueLoadCard (a cluster's anchor) and the
 * clusterVisibleCardId broadcast (each sibling). QueueCompleteCard takes a card off the list,
 * so an ordinary rating costs no read here. The rest are read READ_DELAY_MS after the last
 * card change. A new rating on a Rem in a cluster is passed to the shared rating handler; any
 * other card that left unrated was skipped, and needs nothing.
 *
 * Known limits: a sibling rated before the widget's 500 ms poll reported it is not seen, and
 * a rating made just before leaving the queue arrives after the session stats were saved.
 */

const READ_DELAY_MS = 1500;
/** The widget reports a sibling up to its poll interval late, so a rating can predate its sighting. */
const SIGHTING_LAG_MS = 2000;
const CLUSTER_VISIBLE_CARD_KEY = 'clusterVisibleCardId';

export interface ReadBackRating {
  score: QueueInteractionScore;
  date: number;
  responseTime?: number;
}

export interface ClusterRating {
  cardId: string;
  remId: RemId;
  rem: PluginRem;
  rating: ReadBackRating;
  /** The regular-queue drill reads its own cards back (mastery_drill_native), list included. */
  drillHandledElsewhere: boolean;
  /** False once the queue closed: its seen list was already saved and reset. */
  queueOpen: boolean;
}

/** The rating to apply from a card's history: its last real answer, if not yet accounted for. */
export function newRatingOf(
  history: ReadonlyArray<ReadBackRating> | undefined,
  notBefore: number,
  settledAt: number
): ReadBackRating | null {
  for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
    const rep = history![i];
    if (rep.score === QueueInteractionScore.TOO_EARLY) continue;
    return rep.date >= notBefore && rep.date > settledAt ? rep : null;
  }
  return null;
}

async function isClusterMember(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  if (await hasCardClusterPowerup(plugin, rem)) return true;
  const parent = rem.parent ? await plugin.rem.findOne(rem.parent) : null;
  return !!parent && hasCardClusterPowerup(plugin, parent);
}

export function registerClusterRatingReadback(
  plugin: RNPlugin,
  apply: (rating: ClusterRating) => Promise<void>
) {
  const watched = new Map<string, { since: number; nativeDrill: boolean }>();
  /** Per card, the time up to which its ratings are already accounted for. */
  const settled = new Map<string, number>();
  const clusterByRem = new Map<RemId, boolean>();
  let anchorId: string | undefined;
  let visibleId: string | undefined;
  let queueOpen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;

  const watch = (cardId: string) => {
    if (!watched.has(cardId)) watched.set(cardId, { since: Date.now(), nativeDrill: isNativeDrillActive() });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void readBack();
    }, READ_DELAY_MS);
  };

  const applyIfCluster = async (
    card: NonNullable<Awaited<ReturnType<RNPlugin['card']['findOne']>>>,
    entry: { since: number; nativeDrill: boolean }
  ) => {
    const rating = newRatingOf(card.repetitionHistory, entry.since - SIGHTING_LAG_MS, settled.get(card._id) ?? 0);
    if (!rating) return;
    settled.set(card._id, rating.date);
    const rem = await plugin.rem.findOne(card.remId);
    if (!rem) return;
    let isCluster = clusterByRem.get(rem._id);
    if (isCluster === undefined) {
      isCluster = await isClusterMember(plugin, rem);
      clusterByRem.set(rem._id, isCluster);
    }
    if (!isCluster) return;
    await apply({
      cardId: card._id,
      remId: rem._id,
      rem,
      rating,
      drillHandledElsewhere: entry.nativeDrill,
      queueOpen,
    });
  };

  const readBack = async () => {
    if (reading) return schedule();
    reading = true;
    try {
      // The card on screen may still be rated. Inside a cluster the anchor stays named by
      // QueueLoadCard while the siblings pass, so only the widget's card counts as current.
      const current = visibleId ?? anchorId;
      for (const [cardId, entry] of [...watched]) {
        if (cardId === current) continue;
        watched.delete(cardId);
        try {
          const card = await plugin.card.findOne(cardId);
          if (card) await applyIfCluster(card, entry);
        } catch (e) {
          console.warn(`[ClusterRatings] could not read ${cardId} back:`, e);
        }
      }
    } finally {
      reading = false;
    }
  };

  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, (data: any) => {
    queueOpen = true;
    anchorId = data?.cardId;
    visibleId = undefined;
    if (data?.cardId) watch(data.cardId);
    schedule();
  });

  plugin.event.addListener(AppEvents.StorageSessionChange, CLUSTER_VISIBLE_CARD_KEY, async () => {
    const cardId = await plugin.storage.getSession<string>(CLUSTER_VISIBLE_CARD_KEY);
    if (!queueOpen || !cardId) return;
    visibleId = cardId;
    watch(cardId);
    schedule();
  });

  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, (data: any) => {
    const cardId: string | undefined = data?.cardId;
    if (!cardId) return;
    watched.delete(cardId);
    settled.set(cardId, Date.now());
  });

  plugin.event.addListener(AppEvents.QueueExit, undefined, () => {
    queueOpen = false;
    anchorId = undefined;
    visibleId = undefined;
    clusterByRem.clear();
    schedule();
  });
}
