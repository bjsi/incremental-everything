import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
  QueueInteractionScore,
} from '@remnote/plugin-sdk';
import React, { useMemo, useCallback } from 'react';
import {
  powerupCode,
  allCardPriorityInfoKey,
  queueSessionCacheKey,
  displayPriorityShieldId,
  displayWeightedShieldId,
  cardPriorityCacheRefreshKey,
  seenCardInSessionKey,
  priorityCalcScopeRemIdsKey,
  incrementalQueueActiveKey,
  displayFsrsDsrId,
  fsrsWeightsId,
} from '../lib/consts';
import { CardPriorityInfo, QueueSessionCache, getCardPriority } from '../lib/card_priority';
import { getPendingCacheUpdate } from '../lib/card_priority/cache';
import { PERFORMANCE_MODE_LIGHT, calculateVolumeBasedPercentile, calculateWeightedShield, formatStabilityDays, getRetrievabilityColor, percentileToHslColor } from '../lib/utils';
import { getEffectivePerformanceMode } from '../lib/mobileUtils';
import { PriorityBadge, WeightedShieldTooltip } from '../components';
import { computeFSRSState, parseWeightsString, FSRSState } from '../lib/fsrs';
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
  allPrioritizedCardInfo: CardPriorityInfo[] | null | undefined,
  seenRemIds: string[],
  scopeRemIds: string[] | null | undefined
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
    console.log(`[CardShield] KB Shield: priority ${topMissedInKb.priority}, percentile ${kbPercentile}%, triggered by remId: ${topMissedInKb.remId}`);
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
      console.log(`[CardShield] Doc Shield: priority ${topMissedInDoc.priority}, percentile ${docPercentile}%, triggered by remId: ${topMissedInDoc.remId}`);
    }
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
  // console.log('[CardPriorityDisplay] effectiveMode:', effectiveMode);

  const useLightMode = effectiveMode === PERFORMANCE_MODE_LIGHT;

  // ✅ Get the display priority shield setting
  const displayPriorityShield = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(displayPriorityShieldId),
    []
  ) ?? true;

  // ✅ Get the display weighted shield setting
  const displayWeightedShield = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(displayWeightedShieldId),
    []
  ) ?? false;

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
      // console.log('[CardPriorityDisplay] rem tracker: ctx or remId is null', ctx);
      return null;
    }
    const found = (await rp.rem.findOne(ctx.remId)) ?? null;
    if (!found) {
      // console.log('[CardPriorityDisplay] rem tracker: rem not found for id', ctx.remId);
    }
    return found;
  }, []);

  const scopeRemIds = useTrackerPlugin(
    (rp) => rp.storage.getSession<string[] | null>(priorityCalcScopeRemIdsKey),
    []
  );

  const isIncrementalQueueActive = useTrackerPlugin(
    (rp) => rp.storage.getSession<boolean>(incrementalQueueActiveKey),
    []
  );

  // --- FSRS settings trackers ---
  const showFsrsDsr = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(displayFsrsDsrId),
    []
  ) ?? true;

  const fsrsWeightsRaw = useTrackerPlugin(
    (rp) => rp.settings.getSetting<string>(fsrsWeightsId),
    []
  );

  // --- Fetch card repetition history ---
  const cardRepData = useTrackerPlugin(async (rp) => {
    const ctx = await rp.widget.getWidgetContext<WidgetLocation.FlashcardUnder>();
    const cardId = ctx?.cardId;
    const remId = ctx?.remId;
    if (!cardId && !remId) return null;

    let cards: any[] = [];
    if (cardId) {
      const card = await rp.card.findOne(cardId);
      if (card) cards = [card];
    }
    if (cards.length === 0 && remId) {
      const remObj = await rp.rem.findOne(remId);
      if (remObj) cards = await remObj.getCards();
    }

    // Use the first card (forward card) as the primary
    const card = cards[0];
    if (!card) return null;

    return {
      cardId: card._id as string,
      history: card.repetitionHistory || [],
      nextRepetitionTime: card.nextRepetitionTime,
    };
  }, []);

  // --- Compute review stats from repetition history ---
  const historyStats = useMemo(() => {
    if (!cardRepData?.history || cardRepData.history.length === 0) {
      return { reps: 0, totalMinutes: 0, lapses: 0, cardAgeText: '0 days', costText: '' };
    }

    const sorted = [...cardRepData.history].sort((a: any, b: any) => a.date - b.date);
    const lastResetIndex = sorted.map((h: any) => h.score).lastIndexOf(QueueInteractionScore.RESET);
    const historyAfterReset = lastResetIndex !== -1 ? sorted.slice(lastResetIndex + 1) : sorted;

    const firstRepDate = historyAfterReset.length > 0 ? historyAfterReset[0].date : null;
    const cardAgeMs = firstRepDate ? Date.now() - firstRepDate : 0;
    const cardAgeDays = Math.max(0, Math.floor(cardAgeMs / (1000 * 60 * 60 * 24)));
    const cardAgeText = formatStabilityDays(cardAgeDays);

    // Count only gradeable repetitions (Again, Hard, Good, Easy)
    const gradeable = historyAfterReset.filter(
      (h: any) => {
        const s = h.score;
        return s === QueueInteractionScore.AGAIN ||
          s === QueueInteractionScore.HARD ||
          s === QueueInteractionScore.GOOD ||
          s === QueueInteractionScore.EASY;
      }
    );
    const reps = gradeable.length;
    const lapses = gradeable.filter((h: any) => h.score === QueueInteractionScore.AGAIN).length;

    let costText = '';
    const totalMs = gradeable.reduce((acc: number, h: any) => acc + (h.responseTime || 0), 0);
    const totalMinutes = Math.round(totalMs / 6000) / 10; // ms → min, 1 decimal

    const nextRepDate = cardRepData?.nextRepetitionTime ? new Date(cardRepData.nextRepetitionTime) : null;
    const isNextRepInFuture = nextRepDate && nextRepDate.getTime() > Date.now();

    if (firstRepDate && totalMinutes > 0) {
      if (isNextRepInFuture) {
        const coverageMs = nextRepDate.getTime() - firstRepDate;
        const coverageYears = coverageMs / (1000 * 60 * 60 * 24 * 365);
        if (coverageYears > 0) {
          const cost = totalMinutes / coverageYears;
          costText = `${cost.toFixed(1)} min/year`;
        }
      } else {
        const ageYears = cardAgeMs / (1000 * 60 * 60 * 24 * 365);
        if (ageYears > 0) {
          const cost = totalMinutes / ageYears;
          costText = `${cost.toFixed(1)} min/year`;
        }
      }
    }

    return { reps, totalMinutes, lapses, cardAgeText, costText };
  }, [cardRepData?.history, cardRepData?.nextRepetitionTime]);

  // --- Compute FSRS state ---
  const fsrsState: FSRSState | null = useMemo(() => {
    if (!showFsrsDsr || !cardRepData?.history || cardRepData.history.length === 0) return null;
    const weights = parseWeightsString(fsrsWeightsRaw);
    return computeFSRSState(cardRepData.history, weights);
  }, [showFsrsDsr, cardRepData?.history, fsrsWeightsRaw]);


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
      return cache ? [...cache] : [];
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
  const shieldStatus = useMemo(() => {
    if (useLightMode || !rem || !sessionCache) return null;
    return computeShieldStatus(rem._id, sessionCache, allPrioritizedCardInfo, seenCardIds, scopeRemIds);
  }, [rem, sessionCache, useLightMode, allPrioritizedCardInfo, seenCardIds, scopeRemIds]);

  // --- Weighted Shield: computed dynamically so it stays fresh as seenCardIds changes ---
  const weightedIsDuePredicate = useCallback(
    (info: CardPriorityInfo) => info.dueCards > 0 && (!seenCardIds.includes(info.remId) || info.remId === rem?._id),
    [seenCardIds, rem?._id]
  );

  const weightedShieldStatus = useMemo(() => {
    if (!displayWeightedShield || useLightMode || !rem || !allPrioritizedCardInfo || allPrioritizedCardInfo.length === 0) return null;

    const kbWeighted = calculateWeightedShield(allPrioritizedCardInfo, weightedIsDuePredicate);

    let docWeighted: number | null = null;
    let docItems: CardPriorityInfo[] | null = null;
    if (scopeRemIds) {
      const scopeSet = new Set(scopeRemIds);
      docItems = allPrioritizedCardInfo.filter(c => scopeSet.has(c.remId));
      if (docItems.length > 0) {
        docWeighted = calculateWeightedShield(docItems, weightedIsDuePredicate);
      }
    }

    return { kb: kbWeighted, doc: docWeighted, docItems };
  }, [displayWeightedShield, useLightMode, rem, allPrioritizedCardInfo, weightedIsDuePredicate, scopeRemIds]);


  // --- 🔌 ON-DEMAND PATH (Light Mode OR Full Mode fallback when cache not ready) ---
  const lightCardInfo = useTrackerPlugin(async (rp) => {
    if (!rem) return null;
    // Skip on-demand only when the cache-based path already found THIS rem
    if (cardInfo) {
      return null;
    }
    // console.log('[CardPriorityDisplay] Using on-demand path (useLightMode:', useLightMode, ', cardInfo:', !!cardInfo, ')');

    const pendingInfo = getPendingCacheUpdate(rem._id);
    if (pendingInfo) {
      return pendingInfo;
    }

    return await getCardPriority(rp, rem);
  }, [useLightMode, rem, refreshSignal, cardInfo]);


  // --- 🔌 COMBINE RESULTS ---
  // Prefer cache-based cardInfo; fall back to on-demand lightCardInfo (covers Light Mode + cache-not-ready)
  const finalCardInfo = cardInfo || lightCardInfo;

  // Check isIncrementalQueueActive
  if (!rem || !finalCardInfo || isIncrementalQueueActive) {
    // console.log('[CardPriorityDisplay] Early return — rem:', !!rem, ', finalCardInfo:', !!finalCardInfo,
    //   ', isIncrementalQueueActive:', isIncrementalQueueActive,
    //   ', cardInfo:', !!cardInfo, ', lightCardInfo:', !!lightCardInfo,
    //   ', useLightMode:', useLightMode,
    //   ', allPrioritizedCardInfo length:', allPrioritizedCardInfo?.length,
    //   ', sessionCache:', !!sessionCache);
    return null;
  }

  // KB percentile is read directly from the main cache, which is already fast.
  // Only show relative data when the cache is actually populated
  const cacheReady = !!(cardInfo && allPrioritizedCardInfo && allPrioritizedCardInfo.length > 0);
  const kbPercentile = (!useLightMode && cacheReady && cardInfo) ? cardInfo.kbPercentile : undefined;

  const priorityColor = kbPercentile !== undefined ? percentileToHslColor(kbPercentile) : '#6b7280';

  // --- NEW: Check if current card is directly impacting the shield ---
  const isKbShieldActive = shieldStatus?.kb && finalCardInfo.priority === shieldStatus.kb.absolute;
  const isDocShieldActive = shieldStatus?.doc && finalCardInfo.priority === shieldStatus.doc.absolute;
  const isAnyShieldActive = isKbShieldActive || isDocShieldActive;

  const handleClick = async () => {
    if (!rem) return;
    await plugin.widget.openPopup('priority', { remId: rem._id });
  };

  const handleDebugClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!rem) return;
    await plugin.widget.openPopup('flashcard_repetition_history', {
      remId: rem._id,
      cardId: cardRepData?.cardId,
    });
  };

  return (
    <div
      className="flex items-center justify-center gap-3 px-3 py-1.5"
      style={{
        backgroundColor: 'var(--rn-clr-background-secondary)',
        border: '1px solid var(--rn-clr-border-primary)',
        borderLeft: `4px solid ${priorityColor}`,
        borderRadius: '8px',
        margin: '4px 0',
        transition: 'background-color 0.15s',
        flexWrap: 'wrap',
      }}
    >
      {/* Priority — clickable to open priority editor */}
      <div
        className="flex items-center gap-2"
        onClick={handleClick}
        style={{ cursor: 'pointer' }}
        title="Click to set priority (Opt+P)"
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.75'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
      >
        <span className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-secondary)' }}>Priority:</span>
        <PriorityBadge priority={finalCardInfo.priority} percentile={kbPercentile} compact useAbsoluteColoring={useLightMode || !cacheReady} source={finalCardInfo.source} isCardPriority={true} />
        {!useLightMode && cacheReady && kbPercentile !== undefined && (
          <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            ({kbPercentile}% KB
            {docPercentile !== undefined && docPercentile !== null && `, ${docPercentile}% Doc`})
          </span>
        )}
        {!useLightMode && cacheReady && (docPercentile === undefined || docPercentile === null) && kbPercentile !== undefined && (
          <span
            className="text-sm opacity-60 cursor-help"
            title="Doc percentile will be recalculated when you start a new queue session"
          >
            ⟳
          </span>
        )}
      </div>

      {/* Shield */}
      {displayPriorityShield && !useLightMode && cacheReady && (shieldStatus?.kb || shieldStatus?.doc) && (
        <>
          <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>|</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold flex items-center gap-1" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              <span style={{
                display: 'inline-block',
                animation: isAnyShieldActive ? 'shieldPulse 2s ease-in-out infinite' : 'none'
              }}>🛡️</span>
              <span>Card Shield:</span>
            </span>
            <div className="flex gap-3 text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              {shieldStatus.kb && (
                <span style={{
                  animation: isKbShieldActive ? 'shieldTextGlow 2s ease-in-out infinite' : 'none',
                  fontWeight: isKbShieldActive ? 700 : 'inherit',
                  color: isKbShieldActive ? 'var(--rn-clr-blue)' : 'inherit'
                }}>
                  KB: <PriorityBadge priority={shieldStatus.kb.absolute} percentile={shieldStatus.kb.percentile} compact />
                  {shieldStatus.kb.percentile !== undefined && ` (${shieldStatus.kb.percentile.toFixed(1)}%)`}
                </span>
              )}
              {shieldStatus.doc && (
                <span style={{
                  animation: isDocShieldActive ? 'shieldTextGlow 2s ease-in-out infinite' : 'none',
                  fontWeight: isDocShieldActive ? 700 : 'inherit',
                  color: isDocShieldActive ? 'var(--rn-clr-blue)' : 'inherit'
                }}>
                  Doc: <PriorityBadge priority={shieldStatus.doc.absolute} percentile={shieldStatus.doc.percentile} compact />
                  {shieldStatus.doc.percentile !== undefined && ` (${shieldStatus.doc.percentile.toFixed(1)}%)`}
                </span>
              )}
            </div>
          </div>
          <style>{`
            @keyframes shieldPulse {
              0%, 100% { transform: scale(1); filter: drop-shadow(0 0 0px rgba(59, 130, 246, 0)); }
              50% { transform: scale(1.15); filter: drop-shadow(0 0 4px rgba(59, 130, 246, 0.6)); }
            }
            @keyframes shieldTextGlow {
              0%, 100% { filter: brightness(1); }
              50% { filter: brightness(1.3); text-shadow: 0 0 4px rgba(59, 130, 246, 0.3); }
            }
          `}</style>
        </>
      )}

      {/* Weighted Shield */}
      {displayWeightedShield && !useLightMode && cacheReady && weightedShieldStatus && allPrioritizedCardInfo && (
        <>
          <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>|</span>
          <WeightedShieldTooltip
            kbValue={weightedShieldStatus.kb}
            docValue={weightedShieldStatus.doc}
            allItems={allPrioritizedCardInfo}
            isDuePredicate={weightedIsDuePredicate}
            docItems={weightedShieldStatus.docItems}
            itemLabel="Cards"
          />
        </>
      )}

      {/* Review Stats + FSRS DSR + Debug */}
      {(historyStats.reps > 0 || fsrsState) && (
        <>
          <span style={{ color: 'var(--rn-clr-content-tertiary)', opacity: 0.4 }}>|</span>
          <div className="flex items-center gap-3" style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
            <span
              title={`Total number of gradeable repetitions.\n\nThe number in red parentheses — (${historyStats.lapses}) — is the number of lapses (AGAIN ratings).\n\nThe following number is the total time spent reviewing this card.\n\nThe card age is the time elapsed since the first repetition.\n\nThe cost is the average time spent reviewing this card per year.`}
              style={{ cursor: 'help' }}
            >
              <strong>{historyStats.reps}</strong> Reps <span style={{ color: '#ef4444' }}>({historyStats.lapses})</span>, ⏳ <strong>{historyStats.totalMinutes}</strong> min, <strong>{historyStats.cardAgeText}</strong> age{historyStats.costText && <>, 💰 <strong>{historyStats.costText}</strong></>}
            </span>

            {showFsrsDsr && fsrsState && (
              <>
                <span style={{ opacity: 0.4 }}>|</span>
                <span title={`FSRS v6 — Difficulty: how hard this card is to remember (1=easy, 10=hard).\nStability: expected interval in days at target retention.\nRetrievability: probability of recall right now.\n\nThe number inside the parenthesis after Stability tells you how much time has passed since your last review of this card.\n\nBased on ${fsrsState.reviewCount} reviews.\n\nNext Difficulty:\nAgain: ${fsrsState.nextD.again.toFixed(2)}\nHard: ${fsrsState.nextD.hard.toFixed(2)}\nGood: ${fsrsState.nextD.good.toFixed(2)}\nEasy: ${fsrsState.nextD.easy.toFixed(2)}`}>
                  D: <strong>{fsrsState.d.toFixed(2)}</strong>
                  {' · '}
                  S: <strong>{formatStabilityDays(fsrsState.s)}</strong> ({formatStabilityDays(fsrsState.daysSinceLastReview)} passed)
                  {' · '}
                  R: <strong style={{ color: getRetrievabilityColor(fsrsState.r) }}>
                    {(fsrsState.r * 100).toFixed(1)}%
                  </strong>
                </span>
                {' · '}
                <span title={`SInc (Stability Increase) — how much your memory stability grows after answering.\n\nHard: ×${fsrsState.sInc.hard.toFixed(2)} → ${formatStabilityDays(fsrsState.s * fsrsState.sInc.hard)}\nGood: ×${fsrsState.sInc.good.toFixed(2)} → ${formatStabilityDays(fsrsState.s * fsrsState.sInc.good)}\nEasy: ×${fsrsState.sInc.easy.toFixed(2)} → ${formatStabilityDays(fsrsState.s * fsrsState.sInc.easy)}\n\nHigher = faster learning. A value of 1.0 means no growth.`}
                  style={{ cursor: 'help' }}
                >
                  SInc: <strong>{fsrsState.sInc.good.toFixed(2)}×</strong>
                </span>
              </>
            )}

            <span
              role="button"
              style={{
                cursor: 'pointer',
                fontSize: '13px',
                opacity: 0.5,
                padding: '2px 4px',
                borderRadius: '4px',
                transition: 'opacity 0.15s, background-color 0.15s',
              }}
              onClick={handleDebugClick}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.backgroundColor = 'transparent'; }}
              title="Inspect full repetition history"
            >
              🔬
            </span>
          </div>
        </>
      )}
    </div>
  );
}

renderWidget(CardPriorityDisplay);
