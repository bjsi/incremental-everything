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
  cardPriorityCacheRefreshKey // 1. Import the refresh key
} from '../lib/consts';
import { CardPriorityInfo, QueueSessionCache } from '../lib/cardPriority';
import { percentileToHslColor } from '../lib/color';
import * as _ from 'remeda';

export function CardPriorityDisplay() {
  const plugin = usePlugin();

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

  // --- NEW: Fetch our ultra-fast session cache ---
  // 3. Add the refreshSignal to the dependency arrays of our main data hooks.
  const sessionCache = useTrackerPlugin(
    (rp) => rp.storage.getSession<QueueSessionCache>(queueSessionCacheKey),
    [refreshSignal] // Re-fetch when signal changes
  );

  // We still need the main cache to find the info for the *current* card.
  const allPrioritizedCardInfo = useTrackerPlugin(
    (rp) => rp.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey),
    [refreshSignal] // Re-fetch when signal changes
  );

  // This lookup remains the same and is very fast.
  const cardInfo = useMemo(() => {
    if (!rem || isIncRem || !allPrioritizedCardInfo) {
      return null;
    }
    return allPrioritizedCardInfo.find(info => info.remId === rem._id);
  }, [rem, isIncRem, allPrioritizedCardInfo]);
  
   // --- MOVED THIS HOOK TO THE TOP LEVEL ---
  const docPercentile = useMemo(() => {
    if (!rem || !sessionCache?.docPercentiles) return null;
    // Simple, instant lookup from the pre-calculated map.
    return sessionCache.docPercentiles[rem._id];
  }, [rem, sessionCache]);

  // --- REWRITTEN: The Shield calculation is now ultra-fast ---
  // It reads from the small, pre-filtered lists in our new session cache.
   const shieldStatus = useTrackerPlugin(async (rp) => { // Added 'async'
    if (!rem || !sessionCache) return null;

    // Get the list of cards seen in this session, now with 'await'.
    const seenRemIds = (await rp.storage.getSession<string[]>(seenCardInSessionKey)) || []; // Added 'await'

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
  }, [rem, sessionCache]); // Depends on the rem and the new cache

  if (!rem || isIncRem || !cardInfo) {
    return null;
  }

  // KB percentile is read directly from the main cache, which is already fast.
  const kbPercentile = cardInfo.kbPercentile;
  const priorityColor = (kbPercentile !== undefined) ? percentileToHslColor(kbPercentile) : '#6b7280';

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
          <span>{cardInfo.priority}</span>
          {/* Show KB percentile (always current). Doc percentile removed after priority change. */}
          {kbPercentile !== undefined && (
            <span style={{ opacity: 0.9, fontSize: '11px' }}>
              ({kbPercentile}% KB
              {docPercentile !== undefined && docPercentile !== null && `, ${docPercentile}% Doc`})
            </span>
          )}
        </div>
        {/* Show refresh icon only when Doc percentile is missing (will be recalculated on next queue) */}
        {(docPercentile === undefined || docPercentile === null) && kbPercentile !== undefined && (
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
      
      {/* --- RESTORED: Document Shield display --- */}
      {(shieldStatus?.kb || shieldStatus?.doc) && (
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