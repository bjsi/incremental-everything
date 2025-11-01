import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useMemo } from 'react';
import { 
  powerupCode, 
  seenCardInSessionKey, 
  allCardPriorityInfoKey,
  queueSessionCacheKey,
  cardPriorityCacheRefreshKey,
  displayPriorityShieldId,
  isMobileDeviceKey,
  alwaysUseLightModeOnMobileId
} from '../lib/consts';
import { CardPriorityInfo, QueueSessionCache, getCardPriority } from '../lib/cardPriority';
import { percentileToHslColor } from '../lib/color';
import * as _ from 'remeda';

export function CardPriorityDisplay() {
  const plugin = usePlugin();

  // ✅ Track the values that determine effective mode
  const performanceModeSetting = useTrackerPlugin(
    (rp) => rp.settings.getSetting<string>('performanceMode'),
    []
  ) || 'full';

  const isMobile = useTrackerPlugin(
    async (rp) => await rp.storage.getSynced<boolean>(isMobileDeviceKey),
    []
  );

  const alwaysUseLightOnMobile = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(alwaysUseLightModeOnMobileId),
    []
  );

  // ✅ Calculate effective mode
  const useLightMode = performanceModeSetting === 'light' || 
                       (isMobile && alwaysUseLightOnMobile !== false);

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

  const rem = useTrackerPlugin(async (rp) => {
    const ctx = await rp.widget.getWidgetContext();
    return ctx?.remId ? await rp.rem.findOne(ctx.remId) : undefined;
  }, []);

  const isIncRem = useTrackerPlugin(async (rp) => {
    return rem ? await rem.hasPowerup(powerupCode) : false;
  }, [rem]);


  // --- 🔌 CACHE-BASED PATH (Full Mode) ---
  const sessionCache = useTrackerPlugin(
    (rp) => (!useLightMode) 
      ? rp.storage.getSession<QueueSessionCache>(queueSessionCacheKey) 
      : null,
    [useLightMode, refreshSignal]
  );

  const allPrioritizedCardInfo = useTrackerPlugin(
    (rp) => (!useLightMode) 
      ? rp.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey) 
      : null,
    [useLightMode, refreshSignal]
  );

  const cardInfo = useMemo(() => {
    if (useLightMode || !rem || isIncRem || !allPrioritizedCardInfo) {
      return null;
    }
    return allPrioritizedCardInfo.find(info => info.remId === rem._id);
  }, [rem, isIncRem, allPrioritizedCardInfo, useLightMode]);
  
  const docPercentile = useMemo(() => {
    if (useLightMode || !rem || !sessionCache?.docPercentiles) return null;
    return sessionCache.docPercentiles[rem._id];
  }, [rem, sessionCache, useLightMode]);


  // --- REWRITTEN: The Shield calculation is now ultra-fast ---
  // It reads from the small, pre-filtered lists in our new session cache.
  const shieldStatus = useTrackerPlugin(async (rp) => {
    if (useLightMode || !rem || !sessionCache) return null;


    // Get the list of cards seen in this session, now with 'await'.
    const seenRemIds = (await rp.storage.getSession<string[]>(seenCardInSessionKey)) || []; 

    // --- KB Shield Calculation (fast) ---
    // Filter the small `dueCardsInKB` list, not the whole main cache.
    const unreviewedDueKb = sessionCache.dueCardsInKB.filter(
      (info) => !seenRemIds.includes(info.remId) || info.remId === rem._id
    );
    const topMissedInKb = _.minBy(unreviewedDueKb, (info) => info.priority);
    
    // --- Document Shield Calculation (fast) ---
    // Filter the small `dueCardsInScope` list.
    const unreviewedDueDoc = sessionCache.dueCardsInScope.filter(
      (info) => !seenRemIds.includes(info.remId) || info.remId === rem._id
    );
    const topMissedInDoc = _.minBy(unreviewedDueDoc, (info) => info.priority);

    return {
      kb: topMissedInKb ? {
        absolute: topMissedInKb.priority,
        percentile: topMissedInKb.kbPercentile || 0,
      } : null,
      doc: topMissedInDoc && sessionCache.docPercentiles[topMissedInDoc.remId] !== undefined ? {
        absolute: topMissedInDoc.priority,
        percentile: sessionCache.docPercentiles[topMissedInDoc.remId]
      } : null,
    };
  }, [rem, sessionCache, useLightMode]);


  // --- 🔌 ON-DEMAND PATH (Light Mode) ---
  const lightCardInfo = useTrackerPlugin(async (rp) => {
    if (!useLightMode || !rem || isIncRem) return null;
    // Fetch priority directly, on-demand. This is fast for a single rem.
    return await getCardPriority(rp, rem);
  }, [useLightMode, rem, isIncRem]);


  // --- 🔌 COMBINE RESULTS ---
  const finalCardInfo = useLightMode ? lightCardInfo : cardInfo;

  if (!rem || isIncRem || !finalCardInfo) {
    return null;
  }

  // KB percentile is read directly from the main cache, which is already fast.
  const kbPercentile = (!useLightMode && cardInfo) ? cardInfo.kbPercentile : undefined;
  
  // Use relative percentile for color in 'full' mode if available,
  // otherwise fall back to the absolute priority.
  const colorValue = (!useLightMode && kbPercentile !== undefined)
    ? kbPercentile            // Use relative percentile (full mode)
    : finalCardInfo.priority; // Use absolute priority (light mode or fallback)

  const priorityColor = percentileToHslColor(colorValue);

  // ... (style objects remain the same) ...

  const infoBarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    padding: '6px 12px',
    backgroundColor: 'rgba(59, 130, 246, 0.05)',
    borderRadius: '6px',
    fontSize: '12px',
    color: '#1e40af',
    borderLeft: `3px solid ${priorityColor}`,
    margin: '4px 0',
  };

  const priorityBadgeStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: 600,
    color: 'white',
    backgroundColor: priorityColor,
  };

  return (
    <div style={infoBarStyle} className="card-priority-display dark:bg-gray-800 dark:text-gray-200">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontWeight: 500 }}>🎴 Priority:</span>
        <div style={priorityBadgeStyle}>
          <span>{finalCardInfo.priority}</span> {/* 🔌 Show absolute priority */}
          
          {/* 🔌 Conditionally show percentiles */}
          {!useLightMode && kbPercentile !== undefined && (
            <span style={{ opacity: 0.9, fontSize: '11px' }}>
              ({kbPercentile}% KB
              {docPercentile !== undefined && docPercentile !== null && `, ${docPercentile}% Doc`})
            </span>
          )}
        </div>
        {/*  🔌 Conditionally show refresh icon only when Doc percentile is missing (will be recalculated on next queue) */}
        {!useLightMode && (docPercentile === undefined || docPercentile === null) && kbPercentile !== undefined && (

          <span 
            style={{ 
              fontSize: '16px', 
              opacity: 0.6,
              cursor: 'help'
            }}
            title="Doc percentile will be recalculated when you start a new queue session"
          >
            ⟳
          </span>
        )}
      </div>
      
      {/* 🔌 Conditionally show Shield display based on setting */}
      {displayPriorityShield && !useLightMode && (shieldStatus?.kb || shieldStatus?.doc) && (
        <>
          <span style={{ color: '#9ca3af' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 600 }}>🛡️ Card Shield</span>
            <div style={{ display: 'flex', gap: '12px' }}>
              {shieldStatus.kb && <span>KB: <strong>{shieldStatus.kb.absolute}</strong> ({shieldStatus.kb.percentile}%)</span>}
              {shieldStatus.doc && <span>Doc: <strong>{shieldStatus.doc.absolute}</strong> ({shieldStatus.doc.percentile}%)</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

renderWidget(CardPriorityDisplay);
