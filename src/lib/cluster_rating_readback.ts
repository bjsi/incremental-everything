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
 * HOW: cards are sighted through QueueLoadCard (the card the queue loaded) and RevealAnswer.
 * Inside a cluster, RevealAnswer is the one queue event that fires for every member, with the
 * member's own cardId (checked live on 1.30.5-beta, findings/QUEUE_AND_PRACTICE.md). A member
 * can't be rated before its answer is revealed, so each rated member is sighted before its
 * rating. QueueCompleteCard takes a card off the list, so an ordinary rating costs no read
 * here. The rest are read READ_DELAY_MS after the last sighting. A new rating on a Rem in a
 * cluster is passed to the shared rating handler; any other card that left unrated was
 * skipped, and needs nothing.
 *
 * This used to follow card_info_bar's clusterVisibleCardId broadcast instead, which needs the
 * bar mounted (only on cards with a priority) and polls every 500 ms, so a member rated
 * quickly could go unseen.
 *
 * Known limit: a rating made just before leaving the queue arrives after the session stats
 * were saved.
 */

const READ_DELAY_MS = 1500;
/** Slack for clock skew between a sighting and the rating's stamp in the card's history. */
const SIGHTING_LAG_MS = 2000;

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
  /** The card that may still be rated: the last one loaded or revealed. */
  let currentId: string | undefined;
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
      // The card on screen may still be rated. Inside a cluster QueueLoadCard keeps naming
      // the loaded member while the others pass, so the last reveal decides.
      for (const [cardId, entry] of [...watched]) {
        if (cardId === currentId) continue;
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
    currentId = data?.cardId;
    if (data?.cardId) watch(data.cardId);
    schedule();
  });

  // Fires once per cluster member, before it can be rated. Synchronous: this runs on every
  // reveal of every card, and needs no bridge call.
  plugin.event.addListener(AppEvents.RevealAnswer, undefined, (data: any) => {
    const cardId: string | undefined = data?.cardId;
    if (!cardId) return;
    queueOpen = true;
    currentId = cardId;
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
    currentId = undefined;
    clusterByRem.clear();
    schedule();
  });
}
