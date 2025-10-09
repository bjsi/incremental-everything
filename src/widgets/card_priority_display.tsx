import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
  Rem,
  QueueItemType,
} from '@remnote/plugin-sdk';
import React, { useEffect, useMemo } from 'react';
import { powerupCode, seenCardInSessionKey, currentSubQueueIdKey, allCardPriorityInfoKey } from '../lib/consts';
import { CardPriorityInfo, getCardPriority, calculateRelativeCardPriority } from '../lib/cardPriority';
import { calculateCardPriorityShield } from '../lib/priority_shield';
import * as _ from 'remeda';
import { percentileToHslColor } from '../lib/color';

export function CardPriorityDisplay() {
  const plugin = usePlugin();
    
  // ADD THIS SYNCHRONOUS CHECK FIRST - before any hooks!
  const ctx = plugin.widget.getWidgetContext();
  
  // If this is a Plugin queue item (IncRem), don't render anything
  // This check happens synchronously before any async operations
  if (ctx?.queueItemType === QueueItemType.Plugin) {
    return null;
  }

  const rem = useTrackerPlugin(async (rp) => {
    const ctx = await rp.widget.getWidgetContext();
    return ctx?.remId ? await rp.rem.findOne(ctx.remId) : undefined;
  }, []);

  const isIncRem = useTrackerPlugin(async (rp) => {
    return rem ? await rem.hasPowerup(powerupCode) : false;
  }, [rem]);

  // --- THIS IS THE NEW REACTIVE LOGIC ---

  // 1. Fetch the priority info for the CURRENT card directly.
  // `useTrackerPlugin` will automatically re-run this when the card's
  // priority property changes, making the widget reactive.
  const cardInfo = useTrackerPlugin(async (rp) => {
    if (!rem || isIncRem) return null;
    return await getCardPriority(rp, rem);
  }, [rem, isIncRem]);
  
  // 2. Fetch the full cache for context. This is still fast because it's
  // just reading from session storage.
  const allPrioritizedCardInfo = useTrackerPlugin(
    (rp) => rp.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey),
    []
  );

  // 3. The shield calculation now uses the fresh `cardInfo` and the cached context.
  const shieldStatus = useTrackerPlugin(async (rp) => {
    if (!rem || isIncRem || !allPrioritizedCardInfo) return null;
    return await calculateCardPriorityShield(rp, allPrioritizedCardInfo, rem._id);
  }, [rem, isIncRem, allPrioritizedCardInfo]);
  
  // The rest of the component remains largely the same...
  const docPrioritizedCardInfo = useTrackerPlugin(async (rp) => {
    if (!rem || isIncRem || !allPrioritizedCardInfo) return null;
    const subQueueId = await rp.storage.getSession<string | null>(currentSubQueueIdKey);
    if (!subQueueId) return null;
    const scopeRem = await rp.rem.findOne(subQueueId);
    if (!scopeRem) return null;
    const descendants = await scopeRem.getDescendants();
    const scopeIds = [scopeRem._id, ...descendants.map(d => d._id)];
    return allPrioritizedCardInfo.filter(c => scopeIds.includes(c.remId));
  }, [allPrioritizedCardInfo, rem, isIncRem]);

  useEffect(() => {
    if (rem && !isIncRem) {
      const updateSeen = async () => {
        const seen = (await plugin.storage.getSession<string[]>(seenCardInSessionKey)) || [];
        if (!seen.includes(rem._id)) {
          await plugin.storage.setSession(seenCardInSessionKey, [...seen, rem._id]);
        }
      };
      updateSeen();
    }
  }, [rem?._id, isIncRem, plugin]);
  
  if (!rem || isIncRem || !cardInfo || !allPrioritizedCardInfo) {
    return null;
  }

  const kbPercentile = calculateRelativeCardPriority(allPrioritizedCardInfo, rem._id);
  const docPercentile = docPrioritizedCardInfo ? calculateRelativeCardPriority(docPrioritizedCardInfo, rem._id) : null;
  const priorityColor = kbPercentile ? percentileToHslColor(kbPercentile) : '#6b7280';

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
          {kbPercentile !== null && (
            <span style={{ opacity: 0.9, fontSize: '11px' }}>
              ({kbPercentile}% of KB{docPercentile !== null && `, ${docPercentile}% of Doc`})
            </span>
          )}
        </div>
      </div>
      
      {shieldStatus && (
        <>
          <span style={{ color: '#9ca3af' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 600 }}>🛡️ Card Shield</span>
            <div style={{ display: 'flex', gap: '12px' }}>
              {shieldStatus.kb ? (
                <span>KB: <strong>{shieldStatus.kb.absolute}</strong> ({shieldStatus.kb.percentile}%)</span>
              ) : <span>KB: 100%</span>}
              {docPrioritizedCardInfo && (
                  shieldStatus.doc ? (
                  <span>Doc: <strong>{shieldStatus.doc.absolute}</strong> ({shieldStatus.doc.percentile}%)</span>
                ) : <span>Doc: 100%</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

renderWidget(CardPriorityDisplay);