import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React, { useMemo } from 'react';
import {
  powerupCode,
  allCardPriorityInfoKey,
  queueSessionCacheKey,
  cardPriorityCacheRefreshKey,
  displayPriorityShieldId,
  seenCardInSessionKey,
  priorityCalcScopeRemIdsKey,
} from '../lib/consts';
import { CardPriorityInfo, QueueSessionCache, getCardPriority } from '../lib/card_priority';
import { PERFORMANCE_MODE_LIGHT, calculateVolumeBasedPercentile } from '../lib/utils';
import { getEffectivePerformanceMode } from '../lib/mobileUtils';
import { PriorityBadge } from '../components';
import * as _ from 'remeda';

type ShieldSlice = {
  absolute: number;
  percentile: number | undefined;
};

type ShieldStatus = {
  kb: ShieldSlice | null;
  doc: ShieldSlice | null;
} | null;

/**
 * Compute the shield status using pre-filtered session cache data.
 * Falls back to the main cache only when percentiles are missing.
 */
function computeShieldStatus(
  remId: string | undefined,
  sessionCache: QueueSessionCache | null,
  allPrioritizedCardInfo: CardPriorityInfo[] | null,
  seenRemIds: string[],
  scopeRemIds: string[] | null
): ShieldStatus {
  if (!remId || !sessionCache) return null;

  const filterUnreviewed = (list: CardPriorityInfo[]) =>
    list.filter((info) => !seenRemIds.includes(info.remId) || info.remId === remId);

  const topMissedInKb = _.minBy(filterUnreviewed(sessionCache.dueCardsInKB), (info) => info.priority);
  const topMissedInDoc = _.minBy(filterUnreviewed(sessionCache.dueCardsInScope), (info) => info.priority);

  const predicate = (info: CardPriorityInfo) => info.dueCards > 0 && (!seenRemIds.includes(info.remId) || info.remId === remId);

  let kbPercentile: number | undefined;
  if (topMissedInKb && allPrioritizedCardInfo) {
    kbPercentile = calculateVolumeBasedPercentile(
      allPrioritizedCardInfo,
      topMissedInKb.priority,
      predicate
    );
    // console.log(`[Display] KB Shield: Priority ${topMissedInKb.priority}, Percentile ${kbPercentile}%, Universe ${allPrioritizedCardInfo.length}`);
  }

  let docPercentile: number | undefined;
  if (topMissedInDoc && allPrioritizedCardInfo && scopeRemIds) {
    const scopeSet = new Set(scopeRemIds);
    const allCardsInScope = allPrioritizedCardInfo.filter(c => scopeSet.has(c.remId));
    if (allCardsInScope.length > 0) {
      docPercentile = calculateVolumeBasedPercentile(
        allCardsInScope,
        topMissedInDoc.priority,
        predicate
      );
      console.log(`[Display] Doc Shield: Priority ${topMissedInDoc.priority}, Percentile ${docPercentile}%, Universe ${allCardsInScope.length}`);
    }
  }

  if (topMissedInKb && kbPercentile !== undefined) {
    console.log(`[CardPriorityShield] KB Shield: Priority ${topMissedInKb.priority}, Percentile ${kbPercentile}%, Universe ${allPrioritizedCardInfo?.length}`);
  }

  return {
    kb: topMissedInKb
      ? {
        absolute: topMissedInKb.priority,
        percentile: kbPercentile,
      }
      : null,
    doc:
      topMissedInDoc && docPercentile !== undefined
        ? {
          absolute: topMissedInDoc.priority,
          percentile: docPercentile,
        }
        : null,
  };
}

