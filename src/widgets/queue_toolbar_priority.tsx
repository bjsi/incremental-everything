import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useEffect, useState } from 'react';
import { PriorityBadge } from '../components';
import {
  displayQueueToolbarPriorityId,
  allIncrementalRemKey,
  allCardPriorityInfoKey,
  currentIncRemKey,
} from '../lib/consts';
import { CardPriorityInfo, getCardPriority } from '../lib/card_priority';
import { getIncrementalRemFromRem, IncrementalRem } from '../lib/incremental_rem';
import { getPendingCacheUpdate } from '../lib/card_priority/cache';
import { calculateRelativePercentile } from '../lib/utils';
import { getEffectivePerformanceMode } from '../lib/mobileUtils';

function QueueToolbarPriority() {
  const plugin = usePlugin();

  const isEnabled = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(displayQueueToolbarPriorityId),
    []
  ) ?? true;

  // We explicitly track currentIncRemKey to trigger re-renders at least when an IncRem changes
  const currentIncRemIdTracker = useTrackerPlugin(
    (rp) => rp.storage.getSession<string>(currentIncRemKey),
    []
  );

  const [polledCardRemId, setPolledCardRemId] = useState<string | undefined>();

  useEffect(() => {
    let isMounted = true;
    const checkCard = async () => {
      try {
        const card = await plugin.queue.getCurrentCard();
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
  }, [plugin]);

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

  // Incremental data
  const allIncRems = useTrackerPlugin(
    (rp) => rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
    []
  ) || [];

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


  if (!isEnabled || !contextData) return null;

  const { rem, incRemInfo } = contextData;

  let priority: number | undefined;
  let percentile: number | undefined | null;
  let source: string | undefined;

  if (incRemInfo) {
    priority = incRemInfo.priority;
    source = 'incremental';
    if (!useLightMode && allIncRems.length > 0) {
       percentile = calculateRelativePercentile(allIncRems, incRemInfo.remId);
    }
  } else {
    // Card logic
    const cardCacheInfo = allPrioritizedCardInfo?.find(info => info.remId === rem._id);
    const finalCardInfo = cardCacheInfo || lightCardInfo;
    
    if (finalCardInfo) {
      priority = finalCardInfo.priority;
      source = finalCardInfo.source;
      if (!useLightMode && cardCacheInfo) {
        percentile = cardCacheInfo.kbPercentile;
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
        padding: '0 8px',
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

renderWidget(QueueToolbarPriority);
