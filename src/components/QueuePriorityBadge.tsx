import { usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useEffect, useState } from 'react';
import { PriorityBadge } from './PriorityBadge';
import {
  displayQueueToolbarPriorityId,
  allIncrementalRemSlimKey,
  allCardPriorityInfoKey,
  currentIncRemKey,
  pendingCardPriorityKey,
} from '../lib/consts';
import { CardPriorityInfo, estimateCardRemPercentile, getCardPriority } from '../lib/card_priority';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import type { SlimIncRem } from '../lib/incremental_rem/cache';
import { getPendingCacheUpdate } from '../lib/card_priority/cache';
import { PendingCardPriority, pendingCardPriorityFor } from '../lib/card_priority/pending_priority';
import { calculateRelativePercentileAt } from '../lib/utils';
import { getEffectivePerformanceMode } from '../lib/mobileUtils';
import { useIESetting } from '../lib/settings';
import { getQueueVisibleCard } from '../lib/queue_visible_card';

/**
 * The current queue item's priority badge; click opens the priority popup.
 * Shared by the Compact queue's toolbar widget and the Beautiful queue's
 * below-top-bar widget.
 *
 * @param active false stops the 500ms card poll and renders nothing — for an
 *   instance the host has hidden (see useHostShown).
 */
export function QueuePriorityBadge({ active = true }: { active?: boolean }) {
  const plugin = usePlugin();

  const isEnabled = useIESetting(displayQueueToolbarPriorityId);

  // We explicitly track currentIncRemKey to trigger re-renders at least when an IncRem changes
  const currentIncRemIdTracker = useTrackerPlugin(
    (rp) => rp.storage.getSession<string>(currentIncRemKey),
    []
  );

  const [polledCardRemId, setPolledCardRemId] = useState<string | undefined>();

  useEffect(() => {
    if (!active) return;
    let isMounted = true;
    const checkCard = async () => {
      try {
        // Cluster-aware: follows the sibling on screen, not the cluster's anchor card.
        const card = await getQueueVisibleCard(plugin);
        if (isMounted) setPolledCardRemId(card?.remId);
      } catch (e) {
        // ignore
      }
    };

    checkCard();
    const intervalId = setInterval(checkCard, 500);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [plugin, active]);

  const contextData = useTrackerPlugin(async (rp) => {
    let remId: string | undefined = polledCardRemId;

    // Fallback to Incremental Rem state (useful during queue transitions)
    if (!remId) {
      remId = await rp.storage.getSession<string>(currentIncRemKey) ?? undefined;
    }

    if (!remId) return null;

    const rem = await rp.rem.findOne(remId);
    if (!rem) return null;

    const incRemInfo = await getIncrementalRemFromRem(rp, rem);

    return { rem, incRemInfo };
  }, [polledCardRemId, currentIncRemIdTracker]);

  const effectiveMode = useTrackerPlugin(
    async (rp) => await getEffectivePerformanceMode(rp),
    []
  );
  const useLightMode = effectiveMode === 'light';

  // Incremental data. The slim projection: ranking needs only remId + priority,
  // and the full key is ~8MB on a large KB.
  const allIncRems = useTrackerPlugin(
    (rp) => rp.storage.getSession<SlimIncRem[]>(allIncrementalRemSlimKey),
    []
  ) || [];

  // What a priority popup just saved, until the tracker's cache write catches up.
  const pendingCardPriority = useTrackerPlugin(
    (rp) => rp.storage.getSession<PendingCardPriority>(pendingCardPriorityKey),
    []
  );

  // Card cache data
  const allPrioritizedCardInfo = useTrackerPlugin(
    async (rp) => {
      if (useLightMode) return null;
      const cache = await rp.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey);
      return cache ? [...cache] : [];
    },
    [useLightMode]
  );

  // Card light data
  const lightCardInfo = useTrackerPlugin(async (rp) => {
    if (!contextData?.rem || contextData.incRemInfo) return null;
    if (!useLightMode && allPrioritizedCardInfo?.find(info => info.remId === contextData.rem._id)) {
      return null;
    }
    const pendingInfo = getPendingCacheUpdate(contextData.rem._id);
    if (pendingInfo) return pendingInfo;
    return await getCardPriority(rp, contextData.rem);
  }, [useLightMode, contextData?.rem, contextData?.incRemInfo, allPrioritizedCardInfo]);


  if (!active || !isEnabled || !contextData) return null;

  const { rem, incRemInfo } = contextData;

  let priority: number | undefined;
  let percentile: number | undefined | null;
  let source: string | undefined;

  if (incRemInfo) {
    priority = incRemInfo.priority;
    source = 'incremental';
    if (!useLightMode && allIncRems.length > 0) {
      // Ranked at the priority read from the Rem, which the tracker writes before
      // it rewrites the cache.
      percentile = calculateRelativePercentileAt(allIncRems, incRemInfo.remId, incRemInfo.priority);
    }
  } else {
    // Card logic
    const cardCacheInfo = allPrioritizedCardInfo?.find(info => info.remId === rem._id);
    const baseCardInfo = cardCacheInfo || lightCardInfo;
    const pending = pendingCardPriorityFor(pendingCardPriority, rem._id, baseCardInfo);

    if (baseCardInfo) {
      priority = pending?.priority ?? baseCardInfo.priority;
      source = pending?.source ?? baseCardInfo.source;
      if (!useLightMode && cardCacheInfo) {
        // The cached kbPercentile was ranked with the old priority; estimate the
        // new one's place until the cache catches up.
        percentile = priority !== cardCacheInfo.priority && allPrioritizedCardInfo
          ? estimateCardRemPercentile(allPrioritizedCardInfo, rem._id, priority)
          : cardCacheInfo.kbPercentile;
      }
    }
  }

  if (priority === undefined) return null;

  // Render similar to how PriorityBadge expects compact mode with useAbsoluteColoring fallback
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0.5rem 0',
        margin: '0 0.5rem',
        cursor: 'pointer',
      }}
      onClick={async () => {
        await plugin.widget.openPopup('priority', { remId: rem._id });
      }}
      title="Click to change priority for this item"
    >
      <PriorityBadge
        priority={priority}
        percentile={percentile === null ? undefined : percentile}
        compact
        useAbsoluteColoring={useLightMode || (percentile === null || percentile === undefined)}
        source={source}
        isCardPriority={!incRemInfo}
      />
    </div>
  );
}