export function CardPriorityDisplay() {
  // console.log('[CardPriorityDisplay] Mounting/Rendering');
  const plugin = usePlugin();

  // ✅ Use the centralized function that handles mobile AND web detection
  const effectiveMode = useTrackerPlugin(
    async (rp) => await getEffectivePerformanceMode(rp),
    []
  );

  const useLightMode = effectiveMode === PERFORMANCE_MODE_LIGHT;

  // ✅ Get the display priority shield setting
  const displayPriorityShield = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(displayPriorityShieldId),
    []
  ) ?? true;

  // 2. Add a new tracker to listen for the refresh signal.
  const refreshSignal = useTrackerPlugin(
    (rp) => rp.storage.getSession(cardPriorityCacheRefreshKey),
    []
  );

  const seenCardIds = useTrackerPlugin(
    (rp) => rp.storage.getSession<string[]>(seenCardInSessionKey),
    [refreshSignal]
  ) ?? [];

  const rem = useTrackerPlugin(async (rp) => {
    const ctx = await rp.widget.getWidgetContext<WidgetLocation.FlashcardAnswerButtons>();
    if (!ctx?.remId) {
      return null;
    }
    return (await rp.rem.findOne(ctx.remId)) ?? null;
  }, []);

  const scopeRemIds = useTrackerPlugin(
    (rp) => rp.storage.getSession<string[] | null>(priorityCalcScopeRemIdsKey),
    []
  );




  // --- 🔌 CACHE-BASED PATH (Full Mode) ---
  const sessionCache = useTrackerPlugin(
    async (rp) => {
      if (useLightMode) {
        return null;
      }
      const cache = await rp.storage.getSession<QueueSessionCache>(queueSessionCacheKey);
      return cache ?? null;
    },
    [useLightMode, refreshSignal]
  );

  const allPrioritizedCardInfo = useTrackerPlugin(
    async (rp) => {
      if (useLightMode) {
        return null;
      }
      const cache = await rp.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey);
      return cache ?? [];
    },
    [useLightMode, refreshSignal]
  );

  const cardInfo = useMemo(() => {
    if (useLightMode || !rem || !allPrioritizedCardInfo) {
      return null;
    }
    return allPrioritizedCardInfo.find(info => info.remId === rem._id);
  }, [rem, allPrioritizedCardInfo, useLightMode]);

  const docPercentile = useMemo(() => {
    if (useLightMode || !rem || !sessionCache?.docPercentiles) return null;
    return sessionCache.docPercentiles[rem._id];
  }, [rem, sessionCache, useLightMode]);


  // --- REWRITTEN: The Shield calculation is now ultra-fast ---
  // It reads from the small, pre-filtered lists in our new session cache.
  // Percentiles are looked up from the main cache to stay fresh.
  const shieldStatus = useMemo(() => {
    if (useLightMode || !rem || !sessionCache) return null;
    return computeShieldStatus(rem._id, sessionCache, allPrioritizedCardInfo, seenCardIds, scopeRemIds);
  }, [rem, sessionCache, useLightMode, allPrioritizedCardInfo, seenCardIds, scopeRemIds]);


  // --- 🔌 ON-DEMAND PATH (Light Mode) ---
  const lightCardInfo = useTrackerPlugin(async (rp) => {
    if (!useLightMode || !rem) return null;
    // Fetch priority directly, on-demand. This is fast for a single rem.
    return await getCardPriority(rp, rem);
  }, [useLightMode, rem, refreshSignal]);


  // --- 🔌 COMBINE RESULTS ---
  const finalCardInfo = useLightMode ? lightCardInfo : cardInfo;

  // console.log('[CardPriorityDisplay] Critical State Check:', {
  //   remId: rem?._id,
  //   useLightMode,
  //   hasFinalCardInfo: !!finalCardInfo,
  //   allPrioritizedCardInfoLength: allPrioritizedCardInfo?.length,
  //   sessionCachePresent: !!sessionCache,
  //   effectiveMode
  // });

  // Widget behaves according to QueueItemType.Flashcard filter (see registerWidget)
  // This means it naturally hides during Incremental Rem queue turns
  if (!rem || !finalCardInfo) {
    // console.warn('[CardPriorityDisplay] Widget not shown. Reason:', {
    //   missingRem: !rem,
    //   missingCardInfo: !finalCardInfo
    // });
    return null;
  }

  // KB percentile is read directly from the main cache, which is already fast.
  const kbPercentile = (!useLightMode && cardInfo) ? cardInfo.kbPercentile : undefined;

  const handleClick = async () => {
    if (!rem) return;
    await plugin.widget.openPopup('priority', { remId: rem._id });
  };

  return (
    <div
      className="flex items-center justify-center gap-4 px-3 py-1.5 rounded-md cursor-pointer transition-all"
      style={{
        backgroundColor: 'var(--rn-clr-background-secondary)',
        border: '1px solid var(--rn-clr-border-primary)',
        margin: '4px 0',
      }}
      onClick={handleClick}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)'; }}
      title="Click to set priority (Opt+P)"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-secondary)' }}>Priority:</span>
        <PriorityBadge priority={finalCardInfo.priority} percentile={kbPercentile} compact useAbsoluteColoring={useLightMode} />
        {!useLightMode && kbPercentile !== undefined && (
          <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            ({kbPercentile}% KB
            {docPercentile !== undefined && docPercentile !== null && `, ${docPercentile}% Doc`})
          </span>
        )}
        {!useLightMode && (docPercentile === undefined || docPercentile === null) && kbPercentile !== undefined && (
          <span
            className="text-sm opacity-60 cursor-help"
            title="Doc percentile will be recalculated when you start a new queue session"
          >
            ⟳
          </span>
        )}
      </div>

      {displayPriorityShield && !useLightMode && (shieldStatus?.kb || shieldStatus?.doc) && (
        <>
          <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>|</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-secondary)' }}>🛡️ Card Shield:</span>
            <div className="flex gap-3 text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              {shieldStatus.kb && (
                <span>
                  KB: <PriorityBadge priority={shieldStatus.kb.absolute} percentile={shieldStatus.kb.percentile} compact />
                  {shieldStatus.kb.percentile !== undefined && ` (${shieldStatus.kb.percentile.toFixed(1)}%)`}
                </span>
              )}
              {shieldStatus.doc && (
                <span>
                  Doc: <PriorityBadge priority={shieldStatus.doc.absolute} percentile={shieldStatus.doc.percentile} compact />
                  {shieldStatus.doc.percentile !== undefined && ` (${shieldStatus.doc.percentile.toFixed(1)}%)`}
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

renderWidget(CardPriorityDisplay);
